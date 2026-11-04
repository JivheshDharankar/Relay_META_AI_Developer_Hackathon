import { randomUUID } from 'crypto';
import {
  addDecimals,
  isDecimalEqual,
  isLessThan,
  roundMoney,
  subtractDecimals,
  toDecimal,
} from '../../../domain/procurement/decimal';
import { calculateLineSubtotal } from '../../../domain/procurement/quantityNormalizer';
import { eventBus } from '../../../events';
import {
  NormalizedQuoteResult,
  Quote,
  QuoteLineItem,
  QuoteStatus,
  QuoteValidationReasonCode,
  SupplierResponse,
} from './types';

export class QuoteNormalizationService {
  private quotes = new Map<string, Quote>();
  private quotesByRfq = new Map<string, Quote[]>();
  private idempotencyStore = new Map<string, Quote>();

  /**
   * Deterministically validates and normalizes an ingested raw supplier response into a trusted Quote entity.
   */
  public async normalizeResponse(
    response: SupplierResponse,
    referenceTime = new Date()
  ): Promise<NormalizedQuoteResult> {
    const dedupeKey = `quote_${response.idempotencyKey || response.id}`;

    // 1. Idempotency Check
    if (this.idempotencyStore.has(dedupeKey)) {
      const existing = this.idempotencyStore.get(dedupeKey)!;
      return {
        quote: existing,
        isDuplicate: true,
      };
    }

    const reasons: QuoteValidationReasonCode[] = [];
    const rejectionReasons: QuoteValidationReasonCode[] = [];

    // 2. Validate Originating RFQ Status
    const { rfq } = response;
    if (!rfq) {
      rejectionReasons.push('RFQ_NOT_FOUND');
    } else if (rfq.status === 'CANCELLED' || rfq.status === 'EXPIRED') {
      rejectionReasons.push('RFQ_INACTIVE');
    } else if (rfq.candidateId !== response.candidateId) {
      rejectionReasons.push('SUPPLIER_MISMATCH');
    }

    // 3. Normalize & Validate Line Items
    const quoteLineItems: QuoteLineItem[] = [];
    let hasPartialItem = false;

    if (!response.lineItems || response.lineItems.length === 0) {
      rejectionReasons.push('INVALID_QUANTITY');
    } else {
      for (let i = 0; i < response.lineItems.length; i++) {
        const item = response.lineItems[i];
        const rfqItem = rfq?.lineItems.find(
          (r) =>
            (r.productId && item.productId && r.productId === item.productId) ||
            r.productName.toLowerCase() === item.productName.toLowerCase()
        );

        const requestedQty = rfqItem ? rfqItem.quantity : item.quotedQuantity;

        // Numeric validation
        if (
          typeof item.quotedQuantity !== 'number' ||
          Number.isNaN(item.quotedQuantity) ||
          item.quotedQuantity <= 0
        ) {
          rejectionReasons.push('INVALID_QUANTITY');
        }

        if (
          typeof item.unitPrice !== 'number' ||
          Number.isNaN(item.unitPrice) ||
          item.unitPrice < 0
        ) {
          rejectionReasons.push('INVALID_UNIT_PRICE');
        }

        if (!item.unit || item.unit.trim().length === 0) {
          rejectionReasons.push('INVALID_UNIT');
        } else if (rfqItem && rfqItem.unit.toUpperCase() !== item.unit.toUpperCase()) {
          rejectionReasons.push('INVALID_UNIT');
        }

        // Partial quantity check
        const isPartial =
          typeof item.quotedQuantity === 'number' &&
          typeof requestedQty === 'number' &&
          isLessThan(toDecimal(item.quotedQuantity), toDecimal(requestedQty));

        if (isPartial) {
          hasPartialItem = true;
        }

        // Line Subtotal Calculation (Deterministic Canonical Decimal: quantity x unitPrice with dimension normalization)
        let lineSubtotal = 0;
        if (
          typeof item.quotedQuantity === 'number' &&
          item.quotedQuantity > 0 &&
          typeof item.unitPrice === 'number' &&
          item.unitPrice >= 0
        ) {
          lineSubtotal = calculateLineSubtotal(
            item.quotedQuantity,
            item.unit,
            item.unitPrice
          );
        }

        quoteLineItems.push({
          productId: item.productId || rfqItem?.productId,
          identitySource: item.identitySource,
          productName: item.productName,
          requestedQuantity: requestedQty,
          quotedQuantity: item.quotedQuantity,
          isPartial,
          unit: item.unit,
          unitPrice: item.unitPrice,
          lineSubtotal,
          notes: item.notes,
          pricingUnit: item.pricingUnit,
          merchant: item.merchant,
          sourceUrl: item.sourceUrl,
          provenanceStatus: item.provenanceStatus,
          packageSizeNote: item.packageSizeNote,
        });
      }
    }

    // 4. Deterministic Financial Arithmetic
    const subtotal = roundMoney(
      addDecimals(...quoteLineItems.map((item) => item.lineSubtotal))
    ).toNumber();

    const deliveryFee = roundMoney(toDecimal(response.deliveryFee ?? 0)).toNumber();
    const tax = roundMoney(toDecimal(response.tax ?? 0)).toNumber();
    const otherCharges = roundMoney(toDecimal(response.otherCharges ?? 0)).toNumber();

    // Final total = subtotal + deliveryFee + tax + otherCharges
    const calculatedTotal = roundMoney(
      addDecimals(subtotal, deliveryFee, tax, otherCharges)
    ).toNumber();

    // 5. Total Mismatch Verification
    let hasTotalMismatch = false;
    let totalMismatchDifference: number | undefined;

    if (response.supplierProvidedTotal !== undefined) {
      const supplierTotal = roundMoney(toDecimal(response.supplierProvidedTotal)).toNumber();
      if (!isDecimalEqual(toDecimal(supplierTotal), toDecimal(calculatedTotal))) {
        hasTotalMismatch = true;
        totalMismatchDifference = subtractDecimals(supplierTotal, calculatedTotal).toNumber();
        rejectionReasons.push('QUOTE_TOTAL_MISMATCH');
        reasons.push('QUOTE_TOTAL_MISMATCH');

        this.emitAudit('QUOTE_TOTAL_MISMATCH', response.id, {
          calculatedTotal,
          supplierProvidedTotal: supplierTotal,
          difference: totalMismatchDifference,
        });
      }
    }

    // 6. Delivery Turnaround & SLA Feasibility
    let deliveryCommitment: 'CONFIRMED' | 'UNKNOWN' | 'EXCEEDED' = 'UNKNOWN';
    let confirmedDeliveryEta = response.confirmedDeliveryEta;

    if (response.deliveryEtaHours !== undefined && response.deliveryEtaHours > 0) {
      confirmedDeliveryEta = new Date(
        response.receivedAt.getTime() + response.deliveryEtaHours * 3600 * 1000
      );
    }

    if (confirmedDeliveryEta && rfq) {
      if (confirmedDeliveryEta.getTime() > rfq.deliveryDeadline.getTime()) {
        deliveryCommitment = 'EXCEEDED';
        rejectionReasons.push('DELIVERY_DEADLINE_EXCEEDED');
      } else {
        deliveryCommitment = 'CONFIRMED';
      }
    } else {
      reasons.push('DELIVERY_TIME_UNKNOWN');
    }

    // 7. Quote Validity & Expiration
    const defaultValidUntil = new Date(response.receivedAt.getTime() + 24 * 3600 * 1000);
    const validUntil = response.validUntil ?? defaultValidUntil;

    if (validUntil.getTime() <= response.receivedAt.getTime()) {
      rejectionReasons.push('QUOTE_EXPIRED');
    } else if (referenceTime.getTime() > validUntil.getTime()) {
      rejectionReasons.push('QUOTE_EXPIRED');
    }

    // 8. Synthesize Final Status
    let status: QuoteStatus;

    if (rejectionReasons.length > 0) {
      if (rejectionReasons.includes('QUOTE_EXPIRED')) {
        status = 'EXPIRED';
      } else {
        status = 'INVALID';
      }
    } else if (hasPartialItem) {
      status = 'PARTIAL';
      reasons.push('PARTIAL_QUANTITY_OFFERED');
    } else {
      status = 'VALID';
      reasons.push('QUOTE_VALID');
    }

    const quoteId = `quote_${randomUUID().slice(0, 8)}`;
    const now = new Date();

    const quote: Quote = {
      id: quoteId,
      rfqId: response.rfqId,
      candidateId: response.candidateId,
      supplierName: response.supplierName,
      responseId: response.id,
      channel: response.channel,
      currency: 'INR',
      lineItems: quoteLineItems,
      subtotal,
      deliveryFee,
      tax,
      otherCharges,
      total: calculatedTotal,
      supplierProvidedTotal: response.supplierProvidedTotal,
      isSimulated: response.isSimulated,
      hasTotalMismatch,
      totalMismatchDifference,
      deliveryEtaHours: response.deliveryEtaHours,
      confirmedDeliveryEta,
      deliveryCommitment,
      validUntil,
      status,
      reasons: Array.from(new Set([...rejectionReasons, ...reasons])),
      rejectionReasons,
      idempotencyKey: dedupeKey,
      receivedAt: response.receivedAt,
      normalizedAt: now,
      updatedAt: now,
      response,
    };

    // 9. Store & Link
    this.quotes.set(quoteId, quote);
    this.idempotencyStore.set(dedupeKey, quote);

    const existingRfqQuotes = this.quotesByRfq.get(response.rfqId) || [];
    this.quotesByRfq.set(response.rfqId, [...existingRfqQuotes, quote]);

    response.quoteId = quoteId;
    response.status = status === 'INVALID' ? 'REJECTED' : 'NORMALIZED';

    // 10. Audit Events
    this.emitAudit('QUOTE_CREATED', quoteId, {
      rfqId: quote.rfqId,
      candidateId: quote.candidateId,
      status: quote.status,
      total: quote.total,
    });

    if (quote.status === 'VALID') {
      this.emitAudit('QUOTE_VALID', quoteId, { total: quote.total });
    } else if (quote.status === 'PARTIAL') {
      this.emitAudit('QUOTE_PARTIAL', quoteId, { total: quote.total });
    } else if (quote.status === 'INVALID') {
      this.emitAudit('QUOTE_INVALID', quoteId, { rejectionReasons: quote.rejectionReasons });
    } else if (quote.status === 'EXPIRED') {
      this.emitAudit('QUOTE_EXPIRED', quoteId, { validUntil: quote.validUntil.toISOString() });
    }

    return {
      quote,
      isDuplicate: false,
    };
  }

  public getQuote(id: string): Quote | undefined {
    return this.quotes.get(id);
  }

  public getQuotesForRFQ(rfqId: string, statusFilter?: QuoteStatus): Quote[] {
    const list = this.quotesByRfq.get(rfqId) || [];
    if (!statusFilter) return list;
    return list.filter((q) => q.status === statusFilter);
  }

  public listQuotes(): Quote[] {
    return Array.from(this.quotes.values());
  }

  public reset(): void {
    this.quotes.clear();
    this.quotesByRfq.clear();
    this.idempotencyStore.clear();
  }

  private emitAudit(eventType: string, aggregateId: string, payload: Record<string, unknown>): void {
    eventBus.publish({
      id: randomUUID(),
      name: eventType,
      aggregateId,
      timestamp: new Date().toISOString(),
      payload,
    }).catch(() => {});
  }
}

export const quoteNormalizationService = new QuoteNormalizationService();

