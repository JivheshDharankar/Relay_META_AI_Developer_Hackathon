import { MandateStatus, PaymentMandate, PaymentPurpose } from './mandate/types';
import { PaymentStatus } from './stateMachine';

export { MandateStatus, PaymentMandate, PaymentPurpose, PaymentStatus };

/**
 * Validated status of a deterministic payment authorization check.
 */
export type PaymentAuthorizationStatus = 'AUTHORIZED' | 'REJECTED' | 'EXPIRED';

/**
 * Deterministic authorization record issued by the authorization engine.
 * Only an AUTHORIZED record may advance to provider execution.
 */
export interface PaymentAuthorization {
  id: string;
  commitmentId: string;
  purchaseOrderId: string;
  supplierId: string;
  supplierName: string;
  mandateId: string;
  amount: number;
  currency: string;
  purpose: PaymentPurpose;
  status: PaymentAuthorizationStatus;
  authorizedAt: Date;
  expiresAt: Date;
  rejectionReasons?: string[];
  /**
   * True when the authorized commercial basis came from simulated supplier
   * responses. Copied from the parent commitment; marks the basis, not the
   * authorization itself.
   */
  commercialBasisSimulated?: boolean;
}

/**
 * Minimal, privacy-sanitized execution request dispatched to a payment provider.
 * Strictly contains NO resident names, NO resident IDs, NO flat numbers, NO AI reasoning.
 */
export interface PaymentExecutionRequest {
  paymentId: string;
  commitmentId: string;
  purchaseOrderId: string;
  supplierId: string;
  supplierName: string;
  recipientReference: string; // Supplier contact / account reference
  amount: number;
  currency: string;
  purpose: PaymentPurpose;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

/**
 * Normalized provider execution result.
 */
export interface PaymentProviderResult {
  status: 'SUCCESS' | 'FAILED' | 'TIMEOUT';
  providerTransactionId: string;
  providerName: string;
  failureCode?: string;
  failureReason?: string;
  isRetryable: boolean;
  processedAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Log of an individual attempt to execute payment through a provider.
 */
export interface PaymentAttempt {
  attemptNumber: number;
  providerName: string;
  providerTransactionId?: string;
  status: 'SUCCESS' | 'FAILED' | 'TIMEOUT';
  failureCode?: string;
  failureReason?: string;
  isRetryable: boolean;
  timestamp: Date;
  durationMs: number;
}

/**
 * Authoritative, immutable Relay Payment domain entity.
 */
export interface Payment {
  id: string;
  authorizationId: string;
  commitmentId: string;
  purchaseOrderId: string;
  supplierId: string;
  supplierName: string;
  supplierContact: string;
  mandateId: string;
  amount: number;
  currency: string;
  purpose: PaymentPurpose;
  status: PaymentStatus;
  idempotencyKey: string;
  providerName: string;
  providerTransactionId?: string;
  attempts: PaymentAttempt[];
  failureCode?: string;
  failureReason?: string;
  isSimulated: boolean;
  authorizedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  /**
   * Concurrency claim flag: true while an active refund attempt is in flight.
   */
  isRefunding?: boolean;
  /**
   * True when the paid commercial basis came from simulated supplier
   * responses. Copied from the authorization; distinct from isSimulated,
   * which marks the payment provider/execution simulation.
   */
  commercialBasisSimulated?: boolean;
}

/**
 * Represents a single supplier commercial payment obligation within a procurement.
 */
export interface SupplierPaymentObligation {
  supplierId: string;
  supplierName: string;
  purchaseOrderId: string;
  amount: number;
  paymentId?: string;
  status: PaymentStatus;
  providerTransactionId?: string;
}

/**
 * Overall payment summary for a Phase 6 procurement commitment.
 * Tracks consolidated state across all supplier allocations.
 */
export interface ProcurementPaymentSummary {
  commitmentId: string;
  rfqId: string;
  totalAmount: number;
  paidAmount: number;
  currency: string;
  status: 'NOT_PAID' | 'PARTIALLY_PAID' | 'FULLY_PAID' | 'FAILED' | 'PROCESSING';
  payments: Payment[];
  supplierObligations: SupplierPaymentObligation[];
}

