import { FulfillmentAuditService, fulfillmentAuditService } from './FulfillmentAuditService';
import { assertLegalFulfillmentTransition } from './stateMachine';
import {
  FulfillmentOrder,
  SupplierFulfillmentEvent,
} from './types';
import {
  mapEventToTargetStatus,
  validateQuantities,
  validateSupplierEvent,
} from './validation';

export interface IngestEventResult {
  order: FulfillmentOrder;
  event: SupplierFulfillmentEvent;
  isDuplicate: boolean;
}

export class FulfillmentEventService {
  private eventsByFulfillment = new Map<string, SupplierFulfillmentEvent[]>();
  private idempotencyStore = new Map<string, IngestEventResult>();
  private fulfillmentLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly auditService: FulfillmentAuditService = fulfillmentAuditService
  ) {}

  /**
   * Deterministically ingests, validates, and applies an operational supplier fulfillment event.
   * Concurrency-guarded and idempotent.
   */
  public async ingestEvent(
    order: FulfillmentOrder,
    event: SupplierFulfillmentEvent
  ): Promise<IngestEventResult> {
    const dedupeKey = `${event.supplierId}_${event.fulfillmentId}_${event.idempotencyKey || event.id}`;

    // 1. Idempotency Check
    if (this.idempotencyStore.has(dedupeKey)) {
      const cached = this.idempotencyStore.get(dedupeKey)!;
      return {
        ...cached,
        isDuplicate: true,
      };
    }

    // 2. Concurrency Lock per Fulfillment Order
    let currentLock = this.fulfillmentLocks.get(order.id) || Promise.resolve();
    let releaseLock: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.fulfillmentLocks.set(order.id, currentLock.then(() => nextLock));

    await currentLock;
    try {
      // 3. Deterministic Validation
      validateSupplierEvent(order, event);

      const targetStatus = mapEventToTargetStatus(event.eventType, order.fulfillmentType);

      // 4. State Machine Transition (if advancing)
      if (order.status !== targetStatus) {
        assertLegalFulfillmentTransition(
          order.status,
          targetStatus,
          order.fulfillmentType
        );
        order.status = targetStatus;
      }

      const now = new Date();
      order.updatedAt = now;

      // 5. Quantity Integrity Validation & Update
      if (typeof event.quantityFulfilled === 'number') {
        const { remainingQuantity } = validateQuantities(
          order.requestedQuantity,
          event.quantityFulfilled
        );
        order.fulfilledQuantity = event.quantityFulfilled;
        order.remainingQuantity = remainingQuantity;
      }

      if (event.eventType === 'ORDER_DELIVERED' && order.lines && order.lines.length > 0) {
        for (const line of order.lines) {
          line.fulfilledQuantity = line.requestedQuantity;
          line.remainingQuantity = 0;
        }
      }

      // 6. Tracking Reference Update
      if (event.trackingReference) {
        order.trackingReference = event.trackingReference;
      }

      // 7. Delivery / Service Completion Timestamps
      if (targetStatus === 'DELIVERED' || targetStatus === 'SERVICE_COMPLETED') {
        order.actualDeliveryAt = event.timestamp || now;
      }

      // 8. Emit Tailored Audit Event
      this.emitAuditForEvent(order, event);

      // Persist in memory history
      const list = this.eventsByFulfillment.get(order.id) || [];
      list.push(event);
      this.eventsByFulfillment.set(order.id, list);

      const result: IngestEventResult = {
        order,
        event,
        isDuplicate: false,
      };

      this.idempotencyStore.set(dedupeKey, result);
      return result;
    } finally {
      releaseLock!();
    }
  }

  public getEventsForFulfillment(fulfillmentId: string): SupplierFulfillmentEvent[] {
    return this.eventsByFulfillment.get(fulfillmentId) || [];
  }

  public reset(): void {
    this.eventsByFulfillment.clear();
    this.idempotencyStore.clear();
    this.fulfillmentLocks.clear();
  }

  private emitAuditForEvent(
    order: FulfillmentOrder,
    event: SupplierFulfillmentEvent
  ): void {
    const payload: Record<string, unknown> = {
      supplierId: event.supplierId,
      eventType: event.eventType,
      status: order.status,
      fulfilledQuantity: order.fulfilledQuantity,
      remainingQuantity: order.remainingQuantity,
      trackingReference: order.trackingReference,
    };

    switch (event.eventType) {
      case 'SUPPLIER_ACCEPTED':
        this.auditService.emit('FULFILLMENT_ACCEPTED', order.id, payload);
        break;
      case 'SUPPLIER_REJECTED':
        this.auditService.emit('FULFILLMENT_REJECTED', order.id, payload);
        break;
      case 'FULFILLMENT_STARTED':
      case 'ORDER_PACKED':
      case 'SERVICE_SCHEDULED':
        this.auditService.emit('FULFILLMENT_STARTED', order.id, payload);
        break;
      case 'ORDER_DISPATCHED':
        this.auditService.emit('FULFILLMENT_DISPATCHED', order.id, payload);
        break;
      case 'ORDER_IN_TRANSIT':
      case 'SERVICE_STARTED':
        this.auditService.emit('FULFILLMENT_IN_TRANSIT', order.id, payload);
        break;
      case 'DELIVERY_ATTEMPTED':
        this.auditService.emit('DELIVERY_ATTEMPTED', order.id, payload);
        break;
      case 'ORDER_DELIVERED':
      case 'SERVICE_COMPLETED':
        this.auditService.emit('FULFILLMENT_DELIVERED', order.id, payload);
        if (order.remainingQuantity > 0) {
          this.auditService.emit('FULFILLMENT_PARTIALLY_COMPLETED', order.id, {
            fulfilledQuantity: order.fulfilledQuantity,
            remainingQuantity: order.remainingQuantity,
          });
        }
        break;
      case 'FULFILLMENT_FAILED':
        this.auditService.emit('FULFILLMENT_FAILED', order.id, payload);
        break;
      default:
        this.auditService.emit('FULFILLMENT_UPDATED', order.id, payload);
        break;
    }
  }
}

export const fulfillmentEventService = new FulfillmentEventService();
