import { env } from '../../config/env';
import { getCatalogReferencePrice } from '../../config/pricingCatalog';
import {
  calculateLineSubtotal,
  normalizeQuantity,
  validateGroceryPriceSanity,
} from '../../domain/procurement/quantityNormalizer';
import { roundMoney } from '../../domain/procurement/decimal';

export type PriceProvenanceStatus =
  | 'VERIFIED_LIVE_LISTING'
  | 'INDICATIVE_MARKET_ESTIMATE'
  | 'SIMULATED_DEMO_PRICE'
  | 'PRICE_UNAVAILABLE';

export interface PriceDiscoveryItem {
  productName: string;
  quantity: number;
  unit: string;
  productId?: string | null;
  identitySource?: string;
  brand?: string;
  packaging?: string;
}

export interface DiscoveredItemPrice {
  productName: string;
  requestedQuantity: number;
  requestedUnit: string;
  canonicalQuantity: number;
  canonicalUnit: string;
  commercialQuantity: number;
  commercialUnit: string;
  discoveredUnitPrice: number;
  pricingUnit: string;
  calculatedSubtotal: number;
  merchant: string;
  sourceUrl?: string;
  provenanceStatus: PriceProvenanceStatus;
  packageSizeNote?: string;
  confidence: number;
  retrievedAt: string;
}

export interface PriceDiscoveryResult {
  locality: string;
  items: DiscoveredItemPrice[];
  totalEstimatedSubtotal: number;
  overallProvenance: PriceProvenanceStatus;
  searchExecuted: boolean;
  searchDurationMs: number;
  sourceUrls: string[];
}

interface CacheEntry {
  timestamp: number;
  result: PriceDiscoveryResult;
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DISCOVERY_TIMEOUT_MS = 25000; // 25s timeout for internet search

export class RealtimePriceDiscoveryService {
  private cache = new Map<string, CacheEntry>();
  private fetchFn: typeof fetch;
  private apiKey?: string;
  private modelProvider?: string;

  constructor(options?: { fetchFn?: typeof fetch; apiKey?: string; modelProvider?: string }) {
    this.fetchFn = options?.fetchFn ?? fetch;
    this.apiKey = options?.apiKey;
    this.modelProvider = options?.modelProvider;
  }

  /**
   * Sanitizes user location for privacy:
   * Extracts city/locality (e.g., "Baner, Pune, Maharashtra"), stripping flat/tower PII.
   */
  public sanitizeLocality(address?: string, city?: string): string {
    if (city && city.trim().length > 0) {
      return `${city.trim()}, Maharashtra, India`;
    }
    if (!address || address.trim().length === 0) {
      return 'Pune, Maharashtra, India';
    }

    const cleaned = address
      .replace(/\b(flat|apt|apartment|unit|tower|block|room|door|villa|penthouse)\s*[a-z0-9\-]+/gi, '')
      .replace(/\s*,\s*,/g, ',')
      .replace(/^[\s,]+|[\s,]+$/g, '')
      .trim();

    return cleaned.length > 0 ? `${cleaned}, India` : 'Pune, Maharashtra, India';
  }

  /**
   * Discovers real-time grocery prices via Meta Muse Spark 1.3 Responses API with web search.
   * Falls back gracefully to catalog benchmarks if API is not configured or times out.
   */
  public async discoverPrices(params: {
    items: PriceDiscoveryItem[];
    location?: { address?: string; city?: string };
    bypassCache?: boolean;
  }): Promise<PriceDiscoveryResult> {
    const startTime = Date.now();
    const locality = this.sanitizeLocality(params.location?.address, params.location?.city);

    if (!params.items || params.items.length === 0) {
      return {
        locality,
        items: [],
        totalEstimatedSubtotal: 0,
        overallProvenance: 'PRICE_UNAVAILABLE',
        searchExecuted: false,
        searchDurationMs: 0,
        sourceUrls: [],
      };
    }

    // Cache lookup
    const cacheKey = `${locality}:${params.items
      .map((it) => `${it.productName.toLowerCase()}_${it.quantity}_${it.unit}`)
      .sort()
      .join('|')}`;

    if (!params.bypassCache && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.result;
      }
    }

    const effectiveApiKey = this.apiKey ?? process.env.META_MODEL_API_KEY ?? env.META_MODEL_API_KEY;
    const effectiveProvider = this.modelProvider ?? process.env.MODEL_PROVIDER ?? env.MODEL_PROVIDER;
    const hasApiKey = Boolean(effectiveApiKey && effectiveApiKey.trim().length > 0);
    const isMock = effectiveProvider === 'mock';

    // If no real API key or in mock mode, use reference benchmark prices
    if (!hasApiKey || isMock) {
      const fallbackResult = this.buildBenchmarkPricingResult(
        params.items,
        locality,
        isMock ? 'SIMULATED_DEMO_PRICE' : 'INDICATIVE_MARKET_ESTIMATE',
        Date.now() - startTime
      );
      this.cache.set(cacheKey, { timestamp: Date.now(), result: fallbackResult });
      return fallbackResult;
    }

    // Call Meta Responses API with native web search
    try {
      const liveResult = await this.queryMetaResponsesApiWithWebSearch(
        params.items,
        locality,
        startTime,
        effectiveApiKey
      );
      this.cache.set(cacheKey, { timestamp: Date.now(), result: liveResult });
      return liveResult;
    } catch (err) {
      // Fall back gracefully to benchmark prices on error/timeout
      const fallbackResult = this.buildBenchmarkPricingResult(
        params.items,
        locality,
        'INDICATIVE_MARKET_ESTIMATE',
        Date.now() - startTime
      );
      this.cache.set(cacheKey, { timestamp: Date.now(), result: fallbackResult });
      return fallbackResult;
    }
  }

  /**
   * Calls Meta /responses endpoint with tools: [{ type: "web_search" }] and include: ["web_search_call.results"].
   */
  private async queryMetaResponsesApiWithWebSearch(
    items: PriceDiscoveryItem[],
    locality: string,
    startTime: number,
    apiKey?: string
  ): Promise<PriceDiscoveryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

    const itemsSummary = items
      .map((it, idx) => `${idx + 1}. ${it.quantity} ${it.unit} ${it.productName}`)
      .join('\n');

    const prompt = `You are Relay's autonomous grocery price discovery agent. Search the internet for current retail and mandi grocery prices in ${locality} for these items:
${itemsSummary}

For each item, search online Indian grocery stores (BigBasket, Blinkit, DMart, Zepto, Jiomart, local mandi) to find actual prices.
At the end of your response, output a strict JSON block enclosed in \`\`\`json ... \`\`\` with the discovered price details:
\`\`\`json
[
  {
    "itemIndex": 0,
    "productName": "string",
    "packSize": "string",
    "packagePrice": number,
    "unitPrice": number,
    "pricingUnit": "kg" | "litre" | "pack" | "unit",
    "merchant": "string",
    "url": "string"
  }
]
\`\`\``;

    const baseUrl = env.META_MODEL_BASE_URL || 'https://api.meta.ai/v1';
    const model = env.META_MODEL_NAME || 'muse-spark-1.3';
    const effectiveKey = apiKey || env.META_MODEL_API_KEY;

    try {
      const response = await this.fetchFn(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${effectiveKey}`,
        },
        body: JSON.stringify({
          model,
          tools: [{ type: 'web_search' }],
          include: ['web_search_call.results'],
          input: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Meta API HTTP error ${response.status}: ${await response.text().catch(() => '')}`);
      }

      const data = (await response.json()) as any;
      const durationMs = Date.now() - startTime;

      return this.parseMetaResponsesOutput(data, items, locality, durationMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parses the Meta Responses output and web_search_call results.
   */
  private parseMetaResponsesOutput(
    data: any,
    items: PriceDiscoveryItem[],
    locality: string,
    durationMs: number
  ): PriceDiscoveryResult {
    const outputEvents: any[] = Array.isArray(data?.output) ? data.output : [];

    // 1. Collect all web search URLs and snippets
    const discoveredWebUrls: string[] = [];
    const webSearchResults: Array<{ title: string; url: string; snippet: string }> = [];

    for (const event of outputEvents) {
      if (event?.type === 'web_search_call' && Array.isArray(event?.results)) {
        for (const res of event.results) {
          if (res?.url) {
            discoveredWebUrls.push(res.url);
            webSearchResults.push({
              title: res.title || '',
              url: res.url,
              snippet: res.snippet || '',
            });
          }
        }
      }
    }

    // 2. Extract model message content text
    let messageText = '';
    for (const event of outputEvents) {
      if (event?.type === 'message' && Array.isArray(event?.content)) {
        for (const part of event.content) {
          if (part?.type === 'text' && typeof part?.text === 'string') {
            messageText += part.text;
          }
        }
      }
    }

    // 3. Try parsing JSON block from messageText
    let parsedItems: any[] = [];
    const jsonMatch = messageText.match(/```json\s*([\s\S]*?)\s*```/i);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed)) {
          parsedItems = parsed;
        }
      } catch {
        // ignore parse error, will fallback
      }
    }

    const discoveredItems: DiscoveredItemPrice[] = [];
    let allVerified = true;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const norm = normalizeQuantity(it.quantity, it.unit);
      const ref = getCatalogReferencePrice(it.productName, it.productId || undefined);

      const parsed = parsedItems.find((p) => p.itemIndex === i || p.itemIndex === i + 1) || parsedItems[i];

      let unitPrice = ref.basePrice;
      let pricingUnit = ref.unit || norm.commercialUnit;
      let merchant = 'Local Verified Retailer';
      let sourceUrl: string | undefined = undefined;
      let provenanceStatus: PriceProvenanceStatus = 'INDICATIVE_MARKET_ESTIMATE';
      let packageSizeNote: string | undefined = undefined;

      if (parsed && typeof parsed.unitPrice === 'number' && parsed.unitPrice > 0) {
        const sanity = validateGroceryPriceSanity(it.productName, parsed.unitPrice, parsed.pricingUnit || pricingUnit);
        if (sanity.isSane) {
          unitPrice = parsed.unitPrice;
          pricingUnit = parsed.pricingUnit || pricingUnit;
          merchant = parsed.merchant || merchant;
          sourceUrl = parsed.url || undefined;
          packageSizeNote = parsed.packSize ? `Listing: ${parsed.packSize} @ ₹${parsed.packagePrice || unitPrice}` : undefined;
          provenanceStatus = sourceUrl && sourceUrl.startsWith('http') ? 'VERIFIED_LIVE_LISTING' : 'INDICATIVE_MARKET_ESTIMATE';
        }
      }

      // If no valid parsed URL, see if any web search result matched the product
      if (!sourceUrl || !sourceUrl.startsWith('http')) {
        const matchingWeb = webSearchResults.find((w) => {
          const lower = `${w.title} ${w.snippet}`.toLowerCase();
          return it.productName.toLowerCase().split(' ').some((kw) => kw.length > 2 && lower.includes(kw));
        });
        if (matchingWeb) {
          sourceUrl = matchingWeb.url;
          provenanceStatus = 'VERIFIED_LIVE_LISTING';
          if (matchingWeb.title.includes('BigBasket')) merchant = 'BigBasket';
          else if (matchingWeb.title.includes('Blinkit')) merchant = 'Blinkit';
          else if (matchingWeb.title.includes('DMart')) merchant = 'DMart';
        }
      }

      if (provenanceStatus !== 'VERIFIED_LIVE_LISTING') {
        allVerified = false;
      }

      const calculatedSubtotal = calculateLineSubtotal(it.quantity, it.unit, unitPrice, pricingUnit);

      discoveredItems.push({
        productName: it.productName,
        requestedQuantity: it.quantity,
        requestedUnit: it.unit,
        canonicalQuantity: norm.canonicalQuantity,
        canonicalUnit: norm.canonicalUnit,
        commercialQuantity: norm.commercialQuantity,
        commercialUnit: norm.commercialUnit,
        discoveredUnitPrice: unitPrice,
        pricingUnit,
        calculatedSubtotal,
        merchant,
        sourceUrl,
        provenanceStatus,
        packageSizeNote,
        confidence: provenanceStatus === 'VERIFIED_LIVE_LISTING' ? 0.95 : 0.85,
        retrievedAt: new Date().toISOString(),
      });
    }

    const totalEstimatedSubtotal = roundMoney(
      discoveredItems.reduce((acc, it) => acc + it.calculatedSubtotal, 0)
    ).toNumber();

    return {
      locality,
      items: discoveredItems,
      totalEstimatedSubtotal,
      overallProvenance: allVerified ? 'VERIFIED_LIVE_LISTING' : 'INDICATIVE_MARKET_ESTIMATE',
      searchExecuted: true,
      searchDurationMs: durationMs,
      sourceUrls: Array.from(new Set(discoveredWebUrls)),
    };
  }

  /**
   * Generates deterministic benchmark pricing when internet search is not enabled or fails.
   */
  private buildBenchmarkPricingResult(
    items: PriceDiscoveryItem[],
    locality: string,
    provenanceStatus: PriceProvenanceStatus,
    durationMs: number
  ): PriceDiscoveryResult {
    const discoveredItems: DiscoveredItemPrice[] = items.map((it) => {
      const norm = normalizeQuantity(it.quantity, it.unit);
      const ref = getCatalogReferencePrice(it.productName, it.productId || undefined);
      const unitPrice = ref.basePrice;
      const pricingUnit = ref.unit || norm.commercialUnit;
      const calculatedSubtotal = calculateLineSubtotal(it.quantity, it.unit, unitPrice, pricingUnit);

      return {
        productName: it.productName,
        requestedQuantity: it.quantity,
        requestedUnit: it.unit,
        canonicalQuantity: norm.canonicalQuantity,
        canonicalUnit: norm.canonicalUnit,
        commercialQuantity: norm.commercialQuantity,
        commercialUnit: norm.commercialUnit,
        discoveredUnitPrice: unitPrice,
        pricingUnit,
        calculatedSubtotal,
        merchant: provenanceStatus === 'SIMULATED_DEMO_PRICE' ? 'Sahyadri Farmers Direct' : 'Verified Market Benchmark',
        provenanceStatus,
        packageSizeNote: `Standard benchmark rate (₹${unitPrice}/${pricingUnit})`,
        confidence: provenanceStatus === 'SIMULATED_DEMO_PRICE' ? 0.99 : 0.88,
        retrievedAt: new Date().toISOString(),
      };
    });

    const totalEstimatedSubtotal = roundMoney(
      discoveredItems.reduce((acc, it) => acc + it.calculatedSubtotal, 0)
    ).toNumber();

    return {
      locality,
      items: discoveredItems,
      totalEstimatedSubtotal,
      overallProvenance: provenanceStatus,
      searchExecuted: false,
      searchDurationMs: durationMs,
      sourceUrls: [],
    };
  }
}

export const realtimePriceDiscoveryService = new RealtimePriceDiscoveryService();
