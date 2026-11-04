import { describe, it, expect } from 'vitest';
import { MockModelProvider } from '../src/agent/model/MockModelProvider';
import { SEED_IDS } from '../src/config/seedConstants';
import type { ToolModelRequest } from '../src/agent/model/types';

function userRequest(prompt: string): ToolModelRequest {
  return { messages: [{ role: 'user', content: prompt }], tools: [] };
}

function toolFollowUp(
  prompt: string,
  results: Array<{ name: string; content: Record<string, unknown> }>,
): ToolModelRequest {
  return {
    messages: [
      { role: 'user', content: prompt },
      ...results.map((r) => ({
        role: 'tool' as const,
        name: r.name,
        content: JSON.stringify(r.content),
      })),
    ],
    tools: [],
  };
}

describe('MockModelProvider multi-item preservation', () => {
  it('emits one createRequest per requested product (rice + sugar + Maggi)', async () => {
    const provider = new MockModelProvider();
    const res = await provider.generateWithTools(
      userRequest('2 kg rice, 1 kg sugar and 2 packs Maggi'),
    );

    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls).toHaveLength(3);
    expect(res.toolCalls?.map((c) => c.name)).toEqual([
      'createRequest',
      'createRequest',
      'createRequest',
    ]);
    expect(res.toolCalls?.[0].arguments).toMatchObject({
      productId: SEED_IDS.products.rice,
      quantity: 2,
      unit: 'KG',
    });
    expect(res.toolCalls?.[1].arguments).toMatchObject({
      productId: SEED_IDS.products.sugar,
      quantity: 1,
      unit: 'KG',
    });
    expect(res.toolCalls?.[2].arguments).toMatchObject({
      productId: SEED_IDS.products.maggi,
      quantity: 2,
      unit: 'PACK',
    });
  });

  it('preserves gram quantities instead of inventing a kilogram default', async () => {
    const provider = new MockModelProvider();
    const res = await provider.generateWithTools(userRequest('500 g sugar'));

    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls?.[0].arguments).toMatchObject({
      productId: SEED_IDS.products.sugar,
      quantity: 500,
      unit: 'GRAM',
    });
  });

  it('never defaults a missing quantity', async () => {
    const provider = new MockModelProvider();
    const res = await provider.generateWithTools(userRequest('I need rice'));

    expect(res.finishReason).toBe('stop');
    expect(res.toolCalls).toBeUndefined();
  });

  it('fails closed without fabricating an order id when createRequest omits one', async () => {
    const provider = new MockModelProvider();
    await provider.generateWithTools(userRequest('2 kg rice'));
    const res = await provider.generateWithTools(
      toolFollowUp('2 kg rice', [
        { name: 'createRequest', content: { success: true, totalPrice: 300 } },
      ]),
    );

    expect(res.finishReason).toBe('stop');
    expect(res.toolCalls).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('res_order_001');
    expect(JSON.stringify(res)).not.toContain('checkAuthorization');
  });

  it('halts downstream tools after a tool failure', async () => {
    const provider = new MockModelProvider();
    await provider.generateWithTools(userRequest('2 kg rice'));
    const res = await provider.generateWithTools(
      toolFollowUp('2 kg rice', [
        {
          name: 'createRequest',
          content: { success: true, orderId: 'ro_real_1', totalPrice: 300 },
        },
        {
          name: 'checkAuthorization',
          content: { success: false, error: { message: 'MANDATE_LIMIT_EXCEEDED' } },
        },
      ]),
    );

    expect(res.finishReason).toBe('stop');
    expect(res.toolCalls).toBeUndefined();
    expect(res.content).toContain('MANDATE_LIMIT_EXCEEDED');
  });
});
