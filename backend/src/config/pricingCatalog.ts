import { SEED_IDS } from './seedConstants';

export interface CatalogPriceReference {
  productId?: string;
  name: string;
  keywords: string[];
  basePrice: number;
  minPrice: number;
  maxPrice: number;
  unit: string;
}

export const CATALOG_REFERENCE_PRICES: CatalogPriceReference[] = [
  {
    productId: SEED_IDS.products.ambemoharRice,
    name: 'Ambemohar Rice',
    keywords: ['ambemohar rice', 'ambemohar', 'ambemohor'],
    basePrice: 95.0,
    minPrice: 88.0,
    maxPrice: 102.0,
    unit: 'kg',
  },
  {
    productId: SEED_IDS.products.rice,
    name: 'Rice (Sona Masoori)',
    keywords: ['rice', 'sona masoori', 'basmati', 'chawal'],
    basePrice: 85.0,
    minPrice: 78.0,
    maxPrice: 90.0,
    unit: 'kg',
  },
  {
    productId: SEED_IDS.products.sugar,
    name: 'Sugar (Refined)',
    keywords: ['sugar', 'cheeni', 'chini', 'sakhar', 'चीनी', 'साखर'],
    basePrice: 44.0,
    minPrice: 42.0,
    maxPrice: 46.0,
    unit: 'kg',
  },
  {
    productId: SEED_IDS.products.maggi,
    name: 'Maggi 2-Minute Noodles',
    keywords: ['maggi', 'maggi 2-minute', 'noodles', 'maggi noodles'],
    basePrice: 14.0,
    minPrice: 13.0,
    maxPrice: 15.0,
    unit: 'pack',
  },
  {
    productId: SEED_IDS.products.wheat,
    name: 'Wheat Flour (Atta)',
    keywords: ['wheat', 'atta', 'flour', 'sharbati'],
    basePrice: 45.0,
    minPrice: 40.0,
    maxPrice: 50.0,
    unit: 'kg',
  },
  {
    productId: SEED_IDS.products.cookingOil,
    name: 'Cooking Oil (Sunflower)',
    keywords: ['cooking oil', 'sunflower oil', 'sunflower', 'oil', 'tel'],
    basePrice: 165.0,
    minPrice: 155.0,
    maxPrice: 175.0,
    unit: 'litre',
  },
  {
    productId: SEED_IDS.products.detergent,
    name: 'Washing Powder Detergent',
    keywords: ['detergent', 'washing powder', 'surf'],
    basePrice: 125.0,
    minPrice: 115.0,
    maxPrice: 135.0,
    unit: 'kg',
  },
  {
    productId: SEED_IDS.products.cleaningLiquid,
    name: 'Surface Cleaning Liquid',
    keywords: ['cleaning liquid', 'floor cleaner', 'surface cleaner'],
    basePrice: 115.0,
    minPrice: 105.0,
    maxPrice: 125.0,
    unit: 'litre',
  },
  {
    productId: SEED_IDS.products.groundnut,
    name: 'Groundnut (Peanuts)',
    keywords: ['groundnut', 'peanuts', 'shengdana', 'mungfali'],
    basePrice: 120.0,
    minPrice: 115.0,
    maxPrice: 128.0,
    unit: 'kg',
  },
  {
    productId: SEED_IDS.products.toothbrushes,
    name: 'Toothbrush Set',
    keywords: ['toothbrush', 'toothbrushes', 'brush'],
    basePrice: 60.0,
    minPrice: 55.0,
    maxPrice: 65.0,
    unit: 'pack',
  },
  {
    productId: SEED_IDS.products.bananas,
    name: 'Fresh Bananas',
    keywords: ['banana', 'bananas', 'kela'],
    basePrice: 50.0,
    minPrice: 45.0,
    maxPrice: 55.0,
    unit: 'dozen',
  },
  {
    productId: SEED_IDS.products.oranges,
    name: 'Fresh Oranges',
    keywords: ['orange', 'oranges', 'santre', 'mosambi'],
    basePrice: 80.0,
    minPrice: 72.0,
    maxPrice: 88.0,
    unit: 'kg',
  },
  {
    productId: SEED_IDS.products.apple,
    name: 'Fresh Apples',
    keywords: ['apple', 'apples', 'seb'],
    basePrice: 140.0,
    minPrice: 125.0,
    maxPrice: 155.0,
    unit: 'kg',
  },
  {
    productId: SEED_IDS.products.bajra,
    name: 'Organic Bajra (Pearl Millet)',
    keywords: ['bajra', 'pearl millet', 'millet'],
    basePrice: 42.0,
    minPrice: 38.0,
    maxPrice: 48.0,
    unit: 'kg',
  },
  {
    productId: SEED_IDS.products.darkChocolate,
    name: 'Dark Chocolate Bar',
    keywords: ['dark chocolate', 'chocolate'],
    basePrice: 95.0,
    minPrice: 85.0,
    maxPrice: 105.0,
    unit: 'pack',
  },
  {
    productId: SEED_IDS.products.maida,
    name: 'Refined Wheat Flour (Maida)',
    keywords: ['maida', 'refined flour'],
    basePrice: 38.0,
    minPrice: 35.0,
    maxPrice: 44.0,
    unit: 'kg',
  },
  {
    name: 'Jowar Flour (Jwari Atta)',
    keywords: ['jowar', 'jwari', 'jowar flour', 'jwari flour', 'jwari ka atta', 'jowar atta', 'ज्वारी'],
    basePrice: 58.0,
    minPrice: 52.0,
    maxPrice: 66.0,
    unit: 'kg',
  },
  {
    name: 'Fresh Potatoes (Aalu)',
    keywords: ['potato', 'potatoes', 'aalu', 'aloo', 'alu', 'batata', 'आलू', 'बटाटा'],
    basePrice: 30.0,
    minPrice: 24.0,
    maxPrice: 38.0,
    unit: 'kg',
  },
  {
    name: 'Fresh Tomatoes (Tamatar)',
    keywords: ['tomato', 'tomatoes', 'tamatar', 'tameta', 'टमाटर', 'टोमॅटो'],
    basePrice: 35.0,
    minPrice: 28.0,
    maxPrice: 45.0,
    unit: 'kg',
  },
  {
    name: 'Fresh Okra (Bhindi)',
    keywords: ['bhindi', 'okra', 'ladyfinger', 'lady finger', 'भेंडी', 'भिंडी'],
    basePrice: 48.0,
    minPrice: 40.0,
    maxPrice: 58.0,
    unit: 'kg',
  },
  {
    name: 'Fresh Cow Milk (Doodh)',
    keywords: ['milk', 'doodh', 'dudh', 'cow milk', 'दूध'],
    basePrice: 62.0,
    minPrice: 58.0,
    maxPrice: 68.0,
    unit: 'litre',
  },
  {
    name: 'Rolled Oats',
    keywords: ['oats', 'rolled oats', 'oatmeal', 'quaker oats', 'ओट्स'],
    basePrice: 160.0,
    minPrice: 140.0,
    maxPrice: 190.0,
    unit: 'kg',
  },
  {
    name: 'Fresh Onions (Pyaz)',
    keywords: ['onion', 'onions', 'pyaz', 'pyaaz', 'kanda', 'कांदा', 'प्याज'],
    basePrice: 38.0,
    minPrice: 30.0,
    maxPrice: 48.0,
    unit: 'kg',
  },
  {
    name: 'Toor Dal (Arhar Dal)',
    keywords: ['toor dal', 'arhar dal', 'tur dal', 'tuvar dal', 'तूर डाळ'],
    basePrice: 145.0,
    minPrice: 135.0,
    maxPrice: 165.0,
    unit: 'kg',
  },
];

const CATALOG_BY_ID = new Map<string, CatalogPriceReference>();
for (const entry of CATALOG_REFERENCE_PRICES) {
  if (entry.productId) {
    CATALOG_BY_ID.set(entry.productId, entry);
  }
}

/**
 * Returns benchmark market pricing for a product from the verified catalog.
 * Falls back gracefully to sensible grocery range for unseen products.
 */
export function getCatalogReferencePrice(
  productName: string,
  productId?: string
): { basePrice: number; minPrice: number; maxPrice: number; unit?: string } {
  if (productId && CATALOG_BY_ID.has(productId)) {
    const entry = CATALOG_BY_ID.get(productId)!;
    return {
      basePrice: entry.basePrice,
      minPrice: entry.minPrice,
      maxPrice: entry.maxPrice,
      unit: entry.unit,
    };
  }

  const lower = productName.toLowerCase();

  // 1. Exact name or keyword match
  for (const entry of CATALOG_REFERENCE_PRICES) {
    if (
      lower === entry.name.toLowerCase() ||
      entry.keywords.some((kw) => lower === kw.toLowerCase())
    ) {
      return {
        basePrice: entry.basePrice,
        minPrice: entry.minPrice,
        maxPrice: entry.maxPrice,
        unit: entry.unit,
      };
    }
  }

  // 2. Longest matching keyword first (prevents "atta" matching before "jwari ka atta")
  let bestMatch: CatalogPriceReference | null = null;
  let bestKwLen = 0;

  for (const entry of CATALOG_REFERENCE_PRICES) {
    for (const kw of entry.keywords) {
      if (lower.includes(kw.toLowerCase()) && kw.length > bestKwLen) {
        bestMatch = entry;
        bestKwLen = kw.length;
      }
    }
  }

  if (bestMatch) {
    return {
      basePrice: bestMatch.basePrice,
      minPrice: bestMatch.minPrice,
      maxPrice: bestMatch.maxPrice,
      unit: bestMatch.unit,
    };
  }

  // Plausible grocery fallback for unseen open-world products
  return {
    basePrice: 65.0,
    minPrice: 45.0,
    maxPrice: 95.0,
    unit: 'kg',
  };
}
