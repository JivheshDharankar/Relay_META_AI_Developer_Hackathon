/**
 * Phase 17.2 Correction 1 — uncertain payment retries are mechanically safe.
 *
 * retryPayment() must reject TIMEOUT/uncertain outcomes unless the caller
 * explicitly passes `acknowledgeUncertainOutcome: true` (operator inspected
 * authoritative provider state). Definitive provider rejections keep the
 * existing retry behavior. Automatic workflow paths never retry.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { RFQService } from '../src/discovery/supplier/rfq/RFQService';
import { SupplierResponseService } from '../src/discovery/supplier/quote/provider/SupplierResponseService';
import { MockSupplierResponseProvider } from '../src/discovery/supplier/quote/provider/MockSupplierResponseProvider';
import { QuoteNormalizationService } from '../src/discovery/supplier/quote/QuoteNormalizationService';
import { SupplierCandidate } from '../src/discovery/supplier/types';
import { RFQ } from '../src/discovery/supplier/rfq/types';
import { Quote } from '../src/discovery/supplier/quote/types';
import {
  ProcurementCommitment,
  PurchaseOrder,
} from '../src/discovery/supplier/selection/types';
import {
  procurementCommitmentService as defaultCommitmentService,
  purchaseOrderService as defaultPOService,
  rfqService as defaultRfqService,
  quoteNormalizationService as defaultQuoteService,
} from '../src/discovery/supplier';
import {
  MandateService,
  PaymentAuthorizationService,
  PaymentExecutionService,
  PaymentService,
  MockPaymentProvider,
  PaymentMandate,
  paymentService as defaultPaymentService,
  mandateService as defaultMandateService,
  mockPaymentProvider as defaultMockProvider,
  paymentExecutionService as defaultExecutionService,
  paymentAuthorizationService as defaultAuthService,
} from '../src/payment';
import { RelayOrchestrator } from '../src/orchestration';

describe('Phase 17.2 — uncertain retry guardrail', () => {
  let rfqService: RFQService;
  let supplierResponseService: SupplierResponseService;
  let quoteNormalizationService: QuoteNormalizationService;
  let mandateService: MandateService;
  let mockProvider: MockPaymentProvider;
  let executionService: PaymentExecutionService;
  let paymentService: PaymentService;

  let candidateA: SupplierCandidate;
  let rfqSingle: RFQ;
  let quoteA: Quote;
  let singleCommitment: ProcurementCommitment;
  let singlePO: PurchaseOrder;
  let communityMandate: PaymentMandate;

  beforeEach(async () => {
    defaultRfqService.reset();
    defaultQuoteService.reset();
    defaultCommitmentService.reset();
    defaultPOService.reset();
    defaultPaymentService.reset();
    await defaultPaymentService.clearDurableClaims();
    defaultMandateService.reset();
    defaultMockProvider.reset();

    rfqService = defaultRfqService;
    quoteNormalizationService = defaultQuoteService;
    const mockResponseProvider = new MockSupplierResponseProvider(rfqService);
    supplierResponseService = new SupplierResponseService(rfqService);
    supplierResponseService.registerProvider(mockResponseProvider);

    mandateService = defaultMandateService;
    mockProvider = defaultMockProvider;
    paymentService = defaultPaymentService;
    executionService = defaultExecutionService;

    candidateA = {
      id: 'cand_retry_audit',
      name: 'Retry Audit Grains',
      address: 'Gultekdi Market Yard, Pune',
      latitude: 18.496,
      longitude: 73.868,
      categories: ['grain_wholesaler'],
      email: 'orders@retryaudit.com',
      phone: '+919876543299',
    };

    const now = new Date();
    rfqSingle = await rfqService.createRFQ({
      candidate: candidateA,
      lineItems: [{ productName: 'Sharbati Wheat', quantity: 100, unit: 'KG' }],
      deliveryArea: 'Greenview Residency Central Depot',
      deliveryDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
      quoteDeadline: new Date(now.getTime() + 4 * 3600 * 1000),
      societyId: 'soc_greenview',
    });

    const respA = await supplierResponseService.ingestResponse({
      rfqId: rfqSingle.id,
      candidateId: candidateA.id,
      supplierName: candidateA.name,
      channel: 'manual',
      lineItems: [{ productName: 'Sharbati Wheat', quotedQuantity: 100, unit: 'KG', unitPrice: 55 }],
      deliveryFee: 100,
      deliveryEtaHours: 8,
    });
    quoteA = (await quoteNormalizationService.normalizeResponse(respA)).quote;

    const commitResult = await defaultCommitmentService.createCommitment({
      rfqId: rfqSingle.id,
      recommendation: {
        decision: 'SELECT_SUPPLIER',
        supplierId: candidateA.id,
        quoteId: quoteA.id,
        reason: 'retry audit probe',
      },
    });
    singleCommitment = commitResult.commitment;
    singlePO = commitResult.purchaseOrders[0];

    communityMandate = mandateService.createMandate({
      ownerReference: `res_retry_${randomUUID().slice(0, 8)}`,
      purpose: 'COMMUNITY_PROCUREMENT',
      spendingLimit: 500000,
      currency: 'INR',
    });
  });

  it('1. TIMEOUT retry without acknowledgement is rejected (no second attempt)', async () => {
    mockProvider.simulateTimeout(singlePO.id);
    const { payments } = await paymentService.payCommitment({
      ownerReference: communityMandate.ownerReference,
      commitmentId: singleCommitment.id,
      mandateId: communityMandate.id,
    });
    const failed = payments[0];
    expect(failed.status).toBe('FAILED');
    expect(failed.attempts[0].status).toBe('TIMEOUT');

    await expect(paymentService.retryPayment(failed.id)).rejects.toThrow(/uncertain outcome/);
    const stored = executionService.getPayment(failed.id)!;
    expect(stored.status).toBe('FAILED');
    expect(stored.attempts).toHaveLength(1);
  });

  it('2. TIMEOUT retry with explicit acknowledgement follows the operator path', async () => {
    mockProvider.simulateTimeout(singlePO.id);
    const { payments } = await paymentService.payCommitment({
      ownerReference: communityMandate.ownerReference,
      commitmentId: singleCommitment.id,
      mandateId: communityMandate.id,
    });
    const failed = payments[0];
    expect(failed.status).toBe('FAILED');

    // Operator inspected provider state, confirmed no charge, cleared the fault.
    mockProvider.clearOverrides();
    const { payment: retried } = await paymentService.retryPayment(failed.id, {
      acknowledgeUncertainOutcome: true,
    });
    expect(retried.status).toBe('SUCCEEDED');
    expect(retried.attempts).toHaveLength(2);
  });

  it('3. Definitive provider rejection keeps existing retry behavior (no ack needed)', async () => {
    mockProvider.simulateFailure(singlePO.id, 'GATEWAY_DECLINED', 'Card declined', true);
    const { payments } = await paymentService.payCommitment({
      ownerReference: communityMandate.ownerReference,
      commitmentId: singleCommitment.id,
      mandateId: communityMandate.id,
    });
    const failed = payments[0];
    expect(failed.status).toBe('FAILED');
    expect(failed.attempts[0].status).toBe('FAILED');
    expect(failed.attempts[0].failureCode).toBe('GATEWAY_DECLINED');

    mockProvider.clearOverrides();
    const { payment: retried } = await paymentService.retryPayment(failed.id);
    expect(retried.status).toBe('SUCCEEDED');
    expect(retried.attempts).toHaveLength(2);
  });

  it('4. Automatic workflow never invokes retryPayment (provider timeout → terminal FAILED)', async () => {
    const retrySpy = vi.spyOn(defaultExecutionService, 'retryPayment');
    try {
      // Force a provider timeout regardless of which supplier gets selected
      // (discovery may serve real Geoapify candidates or mock candidates).
      defaultMockProvider.setGlobalFailure({ type: 'TIMEOUT', isRetryable: true });

      const orchestrator = new RelayOrchestrator();
      const retryResident = `res_autoretry_${randomUUID().slice(0, 8)}`;
      // Real mandate fixture: PAY must never auto-create consent.
      defaultMandateService.createMandate({
        ownerReference: retryResident,
        purpose: 'COMMUNITY_PROCUREMENT',
        spendingLimit: 1000000,
        currency: 'INR',
      });
      const workflow = await orchestrator.submitRequest({
        residentReference: retryResident,
        requestText: 'I need 2 kg maida.',
        location: {
          address: '100 Feet Road, Indiranagar, Bengaluru',
          latitude: 12.9716,
          longitude: 77.5946,
          city: 'Bengaluru',
        },
      });
      const finished = await orchestrator.executeWorkflow(workflow.id);
      expect(finished.status).toBe('FAILED');
      expect(finished.failureReason).toMatch(/PAYMENT_FAILED/);
      expect(retrySpy).not.toHaveBeenCalled();

      const commitmentId = finished.entities.commitmentId!;
      const history = defaultExecutionService.getPaymentsForCommitment(commitmentId);
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('FAILED');
      expect(history[0].attempts).toHaveLength(1);
    } finally {
      retrySpy.mockRestore();
      defaultMockProvider.clearOverrides();
    }
  }, 120000);

  it('5. Recovery re-execution returns the cached payment (no second provider call)', async () => {
    mockProvider.simulateTimeout(singlePO.id);
    const captureSpy = vi.spyOn(mockProvider, 'authorizeAndCapture');
    try {
      const first = await paymentService.payCommitment({
        ownerReference: communityMandate.ownerReference,
        commitmentId: singleCommitment.id,
        mandateId: communityMandate.id,
      });
      expect(first.payments[0].status).toBe('FAILED');
      expect(captureSpy).toHaveBeenCalledTimes(1);

      // Simulate a recovery re-run of the PAY stage: same IDs, no new charge.
      const second = await paymentService.payCommitment({
        ownerReference: communityMandate.ownerReference,
        commitmentId: singleCommitment.id,
        mandateId: communityMandate.id,
      });
      expect(second.payments[0].id).toBe(first.payments[0].id);
      expect(second.payments[0].status).toBe('FAILED');
      expect(captureSpy).toHaveBeenCalledTimes(1);
      expect(executionService.getPaymentsForCommitment(singleCommitment.id)).toHaveLength(1);
    } finally {
      captureSpy.mockRestore();
    }
  });

  it('6. Concurrent payCommitment calls coalesce onto one provider charge', async () => {
    const captureSpy = vi.spyOn(mockProvider, 'authorizeAndCapture');
    try {
      const input = {
        ownerReference: communityMandate.ownerReference,
        commitmentId: singleCommitment.id,
        mandateId: communityMandate.id,
      };
      const [first, second] = await Promise.all([
        paymentService.payCommitment(input),
        paymentService.payCommitment(input),
      ]);
      expect(first.payments[0].id).toBe(second.payments[0].id);
      expect(first.payments[0].status).toBe('SUCCEEDED');
      expect(captureSpy).toHaveBeenCalledTimes(1);
      expect(executionService.getPaymentsForCommitment(singleCommitment.id)).toHaveLength(1);
      const mandate = mandateService.getMandate(communityMandate.id)!;
      expect(mandate.reservedAmount).toBe(0);
      expect(mandate.spentAmount).toBe(singlePO.total);
    } finally {
      captureSpy.mockRestore();
    }
  });

  it('7. Sequential payCommitment after failure reuses the payment without a new reservation', async () => {
    mockProvider.simulateTimeout(singlePO.id);
    const input = {
      ownerReference: communityMandate.ownerReference,
      commitmentId: singleCommitment.id,
      mandateId: communityMandate.id,
    };
    const first = await paymentService.payCommitment(input);
    expect(first.payments[0].status).toBe('FAILED');
    const authCount = defaultAuthService.listAuthorizations().length;

    const second = await paymentService.payCommitment(input);
    expect(second.payments[0].id).toBe(first.payments[0].id);
    expect(defaultAuthService.listAuthorizations()).toHaveLength(authCount);
    const mandate = mandateService.getMandate(communityMandate.id)!;
    expect(mandate.reservedAmount).toBe(0);
    expect(mandate.spentAmount).toBe(0);
  });

  it('8. Expired authorization cannot execute and releases its reservation', async () => {
    const auth = await defaultAuthService.authorizePayment({
      commitment: singleCommitment,
      purchaseOrder: singlePO,
      mandate: communityMandate,
      amount: singlePO.total,
      currency: 'INR',
      purpose: 'COMMUNITY_PROCUREMENT',
    });
    expect(auth.status).toBe('AUTHORIZED');

    auth.expiresAt = new Date(Date.now() - 1000);
    await expect(
      executionService.executePayment({ authorization: auth, purchaseOrder: singlePO })
    ).rejects.toThrow('AUTHORIZATION_EXPIRED');
    expect(auth.status).toBe('EXPIRED');
    const mandate = mandateService.getMandate(communityMandate.id)!;
    expect(mandate.reservedAmount).toBe(0);
    expect(executionService.getPaymentsForCommitment(singleCommitment.id)).toHaveLength(0);
  });

  it('9. Rejected authorization records cannot advance to execution', async () => {
    await expect(
      defaultAuthService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total + 1, // AMOUNT_MISMATCH → REJECTED record
        currency: 'INR',
        purpose: 'COMMUNITY_PROCUREMENT',
      })
    ).rejects.toThrow();
    const rejected = defaultAuthService.listAuthorizations().find((a) => a.status === 'REJECTED');
    expect(rejected).toBeDefined();

    await expect(
      executionService.executePayment({ authorization: rejected!, purchaseOrder: singlePO })
    ).rejects.toThrow('AUTHORIZATION_NOT_EXECUTABLE');
    expect(executionService.getPaymentsForCommitment(singleCommitment.id)).toHaveLength(0);
  });

  it('11. Hung provider fails closed with PROVIDER_TIMEOUT (uncertain, ack-gated)', async () => {
    const hangingProvider = {
      providerName: 'hang_probe',
      isSimulated: true,
      authorizeAndCapture: () => new Promise<never>(() => {}),
    } as any;
    const shortExec = new PaymentExecutionService(hangingProvider, mandateService, undefined as any, 50);
    const shortPay = new PaymentService(
      defaultCommitmentService,
      defaultPOService,
      mandateService,
      defaultAuthService,
      shortExec
    );

    const { payments } = await shortPay.payCommitment({
      ownerReference: communityMandate.ownerReference,
      commitmentId: singleCommitment.id,
      mandateId: communityMandate.id,
    });
    expect(payments[0].status).toBe('FAILED');
    expect(payments[0].failureCode).toBe('PROVIDER_TIMEOUT');
    const mandate = mandateService.getMandate(communityMandate.id)!;
    expect(mandate.reservedAmount).toBe(0);

    // Uncertain outcome: retry without operator acknowledgement is rejected.
    await expect(shortPay.retryPayment(payments[0].id)).rejects.toThrow(/uncertain outcome/);
  });

  it('12. Provider crash during retry returns the payment to FAILED (never stuck)', async () => {
    mockProvider.simulateFailure(singlePO.id, 'GATEWAY_DECLINED', 'Card declined', true);
    const { payments } = await paymentService.payCommitment({
      ownerReference: communityMandate.ownerReference,
      commitmentId: singleCommitment.id,
      mandateId: communityMandate.id,
    });
    const failed = payments[0];
    expect(failed.status).toBe('FAILED');

    const crashingProvider = {
      providerName: 'crash_probe',
      isSimulated: true,
      authorizeAndCapture: async () => {
        throw new Error('GATEWAY_EXPLODED');
      },
    } as any;
    const retried = await paymentService.retryPayment(failed.id, { provider: crashingProvider });
    expect(retried.payment.status).toBe('FAILED');
    expect(retried.payment.failureCode).toBe('PROVIDER_ERROR');
    const mandate = mandateService.getMandate(communityMandate.id)!;
    expect(mandate.reservedAmount).toBe(0);

    // Retryable again after acknowledgement (uncertain outcome), not stranded.
    mockProvider.clearOverrides();
    const again = await paymentService.retryPayment(failed.id, {
      acknowledgeUncertainOutcome: true,
    });
    expect(again.payment.status).toBe('SUCCEEDED');
  });

  it('10. Concurrent retries of one payment coalesce onto one new attempt', async () => {
    mockProvider.simulateFailure(singlePO.id, 'GATEWAY_DECLINED', 'Card declined', true);
    const { payments } = await paymentService.payCommitment({
      ownerReference: communityMandate.ownerReference,
      commitmentId: singleCommitment.id,
      mandateId: communityMandate.id,
    });
    const failed = payments[0];
    expect(failed.status).toBe('FAILED');

    mockProvider.clearOverrides();
    const captureSpy = vi.spyOn(mockProvider, 'authorizeAndCapture');
    try {
      const [a, b] = await Promise.all([
        paymentService.retryPayment(failed.id),
        paymentService.retryPayment(failed.id),
      ]);
      expect(a.payment.id).toBe(b.payment.id);
      expect(a.payment.status).toBe('SUCCEEDED');
      expect(a.payment.attempts).toHaveLength(2);
      expect(captureSpy).toHaveBeenCalledTimes(1);
    } finally {
      captureSpy.mockRestore();
    }
  });
});
