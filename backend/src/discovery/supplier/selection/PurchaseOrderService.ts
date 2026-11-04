import { randomUUID } from 'crypto';
import { eventBus } from '../../../events';
import { calculateLineSubtotal } from '../../../domain/procurement/quantityNormalizer';
import { Quote } from '../quote/types';
import { RFQ } from '../rfq/types';
import {
  ProcurementCommitment,
  PurchaseOrder,
  PurchaseOrderLine,
} from './types';

export class PurchaseOrderService {
  private purchaseOrders = new Map<string, PurchaseOrder>();
  private purchaseOrdersByCommitment = new Map<string, PurchaseOrder[]>();
  private idempotencyStore = new Map<string, PurchaseOrder[]>();

  /**
   * Generates formal Purchase Orders from a validated, committed procurement commitment.
   * Generates one PO per supplier allocation, ensuring complete supplier confidentiality.
   */
  public async generatePurchaseOrders(
    commitment: ProcurementCommitment,
    rfq: RFQ,
    options?: {
      supplierContacts?: Map<string, string>;
      idempotencyKey?: string;
      quotes?: Map<string, Quote>;
    }
  ): Promise<PurchaseOrder[]> {
    const dedupeKey = options?.idempotencyKey || `po_gen_${commitment.id}`;
    if (this.idempotencyStore.has(dedupeKey)) {
      return this.idempotencyStore.get(dedupeKey)!;
    }

    const createdPOs: PurchaseOrder[] = [];
    const now = new Date();

    for (const alloc of commitment.allocations) {
      const poId = `po_${randomUUID().slice(0, 8)}`;
      const poNumber = `PO-${now.getFullYear()}-${randomUUID().slice(0, 6).toUpperCase()}`;

      const contact =
        options?.supplierContacts?.get(alloc.supplierId) ||
        (alloc.supplierId === rfq.candidateId ? rfq.recipientContact : 'procurement@supplier.com');

      let lines: PurchaseOrderLine[];
      if (rfq.lineItems && rfq.lineItems.length > 1) {
        const quote = options?.quotes?.get(alloc.quoteId);
        lines = rfq.lineItems.map((rfqLine, index) => {
          const qLine = quote?.lineItems.find(
            (ql) =>
              (ql.productId && rfqLine.productId && ql.productId === rfqLine.productId) ||
              ql.productName.toLowerCase() === rfqLine.productName.toLowerCase() ||
              ql.productName.toLowerCase().includes(rfqLine.productName.toLowerCase()) ||
              rfqLine.productName.toLowerCase().includes(ql.productName.toLowerCase())
          );
          const unitPrice = qLine?.unitPrice ?? alloc.agreedUnitPrice;
          const lineTotal =
            qLine?.lineSubtotal ??
            calculateLineSubtotal(rfqLine.quantity, rfqLine.unit, unitPrice, qLine?.pricingUnit);
          return {
            lineNumber: index + 1,
            productName: rfqLine.productName,
            quantity: rfqLine.quantity,
            unit: rfqLine.unit,
            unitPrice,
            lineTotal,
          };
        });
      } else {
        lines = [
          {
            lineNumber: 1,
            productName: commitment.product.productName,
            quantity: alloc.allocatedQuantity,
            unit: alloc.unit,
            unitPrice: alloc.agreedUnitPrice,
            lineTotal: alloc.lineSubtotal,
          },
        ];
      }

      const po: PurchaseOrder = {
        id: poId,
        poNumber,
        commitmentId: commitment.id,
        rfqId: commitment.rfqId,
        supplierId: alloc.supplierId,
        supplierName: alloc.supplierName,
        supplierContact: contact,
        lines,
        subtotal: alloc.lineSubtotal,
        deliveryFee: alloc.deliveryFee,
        tax: alloc.tax,
        total: alloc.totalAmount,
        currency: 'INR',
        deliveryDeadline: commitment.deliveryDeadline,
        deliveryArea: rfq.deliveryArea, // Society/area level only (no flat number)
        terms: 'Pre-authorized via resident mandate; settled upon delivery verification and reconciliation.',
        status: 'READY_FOR_PAYMENT',
        createdAt: now,
        updatedAt: now,
        commercialBasisSimulated: commitment.commercialBasisSimulated,
      };

      this.purchaseOrders.set(poId, po);
      createdPOs.push(po);

      this.emitAudit('PURCHASE_ORDER_CREATED', poId, {
        poNumber: po.poNumber,
        commitmentId: commitment.id,
        supplierId: po.supplierId,
        total: po.total,
        deliveryDeadline: po.deliveryDeadline.toISOString(),
      });
    }

    this.purchaseOrdersByCommitment.set(commitment.id, createdPOs);
    this.idempotencyStore.set(dedupeKey, createdPOs);

    commitment.purchaseOrderIds = createdPOs.map((p) => p.id);

    return createdPOs;
  }

  public getPurchaseOrder(id: string): PurchaseOrder | undefined {
    return this.purchaseOrders.get(id);
  }

  public getPurchaseOrdersForCommitment(commitmentId: string): PurchaseOrder[] {
    return this.purchaseOrdersByCommitment.get(commitmentId) || [];
  }

  public listPurchaseOrders(): PurchaseOrder[] {
    return Array.from(this.purchaseOrders.values());
  }

  public reset(): void {
    this.purchaseOrders.clear();
    this.purchaseOrdersByCommitment.clear();
    this.idempotencyStore.clear();
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

export const purchaseOrderService = new PurchaseOrderService();

