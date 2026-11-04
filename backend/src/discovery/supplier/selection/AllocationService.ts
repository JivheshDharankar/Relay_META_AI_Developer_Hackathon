import { randomUUID } from 'crypto';
import {
  addDecimals,
  divideDecimals,
  multiplyDecimals,
  roundMoney,
  toDecimal,
  toDecimalOptional,
  toNonNegativeDecimal,
} from '../../../domain/procurement/decimal';
import { calculateLineSubtotal } from '../../../domain/procurement/quantityNormalizer';
import { Quote } from '../quote/types';
import { ProposedAllocation, SupplierAllocation } from './types';

export interface CalculatedAllocationPlan {
  allocations: SupplierAllocation[];
  financials: {
    subtotal: number;
    deliveryFee: number;
    tax: number;
    otherCharges: number;
    total: number;
    currency: string;
  };
}

export class AllocationService {
  /**
   * Deterministically calculates financial breakdowns for single or multi-supplier allocations
   * using Decimal arithmetic, ensuring zero floating-point drift and strict conservation of funds.
   */
  public calculateAllocations(
    commitmentId: string,
    proposedAllocations: ProposedAllocation[],
    quoteMap: Map<string, Quote>
  ): CalculatedAllocationPlan {
    const allocations: SupplierAllocation[] = [];

    let totalSubtotalDecimal = toDecimal(0);
    let totalDeliveryFeeDecimal = toDecimal(0);
    let totalTaxDecimal = toDecimal(0);
    let totalOtherChargesDecimal = toDecimal(0);
    let grandTotalDecimal = toDecimal(0);

    for (const proposed of proposedAllocations) {
      const quote = quoteMap.get(proposed.quoteId);
      if (!quote) {
        throw new Error(`Quote '${proposed.quoteId}' not found during allocation calculation`);
      }

      if (proposed.quantity <= 0) {
        throw new Error(
          `Proposed allocation quantity must be positive, got ${proposed.quantity} for supplier '${proposed.supplierId}'`
        );
      }

      const lines = Array.isArray(quote.lineItems) ? quote.lineItems : [];
      if (lines.length === 0) {
        throw new Error(`Quote '${proposed.quoteId}' has no line items for allocation`);
      }
      const primaryLine = quote.lineItems[0];
      const unit = primaryLine?.unit ?? 'units';

      // 1. Line subtotal extended PER QUOTED LINE, then summed. Single-line
      // quotes follow the exact legacy arithmetic; multi-line quotes must
      // never price the summed quantity at one line's unit price. The scale
      // factor is exactly 1 for full awards and prorates partial (split)
      // awards deterministically. All Decimal — no floating point.
      let lineSubtotalDecimal;
      let unitPrice: number;
      if (lines.length <= 1) {
        if (
          primaryLine.unitPrice === undefined ||
          primaryLine.unitPrice === null ||
          isNaN(primaryLine.unitPrice)
        ) {
          throw new Error(`Quote '${proposed.quoteId}' line item is missing required unitPrice`);
        }
        if (primaryLine.unitPrice < 0) {
          throw new Error(
            `Quote '${proposed.quoteId}' line item has negative unitPrice: ${primaryLine.unitPrice}`
          );
        }
        unitPrice = primaryLine.unitPrice;
        lineSubtotalDecimal = toDecimal(
          calculateLineSubtotal(
            proposed.quantity,
            unit,
            unitPrice,
            primaryLine.pricingUnit
          )
        );
      } else {
        const totalQuotedQty = lines.reduce((acc, l) => acc + (l.quotedQuantity ?? 0), 0);
        if (totalQuotedQty <= 0) {
          throw new Error(
            `Quote '${proposed.quoteId}' total quoted quantity must be positive, got ${totalQuotedQty}`
          );
        }
        const factor = divideDecimals(proposed.quantity, totalQuotedQty);
        let extendedSum = toDecimal(0);
        for (const line of lines) {
          if (
            line.unitPrice === undefined ||
            line.unitPrice === null ||
            isNaN(line.unitPrice)
          ) {
            throw new Error(`Quote '${proposed.quoteId}' line item is missing required unitPrice`);
          }
          if (line.unitPrice < 0) {
            throw new Error(
              `Quote '${proposed.quoteId}' line item has negative unitPrice: ${line.unitPrice}`
            );
          }
          const lineQty = line.quotedQuantity ?? 0;
          if (lineQty < 0) {
            throw new Error(
              `Quote '${proposed.quoteId}' line item has negative quotedQuantity: ${line.quotedQuantity}`
            );
          }
          const lineExtended = line.lineSubtotal !== undefined && line.lineSubtotal > 0
            ? toDecimal(line.lineSubtotal)
            : toDecimal(calculateLineSubtotal(lineQty, line.unit, line.unitPrice, line.pricingUnit));
          extendedSum = addDecimals(extendedSum, multiplyDecimals(lineExtended, factor));
        }
        lineSubtotalDecimal = roundMoney(extendedSum);
        // Blended record rate so quantity × agreedUnitPrice tracks the true
        // multi-line subtotal on downstream records (single-line keeps the
        // exact quoted price above).
        unitPrice =
          proposed.quantity > 0
            ? roundMoney(divideDecimals(lineSubtotalDecimal, proposed.quantity)).toNumber()
            : 0;
      }

      // 2. Delivery fee & charges for this supplier allocation
      // Optional fees default to 0 if omitted, but negative values and invalid strings are strictly rejected
      const deliveryFeeDecimal = roundMoney(
        toNonNegativeDecimal(toDecimalOptional(quote.deliveryFee, 0), 'Delivery fee')
      );
      const taxDecimal = roundMoney(
        toNonNegativeDecimal(toDecimalOptional(quote.tax, 0), 'Tax')
      );
      const otherChargesDecimal = roundMoney(
        toNonNegativeDecimal(toDecimalOptional(quote.otherCharges, 0), 'Other charges')
      );

      // 3. Allocation total = lineSubtotal + deliveryFee + tax + otherCharges
      const allocationTotalDecimal = roundMoney(
        addDecimals(
          lineSubtotalDecimal,
          deliveryFeeDecimal,
          taxDecimal,
          otherChargesDecimal
        )
      );

      const allocation: SupplierAllocation = {
        id: `alloc_${randomUUID().slice(0, 8)}`,
        commitmentId,
        supplierId: proposed.supplierId,
        supplierName: quote.supplierName,
        quoteId: quote.id,
        allocatedQuantity: proposed.quantity,
        unit,
        agreedUnitPrice: unitPrice,
        lineSubtotal: lineSubtotalDecimal.toNumber(),
        deliveryFee: deliveryFeeDecimal.toNumber(),
        tax: taxDecimal.toNumber(),
        otherCharges: otherChargesDecimal.toNumber(),
        totalAmount: allocationTotalDecimal.toNumber(),
        deliveryEtaHours: quote.deliveryEtaHours,
        confirmedDeliveryEta: quote.confirmedDeliveryEta,
      };

      allocations.push(allocation);

      totalSubtotalDecimal = addDecimals(totalSubtotalDecimal, lineSubtotalDecimal);
      totalDeliveryFeeDecimal = addDecimals(totalDeliveryFeeDecimal, deliveryFeeDecimal);
      totalTaxDecimal = addDecimals(totalTaxDecimal, taxDecimal);
      totalOtherChargesDecimal = addDecimals(totalOtherChargesDecimal, otherChargesDecimal);
      grandTotalDecimal = addDecimals(grandTotalDecimal, allocationTotalDecimal);
    }

    return {
      allocations,
      financials: {
        subtotal: roundMoney(totalSubtotalDecimal).toNumber(),
        deliveryFee: roundMoney(totalDeliveryFeeDecimal).toNumber(),
        tax: roundMoney(totalTaxDecimal).toNumber(),
        otherCharges: roundMoney(totalOtherChargesDecimal).toNumber(),
        total: roundMoney(grandTotalDecimal).toNumber(),
        currency: 'INR',
      },
    };
  }
}

export const allocationService = new AllocationService();

