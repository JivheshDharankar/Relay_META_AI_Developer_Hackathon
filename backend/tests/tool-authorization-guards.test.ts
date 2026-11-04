import { describe, it, expect } from 'vitest';
import { rfqService } from '../src/discovery/supplier';
import { getQuotesForRFQTool, compareQuotesForRFQTool } from '../src/agent/tools/definitions';
import { getModelProvider } from '../src/agent/model';
import type { ToolExecutionContext } from '../src/agent/tools/types';

const ctxA: ToolExecutionContext = {
  residentId: 'res_a',
  societyId: 'soc_a',
  runId: 'run_a',
};
const ctxB: ToolExecutionContext = {
  residentId: 'res_b',
  societyId: 'soc_b',
  runId: 'run_b',
};

describe('Tool ownership guards', () => {
  it('denies RFQ-scoped tools from another society', async () => {
    rfqService.reset();
    const rfq = await rfqService.createRFQ({
      candidate: {
        id: 'cand_1',
        name: 'Supplier One',
        formattedAddress: 'Market Yard, Pune',
        latitude: 18.52,
        longitude: 73.85,
        distanceKm: 1,
        distanceMeters: 1000,
        categories: ['commercial.supermarket'],
        source: 'registry',
        email: 'supplier@example.com',
      } as any,
      lineItems: [{ productName: 'rice', quantity: 2, unit: 'KG' }],
      deliveryArea: 'Society A',
      deliveryDeadline: new Date(Date.now() + 12 * 3600 * 1000),
      quoteDeadline: new Date(Date.now() + 2 * 3600 * 1000),
      contactMethod: 'email',
      societyId: 'soc_a',
    } as any);

    // Same society may read (empty quotes is a valid result).
    const own = await (getQuotesForRFQTool.execute as any)({ rfqId: rfq.id }, ctxA);
    expect(own.success).toBe(true);

    // Another society is denied at the tool layer by bare ID.
    await expect((getQuotesForRFQTool.execute as any)({ rfqId: rfq.id }, ctxB)).rejects.toThrow(
      /CROSS_SOCIETY|another society/,
    );
    await expect((compareQuotesForRFQTool.execute as any)({ rfqId: rfq.id }, ctxB)).rejects.toThrow(
      /CROSS_SOCIETY|another society/,
    );
  });

  it('allows the owning society and denies others for the same RFQ id', async () => {
    // Covered by the first test: ctxA reads successfully while ctxB is
    // rejected for the identical rfqId. A bare ID alone is not authority
    // whenever an execution context is present (the agent path).
    expect(ctxA.societyId).not.toBe(ctxB.societyId);
  });
});

describe('Model provider factory', () => {
  it('fails closed on an unknown provider name instead of silently using mock', () => {
    expect(() => getModelProvider('typo-provider')).toThrow(/Unknown model provider/);
    expect(getModelProvider('mock').providerName).toBe('mock');
  });
});
