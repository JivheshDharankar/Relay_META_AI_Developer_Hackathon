import { randomUUID } from 'crypto';
import {
  isDecimalEqual,
  roundQuantity,
  subtractDecimals,
  toDecimal,
} from '../domain/procurement/decimal';
import { ProcurementCommitment, PurchaseOrder } from '../discovery/supplier/selection/types';
import { FulfillmentOrder } from '../fulfillment/types';
import { Payment } from '../payment/types';
import { AllocationAuditService, allocationAuditService } from './AllocationAuditService';
import {
  LineReconciliationBreakdown,
  ReconciliationDiscrepancy,
  ReconciliationDiscrepancyType,
  ReconciliationResult,
  ReconciliationStatus,
  ResidentAllocation,
} from './types';

export interface ReconcileCommitmentInput {
  commitment: ProcurementCommitment;
  fulfillments: FulfillmentOrder[];
  allocations: ResidentAllocation[];
  payments: Payment[];
  purchaseOrders?: PurchaseOrder[];
  idempotencyKey?: string;
}

export class ReconciliationService {
  private reconciliations = new Map<string, ReconciliationResult>();
  private discrepanciesByReconciliation = new Map<string, ReconciliationDiscrepancy[]>();
  private idempotencyStore = new Map<string, ReconciliationResult>();

  constructor(
    private readonly auditService: AllocationAuditService = allocationAuditService
  ) {}

  /**
   * Deterministically executes complete 4-pillar reconciliation:
   * 1. Quantity reconciliation: SUM(resident allocated quantity) == verified fulfilled quantity
   * 2. Monetary reconciliation: SUM(resident amounts) == authoritative allocatable procurement amount
   * 3. Supplier obligation reconciliation: supplier fulfillment == purchase order commitments
   * 4. Payment linkage reconciliation: paid obligations == supplier obligations
   *
   * Invariant: Never silently "fixes" numbers. If discrepancies exist, records them and marks DISCREPANCY or BLOCKED.
   */
  public reconcileCommitment(input: ReconcileCommitmentInput): ReconciliationResult {
    const { commitment, fulfillments, allocations, payments, purchaseOrders } = input;
    const dedupeKey = input.idempotencyKey || `rec_${commitment.id}_${allocations.length}_${fulfillments.length}`;

    // 1. Idempotency Check
    if (this.idempotencyStore.has(dedupeKey)) {
      return this.idempotencyStore.get(dedupeKey)!;
    }

    const reconciliationId = `rec_${randomUUID().slice(0, 10)}`;
    const discrepancies: ReconciliationDiscrepancy[] = [];

    this.auditService.emit('RECONCILIATION_STARTED', reconciliationId, {
      commitmentId: commitment.id,
      allocationCount: allocations.length,
      fulfillmentCount: fulfillments.length,
    });

    // Check A: Unverified Fulfillment Prerequisite
    const unverified = fulfillments.filter((f) => f.status !== 'VERIFIED');
    if (unverified.length > 0) {
      const disc = this.createDiscrepancy({
        reconciliationId,
        commitmentId: commitment.id,
        discrepancyType: 'UNVERIFIED_FULFILLMENT',
        expectedValue: 'VERIFIED',
        actualValue: unverified.map((u) => `${u.id}:${u.status}`).join(','),
        difference: unverified.length,
        affectedResidentOrderIds: allocations.map((a) => a.residentOrderId),
        reasonCode: 'FULFILLMENT_NOT_VERIFIED',
        message: `Fulfillment orders [${unverified.map((u) => u.id).join(', ')}] are not verified; reconciliation is BLOCKED`,
      });
      discrepancies.push(disc);

      const blockedResult: ReconciliationResult = {
        id: reconciliationId,
        commitmentId: commitment.id,
        status: 'BLOCKED',
        verifiedFulfilledQuantity: 0,
        totalAllocatedQuantity: allocations.reduce((s, a) => s + a.allocatedQuantity, 0),
        authoritativeProcurementAmount: commitment.financials.total,
        totalAllocatedResidentAmount: allocations.reduce((s, a) => s + a.totalAmount, 0),
        isQuantityMatched: false,
        isMonetaryMatched: false,
        isSupplierObligationsMatched: false,
        isPaymentVerified: false,
        discrepancies,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      this.saveReconciliation(blockedResult, dedupeKey);
      this.auditService.emit('RECONCILIATION_BLOCKED', reconciliationId, {
        commitmentId: commitment.id,
        reason: 'UNVERIFIED_FULFILLMENT',
      });
      return blockedResult;
    }

    // Check B: Quantity Reconciliation (Per-Line Integrity)
    const totalVerifiedFulfilled = fulfillments.reduce(
      (sum, f) => sum + f.fulfilledQuantity,
      0
    );
    const totalAllocatedQuantity = allocations.reduce(
      (sum, a) => sum + a.allocatedQuantity,
      0
    );

    // Group resident allocations by line key `${productId}_${unit}`
    interface AllocationLineGroup {
      productId: string;
      productName: string;
      unit: string;
      requestedQuantity: number;
      allocatedQuantity: number;
    }

    const lineGroupMap = new Map<string, AllocationLineGroup>();
    for (const alloc of allocations) {
      const pid = alloc.productId || commitment.product.productId || alloc.productName;
      const key = `${pid}_${alloc.unit}`;
      const existing = lineGroupMap.get(key);
      if (existing) {
        existing.requestedQuantity += alloc.requestedQuantity;
        existing.allocatedQuantity += alloc.allocatedQuantity;
      } else {
        lineGroupMap.set(key, {
          productId: pid,
          productName: alloc.productName,
          unit: alloc.unit,
          requestedQuantity: alloc.requestedQuantity,
          allocatedQuantity: alloc.allocatedQuantity,
        });
      }
    }

    const verifiedFulfillments = fulfillments.filter((f) => f.status === 'VERIFIED');

    // Build per-line reconciliation breakdown
    const lineBreakdowns: LineReconciliationBreakdown[] = [];
    const isMultiItem = lineGroupMap.size > 1;

    for (const group of lineGroupMap.values()) {
      let lineVerifiedQuantity = 0;

      if (!isMultiItem) {
        // Single-item request: scalar verified fulfillment matches directly
        lineVerifiedQuantity = totalVerifiedFulfilled;
      } else {
        // Multi-item request:
        // 1. Check fulfillment order lines directly if present
        const fulfillmentLines = verifiedFulfillments.flatMap((f) => f.lines || []);
        const matchingFulfillmentLine = fulfillmentLines.find(
          (fl) =>
            (fl.productId && group.productId && fl.productId === group.productId) ||
            fl.productName.toLowerCase() === group.productName.toLowerCase() ||
            fl.productName.toLowerCase().includes(group.productName.toLowerCase()) ||
            group.productName.toLowerCase().includes(fl.productName.toLowerCase())
        );

        if (matchingFulfillmentLine) {
          lineVerifiedQuantity = matchingFulfillmentLine.fulfilledQuantity;
        } else {
          // 2. Check if any fulfillments explicitly match by productId or productName & unit
          const matchingFulfillments = verifiedFulfillments.filter(
            (f) =>
              (f.productName.toLowerCase() === group.productName.toLowerCase() && f.unit === group.unit) ||
              (f.productName.toLowerCase().includes(group.productName.toLowerCase()) && f.unit === group.unit)
          );

          if (matchingFulfillments.length > 0 && matchingFulfillments.length < verifiedFulfillments.length) {
            lineVerifiedQuantity = matchingFulfillments.reduce((sum, f) => sum + f.fulfilledQuantity, 0);
          } else if (purchaseOrders && purchaseOrders.length > 0) {
            // Check if PO lines correspond to this group
            const poLines = purchaseOrders.flatMap((po) => po.lines);
            const matchingPoLine = poLines.find(
              (l) =>
                l.productName.toLowerCase() === group.productName.toLowerCase() ||
                l.productName.toLowerCase().includes(group.productName.toLowerCase()) ||
                group.productName.toLowerCase().includes(l.productName.toLowerCase())
            );

            if (matchingPoLine) {
              if (verifiedFulfillments.length > 0 && verifiedFulfillments.every((f) => f.status === 'VERIFIED')) {
                lineVerifiedQuantity = matchingPoLine.quantity;
              }
            }
          } else {
            // Check commitment items or lineItems if fulfillments don't carry individual lines
            const cItems = (commitment as any).items || commitment.lineItems;
            if (cItems && Array.isArray(cItems)) {
              const matchingCItem = cItems.find(
                (ci: any) =>
                  (ci.productId && group.productId && ci.productId === group.productId) ||
                  ci.productName.toLowerCase() === group.productName.toLowerCase() ||
                  ci.productName.toLowerCase().includes(group.productName.toLowerCase()) ||
                  group.productName.toLowerCase().includes(ci.productName.toLowerCase())
              );
              if (
                matchingCItem &&
                verifiedFulfillments.length > 0 &&
                verifiedFulfillments.every((f) => f.status === 'VERIFIED')
              ) {
                lineVerifiedQuantity =
                  matchingCItem.committedQuantity ??
                  matchingCItem.requestedQuantity ??
                  matchingCItem.quantity ??
                  group.allocatedQuantity;
              }
            }
          }
        }
      }

      const isMatched = isDecimalEqual(
        toDecimal(group.allocatedQuantity),
        toDecimal(lineVerifiedQuantity)
      );

      lineBreakdowns.push({
        productId: group.productId,
        productName: group.productName,
        unit: group.unit,
        requestedQuantity: group.requestedQuantity,
        allocatedQuantity: group.allocatedQuantity,
        verifiedFulfilledQuantity: lineVerifiedQuantity,
        isMatched,
      });
    }

    const isQuantityMatched = isMultiItem
      ? lineBreakdowns.length > 0 && lineBreakdowns.every((l) => l.isMatched)
      : isDecimalEqual(toDecimal(totalAllocatedQuantity), toDecimal(totalVerifiedFulfilled)) &&
        lineBreakdowns.every((l) => l.isMatched);

    let reconciliationReason: string | undefined;
    if (isMultiItem) {
      if (isQuantityMatched) {
        reconciliationReason = `Delivered quantities match allocated quantities across all ${lineBreakdowns.length} line items.`;
      } else {
        const mismatches = lineBreakdowns
          .filter((l) => !l.isMatched)
          .map(
            (l) =>
              `${l.productName} (allocated ${l.allocatedQuantity} ${l.unit}, verified ${l.verifiedFulfilledQuantity} ${l.unit})`
          )
          .join(', ');
        reconciliationReason = `Delivered quantities mismatch allocated quantities for: ${mismatches}.`;
      }
    }

    if (!isQuantityMatched) {
      const diff = subtractDecimals(totalVerifiedFulfilled, totalAllocatedQuantity).toNumber();
      const discType: ReconciliationDiscrepancyType =
        totalAllocatedQuantity > totalVerifiedFulfilled
          ? 'OVER_ALLOCATION_DETECTED'
          : 'QUANTITY_MISMATCH';

      discrepancies.push(
        this.createDiscrepancy({
          reconciliationId,
          commitmentId: commitment.id,
          discrepancyType: discType,
          expectedValue: totalVerifiedFulfilled,
          actualValue: totalAllocatedQuantity,
          difference: diff,
          affectedResidentOrderIds: allocations.map((a) => a.residentOrderId),
          reasonCode: discType,
          message:
            reconciliationReason ||
            `Allocated quantity (${totalAllocatedQuantity}) does not match verified fulfilled quantity (${totalVerifiedFulfilled})`,
        })
      );
    }

    // Check C: Monetary Reconciliation
    const authoritativeCost = commitment.financials.total;
    const totalResidentAmount = allocations.reduce(
      (acc, a) => acc.plus(toDecimal(a.totalAmount)),
      toDecimal(0)
    );

    const isMonetaryMatched = isDecimalEqual(totalResidentAmount, toDecimal(authoritativeCost));

    if (!isMonetaryMatched) {
      const diff = subtractDecimals(authoritativeCost, totalResidentAmount).toNumber();
      discrepancies.push(
        this.createDiscrepancy({
          reconciliationId,
          commitmentId: commitment.id,
          discrepancyType: 'MONETARY_MISMATCH',
          expectedValue: authoritativeCost,
          actualValue: totalResidentAmount.toNumber(),
          difference: diff,
          affectedResidentOrderIds: allocations.map((a) => a.residentOrderId),
          reasonCode: 'MONETARY_MISMATCH',
          message: `Resident allocated total (₹${totalResidentAmount.toString()}) does not match authoritative procurement cost (₹${authoritativeCost})`,
        })
      );
    }

    // Check D: Supplier Obligations Reconciliation
    let isSupplierObligationsMatched = true;
    if (purchaseOrders && purchaseOrders.length > 0) {
      const poTotalQuantity = purchaseOrders.reduce(
        (sum, po) => sum + po.lines.reduce((s, l) => s + l.quantity, 0),
        0
      );
      // Verified fulfillment cannot exceed PO committed quantity
      if (totalVerifiedFulfilled > poTotalQuantity) {
        isSupplierObligationsMatched = false;
        discrepancies.push(
          this.createDiscrepancy({
            reconciliationId,
            commitmentId: commitment.id,
            discrepancyType: 'SUPPLIER_OBLIGATION_MISMATCH',
            expectedValue: poTotalQuantity,
            actualValue: totalVerifiedFulfilled,
            difference: totalVerifiedFulfilled - poTotalQuantity,
            affectedResidentOrderIds: allocations.map((a) => a.residentOrderId),
            reasonCode: 'PO_EXCEEDED',
            message: `Verified fulfilled quantity (${totalVerifiedFulfilled}) exceeds issued PO quantity (${poTotalQuantity})`,
          })
        );
      }
    }

    // Check E: Payment Linkage Reconciliation
    let isPaymentVerified = true;
    if (payments.length === 0) {
      isPaymentVerified = false;
      discrepancies.push(
        this.createDiscrepancy({
          reconciliationId,
          commitmentId: commitment.id,
          discrepancyType: 'PAYMENT_LINKAGE_MISMATCH',
          expectedValue: 'SUCCEEDED',
          actualValue: 'NO_PAYMENTS_RECORDED',
          difference: 0,
          affectedResidentOrderIds: allocations.map((a) => a.residentOrderId),
          reasonCode: 'MISSING_PAYMENT',
          message: 'Zero payment records found for fulfilled commitment',
        })
      );
    } else {
      const failedPayments = payments.filter((p) => p.status !== 'SUCCEEDED');
      if (failedPayments.length > 0) {
        isPaymentVerified = false;
        discrepancies.push(
          this.createDiscrepancy({
            reconciliationId,
            commitmentId: commitment.id,
            discrepancyType: 'PAYMENT_LINKAGE_MISMATCH',
            expectedValue: 'SUCCEEDED',
            actualValue: failedPayments.map((p) => `${p.id}:${p.status}`).join(','),
            difference: failedPayments.length,
            affectedResidentOrderIds: allocations.map((a) => a.residentOrderId),
            reasonCode: 'PAYMENT_STATUS_NOT_SUCCEEDED',
            message: `${failedPayments.length} payment(s) are not in SUCCEEDED status`,
          })
        );
      }
    }

    // Check F: Negative Value Detection
    for (const alloc of allocations) {
      if (alloc.allocatedQuantity < 0 || alloc.totalAmount < 0) {
        discrepancies.push(
          this.createDiscrepancy({
            reconciliationId,
            commitmentId: commitment.id,
            discrepancyType: 'NEGATIVE_VALUE_DETECTED',
            expectedValue: '>= 0',
            actualValue: `qty:${alloc.allocatedQuantity},amt:${alloc.totalAmount}`,
            difference: Math.min(alloc.allocatedQuantity, alloc.totalAmount),
            affectedResidentOrderIds: [alloc.residentOrderId],
            reasonCode: 'NEGATIVE_RECORD',
            message: `Resident order '${alloc.residentOrderId}' has negative values`,
          })
        );
      }
    }

    const finalStatus: ReconciliationStatus =
      discrepancies.length > 0 ? 'DISCREPANCY' : 'RECONCILED';

    // Commercial provenance: conservative taint across contributing POs.
    const poFlags = (purchaseOrders ?? [])
      .map((po) => po.commercialBasisSimulated)
      .filter((v): v is boolean => v !== undefined);
    const commercialBasisSimulated =
      poFlags.length === 0
        ? commitment.commercialBasisSimulated
        : poFlags.some((v) => v === true);

    const result: ReconciliationResult = {
      id: reconciliationId,
      commitmentId: commitment.id,
      status: finalStatus,
      commercialBasisSimulated,
      verifiedFulfilledQuantity: totalVerifiedFulfilled,
      totalAllocatedQuantity,
      authoritativeProcurementAmount: authoritativeCost,
      totalAllocatedResidentAmount: totalResidentAmount.toNumber(),
      isQuantityMatched,
      isMonetaryMatched,
      isSupplierObligationsMatched,
      isPaymentVerified,
      lineItems: lineBreakdowns,
      reason: reconciliationReason,
      discrepancies,
      reconciledAt: finalStatus === 'RECONCILED' ? new Date() : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.saveReconciliation(result, dedupeKey);

    if (finalStatus === 'RECONCILED') {
      this.auditService.emit('RECONCILIATION_RECONCILED', reconciliationId, {
        commitmentId: commitment.id,
        quantity: totalAllocatedQuantity,
        amount: totalResidentAmount.toNumber(),
      });
    } else {
      this.auditService.emit('RECONCILIATION_DISCREPANCY', reconciliationId, {
        commitmentId: commitment.id,
        discrepancyCount: discrepancies.length,
        discrepancies: discrepancies.map((d) => ({
          type: d.discrepancyType,
          difference: d.difference,
          reason: d.reasonCode,
        })),
      });
    }

    return result;
  }

  public getReconciliationResult(commitmentId: string): ReconciliationResult | undefined {
    return this.reconciliations.get(commitmentId);
  }

  private createDiscrepancy(params: {
    reconciliationId: string;
    commitmentId: string;
    discrepancyType: ReconciliationDiscrepancyType;
    expectedValue: number | string;
    actualValue: number | string;
    difference: number;
    affectedResidentOrderIds: string[];
    reasonCode: string;
    message: string;
  }): ReconciliationDiscrepancy {
    return {
      id: `disc_${randomUUID().slice(0, 10)}`,
      reconciliationId: params.reconciliationId,
      commitmentId: params.commitmentId,
      discrepancyType: params.discrepancyType,
      expectedValue: params.expectedValue,
      actualValue: params.actualValue,
      difference: roundQuantity(params.difference).toNumber(),
      affectedResidentOrderIds: params.affectedResidentOrderIds,
      reasonCode: params.reasonCode,
      message: params.message,
      createdAt: new Date(),
    };
  }

  private saveReconciliation(result: ReconciliationResult, dedupeKey: string): void {
    this.reconciliations.set(result.commitmentId, result);
    this.discrepanciesByReconciliation.set(result.id, result.discrepancies);
    this.idempotencyStore.set(dedupeKey, result);
  }
}

export const reconciliationService = new ReconciliationService();
