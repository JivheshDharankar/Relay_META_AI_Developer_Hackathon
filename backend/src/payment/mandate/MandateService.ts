import { randomUUID } from 'crypto';
import {
  addDecimals,
  isLessThan,
  roundMoney,
  subtractDecimals,
  toDecimal,
} from '../../domain/procurement/decimal';
import { CreateMandateInput, PaymentMandate } from './types';
import {
  MANDATE_SPENDING_LIMIT_CEILING,
  MandateValidationError,
  validateMandateForPayment,
} from './validation';

export class MandateService {
  private mandates = new Map<string, PaymentMandate>();
  // Mutex per mandate to serialize capacity reservation and commit operations safely
  private reservationLocks = new Map<string, Promise<unknown>>();

  /**
   * Creates and registers a new authorized payment mandate.
   */
  public createMandate(input: CreateMandateInput): PaymentMandate {
    const id = input.id || `mandate_${randomUUID().slice(0, 8)}`;
    const now = new Date();

    const mandate: PaymentMandate = {
      id,
      ownerReference: input.ownerReference,
      purpose: input.purpose,
      currency: input.currency || 'INR',
      spendingLimit: roundMoney(toDecimal(input.spendingLimit)).toNumber(),
      spentAmount: 0,
      reservedAmount: 0,
      status: 'ACTIVE',
      validFrom: input.validFrom || now,
      validUntil: input.validUntil,
      providerReference: input.providerReference,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };

    this.mandates.set(id, mandate);
    return mandate;
  }

  public getMandate(id: string): PaymentMandate | undefined {
    return this.mandates.get(id);
  }

  public listMandates(): PaymentMandate[] {
    return Array.from(this.mandates.values());
  }

  public pauseMandate(id: string): PaymentMandate {
    const mandate = this.getMandateOrThrow(id);
    mandate.status = 'PAUSED';
    mandate.updatedAt = new Date();
    return mandate;
  }

  public resumeMandate(id: string): PaymentMandate {
    const mandate = this.getMandateOrThrow(id);
    if (mandate.status === 'REVOKED') {
      throw new Error(`Cannot resume revoked mandate '${id}'`);
    }
    mandate.status = 'ACTIVE';
    mandate.updatedAt = new Date();
    return mandate;
  }

  public revokeMandate(id: string): PaymentMandate {
    const mandate = this.getMandateOrThrow(id);
    mandate.status = 'REVOKED';
    mandate.updatedAt = new Date();
    return mandate;
  }

  /**
   * Updates the authorized spending limit of an existing mandate in place.
   * Mandate identity (id, owner, purpose, validity window, provider
   * reference) is preserved; only the limit changes.
   *
   * Serialized under the same per-mandate lock as capacity reservation so
   * a limit update can never interleave with an in-flight payment
   * authorization. Spent and reserved amounts are untouched: reducing the
   * limit below already-used capacity simply clamps remaining capacity to
   * zero under the existing deterministic rule; completed payments are
   * never retroactively invalidated.
   */
  public async updateSpendingLimit(
    id: string,
    newLimit: number
  ): Promise<{ mandate: PaymentMandate; previousLimit: number }> {
    if (typeof newLimit !== 'number' || !Number.isFinite(newLimit)) {
      throw new MandateValidationError([
        'INVALID_SPENDING_LIMIT: Spending limit must be a finite number',
      ]);
    }
    const roundedLimit = roundMoney(toDecimal(newLimit)).toNumber();
    if (!(roundedLimit > 0)) {
      throw new MandateValidationError([
        'INVALID_SPENDING_LIMIT: Spending limit must be greater than 0',
      ]);
    }
    if (roundedLimit > MANDATE_SPENDING_LIMIT_CEILING) {
      throw new MandateValidationError([
        `SPENDING_LIMIT_CEILING_EXCEEDED: Spending limit exceeds maximum allowable ceiling of ₹${MANDATE_SPENDING_LIMIT_CEILING.toLocaleString('en-IN')}`,
      ]);
    }

    return this.withMandateLock(id, () => {
      const mandate = this.getMandateOrThrow(id);
      if (mandate.status === 'REVOKED') {
        throw new MandateValidationError([
          `MANDATE_REVOKED: Payment mandate '${id}' has been permanently revoked and its limit cannot be changed`,
        ]);
      }
      const previousLimit = mandate.spendingLimit;
      mandate.spendingLimit = roundedLimit;
      mandate.updatedAt = new Date();
      return { mandate, previousLimit };
    });
  }

  public getRemainingCapacity(id: string): number {
    const mandate = this.getMandateOrThrow(id);
    const limit = toDecimal(mandate.spendingLimit);
    const spentAndReserved = addDecimals(mandate.spentAmount, mandate.reservedAmount);
    const remaining = subtractDecimals(limit, spentAndReserved);
    return Math.max(0, roundMoney(remaining).toNumber());
  }

  /**
   * Atomically reserves spending capacity on a mandate before invoking a payment provider.
   * Concurrency-guarded to prevent two simultaneous requests from overspending the mandate.
   */
  public async reserveCapacity(
    id: string,
    amount: number,
    options?: {
      currency?: string;
      purpose?: PaymentMandate['purpose'];
      referenceTime?: Date;
    }
  ): Promise<{ success: boolean; error?: string; remainingCapacity: number }> {
    return this.withMandateLock(id, () => {
      const mandate = this.mandates.get(id);
      if (!mandate) {
        return { success: false, error: 'MANDATE_NOT_FOUND', remainingCapacity: 0 };
      }

      const currency = options?.currency || mandate.currency;
      const purpose = options?.purpose || mandate.purpose;

      const validation = validateMandateForPayment(
        mandate,
        { amount, currency, purpose },
        { referenceTime: options?.referenceTime }
      );

      if (!validation.valid) {
        return {
          success: false,
          error: validation.errors[0],
          remainingCapacity: validation.remainingCapacity,
        };
      }

      // Check capacity using Decimal
      const limit = toDecimal(mandate.spendingLimit);
      const spent = toDecimal(mandate.spentAmount);
      const reserved = toDecimal(mandate.reservedAmount);
      const amtDecimal = toDecimal(amount);

      const currentCommitted = addDecimals(spent, reserved);
      const remainingDecimal = subtractDecimals(limit, currentCommitted);

      if (isLessThan(remainingDecimal, amtDecimal)) {
        return {
          success: false,
          error: `SPENDING_LIMIT_EXCEEDED: Cannot reserve ₹${amount}; available capacity is ₹${validation.remainingCapacity}`,
          remainingCapacity: validation.remainingCapacity,
        };
      }

      // Atomically update reservation
      const newReserved = roundMoney(addDecimals(reserved, amtDecimal)).toNumber();
      mandate.reservedAmount = newReserved;
      mandate.updatedAt = new Date();

      const newRemaining = Math.max(
        0,
        roundMoney(subtractDecimals(remainingDecimal, amtDecimal)).toNumber()
      );

      return {
        success: true,
        remainingCapacity: newRemaining,
      };
    });
  }

  /**
   * Releases previously reserved capacity (e.g. if authorization fails or payment is rejected).
   */
  public releaseReservation(id: string, amount: number): void {
    const mandate = this.mandates.get(id);
    if (!mandate) return;

    const currentReserved = toDecimal(mandate.reservedAmount);
    const amt = toDecimal(amount);
    const newReserved = roundMoney(subtractDecimals(currentReserved, amt));

    mandate.reservedAmount = Math.max(0, newReserved.toNumber());
    mandate.updatedAt = new Date();
  }

  /**
   * Commits spending once a payment succeeds: decreases reserved capacity and increases spent amount.
   */
  public commitSpending(id: string, amount: number): void {
    const mandate = this.mandates.get(id);
    if (!mandate) return;

    const currentReserved = toDecimal(mandate.reservedAmount);
    const currentSpent = toDecimal(mandate.spentAmount);
    const amt = toDecimal(amount);

    const newReserved = Math.max(0, roundMoney(subtractDecimals(currentReserved, amt)).toNumber());
    const newSpent = roundMoney(addDecimals(currentSpent, amt)).toNumber();

    mandate.reservedAmount = newReserved;
    mandate.spentAmount = newSpent;
    mandate.updatedAt = new Date();
  }

  /**
   * Credits a refunded amount back to the mandate: spent decreases so the
   * resident's cumulative capacity is restored exactly once per refund.
   */
  public refundSpending(id: string, amount: number): void {
    const mandate = this.mandates.get(id);
    if (!mandate) return;

    const currentSpent = toDecimal(mandate.spentAmount);
    const amt = toDecimal(amount);
    const newSpent = roundMoney(subtractDecimals(currentSpent, amt));

    mandate.spentAmount = Math.max(0, newSpent.toNumber());
    mandate.updatedAt = new Date();
  }

  public reset(): void {
    this.mandates.clear();
    this.reservationLocks.clear();
  }

  /**
   * Serializes all mutations affecting a mandate's spending capacity
   * (reservations and limit updates) through one FIFO promise chain per
   * mandate id, so concurrent operations apply in arrival order and never
   * interleave.
   */
  private async withMandateLock<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
    const currentLock = this.reservationLocks.get(id) || Promise.resolve();
    let releaseLock: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.reservationLocks.set(id, currentLock.then(() => nextLock));

    await currentLock;
    try {
      return await fn();
    } finally {
      releaseLock!();
    }
  }

  private getMandateOrThrow(id: string): PaymentMandate {
    const mandate = this.mandates.get(id);
    if (!mandate) {
      throw new Error(`Mandate '${id}' not found`);
    }
    return mandate;
  }
}

export const mandateService = new MandateService();

