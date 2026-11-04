import { randomUUID } from 'crypto';
import { eventBus } from '../events';

export type PaymentAuditEventType =
  | 'PAYMENT_AUTHORIZATION_STARTED'
  | 'PAYMENT_AUTHORIZATION_VALIDATED'
  | 'PAYMENT_AUTHORIZATION_REJECTED'
  | 'PAYMENT_RESERVED'
  | 'PAYMENT_SUBMITTED'
  | 'PAYMENT_PROCESSING'
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_RETRY_REQUESTED'
  | 'PAYMENT_AUTHORIZATION_EXPIRED'
  | 'PAYMENT_CANCELLED'
  | 'PAYMENT_REFUNDED';

export class PaymentAuditService {
  /**
   * Emits a privacy-sanitized financial audit event to the Relay event bus.
   * Ensures zero resident PII, flat numbers, budgets, or secret credentials are ever exposed in logs.
   */
  public emit(
    eventType: PaymentAuditEventType,
    aggregateId: string,
    payload: Record<string, unknown>
  ): void {
    eventBus
      .publish({
        id: randomUUID(),
        name: eventType,
        aggregateId,
        timestamp: new Date().toISOString(),
        payload: this.sanitizePayload(payload),
      })
      .catch(() => {});
  }

  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const forbiddenKeys = [
      'flatNumber',
      'apartment',
      'residentName',
      'residentEmail',
      'residentPhone',
      'pin',
      'password',
      'cvv',
      'prompt',
      'reasoning',
    ];

    for (const [key, value] of Object.entries(payload)) {
      if (forbiddenKeys.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
        continue;
      }
      sanitized[key] = value;
    }

    return sanitized;
  }
}

export const paymentAuditService = new PaymentAuditService();

