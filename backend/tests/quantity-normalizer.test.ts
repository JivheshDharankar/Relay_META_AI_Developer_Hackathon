import {
  calculateLineSubtotal,
  computePackagePricing,
  normalizeQuantity,
  validateGroceryPriceSanity,
} from '../src/domain/procurement/quantityNormalizer';
import { normalizeIndicNumberWords } from '../src/agent/intent/multilingual';

describe('Intelligent Quantity & Unit Normalization', () => {
  describe('normalizeQuantity (Dimensions & Commercial Conversions)', () => {
    it('normalizes weight units (grams to canonical grams and commercial kg)', () => {
      const q500g = normalizeQuantity(500, 'g');
      expect(q500g.canonicalQuantity).toBe(500);
      expect(q500g.canonicalUnit).toBe('grams');
      expect(q500g.commercialQuantity).toBe(0.5);
      expect(q500g.commercialUnit).toBe('kg');
      expect(q500g.dimension).toBe('weight');

      const q250g = normalizeQuantity(250, 'grams');
      expect(q250g.commercialQuantity).toBe(0.25);
      expect(q250g.commercialUnit).toBe('kg');

      const q750g = normalizeQuantity(750, 'gm');
      expect(q750g.commercialQuantity).toBe(0.75);
      expect(q750g.commercialUnit).toBe('kg');

      const q4kg = normalizeQuantity(4, 'kg');
      expect(q4kg.canonicalQuantity).toBe(4000);
      expect(q4kg.canonicalUnit).toBe('grams');
      expect(q4kg.commercialQuantity).toBe(4);
      expect(q4kg.commercialUnit).toBe('kg');
    });

    it('normalizes volume units (ml to canonical ml and commercial litre)', () => {
      const q500ml = normalizeQuantity(500, 'ml');
      expect(q500ml.canonicalQuantity).toBe(500);
      expect(q500ml.canonicalUnit).toBe('ml');
      expect(q500ml.commercialQuantity).toBe(0.5);
      expect(q500ml.commercialUnit).toBe('litre');
      expect(q500ml.dimension).toBe('volume');

      const q1L = normalizeQuantity(1, 'litre');
      expect(q1L.canonicalQuantity).toBe(1000);
      expect(q1L.canonicalUnit).toBe('ml');
      expect(q1L.commercialQuantity).toBe(1);
      expect(q1L.commercialUnit).toBe('litre');
    });

    it('normalizes count and dozen units', () => {
      const q1Dozen = normalizeQuantity(1, 'dozen');
      expect(q1Dozen.canonicalQuantity).toBe(12);
      expect(q1Dozen.canonicalUnit).toBe('units');
      expect(q1Dozen.dimension).toBe('count');

      const q2Packs = normalizeQuantity(2, 'packs');
      expect(q2Packs.canonicalQuantity).toBe(2);
      expect(q2Packs.canonicalUnit).toBe('packs');
      expect(q2Packs.commercialUnit).toBe('pack');
    });

    it('fails closed on invalid non-positive numbers', () => {
      expect(() => normalizeQuantity(0, 'kg')).toThrow(/INVALID_QUANTITY/);
      expect(() => normalizeQuantity(-5, 'kg')).toThrow(/INVALID_QUANTITY/);
      expect(() => normalizeQuantity(NaN, 'kg')).toThrow(/INVALID_QUANTITY/);
    });
  });

  describe('calculateLineSubtotal (Deterministic Prevention of 1000x Inflation)', () => {
    it('CRITICAL: 500 grams of oats at ₹65/kg evaluates to ₹32.50, never ₹32,500', () => {
      const subtotal = calculateLineSubtotal(500, 'g', 65.0, 'kg');
      expect(subtotal).toBe(32.5);
    });

    it('CRITICAL: 500 grams of oats at ₹160/kg evaluates to ₹80.00', () => {
      const subtotal = calculateLineSubtotal(500, 'grams', 160.0, 'kg');
      expect(subtotal).toBe(80.0);
    });

    it('calculates full grocery basket accurately', () => {
      // 4 kg jwari ka atta @ ₹58/kg
      const jowar = calculateLineSubtotal(4, 'kg', 58.0, 'kg');
      expect(jowar).toBe(232.0);

      // 5 kg chini @ ₹44/kg
      const chini = calculateLineSubtotal(5, 'kg', 44.0, 'kg');
      expect(chini).toBe(220.0);

      // 3 kg aalu @ ₹30/kg
      const aalu = calculateLineSubtotal(3, 'kg', 30.0, 'kg');
      expect(aalu).toBe(90.0);

      // 0.5 kg (adha kilo) tamatar @ ₹35/kg
      const tamatar = calculateLineSubtotal(0.5, 'kg', 35.0, 'kg');
      expect(tamatar).toBe(17.5);

      // 1 kg bhindi @ ₹48/kg
      const bhindi = calculateLineSubtotal(1, 'kg', 48.0, 'kg');
      expect(bhindi).toBe(48.0);

      // 1 litre doodh @ ₹62/litre
      const doodh = calculateLineSubtotal(1, 'litre', 62.0, 'litre');
      expect(doodh).toBe(62.0);

      // 500 gram oats @ ₹160/kg
      const oats = calculateLineSubtotal(500, 'g', 160.0, 'kg');
      expect(oats).toBe(80.0);

      const totalBasket = jowar + chini + aalu + tamatar + bhindi + doodh + oats;
      expect(totalBasket).toBe(749.5);
      // Realistic total basket under ₹800, completely eliminating the ₹35,684 error!
      expect(totalBasket).toBeLessThan(1000);
    });
  });

  describe('Colloquial Hindi/Hinglish Quantity Word Normalization', () => {
    it('normalizes adha / aadha to 0.5', () => {
      const text = normalizeIndicNumberWords('adha kilo tamatar aur aadha litre doodh');
      expect(text).toContain('0.5');
      expect(text).toContain('kilo tamatar');
      expect(text).toContain('litre doodh');
    });

    it('normalizes dedh and dhai to 1.5 and 2.5', () => {
      const text = normalizeIndicNumberWords('dedh kilo chini aur dhai kilo aalu');
      expect(text).toContain('1.5');
      expect(text).toContain('2.5');
    });

    it('normalizes paav kilo to 0.25 kg while preserving pav bhaji', () => {
      const paavKilo = normalizeIndicNumberWords('paav kilo mirchi');
      expect(paavKilo).toContain('0.25');

      const pavBhaji = normalizeIndicNumberWords('2 pack pav bhaji');
      expect(pavBhaji).toContain('pav bhaji');
      expect(pavBhaji).not.toContain('0.25 bhaji');
    });
  });

  describe('computePackagePricing (Whole-Pack Discrete Mathematics)', () => {
    it('computes whole packages required for bulk quantity', () => {
      // Need 2 kg, available in 500g packs @ ₹60/pack
      const pkg = computePackagePricing(2, 'kg', 500, 'g', 60);
      expect(pkg.packagesRequired).toBe(4);
      expect(pkg.normalizedUnitPrice).toBe(120); // ₹120/kg
      expect(pkg.totalCost).toBe(240);
    });

    it('rounds up to whole packages when non-divisible', () => {
      // Need 1.2 kg, available in 500g packs
      const pkg = computePackagePricing(1.2, 'kg', 500, 'g', 60);
      expect(pkg.packagesRequired).toBe(3); // 3 * 500g = 1.5kg
      expect(pkg.totalCost).toBe(180);
    });
  });

  describe('validateGroceryPriceSanity', () => {
    it('accepts realistic grocery market prices', () => {
      expect(validateGroceryPriceSanity('sugar', 44, 'kg').isSane).toBe(true);
      expect(validateGroceryPriceSanity('oats', 160, 'kg').isSane).toBe(true);
      expect(validateGroceryPriceSanity('milk', 62, 'litre').isSane).toBe(true);
    });

    it('rejects anomalies and corrupted unit rates', () => {
      // If someone multiplied 65 * 1000 = 65,000/kg
      const checkHigh = validateGroceryPriceSanity('oats', 32500, 'kg');
      expect(checkHigh.isSane).toBe(false);
      expect(checkHigh.reason).toContain('Suspiciously high price');

      const checkZero = validateGroceryPriceSanity('milk', 0, 'litre');
      expect(checkZero.isSane).toBe(false);
    });
  });
});

