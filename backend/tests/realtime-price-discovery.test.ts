import {
  RealtimePriceDiscoveryService,
  realtimePriceDiscoveryService,
} from '../src/agent/pricing/RealtimePriceDiscoveryService';

describe('RealtimePriceDiscoveryService', () => {
  describe('Locality & Delivery Area Sanitization', () => {
    it('strips resident flat and door PII to preserve privacy', () => {
      const address = 'Flat 402, Tower B, Skyi Star City, Bhugaon, Pune';
      const sanitized = realtimePriceDiscoveryService.sanitizeLocality(address);
      expect(sanitized).not.toContain('Flat 402');
      expect(sanitized).not.toContain('Tower B');
      expect(sanitized).toContain('Skyi Star City, Bhugaon, Pune');
    });

    it('respects explicitly provided city', () => {
      const sanitized = realtimePriceDiscoveryService.sanitizeLocality('Door 12, Main Street', 'Nashik');
      expect(sanitized).toContain('Nashik, Maharashtra, India');
      expect(sanitized).not.toContain('Door 12');
    });

    it('falls back to Pune when address is missing', () => {
      const sanitized = realtimePriceDiscoveryService.sanitizeLocality();
      expect(sanitized).toBe('Pune, Maharashtra, India');
    });
  });

  describe('Grocery Price Discovery & Provenance Tracking', () => {
    const testItems = [
      { productName: 'jwari ka atta', quantity: 4, unit: 'kg' },
      { productName: 'chini', quantity: 5, unit: 'kg' },
      { productName: 'aalu', quantity: 3, unit: 'kg' },
      { productName: 'tamatar', quantity: 0.5, unit: 'kg' },
      { productName: 'bhindi', quantity: 1, unit: 'kg' },
      { productName: 'doodh', quantity: 1, unit: 'litre' },
      { productName: 'oats', quantity: 500, unit: 'g' },
    ];

    it('discovers benchmark prices accurately when mock or fallback', async () => {
      const result = await realtimePriceDiscoveryService.discoverPrices({
        items: testItems,
        location: { address: 'Baner, Pune' },
      });

      expect(result.items).toHaveLength(7);
      expect(result.locality).toContain('Baner, Pune');

      // Check item 1: 4 kg jwari ka atta @ ~₹58/kg = ₹232
      const jowar = result.items.find((i) => i.productName === 'jwari ka atta')!;
      expect(jowar.discoveredUnitPrice).toBe(58);
      expect(jowar.calculatedSubtotal).toBe(232);

      // Check item 2: 5 kg chini @ ₹44/kg = ₹220
      const chini = result.items.find((i) => i.productName === 'chini')!;
      expect(chini.discoveredUnitPrice).toBe(44);
      expect(chini.calculatedSubtotal).toBe(220);

      // Check item 4: 0.5 kg tamatar @ ₹35/kg = ₹17.50
      const tamatar = result.items.find((i) => i.productName === 'tamatar')!;
      expect(tamatar.commercialQuantity).toBe(0.5);
      expect(tamatar.discoveredUnitPrice).toBe(35);
      expect(tamatar.calculatedSubtotal).toBe(17.5);

      // Check item 7: 500g oats @ ₹160/kg = ₹80 (NEVER ₹80,000!)
      const oats = result.items.find((i) => i.productName === 'oats')!;
      expect(oats.commercialQuantity).toBe(0.5);
      expect(oats.discoveredUnitPrice).toBe(160);
      expect(oats.calculatedSubtotal).toBe(80);

      // Total basket subtotal must be reasonable (< ₹1,000)
      expect(result.totalEstimatedSubtotal).toBe(749.5);
      expect(result.totalEstimatedSubtotal).toBeLessThan(1000);
    });

    it('caches discovery results for the same locality and items', async () => {
      const res1 = await realtimePriceDiscoveryService.discoverPrices({
        items: [{ productName: 'sugar', quantity: 2, unit: 'kg' }],
        location: { address: 'Kothrud, Pune' },
      });

      const res2 = await realtimePriceDiscoveryService.discoverPrices({
        items: [{ productName: 'sugar', quantity: 2, unit: 'kg' }],
        location: { address: 'Kothrud, Pune' },
      });

      expect(res1.items[0].calculatedSubtotal).toBe(res2.items[0].calculatedSubtotal);
    });

    it('handles simulated fetch response with live search results', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output: [
            {
              type: 'web_search_call',
              results: [
                {
                  title: 'Aashirvaad Jowar Atta 1kg - BigBasket',
                  url: 'https://www.bigbasket.com/pd/40193427/aashirvaad-jowar-atta-1-kg/',
                  snippet: 'Buy Aashirvaad Jowar Atta 1 kg Online at Rs 68 on BigBasket',
                },
                {
                  title: 'Kelloggs Oats 500g - Blinkit',
                  url: 'https://blinkit.com/prn/kelloggs-oats/prid/12345',
                  snippet: 'Buy Kelloggs Rolled Oats 500g at Rs 95 in Pune',
                },
              ],
            },
            {
              type: 'message',
              content: [
                {
                  type: 'text',
                  text: 'Found current retail prices. ```json\n[\n  {"itemIndex": 0, "productName": "jwari ka atta", "packagePrice": 68, "unitPrice": 68, "pricingUnit": "kg", "merchant": "BigBasket", "url": "https://www.bigbasket.com/pd/40193427/aashirvaad-jowar-atta-1-kg/"},\n  {"itemIndex": 1, "productName": "oats", "packagePrice": 95, "unitPrice": 190, "pricingUnit": "kg", "merchant": "Blinkit", "url": "https://blinkit.com/prn/kelloggs-oats/prid/12345"}\n]\n```',
                },
              ],
            },
          ],
        }),
      });

      const service = new RealtimePriceDiscoveryService({
        fetchFn: mockFetch as any,
        apiKey: 'test-meta-key',
        modelProvider: 'meta',
      });

      const result = await service.discoverPrices({
        items: [
          { productName: 'jwari ka atta', quantity: 2, unit: 'kg' },
          { productName: 'oats', quantity: 500, unit: 'g' },
        ],
        location: { address: 'Baner, Pune' },
        bypassCache: true,
      });

      expect(result.searchExecuted).toBe(true);
      expect(result.overallProvenance).toBe('VERIFIED_LIVE_LISTING');
      expect(result.items[0].discoveredUnitPrice).toBe(68);
      expect(result.items[0].sourceUrl).toContain('bigbasket.com');
      expect(result.items[0].merchant).toBe('BigBasket');

      // 500g oats @ ₹190/kg => ₹95.00
      expect(result.items[1].discoveredUnitPrice).toBe(190);
      expect(result.items[1].calculatedSubtotal).toBe(95);
      expect(result.items[1].sourceUrl).toContain('blinkit.com');
    });
  });
});

