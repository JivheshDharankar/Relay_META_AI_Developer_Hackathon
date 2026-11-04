import { Quote } from '../quote/types';
import { RFQLineItem } from '../rfq/types';

/**
 * Deterministic lifecycle status of a procurement commitment.
 */
export type CommitmentStatus =
  | 'DRAFT'
  | 'VALIDATED'
  | 'COMMITTED'
  | 'PURCHASE_ORDER_CREATED'
  | 'READY_FOR_PAYMENT'
  | 'PAID'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED';

/**
 * Supported autonomous selection decision types.
 */
export type SelectionDecisionType =
  | 'SELECT_SUPPLIER'
  | 'SPLIT_ORDER'
  | 'REJECT_ALL'
  | 'REQUEST_MORE_NEGOTIATION';

/**
 * Status of an issued Purchase Order.
 */
export type PurchaseOrderStatus =
  | 'ISSUED'
  | 'READY_FOR_PAYMENT'
  | 'PAID'
  | 'CANCELLED';

/**
 * Factual eligibility evaluation for a specific quote against procurement requirements.
 */
export interface QuoteEligibilityResult {
  quoteId: string;
  candidateId: string;
  supplierName: string;
  isEligible: boolean;
  reasons: string[];
  isEligibleForSplit: boolean;
  remainingSlaHours: number;
  moqSatisfied: boolean;
  quote: Quote;
}

/**
 * Factual comparative metrics computed deterministically for candidate selection.
 */
export interface QuoteSelectionMetrics {
  quoteId: string;
  candidateId: string;
  supplierName: string;
  unitPrice: number;
  total: number;
  priceDifferenceFromLowest: number;
  deliveryFee: number;
  deliveryEtaHours?: number;
  slaMarginHours: number;
  isSlaCompliant: boolean;
  availableQuantity: number;
  requestedQuantity: number;
  offeredQuantity: number;
  isPartial: boolean;
  moq: number;
  moqSatisfied: boolean;
  uncoveredItems?: string[];
  negotiatedSavings: number;
  supplierDistanceKm?: number;
  isEligible: boolean;
  eligibilityReasons: string[];
  /**
   * True when the underlying quote came from Relay's simulated commercial
   * responses rather than a real supplier channel.
   */
  isSimulated?: boolean;
}

/**
 * Normalized summary of all candidate quotes presented for selection reasoning.
 */
export interface SelectionComparisonSummary {
  rfqId: string;
  requestedQuantity: number;
  unit: string;
  lineItems?: RFQLineItem[];
  quotes: QuoteSelectionMetrics[];
  eligibleQuotes: QuoteSelectionMetrics[];
  lowestCostQuoteId?: string;
  fastestDeliveryQuoteId?: string;
  bestSlaMarginQuoteId?: string;
  fullFulfillmentQuoteIds: string[];
  splitCandidates: QuoteSelectionMetrics[];
}

/**
 * Allocation item proposed within a split or single procurement recommendation.
 */
export interface ProposedAllocation {
  supplierId: string;
  quoteId: string;
  quantity: number;
}

/**
 * Structured AI selection recommendation output.
 */
export interface AISelectionRecommendation {
  decision: SelectionDecisionType;
  supplierId?: string;
  quoteId?: string;
  allocations?: ProposedAllocation[];
  reason: string;
  expectedBenefit?: {
    costSaving?: number;
    deliveryHours?: number;
    fulfillmentPercent?: number;
  };
}

/**
 * Verified allocation of procurement quantity to a specific qualified supplier.
 */
export interface SupplierAllocation {
  id: string;
  commitmentId: string;
  supplierId: string;
  supplierName: string;
  quoteId: string;
  allocatedQuantity: number;
  unit: string;
  agreedUnitPrice: number;
  lineSubtotal: number;
  deliveryFee: number;
  tax: number;
  otherCharges: number;
  totalAmount: number;
  deliveryEtaHours?: number;
  confirmedDeliveryEta?: Date;
}

/**
 * Product-specific line item preserved on a Procurement Commitment.
 * Ensures multi-product requests retain individual product identity,
 * units, and quantities without collapsing or cross-unit summation.
 */
export interface CommitmentLineItem {
  lineNumber: number;
  productId?: string | null;
  productName: string;
  sku?: string | null;
  requestedQuantity: number;
  unit: string;
  committedQuantity: number;
  unitPrice?: number;
  lineSubtotal?: number;
  supplierConfirmedQuantity?: number;
  fulfilledQuantity?: number;
  allocatedQuantity?: number;
  identitySource?: 'catalog' | 'open-world';
}

/**
 * Core Procurement Commitment domain entity representing un-paid binding procurement intent.
 */
export interface ProcurementCommitment {
  id: string;
  rfqId: string;
  societyId?: string;
  selectedQuoteIds: string[];
  supplierIds: string[];
  /** Authoritative product-specific line items for multi-item and single-item baskets. */
  items?: CommitmentLineItem[];
  product: {
    productId?: string;
    productName: string;
    unit: string;
  };
  lineItems?: RFQLineItem[];
  requestedQuantity: number;
  committedQuantity: number;
  allocations: SupplierAllocation[];
  financials: {
    subtotal: number;
    deliveryFee: number;
    tax: number;
    otherCharges: number;
    total: number;
    currency: string;
  };
  deliveryDeadline: Date;
  status: CommitmentStatus;
  purchaseOrderIds: string[];
  negotiationReference?: string;
  /**
   * True when the committed commercial basis came from simulated supplier
   * responses (no live supplier participated). False when all selected
   * quotes arrived through real supplier channels. Undefined when unknown.
   * This marks the COMMERCIAL BASIS only — the commitment itself is a real
   * Relay-authoritative record, and supplier identity stays independent.
   */
  commercialBasisSimulated?: boolean;
  recommendationReason: string;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  committedAt?: Date;
}

/**
 * Single line item on a formal Purchase Order.
 */
export interface PurchaseOrderLine {
  lineNumber: number;
  productId?: string;
  sku?: string;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  lineTotal: number;
}

/**
 * Formal Purchase Order issued to a selected supplier.
 * Contains supplier-facing commercial parameters strictly omitting resident identities.
 */
export interface PurchaseOrder {
  id: string;
  poNumber: string;
  commitmentId: string;
  rfqId: string;
  supplierId: string;
  supplierName: string;
  supplierContact: string;
  lines: PurchaseOrderLine[];
  subtotal: number;
  deliveryFee: number;
  tax: number;
  total: number;
  currency: string;
  deliveryDeadline: Date;
  deliveryArea: string;
  terms: string;
  status: PurchaseOrderStatus;
  createdAt: Date;
  updatedAt: Date;
  /**
   * True when the PO's commercial basis came from simulated supplier
   * responses. Copied from the parent commitment; see its documentation.
   */
  commercialBasisSimulated?: boolean;
}

/**
 * Result of deterministic selection validation.
 */
export interface SelectionValidationResult {
  valid: boolean;
  errors: string[];
  validatedAllocations?: SupplierAllocation[];
}
