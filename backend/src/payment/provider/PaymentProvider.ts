import { PaymentExecutionRequest, PaymentProviderResult } from '../types';

/**
 * Provider-agnostic payment gateway abstraction.
 * All concrete providers (Mock, Sandbox, or future real gateways) implement this interface.
 */
export interface PaymentProvider {
  readonly providerName: string;
  readonly isSimulated: boolean;

  /**
   * Executes payment authorization and capture for a validated, privacy-sanitized payment request.
   * NEVER receives raw resident PII, AI prompts, or arbitrary amounts.
   */
  authorizeAndCapture(
    request: PaymentExecutionRequest
  ): Promise<PaymentProviderResult>;

  /**
   * Optional refund of a previously captured transaction. Providers that
   * cannot refund must not implement this; callers fail closed instead of
   * fabricating a refund.
   */
  refund?(input: {
    providerTransactionId: string;
    amount: number;
    currency: string;
  }): Promise<{ status: 'REFUNDED' | 'FAILED' | 'TIMEOUT'; providerTransactionId: string; failureReason?: string }>;

  /**
   * Queries provider status by idempotency key to recover from crashes / network loss.
   */
  lookupPayment?(idempotencyKey: string): Promise<PaymentProviderResult | null>;

  /**
   * Queries provider refund status by transaction ID to recover from crashes / network loss.
   */
  lookupRefund?(providerTransactionId: string): Promise<{ status: 'REFUNDED' | 'FAILED' | 'TIMEOUT'; providerTransactionId: string; failureReason?: string } | null>;
}

