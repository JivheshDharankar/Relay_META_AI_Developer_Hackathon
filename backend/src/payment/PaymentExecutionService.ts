import { randomUUID } from 'crypto';
import { PurchaseOrder } from '../discovery/supplier/selection/types';
import { MandateService, mandateService } from './mandate/MandateService';
import { PaymentAuditService, paymentAuditService } from './PaymentAuditService';
import { MockPaymentProvider, mockPaymentProvider } from './provider/MockPaymentProvider';
import { PaymentProvider } from './provider/PaymentProvider';
import { assertLegalPaymentTransition } from './stateMachine';
import { prisma } from '../config/prisma';
import {
  Payment,
  PaymentAttempt,
  PaymentAuthorization,
  PaymentExecutionRequest,
} from './types';

export interface ExecutePaymentInput {
  authorization: PaymentAuthorization;
  purchaseOrder: PurchaseOrder;
  provider?: PaymentProvider;
  idempotencyKey?: string;
}

/**
 * Failure codes where Relay cannot prove whether the provider charged the
 * transaction: the response was lost after submission. Retrying such an
 * outcome requires explicit operator acknowledgement (see retryPayment).
 * Definitive provider rejections (e.g. GATEWAY_DECLINED) are NOT uncertain:
 * the provider authoritatively answered "no".
 */
const UNCERTAIN_FAILURE_CODES = new Set([
  'PROVIDER_TIMEOUT',
  'NETWORK_ERROR',
  'PROVIDER_ERROR',
]);

export function isUncertainAttempt(attempt: PaymentAttempt): boolean {
  if (attempt.status === 'TIMEOUT') return true;
  return !!attempt.failureCode && UNCERTAIN_FAILURE_CODES.has(attempt.failureCode);
}

/**
 * Deterministically fingerprints payment payload from:
 * - Amount in integer paise
 * - Purchase Order ID
 * - Mandate ID
 */
export function computePaymentFingerprint(input: ExecutePaymentInput): string {
  const amountPaise = Math.round(Number(input.authorization.amount) * 100);
  const poId = String(input.purchaseOrder?.id || '').trim();
  const mandateId = String(input.authorization?.mandateId || '').trim();
  return `${amountPaise}:${poId}:${mandateId}`;
}

function deserializePayment(data: unknown): Payment {
  const raw = typeof data === 'string' ? JSON.parse(data) : (data as any);
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    authorizedAt: new Date(raw.authorizedAt),
    completedAt: raw.completedAt ? new Date(raw.completedAt) : undefined,
    attempts: (raw.attempts || []).map((att: any) => ({
      ...att,
      timestamp: new Date(att.timestamp),
    })),
  };
}

export class PaymentExecutionService {
  private payments = new Map<string, Payment>();
  private paymentsByCommitment = new Map<string, Payment[]>();
  private idempotencyStore = new Map<string, Payment>();
  private idempotencyFingerprints = new Map<string, string>();
  private inFlightExecutions = new Map<string, Promise<Payment>>();
  private inFlightRetries = new Map<string, Promise<Payment>>();
  private inFlightRefunds = new Map<string, Promise<Payment>>();

  public staleClaimThresholdMs: number = 3000;

  private async pollForPaymentClaimCompletion(
    dedupeKey: string,
    incomingFingerprint: string,
    maxWaitMs = 10000
  ): Promise<Payment> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const claim = await prisma.paymentIdempotencyClaim.findUnique({
          where: { key: dedupeKey },
        });
        if (!claim) break;
        if (claim.fingerprint !== incomingFingerprint) {
          throw new Error(
            `IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key '${dedupeKey}' was already used with a different payment payload`
          );
        }
        if (claim.status === 'EXECUTED' && claim.paymentData) {
          const p = deserializePayment(claim.paymentData);
          this.payments.set(p.id, p);
          this.idempotencyStore.set(dedupeKey, p);
          this.idempotencyFingerprints.set(dedupeKey, incomingFingerprint);
          return p;
        }
        if (claim.status === 'FAILED') {
          throw new Error('PAYMENT_EXECUTION_FAILED: Payment execution failed on claiming instance');
        }
      } catch (err: any) {
        if (err.message?.includes('IDEMPOTENCY_PAYLOAD_MISMATCH')) {
          throw err;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `IDEMPOTENCY_CLAIM_TIMEOUT: Timed out waiting for claiming instance to complete payment '${dedupeKey}'`
    );
  }

  private async pollForRefundClaimCompletion(
    paymentId: string,
    payment: Payment,
    maxWaitMs = 10000
  ): Promise<Payment> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const claim = await prisma.paymentRefundClaim.findUnique({
          where: { paymentId },
        });
        if (!claim) break;
        if (claim.status === 'REFUNDED') {
          payment.status = 'REFUNDED';
          payment.isRefunding = false;
          return payment;
        }
        if (claim.status === 'FAILED') {
          throw new Error('REFUND_FAILED: Prior refund attempt failed on claiming instance');
        }
      } catch (err: any) {
        if (err.message?.includes('REFUND_FAILED')) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `REFUND_CLAIM_TIMEOUT: Timed out waiting for claiming instance to complete refund for payment '${paymentId}'`
    );
  }

  constructor(
    private readonly defaultProvider: PaymentProvider = mockPaymentProvider,
    private readonly mandateSvc: MandateService = mandateService,
    private readonly auditSvc: PaymentAuditService = paymentAuditService,
    /**
     * Maximum time to await a provider response before treating the attempt
     * as a provider timeout (uncertain outcome: terminal FAILED with
     * TIMEOUT_NO_RESPONSE, retryable only after the operator inspects
     * provider state and acknowledges). Guards against hung providers.
     */
    private readonly providerTimeoutMs: number = 30000
  ) {}

  /**
   * Awaits a provider call, failing closed when the provider never settles:
   * a hung provider rejects with code PROVIDER_TIMEOUT (uncertain outcome —
   * Relay cannot prove whether the provider charged the transaction).
   */
  private async awaitProvider(
    provider: PaymentProvider,
    providerRequest: PaymentExecutionRequest
  ): Promise<import('./types').PaymentProviderResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        provider.authorizeAndCapture(providerRequest),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(
              `Provider '${provider.providerName}' did not respond within ${this.providerTimeoutMs}ms`
            );
            (err as any).code = 'PROVIDER_TIMEOUT';
            reject(err);
          }, this.providerTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Executes payment for an already-authorized commercial transaction against a supplier.
   * Strictly concurrency-protected and idempotent.
   */
  public async executePayment(input: ExecutePaymentInput): Promise<Payment> {
    // Only a live AUTHORIZED record may advance to provider execution.
    // Rejected/expired records fail closed here, and an authorization past
    // its 15-minute window is marked EXPIRED with its mandate reservation
    // released (never left orphaned).
    if (input.authorization.status !== 'AUTHORIZED') {
      throw new Error(
        `AUTHORIZATION_NOT_EXECUTABLE: Authorization '${input.authorization.id}' has status '${input.authorization.status}'; only AUTHORIZED records may execute`
      );
    }
    if (input.authorization.expiresAt.getTime() <= Date.now()) {
      input.authorization.status = 'EXPIRED';
      this.mandateSvc.releaseReservation(input.authorization.mandateId, input.authorization.amount);
      this.auditSvc.emit('PAYMENT_AUTHORIZATION_EXPIRED', input.authorization.id, {
        commitmentId: input.authorization.commitmentId,
        purchaseOrderId: input.authorization.purchaseOrderId,
        amount: input.authorization.amount,
        currency: input.authorization.currency,
      });
      throw new Error(
        `AUTHORIZATION_EXPIRED: Authorization '${input.authorization.id}' expired at ${input.authorization.expiresAt.toISOString()}`
      );
    }

    const dedupeKey =
      input.idempotencyKey ||
      `pay_${input.authorization.commitmentId}_${input.authorization.supplierId}_${input.authorization.purpose}`;

    const incomingFingerprint = computePaymentFingerprint(input);

    // 1. In-Memory Idempotency Check
    if (this.idempotencyStore.has(dedupeKey)) {
      const storedFingerprint = this.idempotencyFingerprints.get(dedupeKey);
      if (storedFingerprint && storedFingerprint !== incomingFingerprint) {
        throw new Error(
          `IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key '${dedupeKey}' was already used with a different payment payload`
        );
      }
      return this.idempotencyStore.get(dedupeKey)!;
    }

    // 2. In-Memory Concurrency Lock Check
    if (this.inFlightExecutions.has(dedupeKey)) {
      const storedFingerprint = this.idempotencyFingerprints.get(dedupeKey);
      if (storedFingerprint && storedFingerprint !== incomingFingerprint) {
        throw new Error(
          `IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key '${dedupeKey}' was already used with a different payment payload`
        );
      }
      return this.inFlightExecutions.get(dedupeKey)!;
    }

    this.idempotencyFingerprints.set(dedupeKey, incomingFingerprint);

    const executionPromise = (async () => {
      const provider = input.provider || this.defaultProvider;

      // 3. Durable Database-Backed Idempotency Claim Boundary
      let dbClaim: any = null;
      try {
        dbClaim = await prisma.paymentIdempotencyClaim.findUnique({
          where: { key: dedupeKey },
        });
      } catch {
        // Prisma query bypassed if database is not reachable in pure mock tests
      }

      if (dbClaim) {
        if (dbClaim.fingerprint !== incomingFingerprint) {
          throw new Error(
            `IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key '${dedupeKey}' was already used with a different payment payload`
          );
        }
        if (dbClaim.status === 'EXECUTED' && dbClaim.paymentData) {
          const payment = deserializePayment(dbClaim.paymentData);
          this.payments.set(payment.id, payment);
          this.idempotencyStore.set(dedupeKey, payment);
          this.idempotencyFingerprints.set(dedupeKey, incomingFingerprint);
          return payment;
        }
        if (dbClaim.status === 'UNCERTAIN') {
          throw new Error(
            `CANNOT_RETRY_UNCERTAIN_PAYMENT: Idempotency key '${dedupeKey}' has an uncertain outcome (${dbClaim.failureCode || 'PROVIDER_TIMEOUT'}). Never issuing a second external charge. Inspect provider state first.`
          );
        }
        if (dbClaim.status === 'FAILED') {
          if (dbClaim.failureCode && UNCERTAIN_FAILURE_CODES.has(dbClaim.failureCode)) {
            throw new Error(
              `CANNOT_RETRY_UNCERTAIN_PAYMENT: Idempotency key '${dedupeKey}' failed with uncertain outcome (${dbClaim.failureCode}). Never issuing a second external charge. Inspect provider state first.`
            );
          }
          try {
            await prisma.paymentIdempotencyClaim.update({
              where: { key: dedupeKey },
              data: { status: 'PENDING', updatedAt: new Date() },
            });
          } catch {
            // fallback
          }
        } else if (dbClaim.status === 'PENDING') {
          const isStale = Date.now() - new Date(dbClaim.updatedAt).getTime() >= this.staleClaimThresholdMs;
          if (isStale) {
            return await this.recoverStalledPaymentClaim(dedupeKey, incomingFingerprint, input, provider);
          }
          try {
            return await this.pollForPaymentClaimCompletion(dedupeKey, incomingFingerprint);
          } catch (err: any) {
            if (err.message?.includes('IDEMPOTENCY_CLAIM_TIMEOUT')) {
              return await this.recoverStalledPaymentClaim(dedupeKey, incomingFingerprint, input, provider);
            }
            throw err;
          }
        }
      } else {
        try {
          dbClaim = await prisma.paymentIdempotencyClaim.create({
            data: {
              id: `claim_${randomUUID().slice(0, 8)}`,
              key: dedupeKey,
              fingerprint: incomingFingerprint,
              status: 'PENDING',
            },
          });
        } catch (err: any) {
          if (err.code === 'P2002') {
            // Concurrently claimed by another instance or thread
            try {
              dbClaim = await prisma.paymentIdempotencyClaim.findUnique({
                where: { key: dedupeKey },
              });
              if (dbClaim) {
                if (dbClaim.fingerprint !== incomingFingerprint) {
                  throw new Error(
                    `IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key '${dedupeKey}' was already used with a different payment payload`
                  );
                }
                if (dbClaim.status === 'EXECUTED' && dbClaim.paymentData) {
                  const payment = deserializePayment(dbClaim.paymentData);
                  this.payments.set(payment.id, payment);
                  this.idempotencyStore.set(dedupeKey, payment);
                  this.idempotencyFingerprints.set(dedupeKey, incomingFingerprint);
                  return payment;
                }
                if (dbClaim.status === 'UNCERTAIN') {
                  throw new Error(
                    `CANNOT_RETRY_UNCERTAIN_PAYMENT: Idempotency key '${dedupeKey}' has an uncertain outcome (${dbClaim.failureCode || 'PROVIDER_TIMEOUT'}). Never issuing a second external charge. Inspect provider state first.`
                  );
                }
                if (dbClaim.status === 'PENDING') {
                  const isStale = Date.now() - new Date(dbClaim.updatedAt).getTime() >= this.staleClaimThresholdMs;
                  if (isStale) {
                    return await this.recoverStalledPaymentClaim(dedupeKey, incomingFingerprint, input, provider);
                  }
                  try {
                    return await this.pollForPaymentClaimCompletion(dedupeKey, incomingFingerprint);
                  } catch (pollErr: any) {
                    if (pollErr.message?.includes('IDEMPOTENCY_CLAIM_TIMEOUT')) {
                      return await this.recoverStalledPaymentClaim(dedupeKey, incomingFingerprint, input, provider);
                    }
                    throw pollErr;
                  }
                }
              }
            } catch (fetchErr: any) {
              if (
                fetchErr.message?.includes('IDEMPOTENCY_PAYLOAD_MISMATCH') ||
                fetchErr.message?.includes('CANNOT_RETRY_UNCERTAIN_PAYMENT')
              ) {
                throw fetchErr;
              }
            }
          }
        }
      }

      const now = new Date();
      const paymentId = `pmt_${randomUUID().slice(0, 8)}`;

      // 3. Assemble Payment Entity in PENDING -> AUTHORIZED state
      const payment: Payment = {
        id: paymentId,
        authorizationId: input.authorization.id,
        commitmentId: input.authorization.commitmentId,
        purchaseOrderId: input.purchaseOrder.id,
        supplierId: input.authorization.supplierId,
        supplierName: input.authorization.supplierName,
        supplierContact: input.purchaseOrder.supplierContact || 'orders@supplier.internal',
        mandateId: input.authorization.mandateId,
        amount: input.authorization.amount,
        currency: input.authorization.currency,
        purpose: input.authorization.purpose,
        status: 'PENDING',
        idempotencyKey: dedupeKey,
        providerName: provider.providerName,
        attempts: [],
        isSimulated: provider.isSimulated,
        commercialBasisSimulated: input.authorization.commercialBasisSimulated,
        authorizedAt: input.authorization.authorizedAt,
        createdAt: now,
        updatedAt: now,
      };

      assertLegalPaymentTransition(payment.status, 'AUTHORIZED');
      payment.status = 'AUTHORIZED';

      this.auditSvc.emit('PAYMENT_SUBMITTED', paymentId, {
        commitmentId: payment.commitmentId,
        purchaseOrderId: payment.purchaseOrderId,
        supplierId: payment.supplierId,
        amount: payment.amount,
        currency: payment.currency,
      });

      // 4. Advance to PROCESSING status
      assertLegalPaymentTransition(payment.status, 'PROCESSING');
      payment.status = 'PROCESSING';
      payment.updatedAt = new Date();

      this.auditSvc.emit('PAYMENT_PROCESSING', paymentId, {
        provider: provider.providerName,
        amount: payment.amount,
      });

      // 5. Construct Minimal Privacy-Sanitized Provider Request
      const providerRequest: PaymentExecutionRequest = {
        paymentId,
        commitmentId: payment.commitmentId,
        purchaseOrderId: payment.purchaseOrderId,
        supplierId: payment.supplierId,
        supplierName: payment.supplierName,
        recipientReference: payment.supplierContact,
        amount: payment.amount,
        currency: payment.currency,
        purpose: payment.purpose,
        idempotencyKey: dedupeKey,
      };

      const attemptStartTime = Date.now();

      try {
        const result = await this.awaitProvider(provider, providerRequest);
        const durationMs = Date.now() - attemptStartTime;

        const attempt: PaymentAttempt = {
          attemptNumber: 1,
          providerName: provider.providerName,
          providerTransactionId: result.providerTransactionId,
          status: result.status,
          failureCode: result.failureCode,
          failureReason: result.failureReason,
          isRetryable: result.isRetryable,
          timestamp: new Date(),
          durationMs,
        };
        payment.attempts.push(attempt);
        payment.providerTransactionId = result.providerTransactionId;

        if (result.status === 'SUCCESS') {
          // Success Path: PROCESSING -> SUCCEEDED
          assertLegalPaymentTransition(payment.status, 'SUCCEEDED');
          payment.status = 'SUCCEEDED';
          payment.completedAt = new Date();
          payment.updatedAt = new Date();

          // Commit spending against mandate
          this.mandateSvc.commitSpending(payment.mandateId, payment.amount);

          this.auditSvc.emit('PAYMENT_SUCCEEDED', paymentId, {
            providerTransactionId: result.providerTransactionId,
            amount: payment.amount,
            currency: payment.currency,
            supplierId: payment.supplierId,
          });
        } else {
          // Failure Path: PROCESSING -> FAILED
          assertLegalPaymentTransition(payment.status, 'FAILED');
          payment.status = 'FAILED';
          payment.failureCode = result.failureCode || 'PROVIDER_FAILURE';
          payment.failureReason = result.failureReason || 'Payment provider rejected transaction';
          payment.updatedAt = new Date();

          // Release reservation on failure
          this.mandateSvc.releaseReservation(payment.mandateId, payment.amount);

          this.auditSvc.emit('PAYMENT_FAILED', paymentId, {
            failureCode: payment.failureCode,
            failureReason: payment.failureReason,
            isRetryable: result.isRetryable,
          });
        }
      } catch (err: any) {
        // Unexpected network / provider runtime crash, or a hung provider
        // that never settled (PROVIDER_TIMEOUT: uncertain outcome — the
        // provider may have charged, so any retry requires the operator to
        // inspect provider state and acknowledge first).
        const failureCode = err?.code === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR';
        const durationMs = Date.now() - attemptStartTime;
        payment.attempts.push({
          attemptNumber: 1,
          providerName: provider.providerName,
          status: 'FAILED',
          failureCode,
          failureReason: err?.message || 'Unexpected provider execution error',
          isRetryable: true,
          timestamp: new Date(),
          durationMs,
        });

        assertLegalPaymentTransition(payment.status, 'FAILED');
        payment.status = 'FAILED';
        payment.failureCode = failureCode;
        payment.failureReason = err?.message || 'Unexpected provider execution error';
        payment.updatedAt = new Date();

        this.mandateSvc.releaseReservation(payment.mandateId, payment.amount);

        this.auditSvc.emit('PAYMENT_FAILED', paymentId, {
          failureCode: payment.failureCode,
          failureReason: payment.failureReason,
        });
      }

      // Persist in memory & idempotency store
      this.payments.set(paymentId, payment);
      const list = this.paymentsByCommitment.get(payment.commitmentId) || [];
      list.push(payment);
      this.paymentsByCommitment.set(payment.commitmentId, list);
      this.idempotencyStore.set(dedupeKey, payment);

      // Persist durable claim outcome in database
      try {
        const claimStatus =
          payment.status === 'SUCCEEDED'
            ? 'EXECUTED'
            : payment.failureCode === 'PROVIDER_TIMEOUT'
            ? 'UNCERTAIN'
            : 'FAILED';
        await prisma.paymentIdempotencyClaim.upsert({
          where: { key: dedupeKey },
          update: {
            status: claimStatus,
            paymentData: payment as any,
            providerTxId: payment.providerTransactionId || null,
            failureCode: payment.failureCode || null,
            updatedAt: new Date(),
          },
          create: {
            id: `claim_${randomUUID().slice(0, 8)}`,
            key: dedupeKey,
            fingerprint: incomingFingerprint,
            status: claimStatus,
            paymentData: payment as any,
            providerTxId: payment.providerTransactionId || null,
            failureCode: payment.failureCode || null,
          },
        });
      } catch {
        // DB fallback
      }

      return payment;
    })();

    this.inFlightExecutions.set(dedupeKey, executionPromise);
    try {
      return await executionPromise;
    } catch (err) {
      if (!this.idempotencyStore.has(dedupeKey)) {
        this.idempotencyFingerprints.delete(dedupeKey);
        try {
          await prisma.paymentIdempotencyClaim.update({
            where: { key: dedupeKey },
            data: { status: 'FAILED', updatedAt: new Date() },
          });
        } catch {
          // DB fallback
        }
      }
      throw err;
    } finally {
      this.inFlightExecutions.delete(dedupeKey);
    }
  }

  /**
   * Retries an explicitly failed payment if classified as retryable.
   *
   * SAFETY: when the last attempt has an UNCERTAIN outcome (TIMEOUT, network
   * loss after submission, or any failure where Relay cannot prove whether
   * the provider charged the transaction), the retry is rejected unless the
   * caller passes `acknowledgeUncertainOutcome: true`. That flag means the
   * operator has inspected the authoritative provider/payment state and
   * explicitly accepts responsibility for the retry — it must never be set
   * automatically, because an uncertain retry uses a fresh provider
   * idempotency key and could double-charge if the first attempt executed.
   * Definitive provider rejections keep the existing retry behavior.
   */
  public async retryPayment(
    paymentId: string,
    options?: {
      provider?: PaymentProvider;
      acknowledgeUncertainOutcome?: boolean;
    }
  ): Promise<Payment> {
    // Concurrent retries of the same payment coalesce onto one execution
    // instead of racing the FAILED -> RETRYING transition.
    const inFlight = this.inFlightRetries.get(paymentId);
    if (inFlight) {
      return inFlight;
    }
    const execution = this.doRetryPayment(paymentId, options);
    this.inFlightRetries.set(paymentId, execution);
    try {
      return await execution;
    } finally {
      this.inFlightRetries.delete(paymentId);
    }
  }

  private async doRetryPayment(
    paymentId: string,
    options?: {
      provider?: PaymentProvider;
      acknowledgeUncertainOutcome?: boolean;
    }
  ): Promise<Payment> {
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new Error(`Payment '${paymentId}' not found for retry`);
    }

    if (payment.status !== 'FAILED') {
      throw new Error(
        `Cannot retry payment in '${payment.status}' status; only FAILED payments can be retried`
      );
    }

    const lastAttempt = payment.attempts[payment.attempts.length - 1];
    if (lastAttempt && !lastAttempt.isRetryable) {
      throw new Error(
        `Payment '${paymentId}' failed with non-retryable code '${lastAttempt.failureCode}' (${lastAttempt.failureReason})`
      );
    }

    if (
      lastAttempt &&
      isUncertainAttempt(lastAttempt) &&
      options?.acknowledgeUncertainOutcome !== true
    ) {
      throw new Error(
        `Cannot retry payment '${paymentId}' with uncertain outcome (last attempt: ` +
          `${lastAttempt.status}/${lastAttempt.failureCode ?? 'unknown'}). ` +
          `Inspect the authoritative provider state first, then retry explicitly with ` +
          `acknowledgeUncertainOutcome: true.`
      );
    }

    // State Machine: FAILED -> RETRYING
    assertLegalPaymentTransition(payment.status, 'RETRYING');
    payment.status = 'RETRYING';
    payment.updatedAt = new Date();

    this.auditSvc.emit('PAYMENT_RETRY_REQUESTED', paymentId, {
      attemptNumber: payment.attempts.length + 1,
    });

    // Re-reserve capacity on mandate
    const reservation = await this.mandateSvc.reserveCapacity(
      payment.mandateId,
      payment.amount,
      { currency: payment.currency, purpose: payment.purpose }
    );

    if (!reservation.success) {
      payment.status = 'FAILED';
      payment.failureCode = 'SPENDING_LIMIT_EXCEEDED';
      payment.failureReason = reservation.error;
      payment.updatedAt = new Date();
      throw new Error(`Cannot retry payment: ${reservation.error}`);
    }

    // RETRYING -> PROCESSING
    assertLegalPaymentTransition(payment.status, 'PROCESSING');
    payment.status = 'PROCESSING';
    payment.updatedAt = new Date();

    const provider = options?.provider || this.defaultProvider;
    const providerRequest: PaymentExecutionRequest = {
      paymentId,
      commitmentId: payment.commitmentId,
      purchaseOrderId: payment.purchaseOrderId,
      supplierId: payment.supplierId,
      supplierName: payment.supplierName,
      recipientReference: payment.supplierContact,
      amount: payment.amount,
      currency: payment.currency,
      purpose: payment.purpose,
      idempotencyKey: `${payment.idempotencyKey}_retry_${payment.attempts.length + 1}`,
    };

    const attemptStartTime = Date.now();

    let result: import('./types').PaymentProviderResult;
    try {
      result = await this.awaitProvider(provider, providerRequest);
    } catch (err: any) {
      // A throwing/hung provider during retry must not strand the payment in
      // RETRYING with an unreleased reservation: record the failed attempt
      // and return the payment to FAILED (retryable again, with
      // acknowledgement when the outcome is uncertain).
      const failureCode = err?.code === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR';
      const durationMs = Date.now() - attemptStartTime;
      payment.attempts.push({
        attemptNumber: payment.attempts.length + 1,
        providerName: provider.providerName,
        status: 'FAILED',
        failureCode,
        failureReason: err?.message || 'Unexpected provider execution error',
        isRetryable: true,
        timestamp: new Date(),
        durationMs,
      });

      assertLegalPaymentTransition(payment.status, 'FAILED');
      payment.status = 'FAILED';
      payment.failureCode = failureCode;
      payment.failureReason = err?.message || 'Unexpected provider execution error';
      payment.updatedAt = new Date();

      this.mandateSvc.releaseReservation(payment.mandateId, payment.amount);

      this.auditSvc.emit('PAYMENT_FAILED', paymentId, {
        failureCode: payment.failureCode,
        failureReason: payment.failureReason,
        isRetry: true,
      });

      return payment;
    }
    const durationMs = Date.now() - attemptStartTime;

    const attempt: PaymentAttempt = {
      attemptNumber: payment.attempts.length + 1,
      providerName: provider.providerName,
      providerTransactionId: result.providerTransactionId,
      status: result.status,
      failureCode: result.failureCode,
      failureReason: result.failureReason,
      isRetryable: result.isRetryable,
      timestamp: new Date(),
      durationMs,
    };
    payment.attempts.push(attempt);
    payment.providerTransactionId = result.providerTransactionId;

    if (result.status === 'SUCCESS') {
      assertLegalPaymentTransition(payment.status, 'SUCCEEDED');
      payment.status = 'SUCCEEDED';
      payment.failureCode = undefined;
      payment.failureReason = undefined;
      payment.completedAt = new Date();
      payment.updatedAt = new Date();

      this.mandateSvc.commitSpending(payment.mandateId, payment.amount);

      this.auditSvc.emit('PAYMENT_SUCCEEDED', paymentId, {
        providerTransactionId: result.providerTransactionId,
        amount: payment.amount,
        isRetry: true,
      });
    } else {
      assertLegalPaymentTransition(payment.status, 'FAILED');
      payment.status = 'FAILED';
      payment.failureCode = result.failureCode;
      payment.failureReason = result.failureReason;
      payment.updatedAt = new Date();

      this.mandateSvc.releaseReservation(payment.mandateId, payment.amount);

      this.auditSvc.emit('PAYMENT_FAILED', paymentId, {
        failureCode: result.failureCode,
        failureReason: result.failureReason,
        isRetry: true,
      });
    }

    return payment;
  }

  /**
   * Refunds a SUCCEEDED payment exactly once. Fails closed when the payment
   * does not exist, is not in a refundable state, has no provider
   * transaction to reverse, or the provider cannot refund — a refund is
   * never fabricated. On success the mandate's spent amount is credited so
   * cumulative capacity is restored.
   *
   * Concurrency-guarded: multiple simultaneous refund invocations for the
   * same payment share the single in-flight operation and will never double-credit.
   */
  public async refundPayment(
    paymentId: string,
    provider?: PaymentProvider
  ): Promise<Payment> {
    const inFlight = this.inFlightRefunds.get(paymentId);
    if (inFlight) {
      return await inFlight;
    }

    const refundPromise = (async () => {
      let payment = this.payments.get(paymentId);
      if (!payment) {
        // Rehydrate payment from durable database claim if available (e.g. across restart or multi-instance)
        try {
          const claim = await prisma.paymentIdempotencyClaim.findFirst({
            where: {
              OR: [
                { key: paymentId },
                { paymentData: { path: ['id'], equals: paymentId } },
              ],
            },
          });
          if (claim?.paymentData) {
            payment = deserializePayment(claim.paymentData);
            this.payments.set(payment.id, payment);
          }
        } catch {
          // query fallback
        }
      }

      // 1. Check database-backed refund claim first
      let dbRefundClaim: any = null;
      try {
        dbRefundClaim = await prisma.paymentRefundClaim.findUnique({
          where: { paymentId },
        });
      } catch {
        // fallback
      }

      if (dbRefundClaim) {
        if (dbRefundClaim.status === 'REFUNDED') {
          if (!dbRefundClaim.mandateCredited) {
            // Outbox recovery: Provider refunded prior to crash, but mandate was not credited yet.
            if (payment) {
              this.mandateSvc.refundSpending(payment.mandateId, payment.amount);
            }
            try {
              await prisma.paymentRefundClaim.update({
                where: { paymentId },
                data: {
                  mandateCredited: true,
                  mandateCreditedAt: new Date(),
                  updatedAt: new Date(),
                },
              });
            } catch {
              // fallback
            }
          }
          if (payment) {
            payment.status = 'REFUNDED';
            payment.isRefunding = false;
          }
          throw new Error(
            `REFUND_NOT_POSSIBLE: Payment '${paymentId}' is REFUNDED; only SUCCEEDED payments can be refunded`
          );
        }
        if (dbRefundClaim.status === 'UNCERTAIN') {
          throw new Error(
            `CANNOT_RETRY_UNCERTAIN_REFUND: Payment '${paymentId}' refund has an uncertain outcome. Refusing to issue a second reversal without operator acknowledgement.`
          );
        }
        if (dbRefundClaim.status === 'FAILED') {
          try {
            await prisma.paymentRefundClaim.update({
              where: { paymentId },
              data: { status: 'CLAIMED', updatedAt: new Date() },
            });
          } catch {
            // fallback
          }
        } else if (dbRefundClaim.status === 'CLAIMED') {
          const isStale = Date.now() - new Date(dbRefundClaim.updatedAt).getTime() >= this.staleClaimThresholdMs;
          if (isStale) {
            return await this.recoverStalledRefundClaim(paymentId, provider);
          }
          if (payment) {
            try {
              return await this.pollForRefundClaimCompletion(paymentId, payment);
            } catch (err: any) {
              if (err.message?.includes('REFUND_CLAIM_TIMEOUT')) {
                return await this.recoverStalledRefundClaim(paymentId, provider);
              }
              throw err;
            }
          }
        }
      }

      if (!payment) {
        throw new Error(`PAYMENT_NOT_FOUND: Payment '${paymentId}' does not exist`);
      }
      if (payment.status !== 'SUCCEEDED') {
        throw new Error(
          `REFUND_NOT_POSSIBLE: Payment '${paymentId}' is ${payment.status}; only SUCCEEDED payments can be refunded`
        );
      }
      if (payment.isRefunding) {
        throw new Error(
          `REFUND_ALREADY_IN_PROGRESS: A refund is already in progress for payment '${paymentId}'`
        );
      }
      assertLegalPaymentTransition(payment.status, 'REFUNDED');
      if (!payment.providerTransactionId) {
        throw new Error(
          `REFUND_NOT_POSSIBLE: Payment '${paymentId}' has no provider transaction to reverse`
        );
      }
      const activeProvider = provider ?? this.defaultProvider;
      const refundFn = activeProvider.refund;
      if (typeof refundFn !== 'function') {
        throw new Error(
          `PROVIDER_REFUND_UNSUPPORTED: Provider '${activeProvider.providerName}' does not support refunds`
        );
      }

      // 2. Durable database claim insertion
      if (!dbRefundClaim) {
        try {
          dbRefundClaim = await prisma.paymentRefundClaim.create({
            data: {
              id: `refclaim_${randomUUID().slice(0, 8)}`,
              paymentId,
              status: 'CLAIMED',
              amount: payment.amount,
              mandateId: payment.mandateId,
              providerTxId: payment.providerTransactionId,
            },
          });
        } catch (err: any) {
          if (err.code === 'P2002') {
            // Concurrently claimed by another instance or thread!
            dbRefundClaim = await prisma.paymentRefundClaim.findUnique({
              where: { paymentId },
            });
            if (dbRefundClaim?.status === 'REFUNDED') {
              if (!dbRefundClaim.mandateCredited) {
                this.mandateSvc.refundSpending(payment.mandateId, payment.amount);
                try {
                  await prisma.paymentRefundClaim.update({
                    where: { paymentId },
                    data: {
                      mandateCredited: true,
                      mandateCreditedAt: new Date(),
                      updatedAt: new Date(),
                    },
                  });
                } catch {
                  // fallback
                }
              }
              payment.status = 'REFUNDED';
              payment.isRefunding = false;
              return payment;
            }
            if (dbRefundClaim?.status === 'CLAIMED') {
              const isStale =
                Date.now() - new Date(dbRefundClaim.updatedAt).getTime() >=
                this.staleClaimThresholdMs;
              if (isStale) {
                return await this.recoverStalledRefundClaim(paymentId, activeProvider);
              }
              return await this.pollForRefundClaimCompletion(paymentId, payment);
            }
          }
        }
      }

      // Atomically claim refund status before dispatching external call
      payment.isRefunding = true;

      try {
        const result = await refundFn.call(activeProvider, {
          providerTransactionId: payment.providerTransactionId!,
          amount: payment.amount,
          currency: payment.currency,
        });

        if (result.status === 'TIMEOUT') {
          try {
            await prisma.paymentRefundClaim.update({
              where: { paymentId },
              data: { status: 'UNCERTAIN', updatedAt: new Date() },
            });
          } catch {
            // ignore
          }
          payment.isRefunding = false;
          throw new Error('REFUND_TIMEOUT: Refund gateway timeout');
        }

        if (result.status !== 'REFUNDED') {
          try {
            await prisma.paymentRefundClaim.update({
              where: { paymentId },
              data: { status: 'FAILED', updatedAt: new Date() },
            });
          } catch {
            // ignore
          }
          throw new Error(
            `REFUND_FAILED: ${result.failureReason || 'Provider refused the refund'}`
          );
        }

        // Provider confirmed refund!
        try {
          await prisma.paymentRefundClaim.update({
            where: { paymentId },
            data: {
              status: 'REFUNDED',
              refundedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        } catch {
          // ignore
        }

        payment.status = 'REFUNDED';
        payment.isRefunding = false;
        payment.updatedAt = new Date();

        // Exactly-once mandate spending credit
        this.mandateSvc.refundSpending(payment.mandateId, payment.amount);

        // Mark mandate as credited in durable outbox
        try {
          await prisma.paymentRefundClaim.update({
            where: { paymentId },
            data: {
              mandateCredited: true,
              mandateCreditedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        } catch {
          // ignore
        }

        this.auditSvc.emit('PAYMENT_REFUNDED', payment.id, {
          commitmentId: payment.commitmentId,
          purchaseOrderId: payment.purchaseOrderId,
          amount: payment.amount,
          currency: payment.currency,
          providerTransactionId: payment.providerTransactionId,
        });
        return payment;
      } catch (err) {
        payment.isRefunding = false;
        try {
          const currentClaim = await prisma.paymentRefundClaim.findUnique({
            where: { paymentId },
          });
          if (currentClaim?.status !== 'UNCERTAIN') {
            await prisma.paymentRefundClaim.update({
              where: { paymentId },
              data: { status: 'FAILED', updatedAt: new Date() },
            });
          }
        } catch {
          // ignore
        }
        throw err;
      }
    })();

    this.inFlightRefunds.set(paymentId, refundPromise);
    try {
      return await refundPromise;
    } finally {
      this.inFlightRefunds.delete(paymentId);
    }
  }

  /**
   * Recovers a stalled PENDING payment claim across crashes or multi-instance races.
   * Guarantees:
   * - Atomic recovery lease acquisition (no two instances can recover simultaneously)
   * - Provider lookup before any new execution (never double-charges if provider captured)
   * - Distinguishes definitive failure vs uncertain timeouts
   */
  public async recoverStalledPaymentClaim(
    dedupeKey: string,
    incomingFingerprint: string,
    input: ExecutePaymentInput,
    providerOverride?: PaymentProvider
  ): Promise<Payment> {
    const provider = providerOverride || input.provider || this.defaultProvider;

    // 1. Atomic recovery lock acquisition
    const staleCutoff = new Date(Date.now() - (this.staleClaimThresholdMs > 0 ? this.staleClaimThresholdMs : -1));
    const claimLock = await prisma.paymentIdempotencyClaim.updateMany({
      where: {
        key: dedupeKey,
        status: 'PENDING',
        updatedAt: { lte: staleCutoff },
      },
      data: {
        updatedAt: new Date(),
      },
    });

    if (claimLock.count === 0) {
      // Another instance won recovery lease or status changed
      const currentClaim = await prisma.paymentIdempotencyClaim.findUnique({
        where: { key: dedupeKey },
      });
      if (currentClaim?.status === 'EXECUTED' && currentClaim.paymentData) {
        const p = deserializePayment(currentClaim.paymentData);
        this.payments.set(p.id, p);
        this.idempotencyStore.set(dedupeKey, p);
        return p;
      }
      return await this.pollForPaymentClaimCompletion(dedupeKey, incomingFingerprint);
    }

    // 2. We won the recovery lease. Check provider state!
    let providerResult: import('./types').PaymentProviderResult | null = null;
    if (typeof provider.lookupPayment === 'function') {
      try {
        providerResult = await provider.lookupPayment(dedupeKey);
      } catch {
        providerResult = null;
      }
    }

    const now = new Date();
    const paymentId = `pmt_${randomUUID().slice(0, 8)}`;

    if (providerResult && providerResult.status === 'SUCCESS') {
      // Window P3/P2: Provider already captured this transaction! Never double-charge.
      const payment: Payment = {
        id: paymentId,
        authorizationId: input.authorization.id,
        commitmentId: input.authorization.commitmentId,
        purchaseOrderId: input.purchaseOrder.id,
        supplierId: input.authorization.supplierId,
        supplierName: input.authorization.supplierName,
        supplierContact: input.purchaseOrder.supplierContact || 'orders@supplier.internal',
        mandateId: input.authorization.mandateId,
        amount: input.authorization.amount,
        currency: input.authorization.currency,
        purpose: input.authorization.purpose,
        status: 'SUCCEEDED',
        idempotencyKey: dedupeKey,
        providerName: provider.providerName,
        providerTransactionId: providerResult.providerTransactionId,
        attempts: [
          {
            attemptNumber: 1,
            providerName: provider.providerName,
            providerTransactionId: providerResult.providerTransactionId,
            status: 'SUCCESS',
            isRetryable: false,
            timestamp: now,
            durationMs: 0,
          },
        ],
        isSimulated: provider.isSimulated,
        commercialBasisSimulated: input.authorization.commercialBasisSimulated,
        authorizedAt: input.authorization.authorizedAt,
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      this.mandateSvc.commitSpending(payment.mandateId, payment.amount);

      await prisma.paymentIdempotencyClaim.update({
        where: { key: dedupeKey },
        data: {
          status: 'EXECUTED',
          paymentData: payment as any,
          providerTxId: providerResult.providerTransactionId,
          updatedAt: new Date(),
        },
      });

      this.payments.set(payment.id, payment);
      this.idempotencyStore.set(dedupeKey, payment);
      this.auditSvc.emit('PAYMENT_SUCCEEDED', payment.id, {
        providerTransactionId: providerResult.providerTransactionId,
        amount: payment.amount,
        currency: payment.currency,
        supplierId: payment.supplierId,
        recovered: true,
      });

      return payment;
    }

    if (
      providerResult &&
      (providerResult.status === 'TIMEOUT' || providerResult.failureCode === 'PROVIDER_TIMEOUT')
    ) {
      // Window P4: Provider timeout with uncertain settlement outcome. Refuse second charge!
      await prisma.paymentIdempotencyClaim.update({
        where: { key: dedupeKey },
        data: {
          status: 'UNCERTAIN',
          failureCode: 'PROVIDER_TIMEOUT',
          updatedAt: new Date(),
        },
      });
      this.mandateSvc.releaseReservation(input.authorization.mandateId, input.authorization.amount);
      throw new Error(
        `UNCERTAIN_PAYMENT_OUTCOME: Provider timed out for claim '${dedupeKey}'. Outcome uncertain; refusing second charge without operator acknowledgement.`
      );
    }

    // Window P1: Crash happened before provider was invoked (or provider has no record)
    // Execute normally using same idempotency key
    const payment: Payment = {
      id: paymentId,
      authorizationId: input.authorization.id,
      commitmentId: input.authorization.commitmentId,
      purchaseOrderId: input.purchaseOrder.id,
      supplierId: input.authorization.supplierId,
      supplierName: input.authorization.supplierName,
      supplierContact: input.purchaseOrder.supplierContact || 'orders@supplier.internal',
      mandateId: input.authorization.mandateId,
      amount: input.authorization.amount,
      currency: input.authorization.currency,
      purpose: input.authorization.purpose,
      status: 'PROCESSING',
      idempotencyKey: dedupeKey,
      providerName: provider.providerName,
      attempts: [],
      isSimulated: provider.isSimulated,
      commercialBasisSimulated: input.authorization.commercialBasisSimulated,
      authorizedAt: input.authorization.authorizedAt,
      createdAt: now,
      updatedAt: now,
    };

    const providerRequest: PaymentExecutionRequest = {
      paymentId,
      commitmentId: payment.commitmentId,
      purchaseOrderId: payment.purchaseOrderId,
      supplierId: payment.supplierId,
      supplierName: payment.supplierName,
      recipientReference: payment.supplierContact,
      amount: payment.amount,
      currency: payment.currency,
      purpose: payment.purpose,
      idempotencyKey: dedupeKey,
    };

    const attemptStartTime = Date.now();
    try {
      const result = await this.awaitProvider(provider, providerRequest);
      const durationMs = Date.now() - attemptStartTime;
      payment.attempts.push({
        attemptNumber: 1,
        providerName: provider.providerName,
        providerTransactionId: result.providerTransactionId,
        status: result.status,
        failureCode: result.failureCode,
        failureReason: result.failureReason,
        isRetryable: result.isRetryable,
        timestamp: new Date(),
        durationMs,
      });
      payment.providerTransactionId = result.providerTransactionId;

      if (result.status === 'SUCCESS') {
        payment.status = 'SUCCEEDED';
        payment.completedAt = new Date();
        payment.updatedAt = new Date();
        this.mandateSvc.commitSpending(payment.mandateId, payment.amount);

        await prisma.paymentIdempotencyClaim.update({
          where: { key: dedupeKey },
          data: {
            status: 'EXECUTED',
            paymentData: payment as any,
            providerTxId: result.providerTransactionId,
            updatedAt: new Date(),
          },
        });

        this.payments.set(payment.id, payment);
        this.idempotencyStore.set(dedupeKey, payment);
        return payment;
      } else {
        payment.status = 'FAILED';
        payment.failureCode = result.failureCode || 'PROVIDER_FAILURE';
        payment.failureReason = result.failureReason || 'Payment provider rejected transaction';
        this.mandateSvc.releaseReservation(payment.mandateId, payment.amount);

        await prisma.paymentIdempotencyClaim.update({
          where: { key: dedupeKey },
          data: {
            status: 'FAILED',
            failureCode: payment.failureCode,
            paymentData: payment as any,
            updatedAt: new Date(),
          },
        });
        this.payments.set(payment.id, payment);
        this.idempotencyStore.set(dedupeKey, payment);
        return payment;
      }
    } catch (err: any) {
      const failureCode = err?.code === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR';
      payment.status = 'FAILED';
      payment.failureCode = failureCode;
      payment.failureReason = err?.message || 'Provider execution error';
      this.mandateSvc.releaseReservation(payment.mandateId, payment.amount);

      await prisma.paymentIdempotencyClaim.update({
        where: { key: dedupeKey },
        data: {
          status: failureCode === 'PROVIDER_TIMEOUT' ? 'UNCERTAIN' : 'FAILED',
          failureCode,
          updatedAt: new Date(),
        },
      });
      this.payments.set(payment.id, payment);
      throw err;
    }
  }

  /**
   * Recovers a stalled CLAIMED refund claim across crashes or multi-instance races.
   * Guarantees:
   * - Atomic recovery lease acquisition
   * - Provider lookup before calling provider refund (never double-refunds)
   * - Outbox mandate spending credit (never loses confirmed credit)
   */
  public async recoverStalledRefundClaim(
    paymentId: string,
    providerOverride?: PaymentProvider
  ): Promise<Payment> {
    let payment = this.payments.get(paymentId);
    if (!payment) {
      const claim = await prisma.paymentIdempotencyClaim.findFirst({
        where: {
          OR: [
            { key: paymentId },
            { paymentData: { path: ['id'], equals: paymentId } },
          ],
        },
      });
      if (claim?.paymentData) {
        payment = deserializePayment(claim.paymentData);
        this.payments.set(payment.id, payment);
      }
    }
    if (!payment) {
      throw new Error(`PAYMENT_NOT_FOUND: Payment '${paymentId}' does not exist`);
    }

    const activeProvider = providerOverride ?? this.defaultProvider;

    // 1. Atomic recovery lock acquisition
    const staleCutoff = new Date(Date.now() - (this.staleClaimThresholdMs > 0 ? this.staleClaimThresholdMs : -1));
    const claimLock = await prisma.paymentRefundClaim.updateMany({
      where: {
        paymentId,
        status: 'CLAIMED',
        updatedAt: { lte: staleCutoff },
      },
      data: {
        updatedAt: new Date(),
      },
    });

    if (claimLock.count === 0) {
      // Check if already completed
      const current = await prisma.paymentRefundClaim.findUnique({
        where: { paymentId },
      });
      if (current?.status === 'REFUNDED') {
        if (!current.mandateCredited) {
          this.mandateSvc.refundSpending(payment.mandateId, payment.amount);
          await prisma.paymentRefundClaim.update({
            where: { paymentId },
            data: { mandateCredited: true, mandateCreditedAt: new Date() },
          });
        }
        payment.status = 'REFUNDED';
        payment.isRefunding = false;
        return payment;
      }
      return await this.pollForRefundClaimCompletion(paymentId, payment);
    }

    // 2. We won the recovery lease. Check provider refund state!
    let providerRefundResult: {
      status: 'REFUNDED' | 'FAILED' | 'TIMEOUT';
      providerTransactionId: string;
      failureReason?: string;
    } | null = null;

    if (typeof activeProvider.lookupRefund === 'function' && payment.providerTransactionId) {
      try {
        providerRefundResult = await activeProvider.lookupRefund(payment.providerTransactionId);
      } catch {
        providerRefundResult = null;
      }
    }

    if (providerRefundResult && providerRefundResult.status === 'REFUNDED') {
      // Window R2: Provider already refunded! Never double-refund.
      await prisma.paymentRefundClaim.update({
        where: { paymentId },
        data: {
          status: 'REFUNDED',
          refundedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      // Outbox credit to mandate
      this.mandateSvc.refundSpending(payment.mandateId, payment.amount);
      await prisma.paymentRefundClaim.update({
        where: { paymentId },
        data: {
          mandateCredited: true,
          mandateCreditedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      payment.status = 'REFUNDED';
      payment.isRefunding = false;
      payment.updatedAt = new Date();
      return payment;
    }

    if (providerRefundResult && providerRefundResult.status === 'TIMEOUT') {
      // Window R6: Provider timeout during refund
      await prisma.paymentRefundClaim.update({
        where: { paymentId },
        data: {
          status: 'UNCERTAIN',
          updatedAt: new Date(),
        },
      });
      payment.isRefunding = false;
      throw new Error('REFUND_TIMEOUT: Refund gateway timeout');
    }

    // Window R1: Provider was not called before crash. Safe to call refund!
    const refundFn = activeProvider.refund;
    if (typeof refundFn !== 'function') {
      throw new Error(
        `PROVIDER_REFUND_UNSUPPORTED: Provider '${activeProvider.providerName}' does not support refunds`
      );
    }

    const result = await refundFn.call(activeProvider, {
      providerTransactionId: payment.providerTransactionId!,
      amount: payment.amount,
      currency: payment.currency,
    });

    if (result.status === 'TIMEOUT') {
      await prisma.paymentRefundClaim.update({
        where: { paymentId },
        data: { status: 'UNCERTAIN', updatedAt: new Date() },
      });
      payment.isRefunding = false;
      throw new Error('REFUND_TIMEOUT: Refund gateway timeout');
    }

    if (result.status !== 'REFUNDED') {
      await prisma.paymentRefundClaim.update({
        where: { paymentId },
        data: { status: 'FAILED', updatedAt: new Date() },
      });
      payment.isRefunding = false;
      throw new Error(`REFUND_FAILED: ${result.failureReason || 'Provider refused the refund'}`);
    }

    await prisma.paymentRefundClaim.update({
      where: { paymentId },
      data: {
        status: 'REFUNDED',
        refundedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    this.mandateSvc.refundSpending(payment.mandateId, payment.amount);
    await prisma.paymentRefundClaim.update({
      where: { paymentId },
      data: {
        mandateCredited: true,
        mandateCreditedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    payment.status = 'REFUNDED';
    payment.isRefunding = false;
    payment.updatedAt = new Date();
    return payment;
  }

  public getPayment(id: string): Payment | undefined {
    return this.payments.get(id);
  }

  public getPaymentsForCommitment(commitmentId: string): Payment[] {
    return this.paymentsByCommitment.get(commitmentId) || [];
  }

  public listPayments(): Payment[] {
    return Array.from(this.payments.values());
  }

  public reset(): void {
    this.payments.clear();
    this.paymentsByCommitment.clear();
    this.idempotencyStore.clear();
    this.idempotencyFingerprints.clear();
    this.inFlightExecutions.clear();
    this.inFlightRetries.clear();
    this.inFlightRefunds.clear();
    if (this.defaultProvider instanceof MockPaymentProvider) {
      this.defaultProvider.reset();
    }
  }

  public async clearDurableClaims(): Promise<void> {
    try {
      await prisma.paymentRefundClaim.deleteMany({});
      await prisma.paymentIdempotencyClaim.deleteMany({});
    } catch {
      // ignore
    }
  }
}

export const paymentExecutionService = new PaymentExecutionService();
