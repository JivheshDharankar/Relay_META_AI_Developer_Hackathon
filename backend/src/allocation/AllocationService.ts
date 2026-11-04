import { randomUUID } from 'crypto';
import { roundMoney } from '../domain/procurement/decimal';
import { ProcurementCommitment, PurchaseOrder } from '../discovery/supplier/selection/types';
import { FulfillmentOrder } from '../fulfillment/types';
import { Payment } from '../payment/types';
import { AllocationAuditService, allocationAuditService } from './AllocationAuditService';
import { AllocationEngine, allocationEngine, QuantityAllocationResultItem } from './AllocationEngine';
import { CostAllocationService, costAllocationService, LineCostInput } from './CostAllocationService';
import { attachDemandLineIds } from './demandLineKey';
import { ReconciliationService, reconciliationService } from './ReconciliationService';
import { ResidentLedgerService, residentLedgerService } from './ResidentLedgerService';
import { assertLegalAllocationTransition } from './stateMachine';
import {
  AllocationExplanation,
  ReconciliationResult,
  ResidentAllocation,
  ResidentAllocationSummary,
  ResidentDemand,
  ResidentLedgerEntry,
} from './types';
import {
  AllocationValidationError,
  validateFulfillmentEntryCondition,
  validateMonetaryConservation,
  validateNonNegativity,
  validateQuantityConservation,
  validateResidentAuthorization,
} from './validation';

export interface PrepareAllocationInput {
  commitment: ProcurementCommitment;
  fulfillments: FulfillmentOrder[];
  residentDemands: ResidentDemand[];
  allowFractions?: boolean;
  idempotencyKey?: string;
  purchaseOrder?: PurchaseOrder;
}

/**
 * Identifies whether a product ID represents a genuine catalog identifier.
 * Placeholder values such as 'prod_dynamic', empty strings, or open-world prefixes
 * are not genuine catalog IDs and must not be used to group heterogeneous products.
 */
export function isCatalogProductId(productId?: string | null): boolean {
  if (!productId || typeof productId !== 'string') return false;
  const trimmed = productId.trim();
  if (
    trimmed === '' ||
    trimmed === 'prod_dynamic' ||
    trimmed.startsWith('open_world_') ||
    trimmed.toLowerCase() === 'null' ||
    trimmed.toLowerCase() === 'undefined'
  ) {
    return false;
  }
  return true;
}

/**
 * Returns a stable grouping key for product demand consolidation.
 * Catalog products group by their real catalog product ID.
 * Open-world products group strictly by their normalized (trimmed, lowercased, single-spaced) product name.
 */
export function getProductGroupingKey(productId?: string | null, productName?: string | null): string {
  if (isCatalogProductId(productId)) {
    return `catalog::${productId!.trim().toLowerCase()}`;
  }
  const normName = (productName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normName) {
    throw new AllocationValidationError([
      'PRODUCT_IDENTITY_MISSING: Demand item has neither a catalog productId nor a productName',
    ]);
  }
  return `open_world::${normName}`;
}

export interface FinalizeAllocationInput {
  commitmentId: string;
  payments: Payment[];
  purchaseOrders?: PurchaseOrder[];
}

export class AllocationService {
  private summaries = new Map<string, ResidentAllocationSummary>();
  private allocations = new Map<string, ResidentAllocation>();
  private allocationsByCommitment = new Map<string, ResidentAllocation[]>();
  private allocationsByResident = new Map<string, ResidentAllocation[]>();
  private allocationsByOrder = new Map<string, ResidentAllocation>();
  private fulfillmentsByCommitment = new Map<string, FulfillmentOrder[]>();
  private commitments = new Map<string, ProcurementCommitment>();
  private idempotencyStore = new Map<string, ResidentAllocationSummary>();
  private mutexes = new Map<string, Promise<void>>();

  constructor(
    private readonly engine: AllocationEngine = allocationEngine,
    private readonly costService: CostAllocationService = costAllocationService,
    private readonly ledgerService: ResidentLedgerService = residentLedgerService,
    private readonly reconService: ReconciliationService = reconciliationService,
    private readonly auditService: AllocationAuditService = allocationAuditService
  ) {}

  /**
   * Prepares and calculates initial resident allocations from verified fulfillment.
   * Status: CALCULATED.
   */
  public prepareAllocation(input: PrepareAllocationInput): ResidentAllocationSummary {
    const { commitment, fulfillments, residentDemands: inputDemands, allowFractions = false } = input;
    const dedupeKey = input.idempotencyKey || `alloc_summary_${commitment.id}_${fulfillments.length}`;

    // 1. Idempotency Check
    if (this.idempotencyStore.has(dedupeKey)) {
      return this.idempotencyStore.get(dedupeKey)!;
    }

    // 2. Entry Condition: All fulfillments must be VERIFIED
    validateFulfillmentEntryCondition(fulfillments);

    this.auditService.emit('ALLOCATION_STARTED', commitment.id, {
      commitmentId: commitment.id,
      fulfilledOrderCount: fulfillments.length,
      residentDemandCount: inputDemands.length,
    });

    // Resolve stable per-line demand keys so shared-order lines join
    // deterministically below instead of collapsing onto the first demand.
    const residentDemands = attachDemandLineIds(inputDemands);

    const totalVerifiedFulfilled = fulfillments.reduce(
      (sum, f) => sum + f.fulfilledQuantity,
      0
    );

    const fulfillmentLines = fulfillments.flatMap((f) => f.lines || []);
    let quantityResults: QuantityAllocationResultItem[];

    if (fulfillmentLines.length > 0 && residentDemands.length > 1) {
      quantityResults = [];
      const demandsByProduct = new Map<string, ResidentDemand[]>();
      for (const d of residentDemands) {
        const key = getProductGroupingKey(d.productId, d.productName);
        const list = demandsByProduct.get(key) || [];
        list.push(d);
        demandsByProduct.set(key, list);
      }

      // Track matched fulfillment lines to prevent cross-product allocation or double-claiming
      const matchedFulfillmentIndices = new Set<number>();

      for (const groupDemands of demandsByProduct.values()) {
        const sample = groupDemands[0];
        const normSample = sample.productName.trim().toLowerCase().replace(/\s+/g, ' ');
        const isCatalog = isCatalogProductId(sample.productId);
        const matchingIndices: number[] = [];

        // 1. Exact catalog match if catalog product
        if (isCatalog) {
          fulfillmentLines.forEach((fl, idx) => {
            if (isCatalogProductId(fl.productId) && fl.productId!.trim().toLowerCase() === sample.productId!.trim().toLowerCase()) {
              matchingIndices.push(idx);
            }
          });
        }

        // 2. Exact normalized name match
        if (matchingIndices.length === 0) {
          fulfillmentLines.forEach((fl, idx) => {
            const normFl = (fl.productName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
            if (normFl === normSample) {
              matchingIndices.push(idx);
            }
          });
        }

        // 3. Fallback: fuzzy/contains name match only if unambiguous and no exact match
        if (matchingIndices.length === 0) {
          fulfillmentLines.forEach((fl, idx) => {
            const normFl = (fl.productName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
            if (normFl.length > 0 && (normFl.includes(normSample) || normSample.includes(normFl))) {
              matchingIndices.push(idx);
            }
          });
        }

        if (matchingIndices.length === 0) {
          throw new AllocationValidationError([
            `UNMATCHED_FULFILLMENT_LINE: No fulfillment line matched product "${sample.productName}"`,
          ]);
        }

        if (matchingIndices.length > 1) {
          throw new AllocationValidationError([
            `AMBIGUOUS_FULFILLMENT_LINE: Multiple fulfillment lines (${matchingIndices.length}) matched product "${sample.productName}"`,
          ]);
        }

        const matchIdx = matchingIndices[0];
        if (matchedFulfillmentIndices.has(matchIdx)) {
          throw new AllocationValidationError([
            `DUPLICATE_FULFILLMENT_MATCH: Fulfillment line for "${fulfillmentLines[matchIdx].productName}" was claimed by multiple product groups`,
          ]);
        }
        matchedFulfillmentIndices.add(matchIdx);

        const matchingFLine = fulfillmentLines[matchIdx];
        const verifiedQty = matchingFLine.fulfilledQuantity;
        const res = this.engine.allocateQuantities({
          residentDemands: groupDemands,
          verifiedFulfilledQuantity: verifiedQty,
          allowFractions,
        });
        quantityResults.push(...res);
      }

      // Ensure no fulfillment lines were left unallocated
      if (matchedFulfillmentIndices.size < fulfillmentLines.length) {
        const unallocated = fulfillmentLines
          .filter((_, idx) => !matchedFulfillmentIndices.has(idx))
          .map((fl) => fl.productName);
        throw new AllocationValidationError([
          `UNALLOCATED_FULFILLMENT_LINES: The following fulfillment lines were not matched to any resident demand: ${unallocated.join(', ')}`,
        ]);
      }
    } else {
      // 3. Deterministic Quantity Allocation (Whole-Unit Hamilton-Hare or Fractional)
      quantityResults = this.engine.allocateQuantities({
        residentDemands,
        verifiedFulfilledQuantity: totalVerifiedFulfilled,
        allowFractions,
      });
    }

    // Extract line costs from commitment items or purchase order lines
    const lineCosts: LineCostInput[] = [];
    if (commitment.items && commitment.items.length > 0) {
      residentDemands.forEach((demand) => {
        const matchedItem =
          commitment.items?.find((item) => {
            if (isCatalogProductId(item.productId) && isCatalogProductId(demand.productId)) {
              return item.productId!.trim().toLowerCase() === demand.productId!.trim().toLowerCase();
            }
            const normItem = (item.productName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
            const normD = demand.productName.trim().toLowerCase().replace(/\s+/g, ' ');
            return normItem === normD || normItem.includes(normD) || normD.includes(normItem);
          });

        if (matchedItem) {
          const unitPrice = matchedItem.unitPrice ?? 0;
          const subtotal = roundMoney(unitPrice * demand.requestedQuantity).toNumber();
          lineCosts.push({
            demandLineId: demand.demandLineId,
            residentOrderId: demand.residentOrderId,
            productId: isCatalogProductId(matchedItem.productId) ? matchedItem.productId! : undefined,
            productName: demand.productName,
            unitPrice,
            subtotal,
            unit: demand.unit,
          });
        }
      });
    } else if (input.purchaseOrder?.lines && input.purchaseOrder.lines.length > 0) {
      residentDemands.forEach((demand) => {
        const matchedLine =
          input.purchaseOrder?.lines.find((line) => {
            if (isCatalogProductId(line.productId) && isCatalogProductId(demand.productId)) {
              return line.productId!.trim().toLowerCase() === demand.productId!.trim().toLowerCase();
            }
            const normLine = (line.productName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
            const normD = demand.productName.trim().toLowerCase().replace(/\s+/g, ' ');
            return normLine === normD || normLine.includes(normD) || normD.includes(normLine);
          });

        if (matchedLine) {
          const unitPrice = matchedLine.unitPrice;
          const subtotal = roundMoney(unitPrice * demand.requestedQuantity).toNumber();
          lineCosts.push({
            demandLineId: demand.demandLineId,
            residentOrderId: demand.residentOrderId,
            productId: isCatalogProductId(matchedLine.productId) ? matchedLine.productId! : undefined,
            productName: demand.productName,
            unitPrice,
            subtotal,
            unit: demand.unit,
          });
        }
      });
    }

    // 4. Deterministic Cost Allocation with exact Paise Rounding Reconciliation
    const costResults = this.costService.allocateCosts(quantityResults, {
      unitPrice:
        fulfillments.length > 0 && fulfillments[0].requestedQuantity > 0
          ? roundMoney(commitment.financials.subtotal / totalVerifiedFulfilled).toNumber()
          : undefined,
      subtotal: commitment.financials.subtotal,
      tax: commitment.financials.tax,
      deliveryFee: commitment.financials.deliveryFee,
      otherCharges: commitment.financials.otherCharges,
      total: commitment.financials.total,
      currency: commitment.financials.currency || 'INR',
      lineCosts: lineCosts.length > 0 ? lineCosts : undefined,
    });

    // Contributing supplier IDs for multi-supplier traceability (zero competitor price leakage)
    const contributingSupplierIds = Array.from(new Set(fulfillments.map((f) => f.supplierId)));

    const now = new Date();
    const demandByLineId = new Map<string, ResidentDemand>(
      residentDemands.map((d) => [d.demandLineId ?? d.residentOrderId, d])
    );
    const residentAllocations: ResidentAllocation[] = costResults.map((cost) => {
      const demandLineId = cost.demandLineId ?? cost.residentOrderId;
      const demand =
        demandByLineId.get(demandLineId) ??
        residentDemands.find((d) => d.residentOrderId === cost.residentOrderId)!;
      const allocId = `alloc_${randomUUID().slice(0, 10)}`;
      return {
        id: allocId,
        commitmentId: commitment.id,
        purchaseOrderId: fulfillments[0]?.purchaseOrderId,
        fulfillmentOrderId: fulfillments[0]?.id,
        residentOrderId: cost.residentOrderId,
        demandLineId,
        residentReference: cost.residentReference,
        productId: demand.productId,
        productName: demand.productName,
        requestedQuantity: cost.requestedQuantity,
        allocatedQuantity: cost.allocatedQuantity,
        unit: demand.unit,
        unitPrice: cost.unitPrice,
        subtotal: cost.subtotal,
        allocatedTax: cost.allocatedTax,
        allocatedDeliveryFee: cost.allocatedDeliveryFee,
        allocatedOtherCharges: cost.allocatedOtherCharges,
        totalAmount: cost.totalAmount,
        allocationStatus: 'CALCULATED',
        reconciliationStatus: 'PENDING',
        idempotencyKey: `${commitment.id}_${demandLineId}_v1`,
        contributingSupplierIds,
        createdAt: now,
        updatedAt: now,
      };
    });

    const totalRequested = residentDemands.reduce((sum, d) => sum + d.requestedQuantity, 0);
    const totalAllocated = residentAllocations.reduce((sum, a) => sum + a.allocatedQuantity, 0);
    const totalResidentAmount = residentAllocations.reduce(
      (sum, a) => sum + a.totalAmount,
      0
    );

    const summary: ResidentAllocationSummary = {
      commitmentId: commitment.id,
      totalRequestedQuantity: totalRequested,
      totalAllocatedQuantity: totalAllocated,
      totalProcurementCost: commitment.financials.total,
      totalResidentAllocatedAmount: roundMoney(totalResidentAmount).toNumber(),
      residentCount: residentAllocations.length,
      status: 'CALCULATED',
      reconciliationStatus: 'PENDING',
      allocations: residentAllocations,
      calculatedAt: now,
      commercialBasisSimulated: commitment.commercialBasisSimulated,
    };

    // Store state
    this.summaries.set(commitment.id, summary);
    this.fulfillmentsByCommitment.set(commitment.id, fulfillments);
    this.commitments.set(commitment.id, commitment);
    this.allocationsByCommitment.set(commitment.id, residentAllocations);

    for (const alloc of residentAllocations) {
      this.allocations.set(alloc.id, alloc);
      this.allocationsByOrder.set(alloc.residentOrderId, alloc);

      const resList = this.allocationsByResident.get(alloc.residentReference) || [];
      resList.push(alloc);
      this.allocationsByResident.set(alloc.residentReference, resList);
    }

    this.idempotencyStore.set(dedupeKey, summary);

    this.auditService.emit('ALLOCATION_CALCULATED', commitment.id, {
      commitmentId: commitment.id,
      allocatedQuantity: totalAllocated,
      totalAmount: summary.totalResidentAllocatedAmount,
    });

    return summary;
  }

  /**
   * Validates calculated allocations against quantity conservation and monetary integrity.
   * Status: VALIDATED.
   */
  public validateAllocation(commitmentId: string): ResidentAllocationSummary {
    const summary = this.summaries.get(commitmentId);
    if (!summary) {
      throw new AllocationValidationError([
        `ALLOCATION_NOT_FOUND: No allocation calculated for commitment '${commitmentId}'`,
      ]);
    }

    assertLegalAllocationTransition(summary.status, 'VALIDATED');

    const fulfillments = this.fulfillmentsByCommitment.get(commitmentId) || [];
    const fulfillmentLines = fulfillments.flatMap((f) => f.lines || []);

    if (fulfillmentLines.length > 0 && summary.allocations.length > 1) {
      // Validate per-line quantity conservation using safe product identity
      const matchedAllocationIds = new Set<string>();

      for (const fLine of fulfillmentLines) {
        const normF = (fLine.productName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
        const isCatalog = isCatalogProductId(fLine.productId);

        let matchingAllocations = summary.allocations.filter((a) => {
          if (isCatalog && isCatalogProductId(a.productId)) {
            return a.productId!.trim().toLowerCase() === fLine.productId!.trim().toLowerCase();
          }
          const normA = (a.productName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
          return normA === normF;
        });

        if (matchingAllocations.length === 0) {
          // Unambiguous fuzzy match fallback
          const fuzzyMatches = summary.allocations.filter((a) => {
            const normA = (a.productName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
            return normA.length > 0 && (normA.includes(normF) || normF.includes(normA));
          });
          if (fuzzyMatches.length === 1) {
            matchingAllocations = fuzzyMatches;
          } else if (fuzzyMatches.length > 1) {
            throw new AllocationValidationError([
              `AMBIGUOUS_ALLOCATION_MATCH: Multiple allocations matched fulfillment line '${fLine.productName}'`,
            ]);
          } else {
            throw new AllocationValidationError([
              `UNMATCHED_FULFILLMENT_LINE: No allocation matched fulfillment line '${fLine.productName}'`,
            ]);
          }
        }

        for (const a of matchingAllocations) {
          matchedAllocationIds.add(a.id);
        }

        const lineAllocated = matchingAllocations.reduce((sum, a) => sum + a.allocatedQuantity, 0);
        validateQuantityConservation(lineAllocated, fLine.fulfilledQuantity);
      }
    } else {
      const totalVerifiedFulfilled = fulfillments.reduce(
        (sum, f) => sum + f.fulfilledQuantity,
        0
      );
      // Validate fundamental quantity conservation
      validateQuantityConservation(summary.totalAllocatedQuantity, totalVerifiedFulfilled);
    }

    // Validate monetary conservation
    validateMonetaryConservation(
      summary.totalResidentAllocatedAmount,
      summary.totalProcurementCost
    );

    // Validate individual non-negativity
    for (const alloc of summary.allocations) {
      validateNonNegativity({
        requestedQuantity: alloc.requestedQuantity,
        allocatedQuantity: alloc.allocatedQuantity,
        unitPrice: alloc.unitPrice,
        subtotal: alloc.subtotal,
        allocatedTax: alloc.allocatedTax,
        allocatedDeliveryFee: alloc.allocatedDeliveryFee,
        allocatedOtherCharges: alloc.allocatedOtherCharges,
        totalAmount: alloc.totalAmount,
      });
    }

    summary.status = 'VALIDATED';
    for (const alloc of summary.allocations) {
      alloc.allocationStatus = 'VALIDATED';
      alloc.updatedAt = new Date();
    }

    this.auditService.emit('ALLOCATION_VALIDATED', commitmentId, {
      commitmentId,
      status: summary.status,
    });

    return summary;
  }

  /**
   * Atomically finalizes the allocation, posts immutable resident ledger entries,
   * and runs complete deterministic 4-pillar reconciliation.
   */
  public async finalizeAllocation(
    input: FinalizeAllocationInput
  ): Promise<{
    summary: ResidentAllocationSummary;
    ledgerEntries: ResidentLedgerEntry[];
    reconciliation: ReconciliationResult;
  }> {
    const { commitmentId, payments, purchaseOrders } = input;

    // Mutex locking to prevent concurrent finalization race conditions
    await this.acquireMutex(commitmentId);

    try {
      let summary = this.summaries.get(commitmentId);
      if (!summary) {
        throw new AllocationValidationError([
          `ALLOCATION_NOT_FOUND: No allocation calculated for commitment '${commitmentId}'`,
        ]);
      }

      // If already finalized, return idempotent state
      if (summary.status === 'FINALIZED') {
        const ledgerEntries = this.ledgerService.getAllEntriesForCommitment(commitmentId);
        const reconciliation = this.reconService.getReconciliationResult(commitmentId)!;
        return { summary, ledgerEntries, reconciliation };
      }

      // Auto-validate if currently CALCULATED
      if (summary.status === 'CALCULATED') {
        summary = this.validateAllocation(commitmentId);
      }

      assertLegalAllocationTransition(summary.status, 'FINALIZED');

      const now = new Date();
      summary.status = 'FINALIZED';
      summary.finalizedAt = now;

      // 1. Advance allocation records to FINALIZED
      for (const alloc of summary.allocations) {
        alloc.allocationStatus = 'FINALIZED';
        alloc.finalizedAt = now;
        alloc.updatedAt = now;
      }

      // 2. Post immutable ledger entries for every resident allocation
      const ledgerEntries: ResidentLedgerEntry[] = [];
      for (const alloc of summary.allocations) {
        const entry = this.ledgerService.postAllocation(alloc);
        ledgerEntries.push(entry);
      }

      // 3. Execute Authoritative 4-Pillar Reconciliation
      const commitment = this.commitments.get(commitmentId)!;
      const fulfillments = this.fulfillmentsByCommitment.get(commitmentId) || [];

      const reconciliation = this.reconService.reconcileCommitment({
        commitment,
        fulfillments,
        allocations: summary.allocations,
        payments,
        purchaseOrders,
      });

      // Update reconciliation status on summary and allocations
      summary.reconciliationStatus = reconciliation.status;
      for (const alloc of summary.allocations) {
        alloc.reconciliationStatus = reconciliation.status;
      }

      this.auditService.emit('ALLOCATION_FINALIZED', commitmentId, {
        commitmentId,
        residentCount: summary.residentCount,
        reconciliationStatus: reconciliation.status,
      });

      return { summary, ledgerEntries, reconciliation };
    } finally {
      this.releaseMutex(commitmentId);
    }
  }

  /**
   * Retrieves resident allocations with server-side authorization check.
   */
  public getResidentAllocations(
    residentReference: string,
    requestingResidentReference: string
  ): ResidentAllocation[] {
    validateResidentAuthorization(requestingResidentReference, residentReference);
    return this.allocationsByResident.get(residentReference) || [];
  }

  /**
   * Retrieves commitment-wide allocation summary.
   */
  public getCommitmentAllocationSummary(
    commitmentId: string
  ): ResidentAllocationSummary | undefined {
    return this.summaries.get(commitmentId);
  }

  /**
   * Authoritative, non-hallucinated resident-facing breakdown of an allocation.
   */
  public explainAllocation(
    residentOrderId: string,
    requestingResidentReference: string
  ): AllocationExplanation {
    const alloc = this.allocationsByOrder.get(residentOrderId);
    if (!alloc) {
      throw new AllocationValidationError([
        `ALLOCATION_NOT_FOUND: No allocation found for resident order '${residentOrderId}'`,
      ]);
    }

    // Server-side authorization check
    validateResidentAuthorization(requestingResidentReference, alloc.residentReference);

    const fulfillments = this.fulfillmentsByCommitment.get(alloc.commitmentId) || [];
    const verifiedFulfilledQuantity = fulfillments.reduce(
      (s, f) => s + f.fulfilledQuantity,
      0
    );

    const isPartial = alloc.allocatedQuantity < alloc.requestedQuantity;
    const policyDesc = isPartial
      ? 'Proportional scarcity distribution using Hamilton-Hare largest-remainder whole-unit allocation.'
      : 'Full fulfillment matching 100% of resident requested quantity.';

    const summaryText = isPartial
      ? `Requested ${alloc.requestedQuantity} ${alloc.unit}, allocated ${alloc.allocatedQuantity} ${alloc.unit} due to partial supplier delivery (${verifiedFulfilledQuantity} total verified units). Net payable is ₹${alloc.totalAmount}.`
      : `Requested ${alloc.requestedQuantity} ${alloc.unit}, fully fulfilled ${alloc.allocatedQuantity} ${alloc.unit}. Net payable is ₹${alloc.totalAmount}.`;

    return {
      residentOrderId: alloc.residentOrderId,
      demandLineId: alloc.demandLineId,
      residentReference: alloc.residentReference,
      productName: alloc.productName,
      requestedQuantity: alloc.requestedQuantity,
      verifiedFulfilledQuantity,
      allocatedQuantity: alloc.allocatedQuantity,
      unit: alloc.unit,
      unitPrice: alloc.unitPrice,
      subtotal: alloc.subtotal,
      allocatedTax: alloc.allocatedTax,
      allocatedDeliveryFee: alloc.allocatedDeliveryFee,
      allocatedOtherCharges: alloc.allocatedOtherCharges,
      totalAmount: alloc.totalAmount,
      allocationPolicy: policyDesc,
      status: alloc.allocationStatus,
      reconciliationStatus: alloc.reconciliationStatus,
      explanationSummary: summaryText,
    };
  }

  private async acquireMutex(key: string): Promise<void> {
    while (this.mutexes.has(key)) {
      await this.mutexes.get(key);
    }
    let resolver: () => void;
    const promise = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    (promise as any)._resolver = resolver!;
    this.mutexes.set(key, promise);
  }

  private releaseMutex(key: string): void {
    const promise = this.mutexes.get(key);
    if (promise) {
      this.mutexes.delete(key);
      const resolver = (promise as any)._resolver;
      if (resolver) resolver();
    }
  }
}

export const allocationService = new AllocationService();
