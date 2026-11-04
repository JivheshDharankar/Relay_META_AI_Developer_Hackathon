import { roundMoney } from './decimal';

export type PhysicalDimension = 'weight' | 'volume' | 'count';

export interface NormalizedQuantity {
  /** Canonical integer/float representation: grams for weight, ml for volume, count for units/packs */
  canonicalQuantity: number;
  /** Canonical unit enum: 'grams' | 'ml' | 'packs' | 'units' */
  canonicalUnit: 'grams' | 'ml' | 'packs' | 'units';
  /** Base commercial unit quantity (e.g. 0.5 for 500g in kg, 1.0 for 1L in litres) */
  commercialQuantity: number;
  /** Base commercial unit name: 'kg' | 'litre' | 'pack' | 'unit' */
  commercialUnit: 'kg' | 'litre' | 'pack' | 'unit';
  /** Original user expression preservation */
  displayQuantity: string;
  /** Physical dimension */
  dimension: PhysicalDimension;
}

export interface PackagePricingDetails {
  packageSize: number; // e.g. 500 (grams or ml)
  packageUnit: string; // e.g. 'g' or 'ml'
  packagePrice: number; // e.g. 60 (INR)
  normalizedUnitPrice: number; // e.g. 120 (INR/kg)
  packagesRequired: number; // e.g. 4 for 2kg
  totalCost: number; // e.g. 240 (INR)
}

/**
 * Standard unit alias mappings for deterministic parsing.
 */
const WEIGHT_UNIT_ALIASES = new Set([
  'g',
  'gm',
  'gms',
  'gram',
  'grams',
  'grm',
  'ग्राम',
  'ग्रॅम',
  'kg',
  'kilo',
  'kilos',
  'kilogram',
  'kilograms',
  'kgs',
  'किलो',
  'किलोग्राम',
]);

const VOLUME_UNIT_ALIASES = new Set([
  'ml',
  'mls',
  'milliliter',
  'milliliters',
  'millilitre',
  'millilitres',
  'मिली',
  'l',
  'lt',
  'ltr',
  'litre',
  'litres',
  'liter',
  'liters',
  'लीटर',
  'लिटर',
]);

const COUNT_UNIT_ALIASES = new Set([
  'pack',
  'packs',
  'packet',
  'packets',
  'box',
  'boxes',
  'bottle',
  'bottles',
  'carton',
  'cartons',
  'pouch',
  'pouches',
  'tin',
  'tins',
  'sachet',
  'sachets',
  'unit',
  'units',
  'piece',
  'pieces',
  'pc',
  'pcs',
  'पॅक',
  'पॅकेट',
]);

/**
 * Normalizes any quantity and unit into its canonical internal representation
 * and comparable commercial unit.
 */
export function normalizeQuantity(quantity: number, rawUnit: string): NormalizedQuantity {
  if (typeof quantity !== 'number' || Number.isNaN(quantity) || quantity <= 0) {
    throw new Error(`INVALID_QUANTITY: Quantity must be a positive finite number, received ${quantity}`);
  }

  const u = rawUnit.trim().toLowerCase();

  // 1. Weight Units
  if (WEIGHT_UNIT_ALIASES.has(u)) {
    const isGrams = ['g', 'gm', 'gms', 'gram', 'grams', 'grm', 'ग्राम', 'ग्रॅम'].includes(u);
    const canonicalQuantity = isGrams ? quantity : Math.round(quantity * 1000);
    const commercialQuantity = isGrams ? quantity / 1000 : quantity;
    const displayQuantity = isGrams
      ? `${quantity} g (${commercialQuantity} kg)`
      : `${quantity} kg (${canonicalQuantity} g)`;

    return {
      canonicalQuantity,
      canonicalUnit: 'grams',
      commercialQuantity: roundMoney(commercialQuantity).toNumber(),
      commercialUnit: 'kg',
      displayQuantity,
      dimension: 'weight',
    };
  }

  // 2. Volume Units
  if (VOLUME_UNIT_ALIASES.has(u)) {
    const isMl = ['ml', 'mls', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'मिली'].includes(u);
    const canonicalQuantity = isMl ? quantity : Math.round(quantity * 1000);
    const commercialQuantity = isMl ? quantity / 1000 : quantity;
    const displayQuantity = isMl
      ? `${quantity} ml (${commercialQuantity} litre)`
      : `${quantity} litre (${canonicalQuantity} ml)`;

    return {
      canonicalQuantity,
      canonicalUnit: 'ml',
      commercialQuantity: roundMoney(commercialQuantity).toNumber(),
      commercialUnit: 'litre',
      displayQuantity,
      dimension: 'volume',
    };
  }

  // 3. Count / Pack Units
  const isDozen = ['dozen', 'dozens', 'dz'].includes(u);
  const countMultiplier = isDozen ? 12 : 1;
  const canonicalCount = quantity * countMultiplier;
  const isPack = COUNT_UNIT_ALIASES.has(u);

  return {
    canonicalQuantity: canonicalCount,
    canonicalUnit: isPack ? 'packs' : 'units',
    commercialQuantity: quantity,
    commercialUnit: isPack ? 'pack' : 'unit',
    displayQuantity: isDozen ? `${quantity} dozen (${canonicalCount} units)` : `${quantity} ${rawUnit}`,
    dimension: 'count',
  };
}

/**
 * Calculates line subtotal deterministically based on physical dimensions.
 * GUARANTEE: Never multiplies 500 grams directly by a per-kg unit price!
 */
export function calculateLineSubtotal(
  quantity: number,
  unit: string,
  unitPrice: number,
  pricingUnit?: string
): number {
  if (quantity <= 0 || unitPrice < 0) return 0;

  const normalized = normalizeQuantity(quantity, unit);
  const pUnit = (pricingUnit || normalized.commercialUnit).toLowerCase().trim();

  // 1. Weight Dimension
  if (normalized.dimension === 'weight') {
    if (pUnit === 'g' || pUnit === 'gram' || pUnit === 'grams') {
      // Unit price is already per gram
      return roundMoney(normalized.canonicalQuantity * unitPrice).toNumber();
    }
    // Unit price is per kilogram (standard wholesale/retail benchmark)
    // 500 grams * (1 kg / 1000g) * ₹60/kg = ₹30.00
    return roundMoney(normalized.commercialQuantity * unitPrice).toNumber();
  }

  // 2. Volume Dimension
  if (normalized.dimension === 'volume') {
    if (pUnit === 'ml' || pUnit === 'millilitre') {
      // Unit price is per ml
      return roundMoney(normalized.canonicalQuantity * unitPrice).toNumber();
    }
    // Unit price is per litre (standard benchmark)
    // 500 ml * (1 L / 1000ml) * ₹60/L = ₹30.00
    return roundMoney(normalized.commercialQuantity * unitPrice).toNumber();
  }

  // 3. Count / Pack Dimension
  return roundMoney(normalized.commercialQuantity * unitPrice).toNumber();
}

/**
 * Normalizes package-level pricing into unit pricing and calculates package requirements.
 * E.g., a product listed as ₹60 for a 500g package:
 * - Normalized price = ₹120/kg
 * - For a 2kg request = 4 packages required = ₹240
 */
export function computePackagePricing(
  requestedQuantity: number,
  requestedUnit: string,
  packageSize: number,
  packageUnit: string,
  packagePrice: number
): PackagePricingDetails {
  const reqNorm = normalizeQuantity(requestedQuantity, requestedUnit);
  const pkgNorm = normalizeQuantity(packageSize, packageUnit);

  if (reqNorm.dimension !== pkgNorm.dimension) {
    throw new Error(
      `DIMENSION_MISMATCH: Cannot calculate package price across dimensions (${reqNorm.dimension} vs ${pkgNorm.dimension})`
    );
  }

  // Normalized unit price (e.g. per kg or per litre)
  const normalizedUnitPrice = roundMoney(
    packagePrice / (pkgNorm.canonicalQuantity / 1000)
  ).toNumber();

  // Whole package requirement (cannot buy fractional packages)
  const packagesRequired = Math.ceil(
    reqNorm.canonicalQuantity / pkgNorm.canonicalQuantity
  );
  const totalCost = roundMoney(packagesRequired * packagePrice).toNumber();

  return {
    packageSize,
    packageUnit,
    packagePrice,
    normalizedUnitPrice,
    packagesRequired,
    totalCost,
  };
}

/**
 * Validates price bounds against sensible local grocery thresholds to catch anomalies.
 */
export function validateGroceryPriceSanity(
  productName: string,
  unitPrice: number,
  pricingUnit: string
): { isSane: boolean; reason?: string } {
  if (unitPrice <= 0) {
    return { isSane: false, reason: `Price must be greater than zero for ${productName}` };
  }

  const u = pricingUnit.toLowerCase();
  // Groceries should rarely exceed ₹3000/kg or ₹1000/L under normal circumstances
  const maxThreshold = u.includes('kg') ? 3500 : u.includes('l') ? 1200 : 5000;
  if (unitPrice > maxThreshold) {
    return {
      isSane: false,
      reason: `Suspiciously high price of ₹${unitPrice}/${pricingUnit} for ${productName} (exceeds threshold of ₹${maxThreshold})`,
    };
  }

  return { isSane: true };
}

