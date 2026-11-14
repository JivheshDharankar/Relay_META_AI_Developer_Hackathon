import { describe, expect, it } from 'vitest';
import { getPilotReadinessBlockers } from '../src/config/pilotReadiness';

const readyIntegrationConfig = {
  MODEL_PROVIDER: 'meta',
  META_MODEL_API_KEY: 'synthetic-test-key',
  SUPPLIER_DISCOVERY_PROVIDER: 'geoapify',
  GEOAPIFY_API_KEY: 'synthetic-test-key',
  SUPPLIER_CONTACT_PROVIDER: 'resend',
  RESEND_API_KEY: 'synthetic-test-key',
};

describe('grocery pilot readiness gate', () => {
  it('reports mock providers and missing credentials as blockers', () => {
    const blockers = getPilotReadinessBlockers({
      ...readyIntegrationConfig,
      MODEL_PROVIDER: 'mock',
      SUPPLIER_DISCOVERY_PROVIDER: 'mock',
      SUPPLIER_CONTACT_PROVIDER: 'mock',
      META_MODEL_API_KEY: '',
      GEOAPIFY_API_KEY: '',
      RESEND_API_KEY: '',
    });
    expect(blockers.join(' ')).toContain('MODEL_PROVIDER is currently mock');
    expect(blockers.join(' ')).toContain('GEOAPIFY_API_KEY');
    expect(blockers.join(' ')).toContain('RESEND_API_KEY');
  });

  it('never declares the pilot ready while supplier ordering, payments or logistics are unimplemented', () => {
    const blockers = getPilotReadinessBlockers(readyIntegrationConfig);
    expect(blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('live supplier purchase-order adapter'),
      expect.stringContaining('live payment gateway adapter'),
      expect.stringContaining('carrier/logistics adapter'),
      expect.stringContaining('live supplier onboarding'),
    ]));
  });
});
