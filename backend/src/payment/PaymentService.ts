import {
  ProcurementCommitmentService,
  procurementCommitmentService,
} from '../discovery/supplier/selection/ProcurementCommitmentService';
import {
  PurchaseOrderService,
  purchaseOrderService,
} from '../discovery/supplier/selection/PurchaseOrderService';
import {
  PaymentAuthorizationService,
  paymentAuthorizationService,
} from './authorization/PaymentAuthorizationService';
import { MandateService, mandateService } from './mandate/MandateService';
import { PaymentExecutionService, paymentExecutionService } from './PaymentExecutionService';
import { addDecimals, roundMoney } from '../domain/procurement/decimal';
import { PaymentProvider } from './provider/PaymentProvider';
import {
  Payment,
  PaymentAuthorization,
  PaymentMandate,
  ProcurementPaymentSummary,
  SupplierPaymentObligation,
} from './types';

export interface PayCommitmentInput {
  commitmentId: string;
  /**
   * Declared payer: the resident (ownerReference) whose mandate may be
   * charged. The resolved mandate MUST be owned by this reference — an
   * explicit foreign mandateId or a foreign default mandate is rejected.
   * Callers pass the server-resolved identity (workflow residentReference or
   * tool execution context), never model-supplied identity.
   */
  ownerReference: string;
  mandateId?: string;
  provider?: PaymentProvider;
  idempotencyKey?: string;
}

export class PaymentService {
  private inFlightPayCommitments = new Map<
    string,
    Promise<{ summary: ProcurementPaymentSummary; payments: Payment[] }>
  >();

  constructor(
    private readonly commitmentSvc: ProcurementCommitmentService = procurementCommitmentService,
    private readonly poSvc: PurchaseOrderService = purchaseOrderService,
    private readonly mandateSvc: MandateService = mandateService,
    private readonly authSvc: PaymentAuthorizationService = paymentAuthorizationService,
    private readonly executionSvc: PaymentExecutionService = paymentExecutionService
  ) {}

  /**
   * Deterministically authorizes and executes payments for all supplier obligations in a
   * Phase 6 Procurement Commitment.
   * Derives authoritative amounts directly from allocations (AI NEVER sets amounts).
   *
   * Concurrent calls for the same commitment coalesce onto one execution:
   * without this, two overlapping calls would each authorize+reserve and then
   * deduplicate at execution, orphaning the loser's reservation (or, with
   * distinct idempotency keys, double-charging the provider).
   */
  public async payCommitment(
    input: PayCommitmentInput
  ): Promise<{ summary: ProcurementPaymentSummary; payments: Payment[] }> {
    const inFlight = this.inFlightPayCommitments.get(input.commitmentId);
    if (inFlight) {
      return inFlight;
    }
    const execution = this.doPayCommitment(input);
    this.inFlightPayCommitments.set(input.commitmentId, execution);
    try {
      return await execution;
    } finally {
      this.inFlightPayCommitments.delete(input.commitmentId);
    }
  }

  private async doPayCommitment(
    input: PayCommitmentInput
  ): Promise<{ summary: ProcurementPaymentSummary; payments: Payment[] }> {
    const commitment = this.commitmentSvc.getCommitment(input.commitmentId);
    if (!commitment) {
      throw new Error(`Procurement commitment '${input.commitmentId}' not found`);
    }

    if (commitment.status !== 'READY_FOR_PAYMENT') {
      throw new Error(
        `Cannot pay commitment in '${commitment.status}' status; expected 'READY_FOR_PAYMENT'`
      );
    }

    const purchaseOrders = this.poSvc.getPurchaseOrdersForCommitment(commitment.id);
    if (purchaseOrders.length === 0) {
      throw new Error(
        `No purchase orders found for procurement commitment '${commitment.id}'`
      );
    }

    if (!input.ownerReference || typeof input.ownerReference !== 'string') {
      throw new Error('MANDATE_OWNER_REQUIRED: payCommitment requires the declared payer ownerReference');
    }

    // Resolve or find authorized mandate. The mandate MUST be owned by the
    // declared payer: neither an explicit foreign mandateId nor a foreign
    // default mandate may be charged.
    let mandate: PaymentMandate | undefined;
    if (input.mandateId) {
      mandate = this.mandateSvc.getMandate(input.mandateId);
      if (!mandate) {
        throw new Error(`Payment mandate '${input.mandateId}' not found`);
      }
      if (mandate.ownerReference !== input.ownerReference) {
        throw new Error(
          `MANDATE_OWNER_MISMATCH: Mandate '${input.mandateId}' is not owned by '${input.ownerReference}'`
        );
      }
    } else {
      // Find default active procurement mandate owned by the declared payer
      // and matching currency and purpose.
      const activeMandates = this.mandateSvc
        .listMandates()
        .filter(
          (m) =>
            m.ownerReference === input.ownerReference &&
            m.status === 'ACTIVE' &&
            m.currency.toUpperCase() === commitment.financials.currency.toUpperCase() &&
            m.purpose === 'COMMUNITY_PROCUREMENT'
        );
      mandate = activeMandates[0];
      if (!mandate) {
        throw new Error(
          `No active COMMUNITY_PROCUREMENT mandate owned by '${input.ownerReference}' found for currency '${commitment.financials.currency}'`
        );
      }
    }

    const payments: Payment[] = [];
    const existingPayments = this.executionSvc.getPaymentsForCommitment(commitment.id);

    // Iterate through each purchase order (one per supplier in single or multi-supplier split)
    for (const po of purchaseOrders) {
      // A payment already exists for this PO (any status): reuse it instead
      // of authorizing again. Authorizing first and deduplicating at
      // execution would orphan the redundant reservation on the mandate.
      // Failed obligations are retried explicitly via retryPayment.
      const existingPayment = existingPayments.find((p) => p.purchaseOrderId === po.id);
      if (existingPayment) {
        payments.push(existingPayment);
        continue;
      }

      // 1. Authorize exact allocation amount
      const alreadyPaid = false;
      const authorization = await this.authSvc.authorizePayment({
        commitment,
        purchaseOrder: po,
        mandate,
        amount: po.total,
        currency: po.currency,
        purpose: 'COMMUNITY_PROCUREMENT',
        alreadyPaid,
      });

      // 2. Execute payment via provider
      const payment = await this.executionSvc.executePayment({
        authorization,
        purchaseOrder: po,
        provider: input.provider,
        idempotencyKey: input.idempotencyKey
          ? `${input.idempotencyKey}_${po.id}`
          : undefined,
      });

      payments.push(payment);
    }

    // 3. Assemble Consolidated Procurement Payment Summary
    const summary = this.buildPaymentSummary(commitment.id);

    // If all supplier obligations have succeeded, advance commitment & POs to PAID
    if (summary.status === 'FULLY_PAID') {
      commitment.status = 'PAID';
      commitment.updatedAt = new Date();
      for (const po of purchaseOrders) {
        po.status = 'PAID';
        po.updatedAt = new Date();
      }
    }

    return { summary, payments };
  }

  /**
   * Retries an explicitly failed payment obligation within a procurement.
   * Uncertain outcomes (TIMEOUT / response lost) require the caller to pass
   * `acknowledgeUncertainOutcome: true` after inspecting authoritative
   * provider state; see PaymentExecutionService.retryPayment.
   */
  public async retryPayment(
    paymentId: string,
    options?: { provider?: PaymentProvider; acknowledgeUncertainOutcome?: boolean }
  ): Promise<{ payment: Payment; summary: ProcurementPaymentSummary }> {
    const payment = await this.executionSvc.retryPayment(paymentId, options);
    const summary = this.buildPaymentSummary(payment.commitmentId);

    if (summary.status === 'FULLY_PAID') {
      const commitment = this.commitmentSvc.getCommitment(payment.commitmentId);
      if (commitment) {
        commitment.status = 'PAID';
        commitment.updatedAt = new Date();
      }
      const purchaseOrders = this.poSvc.getPurchaseOrdersForCommitment(payment.commitmentId);
      for (const po of purchaseOrders) {
        if (po.id === payment.purchaseOrderId) {
          po.status = 'PAID';
          po.updatedAt = new Date();
        }
      }
    }

    return { payment, summary };
  }

  public getPayment(paymentId: string): Payment | undefined {
    return this.executionSvc.getPayment(paymentId);
  }

  public getPaymentsForCommitment(commitmentId: string): Payment[] {
    return this.executionSvc.getPaymentsForCommitment(commitmentId);
  }

  public getAuthorization(authorizationId: string): PaymentAuthorization | undefined {
    return this.authSvc.getAuthorization(authorizationId);
  }

  public getMandate(mandateId: string): PaymentMandate | undefined {
    return this.mandateSvc.getMandate(mandateId);
  }

  /**
   * Deterministically calculates current payment state across all supplier allocations.
   */
  public getProcurementPaymentSummary(commitmentId: string): ProcurementPaymentSummary {
    return this.buildPaymentSummary(commitmentId);
  }

  public reset(): void {
    this.inFlightPayCommitments.clear();
    this.mandateSvc.reset();
    this.authSvc.reset();
    this.executionSvc.reset();
  }

  public async clearDurableClaims(): Promise<void> {
    await this.executionSvc.clearDurableClaims();
  }

  private buildPaymentSummary(commitmentId: string): ProcurementPaymentSummary {
    const commitment = this.commitmentSvc.getCommitment(commitmentId);
    if (!commitment) {
      throw new Error(`Commitment '${commitmentId}' not found`);
    }

    const purchaseOrders = this.poSvc.getPurchaseOrdersForCommitment(commitmentId);
    const payments = this.executionSvc.getPaymentsForCommitment(commitmentId);

    const obligations: SupplierPaymentObligation[] = purchaseOrders.map((po) => {
      const matchingPayment = payments.find((p) => p.purchaseOrderId === po.id);
      return {
        supplierId: po.supplierId,
        supplierName: po.supplierName,
        purchaseOrderId: po.id,
        amount: po.total,
        paymentId: matchingPayment?.id,
        status: matchingPayment?.status || 'PENDING',
        providerTransactionId: matchingPayment?.providerTransactionId,
      };
    });

    const successfulPayments = payments.filter((p) => p.status === 'SUCCEEDED');
    // Exact Decimal sum: float accumulation could print paise artifacts on
    // multi-obligation summaries (e.g. 0.1 + 0.2).
    const paidAmount = roundMoney(
      addDecimals(...successfulPayments.map((p) => p.amount))
    ).toNumber();

    const allSucceeded =
      obligations.length > 0 && obligations.every((o) => o.status === 'SUCCEEDED');
    const anyFailed = obligations.some((o) => o.status === 'FAILED');
    const anyProcessing = obligations.some((o) => o.status === 'PROCESSING' || o.status === 'AUTHORIZED');

    let overallStatus: ProcurementPaymentSummary['status'] = 'NOT_PAID';
    if (allSucceeded) {
      overallStatus = 'FULLY_PAID';
    } else if (successfulPayments.length > 0 && anyFailed) {
      overallStatus = 'PARTIALLY_PAID';
    } else if (anyFailed && successfulPayments.length === 0) {
      overallStatus = 'FAILED';
    } else if (anyProcessing) {
      overallStatus = 'PROCESSING';
    }

    return {
      commitmentId,
      rfqId: commitment.rfqId,
      totalAmount: commitment.financials.total,
      paidAmount,
      currency: commitment.financials.currency,
      status: overallStatus,
      payments,
      supplierObligations: obligations,
    };
  }
}

export const paymentService = new PaymentService();

