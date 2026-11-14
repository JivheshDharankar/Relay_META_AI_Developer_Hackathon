import { env } from './env';

export interface PilotReadinessConfig {
  MODEL_PROVIDER: string;
  META_MODEL_API_KEY?: string;
  SUPPLIER_DISCOVERY_PROVIDER: string;
  GEOAPIFY_API_KEY?: string;
  SUPPLIER_CONTACT_PROVIDER: string;
  RESEND_API_KEY?: string;
}

/**
 * Returns actionable blockers for the real-world grocery pilot.
 * A provider interface or sandbox is not evidence that a real supplier order,
 * payment, or delivery has occurred.
 */
export function getPilotReadinessBlockers(config: PilotReadinessConfig = env): string[] {
  const blockers: string[] = [];
  if (config.MODEL_PROVIDER === 'mock') blockers.push('Configure a live model provider; MODEL_PROVIDER is currently mock.');
  if (['meta', 'meta-spark', 'meta-model'].includes(config.MODEL_PROVIDER) && !config.META_MODEL_API_KEY?.trim()) {
    blockers.push('Configure META_MODEL_API_KEY for the selected Meta model provider.');
  }
  if (config.SUPPLIER_DISCOVERY_PROVIDER !== 'geoapify') blockers.push('Configure live supplier discovery; SUPPLIER_DISCOVERY_PROVIDER is currently mock.');
  if (!config.GEOAPIFY_API_KEY?.trim()) blockers.push('Configure GEOAPIFY_API_KEY for live supplier-location discovery.');
  if (config.SUPPLIER_CONTACT_PROVIDER !== 'resend') blockers.push('Configure supplier RFQ email delivery; SUPPLIER_CONTACT_PROVIDER is currently mock.');
  if (!config.RESEND_API_KEY?.trim()) blockers.push('Configure RESEND_API_KEY for real supplier RFQ delivery.');

  // These adapters do not exist yet. Sandbox and mock providers are not production integrations.
  blockers.push('Implement and verify a live supplier purchase-order adapter with supplier-side acceptance evidence.');
  blockers.push('Implement and verify a live payment gateway adapter, signed webhooks, idempotency and payment-status recovery.');
  blockers.push('Implement and verify a carrier/logistics adapter with verifiable tracking events and proof of delivery.');
  blockers.push('Complete live supplier onboarding and verify identity, contact channel, product range and service area.');
  return blockers;
}

export function assertPilotReadiness(): void {
  const blockers = getPilotReadinessBlockers();
  if (blockers.length > 0) {
    throw new Error('Relay pilot mode is blocked until live integrations are ready:\n- ' + blockers.join('\n- '));
  }
}
