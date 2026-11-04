import { IntentExtractor } from '../src/agent/intent/intentExtractor';
import { normalizeIndicNumberWords } from '../src/agent/intent/multilingual';
import { MockModelProvider } from '../src/agent/model/MockModelProvider';
import { ProductUnit } from '@prisma/client';
import { relayOrchestrator } from '../src/orchestration/RelayOrchestrator';
import { WorkflowExecutor } from '../src/orchestration/WorkflowExecutor';
import { vi, beforeEach } from 'vitest';

describe('End-to-End Grocery Procurement & Price Normalization', () => {
  const testPrompt =
    'Mujhe 4 kilo jwari ka atta 5 kilo chini 3 kilo aalu adha kilo tamatar 1 kilo bhindi aur 1 litre doodh chaiye along with 500 gram of oats. Keep the rate optimal.';

  beforeEach(() => {
    vi.spyOn(WorkflowExecutor.prototype, 'syncToPrisma').mockResolvedValue(undefined as any);
  });

  it('normalizes colloquial Hindi/Hinglish quantities in the prompt', () => {
    const normalized = normalizeIndicNumberWords(testPrompt);
    // adha kilo should be converted to 0.5 kilo
    expect(normalized).toContain('0.5');
    expect(normalized).toContain('kilo tamatar');
  });

  it('extracts all 7 items accurately with zero unmappable items', async () => {
    // Provide structured mock responses for the 7 items
    const mockProvider = new MockModelProvider({
      scripted: [
        {
          response: {
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                name: 'extract_procurement_intent',
                arguments: {
                  items: [
                    { productName: 'jwari ka atta', quantity: 4, unit: 'kg' },
                    { productName: 'chini', quantity: 5, unit: 'kg' },
                    { productName: 'aalu', quantity: 3, unit: 'kg' },
                    { productName: 'tamatar', quantity: 0.5, unit: 'kg' },
                    { productName: 'bhindi', quantity: 1, unit: 'kg' },
                    { productName: 'doodh', quantity: 1, unit: 'litre' },
                    { productName: 'oats', quantity: 500, unit: 'gram' },
                  ],
                  preferences: 'Keep the rate optimal.',
                },
              },
            ],
          },
        },
      ],
    });

    const extractor = new IntentExtractor({ provider: mockProvider });
    const result = await extractor.extract(testPrompt);

    expect(result.status).toBe('ok');
    expect(result.intent).toBeDefined();
    expect(result.intent!.items).toHaveLength(7);

    // Verify all 7 items are resolved
    for (const item of result.intent!.items) {
      expect(item.resolution.status).toBe('resolved');
      expect(item.quantity).toBeGreaterThan(0);
      expect(item.unit).toBeDefined();
    }

    // Verify chini resolved to catalog sugar SKU
    const chiniItem = result.intent!.items.find((i) => i.productName.includes('chini') || i.productName.includes('sugar'));
    expect(chiniItem).toBeDefined();
    expect(chiniItem!.resolution.status).toBe('resolved');

    // Verify oats has quantity 500 and unit GRAM
    const oatsItem = result.intent!.items.find((i) => i.productName.includes('oats'));
    expect(oatsItem).toBeDefined();
    expect(oatsItem!.quantity).toBe(500);
    expect(oatsItem!.unit).toBe(ProductUnit.GRAM);
  });

  it('executes full 13-stage workflow and yields realistic basket total under ₹1000', async () => {
    const workflow = await relayOrchestrator.createWorkflow({
      requestText: testPrompt,
      residentReference: 'res_demo_resident',
      societyReference: 'soc_greenview_pune',
      resolvedItems: [
        { productName: 'jwari ka atta', quantity: 4, unit: 'kg', identitySource: 'open-world' },
        { productName: 'sugar', quantity: 5, unit: 'kg', identitySource: 'catalog' },
        { productName: 'aalu', quantity: 3, unit: 'kg', identitySource: 'open-world' },
        { productName: 'tamatar', quantity: 0.5, unit: 'kg', identitySource: 'open-world' },
        { productName: 'bhindi', quantity: 1, unit: 'kg', identitySource: 'open-world' },
        { productName: 'doodh', quantity: 1, unit: 'litre', identitySource: 'open-world' },
        { productName: 'oats', quantity: 500, unit: 'gram', identitySource: 'open-world' },
      ],
      location: {
        address: 'Skyi Star City, Bhugaon, Pune',
        city: 'Pune',
        latitude: 18.5204,
        longitude: 73.8567,
      },
    });

    const completedWf = await relayOrchestrator.executeWorkflow(workflow.id);

    if (completedWf.status === 'FAILED') {
      console.log('WORKFLOW FAILED AT STAGE:', completedWf.currentStage);
      console.log('FAILURE REASON:', completedWf.failureReason);
    }

    expect(completedWf.status).toBe('COMPLETED');
    expect(completedWf.currentStage).toBe('COMPLETE');

    // Check selected quote and financials
    const selectedQuote = (completedWf as any)._selectedQuote;
    expect(selectedQuote).toBeDefined();

    // Verify line item subtotal for Oats (500g):
    // Price must be normalized around ₹80, NEVER ₹32,500 or ₹80,000!
    const oatsLine = selectedQuote.lineItems.find((l: any) => l.productName.toLowerCase().includes('oats'));
    expect(oatsLine).toBeDefined();
    expect(oatsLine.lineSubtotal).toBeLessThan(150);
    expect(oatsLine.lineSubtotal).toBeGreaterThan(30);

    // Verify Total Basket Subtotal & Total
    // 4kg jowar (~₹232) + 5kg sugar (~₹220) + 3kg aalu (~₹90) + 0.5kg tamatar (~₹17) + 1kg bhindi (~₹48) + 1L milk (~₹62) + 500g oats (~₹80)
    // Subtotal should be around ~₹750 - ₹800
    // Total including delivery fee (~₹45) and tax (~₹38) should be around ₹800 - ₹900
    expect(selectedQuote.subtotal).toBeGreaterThan(600);
    expect(selectedQuote.subtotal).toBeLessThan(1000);

    expect(selectedQuote.total).toBeGreaterThan(700);
    expect(selectedQuote.total).toBeLessThan(1100);

    // CRITICAL ASSERTION: The absurd ₹35,684.19 total is completely impossible now!
    expect(selectedQuote.total).not.toBeCloseTo(35684.19, 0);
  });
});
