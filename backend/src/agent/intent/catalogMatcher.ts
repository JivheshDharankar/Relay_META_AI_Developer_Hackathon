import { ProductUnit } from '@prisma/client';
import { SEED_IDS } from '../../config/seedConstants';

export interface CatalogFormAlias {
  /**
   * Form-specific normalized name backed by the same catalog SKU (for example,
   * a flour form of a stocked grain product). Aliases preserve a validated
   * product-form distinction without inventing a separate product ID.
   */
  canonicalName: string;
  keywords: string[];
}

export interface CatalogEntry {
  productId: string;
  canonicalName: string;
  keywords: string[];
  unit: ProductUnit;
  /** Checked before this entry's generic keywords; productId lookup stays on the base entry. */
  formAliases?: CatalogFormAlias[];
  /**
   * Keywords that disqualify this entry. Used by SKUs stocked in an
   * unprocessed form (e.g. grain) so a processed form ("bajra atta")
   * falls through to open-world instead of the mismatched SKU.
   */
  matchExclusions?: string[];
}

/**
 * Deterministic Relay catalog for intent resolution.
 * The model NEVER supplies product IDs; Relay maps the model's normalized
 * product name to an authoritative ID here, or fails closed as unmappable.
 */
export const INTENT_CATALOG: CatalogEntry[] = [
  {
    // Must precede the generic rice entry: first-match wins and
    // "ambemohar rice" contains the word "rice".
    productId: SEED_IDS.products.ambemoharRice,
    canonicalName: 'ambemohar rice',
    keywords: ['ambemohar rice', 'ambemohar', 'ambemohor'],
    unit: ProductUnit.KG,
    matchExclusions: ['atta', 'flour'],
  },
  {
    productId: SEED_IDS.products.rice,
    canonicalName: 'rice',
    keywords: ['rice', 'basmati', 'chawal', 'चावल', 'तांदूळ', 'tandul'],
    unit: ProductUnit.KG,
    matchExclusions: ['atta', 'flour'],
  },
  {
    productId: SEED_IDS.products.wheat,
    canonicalName: 'wheat',
    keywords: ['wheat', 'atta', 'flour', 'sharbati', 'गेहूं', 'गहू', 'gehu', 'gahu'],
    unit: ProductUnit.KG,
    // The wheat SKU is whole wheat atta: refined flour is maida, never this SKU.
    matchExclusions: ['refined'],
    formAliases: [
      {
        canonicalName: 'wheat flour',
        keywords: ['wheat flour', 'whole wheat flour', 'whole wheat atta', 'atta', 'गव्हाचे पीठ', 'गेहूं का आटा'],
      },
    ],
  },
  {
    productId: SEED_IDS.products.cookingOil,
    canonicalName: 'cooking oil',
    keywords: ['cooking oil', 'sunflower oil', 'sunflower', 'oil', 'तेल', 'tel'],
    unit: ProductUnit.LITRE,
    // The cooking-oil SKU is sunflower oil: other seed oils fall through to
    // open-world instead of this mismatched SKU.
    matchExclusions: ['peanut', 'groundnut', 'coconut', 'mustard', 'sesame', 'olive', 'palm'],
  },
  {
    productId: SEED_IDS.products.detergent,
    canonicalName: 'detergent',
    keywords: ['detergent', 'washing powder', 'laundry', 'डिटर्जेंट'],
    unit: ProductUnit.KG,
  },
  {
    productId: SEED_IDS.products.cleaningLiquid,
    canonicalName: 'cleaning liquid',
    keywords: ['cleaning liquid', 'disinfectant', 'surface cleaner', 'floor cleaner'],
    unit: ProductUnit.LITRE,
  },
  {
    productId: SEED_IDS.products.sugar,
    canonicalName: 'sugar',
    keywords: ['sugar', 'cheeni', 'chini', 'sakhar', 'चीनी', 'साखर'],
    unit: ProductUnit.KG,
    // "Sugar free" products are not the sugar SKU.
    matchExclusions: ['free'],
  },
  {
    productId: SEED_IDS.products.groundnut,
    canonicalName: 'groundnut',
    keywords: ['groundnut', 'peanut', 'peanuts', 'moongphali', 'shengdana', 'shengdane', 'मूंगफली', 'शेंगदाणे'],
    unit: ProductUnit.KG,
    // The groundnut SKU is raw groundnuts: peanut oil is a different
    // product (butter/chikki forms are covered by the shared guard).
    matchExclusions: ['oil'],
  },
  {
    productId: SEED_IDS.products.toothbrushes,
    canonicalName: 'toothbrush',
    keywords: ['toothbrush', 'toothbrushes', 'tooth brush', 'brush', 'टूथब्रश'],
    unit: ProductUnit.UNIT,
  },
  {
    productId: SEED_IDS.products.bananas,
    canonicalName: 'banana',
    keywords: ['banana', 'bananas', 'kela', 'kele', 'केला', 'केले', 'केळी'],
    unit: ProductUnit.UNIT,
  },
  {
    productId: SEED_IDS.products.oranges,
    canonicalName: 'orange',
    keywords: ['orange', 'oranges', 'santra', 'santre', 'संतरा', 'संत्री'],
    unit: ProductUnit.UNIT,
  },
  {
    productId: SEED_IDS.products.apple,
    canonicalName: 'apple',
    keywords: ['apple', 'apples', 'seb', 'सेब', 'safarchand', 'सफरचंद'],
    unit: ProductUnit.KG,
  },
  {
    productId: SEED_IDS.products.bajra,
    canonicalName: 'bajra',
    keywords: ['bajra', 'pearl millet', 'बाजरा', 'बाजरी'],
    unit: ProductUnit.KG,
    matchExclusions: ['atta', 'flour'],
  },
  {
    productId: SEED_IDS.products.darkChocolate,
    canonicalName: 'dark chocolate',
    keywords: ['dark chocolate', 'chocolate', 'cocoa bar', 'चॉकलेट'],
    unit: ProductUnit.KG,
  },
  {
    productId: SEED_IDS.products.maida,
    canonicalName: 'maida',
    keywords: ['maida', 'refined flour', 'refined wheat flour', 'मैदा'],
    unit: ProductUnit.KG,
  },
  {
    productId: SEED_IDS.products.maggi,
    canonicalName: 'maggi',
    keywords: ['maggi', 'instant noodles', 'noodles', 'maggi noodles', 'मॅगी', 'मैगी'],
    unit: ProductUnit.PACK,
  },
];

function cleanName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesKeyword(cleaned: string, keyword: string): boolean {
  if (cleaned === keyword) return true;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{M}\\p{N}])`, 'u').test(cleaned);
}

export interface CatalogMatch {
  productId: string;
  canonicalName: string;
  unit: ProductUnit;
}

/**
 * Words denoting a processed grain form. They are shared across grains
 * ("wheat atta", "bajra atta", "rice flour"), so a match that relies ONLY
 * on one of these words is valid only when no other entry's distinctive
 * keyword is present — otherwise the form belongs to that other grain and
 * the item must fall through to open-world instead of a mismatched SKU.
 */
const SHARED_FORM_WORDS = ['atta', 'flour'];

/**
 * Generic processed-form words. Catalog SKUs are stocked in their base form
 * (fresh fruit, raw grain, plain sugar), so a name carrying one of these
 * words is a DIFFERENT product ("apple juice", "banana chips", "rice cakes")
 * and must fall through to open-world instead of the base SKU. Applies to
 * every entry; no entry stocks any of these forms as its own keyword.
 */
const PROCESSED_FORM_WORDS = [
  'juice',
  'cider',
  'vinegar',
  'chips',
  'cookies',
  'cake',
  'cakes',
  'biscuit',
  'biscuits',
  'bread',
  'butter',
  'holder',
  'basket',
  'chikki',
];

function entryKeywords(entry: CatalogEntry): string[] {
  return [
    ...entry.keywords,
    ...(entry.formAliases ?? []).flatMap((alias) => alias.keywords),
  ];
}

/**
 * Whether the cleaned name contains a distinctive (non-form) keyword of an
 * entry other than `entry` — i.e. the name is really about another product
 * whose form word merely overlaps (e.g. "bajra atta" vs the wheat SKU).
 */
function claimedByAnotherEntry(cleaned: string, entry: CatalogEntry): boolean {
  return INTENT_CATALOG.some((other) => {
    if (other === entry) return false;
    return entryKeywords(other)
      .filter((keyword) => !SHARED_FORM_WORDS.includes(keyword))
      .some((keyword) => matchesKeyword(cleaned, keyword));
  });
}

/**
 * Whether a form-only match ("atta", "flour") carries an UNKNOWN qualifier
 * word ("gram flour", "chestnut flour") that names a different product than
 * this entry's grain. Bare form words ("atta") and brand-qualified ones
 * ("Aashirvaad atta", via the model's own brand attribution) still resolve;
 * anything else falls through to open-world instead of a mismatched SKU.
 * Purely structural — no product vocabulary.
 */
function hasUnknownQualifier(cleaned: string, matched: string[], brand?: string): boolean {
  let rest = ` ${cleaned} `;
  const stripWords = (phrase: string): void => {
    for (const word of phrase.toLowerCase().split(/\s+/)) {
      if (word.length > 0) rest = rest.split(word).join(' ');
    }
  };
  for (const keyword of matched) stripWords(keyword);
  for (const form of SHARED_FORM_WORDS) stripWords(form);
  if (brand) stripWords(brand);
  return /[a-z]/.test(rest);
}

/**
 * Deterministically resolves a model-proposed product name to an
 * authoritative catalog entry. Returns null when nothing matches —
 * callers must fail closed (UNMAPPABLE_PRODUCT), never substitute.
 */
export function matchCatalogProduct(productName: string, brand?: string): CatalogMatch | null {
  const cleaned = cleanName(productName);
  if (cleaned.length === 0) return null;
  if (PROCESSED_FORM_WORDS.some((word) => matchesKeyword(cleaned, word))) {
    return null;
  }
  for (const entry of INTENT_CATALOG) {
    if ((entry.matchExclusions ?? []).some((keyword) => matchesKeyword(cleaned, keyword))) {
      continue;
    }
    const matched = entryKeywords(entry).filter((keyword) => matchesKeyword(cleaned, keyword));
    if (matched.length === 0) continue;
    const formOnly = matched.every((keyword) => SHARED_FORM_WORDS.includes(keyword));
    if (formOnly && hasUnknownQualifier(cleaned, matched, brand)) continue;
    if (formOnly && claimedByAnotherEntry(cleaned, entry)) continue;
    for (const alias of entry.formAliases ?? []) {
      if (alias.keywords.some((keyword) => matchesKeyword(cleaned, keyword))) {
        return {
          productId: entry.productId,
          canonicalName: alias.canonicalName,
          unit: entry.unit,
        };
      }
    }
    return {
      productId: entry.productId,
      canonicalName: entry.canonicalName,
      unit: entry.unit,
    };
  }
  return null;
}

export function canonicalNameForProductId(productId: string): string | null {
  return INTENT_CATALOG.find((e) => e.productId === productId)?.canonicalName ?? null;
}
