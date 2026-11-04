import {
  isDecimalEqual,
  roundMoney,
  toDecimal,
} from '../domain/procurement/decimal';
import { QuantityAllocationResultItem } from './AllocationEngine';
import { AllocationValidationError, validateMonetaryConservation, validateNonNegativity } from './validation';

export interface LineCostInput {
  demandLineId?: string;
  residentOrderId?: string;
  productId?: string;
  productName?: string;
  unitPrice: number;
  subtotal: number;
  tax?: number;
  deliveryFee?: number;
  otherCharges?: number;
  unit?: string;
}

export interface ProcurementFinancialsInput {
  unitPrice?: number;
  subtotal: number;
  tax: number;
  deliveryFee: number;
  otherCharges: number;
  total: number;
  currency?: string;
  lineCosts?: LineCostInput[];
}

export interface ResidentCostItem {
  residentOrderId: string;
  /**
   * Per-line demand key carried through from quantity allocation. Always
   * populated by the pipeline; optional only for backward compatibility
   * with previously constructed items.
   */
  demandLineId?: string;
  residentReference: string;
  requestedQuantity: number;
  allocatedQuantity: number;
  unitPrice: number;
  subtotal: number;
  allocatedTax: number;
  allocatedDeliveryFee: number;
  allocatedOtherCharges: number;
  totalAmount: number;
}

export class CostAllocationService {
  /**
   * Deterministically calculates financial obligations per resident based on fulfilled quantities.
   *
   * Enforces:
   * 1. Exact Decimal arithmetic (INR 2 decimal places / paise precision).
   * 2. Zero paise leakage: SUM(resident amounts) == authoritative total procurement cost.
   * 3. Line-item integrity: resident.total == subtotal + tax + delivery + other.
   * 4. Residual paise allocation applied deterministically to the largest share.
   */
  public allocateCosts(
    quantityAllocations: QuantityAllocationResultItem[],
    financials: ProcurementFinancialsInput
  ): ResidentCostItem[] {
    const totalAllocated = quantityAllocations.reduce(
      (sum, item) => sum + item.allocatedQuantity,
      0
    );

    // Validate authoritative procurement cost integrity: total == subtotal + tax + deliveryFee + otherCharges
    const authoritativeSubtotal = toDecimal(financials.subtotal);
    const authoritativeTax = toDecimal(financials.tax);
    const authoritativeDelivery = toDecimal(financials.deliveryFee);
    const authoritativeOther = toDecimal(financials.otherCharges);
    const authoritativeTotal = toDecimal(financials.total);

    const calculatedTotal = authoritativeSubtotal
      .plus(authoritativeTax)
      .plus(authoritativeDelivery)
      .plus(authoritativeOther);

    if (!isDecimalEqual(calculatedTotal, authoritativeTotal)) {
      throw new AllocationValidationError([
        `INVALID_FINANCIAL_INPUT: Procurement components (subtotal: ${authoritativeSubtotal}, tax: ${authoritativeTax}, delivery: ${authoritativeDelivery}, other: ${authoritativeOther}) sum to ₹${calculatedTotal.toString()}, which does not match total ₹${authoritativeTotal.toString()}`,
      ]);
    }

    // Zero allocation case (e.g. supplier fulfillment failed completely)
    if (totalAllocated === 0 || quantityAllocations.length === 0) {
      return quantityAllocations.map((item) => ({
        residentOrderId: item.residentOrderId,
        demandLineId: item.demandLineId ?? item.residentOrderId,
        residentReference: item.residentReference,
        requestedQuantity: item.requestedQuantity,
        allocatedQuantity: 0,
        unitPrice: financials.unitPrice || 0,
        subtotal: 0,
        allocatedTax: 0,
        allocatedDeliveryFee: 0,
        allocatedOtherCharges: 0,
        totalAmount: 0,
      }));
    }

    const decTotalAllocated = toDecimal(totalAllocated);

    const hasLineCosts =
      financials.lineCosts &&
      financials.lineCosts.length > 0 &&
      financials.lineCosts.some((lc) => lc.unitPrice > 0 || lc.subtotal > 0);

    // Cost breakdown per resident / demand item
    const preliminaryItems = quantityAllocations.map((item) => {
      const decAlloc = toDecimal(item.allocatedQuantity);

      let subtotal: ReturnType<typeof toDecimal>;
      let unitPrice = 0;
      let allocatedTax: ReturnType<typeof toDecimal>;
      let allocatedDeliveryFee: ReturnType<typeof toDecimal>;
      let allocatedOtherCharges: ReturnType<typeof toDecimal>;

      if (hasLineCosts) {
        let lc: LineCostInput;
        const isSingleItem =
          quantityAllocations.length === 1 && financials.lineCosts!.length === 1;

        if (isSingleItem) {
          // Rule 3 & 6: Resident-order fallback permitted only when there is exactly
          // one financial line and exactly one allocation line.
          lc = financials.lineCosts![0];
        } else {
          // Multi-item allocation: Rules 1, 2, 4, 5
          // Rule 1: Exact demandLineId matching is authoritative.
          // Rule 2: Never allow a shared residentOrderId to match a different product line.
          // Rule 4: If an exact demand-line match is missing or ambiguous, fail closed.
          // Rule 5: Do not silently fall back to array index or the first financial line.
          if (!item.demandLineId) {
            throw new AllocationValidationError([
              `DEMAND_LINE_COST_UNMATCHED: Allocation item for resident order '${item.residentOrderId}' lacks a demandLineId in multi-item allocation`,
            ]);
          }

          const matches = financials.lineCosts!.filter(
            (c) => Boolean(c.demandLineId && c.demandLineId === item.demandLineId)
          );

          if (matches.length === 0) {
            throw new AllocationValidationError([
              `DEMAND_LINE_COST_UNMATCHED: No financial line cost matched demandLineId '${item.demandLineId}' for resident order '${item.residentOrderId}'`,
            ]);
          }

          if (matches.length > 1) {
            throw new AllocationValidationError([
              `DEMAND_LINE_COST_AMBIGUOUS: Multiple financial line costs (${matches.length}) matched demandLineId '${item.demandLineId}'`,
            ]);
          }

          lc = matches[0];
        }

        unitPrice = lc.unitPrice;
        const lineUnitPriceDec = toDecimal(lc.unitPrice);

        // Subtotal based on line unit price and allocated quantity
        if (lc.subtotal !== undefined && item.requestedQuantity > 0 && item.allocatedQuantity === item.requestedQuantity) {
          subtotal = roundMoney(toDecimal(lc.subtotal));
        } else {
          subtotal = roundMoney(lineUnitPriceDec.times(decAlloc));
        }

        // Apportion tax, delivery, and other charges proportionally to line subtotal
        if (authoritativeSubtotal.isZero()) {
          allocatedTax = toDecimal(0);
          allocatedDeliveryFee = toDecimal(0);
          allocatedOtherCharges = toDecimal(0);
        } else {
          const subtotalShare = subtotal.dividedBy(authoritativeSubtotal);
          allocatedTax = roundMoney(authoritativeTax.times(subtotalShare));
          allocatedDeliveryFee = roundMoney(authoritativeDelivery.times(subtotalShare));
          allocatedOtherCharges = roundMoney(authoritativeOther.times(subtotalShare));
        }
      } else {
        const share = decAlloc.dividedBy(decTotalAllocated);

        subtotal = roundMoney(authoritativeSubtotal.times(share));
        allocatedTax = roundMoney(authoritativeTax.times(share));
        allocatedDeliveryFee = roundMoney(authoritativeDelivery.times(share));
        allocatedOtherCharges = roundMoney(authoritativeOther.times(share));

        unitPrice =
          financials.unitPrice !== undefined
            ? financials.unitPrice
            : item.allocatedQuantity > 0
            ? roundMoney(subtotal.dividedBy(decAlloc)).toNumber()
            : 0;
      }

      return {
        residentOrderId: item.residentOrderId,
        demandLineId: item.demandLineId ?? item.residentOrderId,
        residentReference: item.residentReference,
        requestedQuantity: item.requestedQuantity,
        allocatedQuantity: item.allocatedQuantity,
        unitPrice,
        subtotalDec: subtotal,
        taxDec: allocatedTax,
        deliveryDec: allocatedDeliveryFee,
        otherDec: allocatedOtherCharges,
      };
    });

    // Residual paise reconciliation for each cost component
    const sumSubtotal = preliminaryItems.reduce((acc, i) => acc.plus(i.subtotalDec), toDecimal(0));
    const sumTax = preliminaryItems.reduce((acc, i) => acc.plus(i.taxDec), toDecimal(0));
    const sumDelivery = preliminaryItems.reduce((acc, i) => acc.plus(i.deliveryDec), toDecimal(0));
    const sumOther = preliminaryItems.reduce((acc, i) => acc.plus(i.otherDec), toDecimal(0));

    const diffSubtotal = authoritativeSubtotal.minus(sumSubtotal);
    const diffTax = authoritativeTax.minus(sumTax);
    const diffDelivery = authoritativeDelivery.minus(sumDelivery);
    const diffOther = authoritativeOther.minus(sumOther);

    // Identify target resident for residual paise: largest allocation, tie-breaker: stable residentOrderId
    const sortedForResidual = [...preliminaryItems].sort((a, b) => {
      const diff = b.allocatedQuantity - a.allocatedQuantity;
      if (Math.abs(diff) > 1e-9) return diff;
      return a.residentOrderId.localeCompare(b.residentOrderId);
    });

    if (sortedForResidual.length > 0) {
      const target = sortedForResidual[0];
      if (!diffSubtotal.isZero()) {
        const candidate = target.subtotalDec.plus(diffSubtotal);
        if (candidate.lessThan(0)) {
          throw new AllocationValidationError([
            `RESIDUAL_PAISE_REJECTED: Residual subtotal adjustment (${diffSubtotal.toString()}) would make target allocation negative (${candidate.toString()})`,
          ]);
        }
        target.subtotalDec = candidate;
      }
      if (!diffTax.isZero()) {
        const candidate = target.taxDec.plus(diffTax);
        if (candidate.lessThan(0)) {
          throw new AllocationValidationError([
            `RESIDUAL_PAISE_REJECTED: Residual tax adjustment (${diffTax.toString()}) would make target allocation negative (${candidate.toString()})`,
          ]);
        }
        target.taxDec = candidate;
      }
      if (!diffDelivery.isZero()) {
        const candidate = target.deliveryDec.plus(diffDelivery);
        if (candidate.lessThan(0)) {
          throw new AllocationValidationError([
            `RESIDUAL_PAISE_REJECTED: Residual delivery adjustment (${diffDelivery.toString()}) would make target allocation negative (${candidate.toString()})`,
          ]);
        }
        target.deliveryDec = candidate;
      }
      if (!diffOther.isZero()) {
        const candidate = target.otherDec.plus(diffOther);
        if (candidate.lessThan(0)) {
          throw new AllocationValidationError([
            `RESIDUAL_PAISE_REJECTED: Residual other charges adjustment (${diffOther.toString()}) would make target allocation negative (${candidate.toString()})`,
          ]);
        }
        target.otherDec = candidate;
      }
    }

    // Assemble final resident cost records
    const finalResults: ResidentCostItem[] = preliminaryItems.map((item) => {
      const totalResidentDec = item.subtotalDec
        .plus(item.taxDec)
        .plus(item.deliveryDec)
        .plus(item.otherDec);

      validateNonNegativity({
        subtotal: item.subtotalDec,
        allocatedTax: item.taxDec,
        allocatedDeliveryFee: item.deliveryDec,
        allocatedOtherCharges: item.otherDec,
        totalAmount: totalResidentDec,
      });

      return {
        residentOrderId: item.residentOrderId,
        demandLineId: item.demandLineId,
        residentReference: item.residentReference,
        requestedQuantity: item.requestedQuantity,
        allocatedQuantity: item.allocatedQuantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotalDec.toNumber(),
        allocatedTax: item.taxDec.toNumber(),
        allocatedDeliveryFee: item.deliveryDec.toNumber(),
        allocatedOtherCharges: item.otherDec.toNumber(),
        totalAmount: totalResidentDec.toNumber(),
      };
    });

    // Final total conservation invariant
    const totalResidentSum = finalResults.reduce(
      (acc, item) => acc.plus(toDecimal(item.totalAmount)),
      toDecimal(0)
    );
    validateMonetaryConservation(totalResidentSum, authoritativeTotal);

    return finalResults;
  }
}

export const costAllocationService = new CostAllocationService();
