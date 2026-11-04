import { randomUUID } from 'crypto';
import {
  ProcurementCommitment,
  PurchaseOrder,
} from '../discovery/supplier/selection/types';
import { Payment } from '../payment/types';
import { DeliveryTrackingService, deliveryTrackingService } from './DeliveryTrackingService';
import { FulfillmentAuditService, fulfillmentAuditService } from './FulfillmentAuditService';
import { SLAMonitoringService, slaMonitoringService } from './SLAMonitoringService';
import { assertLegalFulfillmentTransition } from './stateMachine';
import {
  FulfillmentOrder,
  FulfillmentType,
  VerificationEvidence,
} from './types';
import { validatePaymentLinkage, validateQuantities } from './validation';

export interface CreateFulfillmentOrderInput {
  commitment: ProcurementCommitment;
  purchaseOrder: PurchaseOrder;
  payment: Payment;
  fulfillmentType?: FulfillmentType;
  deliveryArea?: string;
  slaDeadline?: Date;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export class FulfillmentOrderService {
  private orders = new Map<string, FulfillmentOrder>();
  private ordersByCommitment = new Map<string, FulfillmentOrder[]>();
  private idempotencyStore = new Map<string, FulfillmentOrder>();

  constructor(
    private readonly auditService: FulfillmentAuditService = fulfillmentAuditService,
    private readonly slaService: SLAMonitoringService = slaMonitoringService,
    private readonly trackingService: DeliveryTrackingService = deliveryTrackingService
  ) {}

  /**
   * Deterministically creates a new FulfillmentOrder linking a paid procurement commitment
   * and purchase order to operational execution.
   */
  public createFulfillmentOrder(input: CreateFulfillmentOrderInput): FulfillmentOrder {
    const dedupeKey =
      input.idempotencyKey || `ful_${input.purchaseOrder.id}`;

    // 1. Idempotency Check
    if (this.idempotencyStore.has(dedupeKey)) {
      return this.idempotencyStore.get(dedupeKey)!;
    }

    // 2. Validate Payment Linkage
    validatePaymentLinkage(input.commitment, input.purchaseOrder, input.payment);

    const now = new Date();
    const fulfillmentId = `ful_${randomUUID().slice(0, 8)}`;
    const fulfillmentType: FulfillmentType = input.fulfillmentType || 'PHYSICAL_GOODS';

    // Quantity calculations
    const primaryLine = input.purchaseOrder.lines[0];
    const isSingleLine = input.purchaseOrder.lines.length === 1;
    const allSameUnit = input.purchaseOrder.lines.every(
      (l) => l.unit.toLowerCase() === input.purchaseOrder.lines[0].unit.toLowerCase()
    );
    // Never sum quantities across heterogeneous products or measurement units.
    const requestedQuantity = isSingleLine
      ? input.purchaseOrder.lines[0].quantity
      : allSameUnit
        ? input.purchaseOrder.lines.reduce((acc, l) => acc + l.quantity, 0)
        : input.purchaseOrder.lines[0].quantity;

    const fulfillmentLines = input.purchaseOrder.lines.map((l) => ({
      lineNumber: l.lineNumber,
      productName: l.productName,
      requestedQuantity: l.quantity,
      fulfilledQuantity: 0,
      remainingQuantity: l.quantity,
      unit: l.unit,
    }));
    const { remainingQuantity } = validateQuantities(requestedQuantity, 0);

    // Authoritative SLA Deadline
    const slaDeadline =
      input.slaDeadline ||
      input.purchaseOrder.deliveryDeadline ||
      input.commitment.deliveryDeadline ||
      this.slaService.computeDefaultDeadline(now);

    const order: FulfillmentOrder = {
      id: fulfillmentId,
      commitmentId: input.commitment.id,
      purchaseOrderId: input.purchaseOrder.id,
      paymentId: input.payment.id,
      supplierId: input.purchaseOrder.supplierId,
      supplierName: input.purchaseOrder.supplierName,
      fulfillmentType,
      status: 'CREATED',
      lines: fulfillmentLines,
      productName: primaryLine?.productName || 'Procured Goods/Service',
      requestedQuantity,
      fulfilledQuantity: 0,
      remainingQuantity,
      unit: primaryLine?.unit || 'units',
      deliveryArea: input.deliveryArea || input.purchaseOrder.deliveryArea || 'Designated Community Area',
      slaDeadline,
      slaStatus: 'ON_TRACK',
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
      commercialBasisSimulated: input.commitment.commercialBasisSimulated,
    };

    // Generate tracking code
    order.trackingReference = this.trackingService.generateTrackingReference(order);

    // State Machine Advance: CREATED -> AWAITING_SUPPLIER_ACCEPTANCE
    assertLegalFulfillmentTransition(order.status, 'AWAITING_SUPPLIER_ACCEPTANCE', fulfillmentType);
    order.status = 'AWAITING_SUPPLIER_ACCEPTANCE';
    order.updatedAt = new Date();

    // 3. Emit Audit Events
    this.auditService.emit('FULFILLMENT_CREATED', fulfillmentId, {
      commitmentId: order.commitmentId,
      purchaseOrderId: order.purchaseOrderId,
      paymentId: order.paymentId,
      supplierId: order.supplierId,
      requestedQuantity: order.requestedQuantity,
      fulfillmentType: order.fulfillmentType,
      slaDeadline: order.slaDeadline.toISOString(),
    });

    this.auditService.emit('FULFILLMENT_ACCEPTANCE_REQUESTED', fulfillmentId, {
      supplierId: order.supplierId,
      trackingReference: order.trackingReference,
    });

    // 4. Persist in memory
    this.orders.set(fulfillmentId, order);
    const list = this.ordersByCommitment.get(order.commitmentId) || [];
    list.push(order);
    this.ordersByCommitment.set(order.commitmentId, list);
    this.idempotencyStore.set(dedupeKey, order);

    return order;
  }

  /**
   * Deterministically verifies that delivered physical goods or completed services
   * have passed delivery validation.
   */
  public verifyFulfillment(
    fulfillmentId: string,
    evidence: VerificationEvidence
  ): FulfillmentOrder {
    const order = this.orders.get(fulfillmentId);
    if (!order) {
      throw new Error(`FulfillmentOrder '${fulfillmentId}' not found for verification`);
    }

    if (order.status !== 'DELIVERED' && order.status !== 'SERVICE_COMPLETED') {
      throw new Error(
        `Cannot verify fulfillment in '${order.status}' status; expected 'DELIVERED' or 'SERVICE_COMPLETED'`
      );
    }

    // State Machine: DELIVERED/SERVICE_COMPLETED -> VERIFIED
    assertLegalFulfillmentTransition(order.status, 'VERIFIED', order.fulfillmentType);
    order.status = 'VERIFIED';
    order.verifiedAt = evidence.verifiedAt || new Date();
    order.verificationEvidence = evidence;
    order.updatedAt = new Date();

    this.auditService.emit('FULFILLMENT_VERIFIED', fulfillmentId, {
      evidenceType: evidence.evidenceType,
      verifiedBy: evidence.verifiedBy,
      fulfilledQuantity: order.fulfilledQuantity,
      requestedQuantity: order.requestedQuantity,
      isSimulated: evidence.isSimulated,
    });

    return order;
  }

  public getFulfillmentOrder(id: string): FulfillmentOrder | undefined {
    return this.orders.get(id);
  }

  public getFulfillmentsForCommitment(commitmentId: string): FulfillmentOrder[] {
    return this.ordersByCommitment.get(commitmentId) || [];
  }

  public listFulfillmentOrders(): FulfillmentOrder[] {
    return Array.from(this.orders.values());
  }

  public reset(): void {
    this.orders.clear();
    this.ordersByCommitment.clear();
    this.idempotencyStore.clear();
  }
}

export const fulfillmentOrderService = new FulfillmentOrderService();

