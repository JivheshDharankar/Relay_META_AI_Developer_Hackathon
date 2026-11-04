import { randomUUID } from 'crypto';
import { roundMoney } from '../../../domain/procurement/decimal';
import { eventBus } from '../../../events';
import { RFQService, rfqService } from '../rfq/RFQService';
import { Quote } from '../quote/types';
import { QuoteNormalizationService, quoteNormalizationService } from '../quote/QuoteNormalizationService';
import { QuoteSelectionComparator, quoteSelectionComparator } from './QuoteSelectionComparator';
import { SelectionAIAdvisor, selectionAIAdvisor } from './SelectionAIAdvisor';
import { SelectionValidator, selectionValidator, SelectionValidationError } from './SelectionValidator';
import { AllocationService, allocationService } from './AllocationService';
import { PurchaseOrderService, purchaseOrderService } from './PurchaseOrderService';
import { assertLegalCommitmentTransition } from './stateMachine';
import {
  AISelectionRecommendation,
  ProcurementCommitment,
  ProposedAllocation,
  PurchaseOrder,
  SelectionComparisonSummary,
} from './types';

export interface CreateCommitmentInput {
  rfqId: string;
  recommendation: AISelectionRecommendation;
  moqMap?: Map<string, number>;
  supplierContacts?: Map<string, string>;
  idempotencyKey?: string;
}

export class ProcurementCommitmentService {
  private commitments = new Map<string, ProcurementCommitment>();
  private commitmentsByRfq = new Map<string, ProcurementCommitment>();
  private idempotencyStore = new Map<string, ProcurementCommitment>();
  private inFlightCommitments = new Map<string, Promise<{ commitment: ProcurementCommitment; purchaseOrders: PurchaseOrder[] }>>();

  constructor(
    private readonly rfqSvc: RFQService = rfqService,
    private readonly quoteSvc: QuoteNormalizationService = quoteNormalizationService,
    private readonly comparator: QuoteSelectionComparator = quoteSelectionComparator,
    private readonly advisor: SelectionAIAdvisor = selectionAIAdvisor,
    private readonly validator: SelectionValidator = selectionValidator,
    private readonly allocationSvc: AllocationService = allocationService,
    private readonly poService: PurchaseOrderService = purchaseOrderService
  ) {}

  /**
   * Generates a deterministic factual comparison summary of all quotes for an RFQ.
   */
  public compareQuotesForSelection(
    rfqId: string,
    options?: {
      moqMap?: Map<string, number>;
      supplierDistances?: Map<string, number>;
      negotiatedSavingsMap?: Map<string, number>;
      referenceTime?: Date;
      quotes?: Quote[];
      quoteIds?: string[];
    }
  ): SelectionComparisonSummary {
    const rfq = this.rfqSvc.getRFQ(rfqId);
    if (!rfq) {
      throw new Error(`RFQ '${rfqId}' not found`);
    }
    let quotes: Quote[];
    if (options?.quotes && options.quotes.length > 0) {
      quotes = options.quotes;
    } else if (options?.quoteIds && options.quoteIds.length > 0) {
      quotes = options.quoteIds
        .map((id) => this.quoteSvc.getQuote(id))
        .filter((q): q is Quote => q !== undefined);
    } else {
      quotes = this.quoteSvc.getQuotesForRFQ(rfqId);
    }
    return this.comparator.generateComparisonSummary(rfq, quotes, options);
  }

  /**
   * Creates a binding procurement commitment and generates supplier purchase orders
   * based on a validated selection recommendation.
   */
  public async createCommitment(
    input: CreateCommitmentInput
  ): Promise<{ commitment: ProcurementCommitment; purchaseOrders: PurchaseOrder[] }> {
    const dedupeKey = input.idempotencyKey || `commit_${input.rfqId}`;

    // 1. Idempotency Check
    if (this.idempotencyStore.has(dedupeKey)) {
      const existing = this.idempotencyStore.get(dedupeKey)!;
      const pos = this.poService.getPurchaseOrdersForCommitment(existing.id);
      return { commitment: existing, purchaseOrders: pos };
    }

    // 2. Concurrency Lock
    if (this.inFlightCommitments.has(dedupeKey)) {
      return this.inFlightCommitments.get(dedupeKey)!;
    }

    const commitmentPromise = (async () => {
      try {
        const rfq = this.rfqSvc.getRFQ(input.rfqId);
        if (!rfq) {
          throw new Error(`RFQ '${input.rfqId}' not found`);
        }
        if (rfq.status === 'CANCELLED' || rfq.status === 'EXPIRED') {
          throw new Error(`Cannot commit procurement: RFQ is in '${rfq.status}' status`);
        }

        this.emitAudit('QUOTE_SELECTION_STARTED', input.rfqId, {
          decisionType: input.recommendation.decision,
        });

        const quotes = this.quoteSvc.getQuotesForRFQ(input.rfqId);
        const quoteIds = new Set<string>(quotes.map((q) => q.id));

        const referencedIds: string[] = [];
        if (input.recommendation.quoteId) {
          referencedIds.push(input.recommendation.quoteId);
        }
        if (input.recommendation.allocations) {
          for (const a of input.recommendation.allocations) {
            if (a.quoteId) referencedIds.push(a.quoteId);
          }
        }

        for (const qId of referencedIds) {
          if (!quoteIds.has(qId)) {
            const extra = this.quoteSvc.getQuote(qId);
            if (extra) {
              quotes.push(extra);
              quoteIds.add(qId);
            }
          }
        }

        if (quotes.length === 0) {
          throw new Error(`No normalized quotes found for RFQ '${input.rfqId}'`);
        }

        // 3. Deterministic Selection Validation
        const validationResult = this.validator.validateRecommendation(
          input.recommendation,
          rfq,
          quotes,
          { moqMap: input.moqMap }
        );

        if (!validationResult.valid) {
          this.emitAudit('SELECTION_REJECTED', input.rfqId, {
            errors: validationResult.errors,
          });
          throw new SelectionValidationError(validationResult.errors);
        }

        this.emitAudit('SELECTION_VALIDATED', input.rfqId, {
          decision: input.recommendation.decision,
        });

        // 4. Construct Proposed Allocations
        const quoteMap = new Map(quotes.map((q) => [q.id, q]));
        const totalQuotedUnits = rfq.lineItems.reduce((acc, li) => acc + li.quantity, 0);

        // Represent procurement commitments using individually identified line items.
        // Never sum quantities across heterogeneous products or measurement units.
        const selectedQuote = quoteMap.get(input.recommendation.quoteId!) || quotes[0];
        const items = rfq.lineItems.map((li, idx) => {
          const qLine = selectedQuote?.lineItems?.find(
            (ql) =>
              (ql.productId && li.productId && ql.productId === li.productId) ||
              ql.productName.toLowerCase() === li.productName.toLowerCase() ||
              ql.productName.toLowerCase().includes(li.productName.toLowerCase()) ||
              li.productName.toLowerCase().includes(ql.productName.toLowerCase())
          ) || selectedQuote?.lineItems?.[idx];

          const unitPrice = qLine?.unitPrice;
          const lineSubtotal =
            qLine?.lineSubtotal ??
            (unitPrice !== undefined ? roundMoney(unitPrice * li.quantity).toNumber() : undefined);

          return {
            lineNumber: idx + 1,
            productId: li.productId || qLine?.productId || null,
            productName: li.productName,
            sku: (qLine as any)?.sku || undefined,
            requestedQuantity: li.quantity,
            unit: li.unit,
            committedQuantity: li.quantity,
            unitPrice,
            lineSubtotal,
            identitySource: (li as any).identitySource,
          };
        });

        const isSingleProduct = rfq.lineItems.length === 1;
        const allSameUnit = rfq.lineItems.every(
          (li) => li.unit.toLowerCase() === rfq.lineItems[0].unit.toLowerCase()
        );
        // Never assign cross-unit numerical sums to requestedQuantity.
        const scalarQuantity = isSingleProduct
          ? rfq.lineItems[0].quantity
          : allSameUnit
            ? rfq.lineItems.reduce((acc, li) => acc + li.quantity, 0)
            : rfq.lineItems[0].quantity;

        let proposedAllocations: ProposedAllocation[];
        if (input.recommendation.decision === 'SELECT_SUPPLIER') {
          proposedAllocations = [
            {
              supplierId: input.recommendation.supplierId!,
              quoteId: input.recommendation.quoteId!,
              quantity: totalQuotedUnits,
            },
          ];
        } else if (input.recommendation.decision === 'SPLIT_ORDER') {
          proposedAllocations = input.recommendation.allocations!;
        } else {
          throw new Error(
            `Cannot commit procurement for non-selection decision '${input.recommendation.decision}'`
          );
        }

        // 5. Calculate Financials with Strict Decimal Arithmetic
        const commitmentId = `commit_${randomUUID().slice(0, 8)}`;
        const allocationPlan = this.allocationSvc.calculateAllocations(
          commitmentId,
          proposedAllocations,
          quoteMap
        );

        this.emitAudit('ALLOCATION_CREATED', commitmentId, {
          allocationCount: allocationPlan.allocations.length,
          total: allocationPlan.financials.total,
        });
        this.emitAudit('ALLOCATION_VALIDATED', commitmentId, {
          total: allocationPlan.financials.total,
        });

        const now = new Date();
        const primaryLine = rfq.lineItems[0];

        // Commercial provenance: conservative taint — if ANY selected quote
        // came from simulated responses, the committed basis is simulated.
        // Unknown (absent flags) stays undefined rather than claiming "real".
        const basisFlags = proposedAllocations
          .map((a) => quoteMap.get(a.quoteId)?.isSimulated)
          .filter((v): v is boolean => v !== undefined);
        const commercialBasisSimulated =
          basisFlags.length === 0 ? undefined : basisFlags.some((v) => v === true);

        // 6. Assemble Commitment Entity
        const commitment: ProcurementCommitment = {
          id: commitmentId,
          rfqId: rfq.id,
          societyId: rfq.societyId,
          selectedQuoteIds: proposedAllocations.map((a) => a.quoteId),
          supplierIds: proposedAllocations.map((a) => a.supplierId),
          items,
          product: {
            productId: primaryLine?.productId,
            productName: primaryLine?.productName || 'Procured product',
            unit: primaryLine?.unit || 'units',
          },
          lineItems: rfq.lineItems,
          requestedQuantity: scalarQuantity,
          committedQuantity: scalarQuantity,
          allocations: allocationPlan.allocations,
          financials: allocationPlan.financials,
          deliveryDeadline: rfq.deliveryDeadline,
          status: 'DRAFT',
          purchaseOrderIds: [],
          recommendationReason: input.recommendation.reason,
          commercialBasisSimulated,
          idempotencyKey: dedupeKey,
          createdAt: now,
          updatedAt: now,
        };

        // State Machine Progression: DRAFT -> VALIDATED -> COMMITTED
        assertLegalCommitmentTransition(commitment.status, 'VALIDATED');
        commitment.status = 'VALIDATED';

        assertLegalCommitmentTransition(commitment.status, 'COMMITTED');
        commitment.status = 'COMMITTED';
        commitment.committedAt = now;

        this.commitments.set(commitmentId, commitment);
        this.commitmentsByRfq.set(rfq.id, commitment);
        this.idempotencyStore.set(dedupeKey, commitment);

        this.emitAudit('PROCUREMENT_COMMITMENT_CREATED', commitmentId, {
          rfqId: commitment.rfqId,
          total: commitment.financials.total,
          committedQuantity: commitment.committedQuantity,
        });
        this.emitAudit('PROCUREMENT_COMMITTED', commitmentId, {
          total: commitment.financials.total,
        });

        // 7. Generate Purchase Orders
        const purchaseOrders = await this.poService.generatePurchaseOrders(
          commitment,
          rfq,
          {
            supplierContacts: input.supplierContacts,
            quotes: quoteMap,
          }
        );

        // State Machine Progression: COMMITTED -> PURCHASE_ORDER_CREATED -> READY_FOR_PAYMENT
        assertLegalCommitmentTransition(commitment.status, 'PURCHASE_ORDER_CREATED');
        commitment.status = 'PURCHASE_ORDER_CREATED';

        assertLegalCommitmentTransition(commitment.status, 'READY_FOR_PAYMENT');
        commitment.status = 'READY_FOR_PAYMENT';
        commitment.updatedAt = new Date();

        this.emitAudit('PROCUREMENT_READY_FOR_PAYMENT', commitmentId, {
          poCount: purchaseOrders.length,
          totalAmount: commitment.financials.total,
        });

        return { commitment, purchaseOrders };
      } finally {
        this.inFlightCommitments.delete(dedupeKey);
      }
    })();

    this.inFlightCommitments.set(dedupeKey, commitmentPromise);
    return commitmentPromise;
  }

  /**
   * Autonomous end-to-end pipeline:
   * Compares quotes -> AI advisor formulates recommendation -> Validates -> Commits -> Issues Purchase Orders.
   */
  public async executeAutonomousSelection(
    rfqId: string,
    options?: {
      moqMap?: Map<string, number>;
      supplierDistances?: Map<string, number>;
      supplierContacts?: Map<string, string>;
      idempotencyKey?: string;
    }
  ): Promise<{
    recommendation: AISelectionRecommendation;
    commitment?: ProcurementCommitment;
    purchaseOrders?: PurchaseOrder[];
  }> {
    const comparison = this.compareQuotesForSelection(rfqId, options);
    const recommendation = await this.advisor.recommendSelection(comparison);

    this.emitAudit('SELECTION_RECOMMENDATION_CREATED', rfqId, {
      decision: recommendation.decision,
      supplierId: recommendation.supplierId,
      reason: recommendation.reason,
    });

    if (recommendation.decision === 'REJECT_ALL') {
      return { recommendation };
    }

    const { commitment, purchaseOrders } = await this.createCommitment({
      rfqId,
      recommendation,
      moqMap: options?.moqMap,
      supplierContacts: options?.supplierContacts,
      idempotencyKey: options?.idempotencyKey,
    });

    return {
      recommendation,
      commitment,
      purchaseOrders,
    };
  }

  public getCommitment(id: string): ProcurementCommitment | undefined {
    return this.commitments.get(id);
  }

  public getCommitmentForRFQ(rfqId: string): ProcurementCommitment | undefined {
    return this.commitmentsByRfq.get(rfqId);
  }

  public listCommitments(): ProcurementCommitment[] {
    return Array.from(this.commitments.values());
  }

  public reset(): void {
    this.commitments.clear();
    this.commitmentsByRfq.clear();
    this.idempotencyStore.clear();
    this.inFlightCommitments.clear();
    this.poService.reset();
  }

  private emitAudit(eventType: string, aggregateId: string, payload: Record<string, unknown>): void {
    eventBus
      .publish({
        id: randomUUID(),
        name: eventType,
        aggregateId,
        timestamp: new Date().toISOString(),
        payload,
      })
      .catch(() => {});
  }
}

export const procurementCommitmentService = new ProcurementCommitmentService();
