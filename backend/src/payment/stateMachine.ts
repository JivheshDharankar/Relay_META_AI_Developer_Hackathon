export type PaymentStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'RETRYING'
  | 'REJECTED'
  | 'CANCELLED'
  | 'REFUNDED';

export class PaymentStateMachineError extends Error {
  constructor(
    public readonly currentStatus: PaymentStatus,
    public readonly attemptedStatus: PaymentStatus,
    message?: string
  ) {
    super(
      message ||
        `Illegal payment status transition from '${currentStatus}' to '${attemptedStatus}'`
    );
    this.name = 'PaymentStateMachineError';
  }
}

const LEGAL_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING: ['AUTHORIZED', 'REJECTED', 'CANCELLED'],
  AUTHORIZED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SUCCEEDED', 'FAILED'],
  FAILED: ['RETRYING', 'CANCELLED'],
  RETRYING: ['PROCESSING', 'FAILED', 'CANCELLED'],
  SUCCEEDED: ['REFUNDED'], // Refund is the only exit from a settled payment
  REJECTED: [],  // Terminal
  CANCELLED: [], // Terminal
  REFUNDED: [],  // Terminal
};

/**
 * Checks whether a transition between two payment statuses is legal.
 */
export function canTransitionPayment(
  current: PaymentStatus,
  next: PaymentStatus
): boolean {
  if (current === next) return true;
  const legalNext = LEGAL_TRANSITIONS[current] || [];
  return legalNext.includes(next);
}

/**
 * Asserts that a payment transition is valid according to the domain state machine.
 * Throws PaymentStateMachineError if illegal.
 */
export function assertLegalPaymentTransition(
  current: PaymentStatus,
  next: PaymentStatus
): void {
  if (!canTransitionPayment(current, next)) {
    throw new PaymentStateMachineError(current, next);
  }
}

