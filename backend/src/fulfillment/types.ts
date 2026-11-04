/**
 * Classification of procurement fulfillment.
 * Supports physical shipments as well as contracted local service engagements.
 */
export type FulfillmentType = 'PHYSICAL_GOODS' | 'SERVICE';

/**
 * Authoritative deterministic lifecycle status of a fulfillment order.
 */
export type FulfillmentStatus =
  | 'CREATED'
  | 'AWAITING_SUPPLIER_ACCEPTANCE'
  | 'ACCEPTED'
  | 'PROCESSING'
  | 'DISPATCHED'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'SERVICE_SCHEDULED'
  | 'SERVICE_IN_PROGRESS'
  | 'SERVICE_COMPLETED'
  | 'VERIFIED'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Deterministic SLA status classification based on deadline and warning thresholds.
 */
export type SLAStatus = 'ON_TRACK' | 'AT_RISK' | 'OVERDUE' | 'BREACHED';

/**
 * Authoritative evidence provided to verify delivery or service completion.
 */
export interface VerificationEvidence {
  evidenceType:
    | 'DELIVERY_CONFIRMATION'
    | 'CARRIER_SIGN_OFF'
    | 'SERVICE_COMPLETION_REPORT'
    | 'SIMULATED_VERIFICATION';
  verifiedBy: string;
  verifiedAt: Date;
  notes?: string;
  isSimulated: boolean;
}

/**
 * Product-specific line item on a Fulfillment Order.
 * Preserves individual product identity, unit, requested, and fulfilled quantities.
 */
export interface FulfillmentOrderLine {
  lineNumber: number;
  productId?: string | null;
  productName: string;
  sku?: string | null;
  requestedQuantity: number;
  fulfilledQuantity: number;
  remainingQuantity: number;
  unit: string;
}

/**
 * Authoritative Fulfillment Order domain entity linking paid procurement commitments
 * and purchase orders to real-world operational execution.
 */
export interface FulfillmentOrder {
  id: string;
  commitmentId: string;
  purchaseOrderId: string;
  paymentId: string;
  supplierId: string;
  supplierName: string;
  fulfillmentType: FulfillmentType;
  status: FulfillmentStatus;
  lines?: FulfillmentOrderLine[];
  productName: string;
  requestedQuantity: number;
  fulfilledQuantity: number;
  remainingQuantity: number;
  unit: string;
  deliveryArea: string;
  slaDeadline: Date;
  slaStatus: SLAStatus;
  expectedDeliveryAt?: Date;
  actualDeliveryAt?: Date;
  trackingReference?: string;
  verificationEvidence?: VerificationEvidence;
  createdAt: Date;
  updatedAt: Date;
  verifiedAt?: Date;
  metadata?: Record<string, unknown>;
  /**
   * True when the fulfilled commercial basis came from simulated supplier
   * responses. Copied from the parent commitment; marks the basis, not the
   * fulfillment itself.
   */
  commercialBasisSimulated?: boolean;
}

/**
 * Supplier-originated operational events ingested during fulfillment.
 */
export type SupplierFulfillmentEventType =
  | 'SUPPLIER_ACCEPTED'
  | 'SUPPLIER_REJECTED'
  | 'FULFILLMENT_STARTED'
  | 'ORDER_PACKED'
  | 'ORDER_DISPATCHED'
  | 'ORDER_IN_TRANSIT'
  | 'DELIVERY_ATTEMPTED'
  | 'ORDER_DELIVERED'
  | 'SERVICE_SCHEDULED'
  | 'SERVICE_STARTED'
  | 'SERVICE_COMPLETED'
  | 'FULFILLMENT_FAILED'
  | 'FULFILLMENT_UPDATED';

/**
 * Normalized supplier fulfillment event record.
 */
export interface SupplierFulfillmentEvent {
  id: string;
  fulfillmentId: string;
  supplierId: string;
  eventType: SupplierFulfillmentEventType;
  timestamp: Date;
  quantityFulfilled?: number;
  trackingReference?: string;
  notes?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

/**
 * Result of deterministic SLA evaluation.
 */
export interface SLACalculationResult {
  slaDeadline: Date;
  remainingMinutes: number;
  isOverdue: boolean;
  isBreached: boolean;
  breachDurationMinutes: number;
  slaStatus: SLAStatus;
}

/**
 * Normalized result from carrier delivery tracking adapter.
 */
export interface DeliveryTrackingResult {
  trackingReference: string;
  carrier: string;
  status:
    | 'PREPARING'
    | 'DISPATCHED'
    | 'IN_TRANSIT'
    | 'OUT_FOR_DELIVERY'
    | 'DELIVERED'
    | 'FAILED'
    | 'EXCEPTION';
  location?: string;
  estimatedDeliveryAt?: Date;
  deliveredAt?: Date;
  lastUpdated: Date;
  isSimulated: boolean;
}

/**
 * Consolidated operational fulfillment summary for multi-supplier procurements.
 */
export interface AggregateProcurementFulfillmentSummary {
  commitmentId: string;
  status:
    | 'NOT_STARTED'
    | 'IN_PROGRESS'
    | 'PARTIALLY_FULFILLED'
    | 'ALL_VERIFIED'
    | 'DELAYED'
    | 'FAILED';
  totalOrders: number;
  verifiedOrders: number;
  failedOrders: number;
  activeOrders: number;
  orders: FulfillmentOrder[];
}

