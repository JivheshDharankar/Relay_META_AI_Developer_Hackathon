import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../src/config/prisma';
import { MandateService } from '../src/payment/mandate/MandateService';
import { PaymentExecutionService } from '../src/payment/PaymentExecutionService';
import { MockPaymentProvider } from '../src/payment/provider/MockPaymentProvider';
import { PaymentAuthorization } from '../src/payment/types';
import { PurchaseOrder } from '../src/discovery/supplier/selection/types';

describe('Financial Durability: Crash-Window & Adversarial Recovery Audit', () => {
  beforeEach(async () => {
    try {
      await prisma.paymentRefundClaim.deleteMany({});
      await prisma.paymentIdempotencyClaim.deleteMany({});
    } catch {
      // ignore if DB is offline
    }
  });

  function createTestPaymentContext(opts: {
    amount: number;
    mandateLimit: number;
    poId?: string;
    mandateId?: string;
  }) {
    const mandates = new MandateService();
    const mandate = mandates.createMandate({
      id: opts.mandateId || `man_${Math.random().toString(36).slice(2, 8)}`,
      ownerReference: 'res_crash_recovery_user',
      purpose: 'COMMUNITY_PROCUREMENT',
      spendingLimit: opts.mandateLimit,
      currency: 'INR',
    });

    const poId = opts.poId || `po_${Math.random().toString(36).slice(2, 8)}`;
    const purchaseOrder: PurchaseOrder = {
      id: poId,
      rfqId: 'rfq_crash_test',
      candidateId: 'cand_sup_crash',
      supplierName: 'Crash Recovery Wholesalers',
      currency: 'INR',
      lineItems: [
        {
          productId: 'prod_crash_1',
          productName: 'Sharbati Wheat',
          quantity: 20,
          unit: 'KG',
          unitPrice: opts.amount / 20,
          subtotal: opts.amount,
        },
      ],
      totalAmount: opts.amount,
      status: 'CONFIRMED',
      commercialBasis: 'AUTHENTIC_SUPPLIER_RESPONSE',
      issuedAt: new Date(),
    };

    const authorization: PaymentAuthorization = {
      id: `auth_${Math.random().toString(36).slice(2, 8)}`,
      commitmentId: 'comm_crash_test',
      purchaseOrderId: poId,
      supplierId: 'cand_sup_crash',
      supplierName: 'Crash Recovery Wholesalers',
      mandateId: mandate.id,
      amount: opts.amount,
      currency: 'INR',
      purpose: 'COMMUNITY_PROCUREMENT',
      status: 'AUTHORIZED',
      authorizedAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
    };

    return { mandates, mandate, purchaseOrder, authorization };
  }

  // =========================================================================
  // CONTROL 1: PAYMENT EXECUTION CRASH-WINDOW RECOVERY
  // =========================================================================
  describe('Control 1: Payment Execution Crash Recovery', () => {
    it('P1: recovers stalled PENDING claim when crash occurs before provider invocation', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 2500,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const providerAuthorizeSpy = vi.spyOn(provider, 'authorizeAndCapture');

      const dedupeKey = `pay_crash_p1_${Date.now()}`;
      const amountPaise = Math.round(Number(authorization.amount) * 100);
      const fingerprint = `${amountPaise}:${purchaseOrder.id}:${mandate.id}`;

      // Simulate crash: DB claim was inserted as PENDING, but process crashed before provider call
      await prisma.paymentIdempotencyClaim.create({
        data: {
          key: dedupeKey,
          fingerprint,
          status: 'PENDING',
          updatedAt: new Date(Date.now() - 10000), // Stalled 10 seconds ago
        },
      });

      // New service instance starts up post-crash
      const recoveredService = new PaymentExecutionService(provider, mandates);
      recoveredService.staleClaimThresholdMs = 100; // Fast recovery in test

      const payment = await recoveredService.executePayment({
        authorization,
        purchaseOrder,
        provider,
        idempotencyKey: dedupeKey,
      });

      expect(payment.status).toBe('SUCCEEDED');
      expect(payment.amount).toBe(2500);
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(2500);
      expect(providerAuthorizeSpy).toHaveBeenCalledTimes(1);

      // Verify DB claim advanced to EXECUTED
      const updatedClaim = await prisma.paymentIdempotencyClaim.findUnique({
        where: { key: dedupeKey },
      });
      expect(updatedClaim?.status).toBe('EXECUTED');
      expect(updatedClaim?.providerTxId).toBe(payment.providerTransactionId);
    });

    it('P2: recovers transaction without double charge when crash occurs while provider request is in flight', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 3200,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const dedupeKey = `pay_crash_p2_${Date.now()}`;

      // Provider already executed the transaction before caller crashed
      const preCapturedTx = await provider.authorizeAndCapture({
        paymentId: 'pmt_flight_crash',
        commitmentId: authorization.commitmentId,
        purchaseOrderId: purchaseOrder.id,
        supplierId: authorization.supplierId,
        supplierName: authorization.supplierName,
        recipientReference: 'orders@supplier.internal',
        amount: authorization.amount,
        currency: authorization.currency,
        purpose: authorization.purpose,
        idempotencyKey: dedupeKey,
      });

      const providerAuthorizeSpy = vi.spyOn(provider, 'authorizeAndCapture');

      const amountPaise = Math.round(Number(authorization.amount) * 100);
      const fingerprint = `${amountPaise}:${purchaseOrder.id}:${mandate.id}`;

      // Stalled PENDING claim left by crashed instance
      await prisma.paymentIdempotencyClaim.create({
        data: {
          key: dedupeKey,
          fingerprint,
          status: 'PENDING',
          updatedAt: new Date(Date.now() - 10000),
        },
      });

      // Recovering instance runs
      const recoveredService = new PaymentExecutionService(provider, mandates);
      recoveredService.staleClaimThresholdMs = 100;

      const payment = await recoveredService.executePayment({
        authorization,
        purchaseOrder,
        provider,
        idempotencyKey: dedupeKey,
      });

      expect(payment.status).toBe('SUCCEEDED');
      expect(payment.providerTransactionId).toBe(preCapturedTx.providerTransactionId);
      // STRICT REQUIREMENT: Zero double charges! authorizeAndCapture must NOT be called again
      expect(providerAuthorizeSpy).not.toHaveBeenCalled();
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(3200);

      const dbClaim = await prisma.paymentIdempotencyClaim.findUnique({
        where: { key: dedupeKey },
      });
      expect(dbClaim?.status).toBe('EXECUTED');
    });

    it('P3: recovers transaction when provider charged successfully but backend crashed before persisting EXECUTED', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 4500,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const dedupeKey = `pay_crash_p3_${Date.now()}`;

      // Provider captured
      const providerTx = await provider.authorizeAndCapture({
        paymentId: 'pmt_crash_p3',
        commitmentId: authorization.commitmentId,
        purchaseOrderId: purchaseOrder.id,
        supplierId: authorization.supplierId,
        supplierName: authorization.supplierName,
        recipientReference: 'orders@supplier.internal',
        amount: authorization.amount,
        currency: authorization.currency,
        purpose: authorization.purpose,
        idempotencyKey: dedupeKey,
      });

      const amountPaise = Math.round(Number(authorization.amount) * 100);
      const fingerprint = `${amountPaise}:${purchaseOrder.id}:${mandate.id}`;

      await prisma.paymentIdempotencyClaim.create({
        data: {
          key: dedupeKey,
          fingerprint,
          status: 'PENDING',
          updatedAt: new Date(Date.now() - 5000),
        },
      });

      const recoveredService = new PaymentExecutionService(provider, mandates);
      recoveredService.staleClaimThresholdMs = 100;

      const payment = await recoveredService.executePayment({
        authorization,
        purchaseOrder,
        provider,
        idempotencyKey: dedupeKey,
      });

      expect(payment.status).toBe('SUCCEEDED');
      expect(payment.providerTransactionId).toBe(providerTx.providerTransactionId);
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(4500);

      const claim = await prisma.paymentIdempotencyClaim.findUnique({
        where: { key: dedupeKey },
      });
      expect(claim?.status).toBe('EXECUTED');
    });

    it('P4: marks claim UNCERTAIN on provider timeout and strictly refuses second charge without operator ack', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 6000,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const dedupeKey = `pay_crash_p4_${Date.now()}`;
      provider.simulateTimeout(dedupeKey);

      const service = new PaymentExecutionService(provider, mandates);
      service.staleClaimThresholdMs = 100;

      // First attempt returns failed payment with PROVIDER_TIMEOUT
      const failedPayment = await service.executePayment({
        authorization,
        purchaseOrder,
        provider,
        idempotencyKey: dedupeKey,
      });
      expect(failedPayment.status).toBe('FAILED');
      expect(failedPayment.failureCode).toBe('PROVIDER_TIMEOUT');

      // Verify claim was marked UNCERTAIN
      const claim = await prisma.paymentIdempotencyClaim.findUnique({
        where: { key: dedupeKey },
      });
      expect(claim?.status).toBe('UNCERTAIN');
      expect(claim?.failureCode).toBe('PROVIDER_TIMEOUT');

      // Mandate reservation was released, no spending committed
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(0);

      // Subsequent retry using the same idempotency key MUST be rejected to prevent double charge
      const newInstance = new PaymentExecutionService(provider, mandates);
      await expect(
        newInstance.executePayment({
          authorization,
          purchaseOrder,
          provider,
          idempotencyKey: dedupeKey,
        })
      ).rejects.toThrow('CANNOT_RETRY_UNCERTAIN_PAYMENT');
    });

    it('P5: restart followed by retry returns cached payment on identical payload, rejects mutated payload', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 1500,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const dedupeKey = `pay_crash_p5_${Date.now()}`;

      const service1 = new PaymentExecutionService(provider, mandates);
      const originalPayment = await service1.executePayment({
        authorization,
        purchaseOrder,
        provider,
        idempotencyKey: dedupeKey,
      });

      expect(originalPayment.status).toBe('SUCCEEDED');

      // Complete service restart (fresh in-memory state)
      const service2 = new PaymentExecutionService(provider, mandates);

      // Identical payload retry -> returns cached payment
      const retriedPayment = await service2.executePayment({
        authorization,
        purchaseOrder,
        provider,
        idempotencyKey: dedupeKey,
      });
      expect(retriedPayment.id).toBe(originalPayment.id);
      expect(retriedPayment.providerTransactionId).toBe(originalPayment.providerTransactionId);

      // Mutated payload retry (e.g. altered amount) -> rejected
      const mutatedAuth = { ...authorization, amount: 9999 };
      await expect(
        service2.executePayment({
          authorization: mutatedAuth,
          purchaseOrder,
          provider,
          idempotencyKey: dedupeKey,
        })
      ).rejects.toThrow('IDEMPOTENCY_PAYLOAD_MISMATCH');
    });

    it('P6: safely coordinates two instances racing to recover the same stalled PENDING claim', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 7500,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const providerAuthorizeSpy = vi.spyOn(provider, 'authorizeAndCapture');
      const dedupeKey = `pay_crash_p6_${Date.now()}`;
      const amountPaise = Math.round(Number(authorization.amount) * 100);
      const fingerprint = `${amountPaise}:${purchaseOrder.id}:${mandate.id}`;

      // Stalled claim
      await prisma.paymentIdempotencyClaim.create({
        data: {
          key: dedupeKey,
          fingerprint,
          status: 'PENDING',
          updatedAt: new Date(Date.now() - 10000),
        },
      });

      const instance1 = new PaymentExecutionService(provider, mandates);
      instance1.staleClaimThresholdMs = 100;
      const instance2 = new PaymentExecutionService(provider, mandates);
      instance2.staleClaimThresholdMs = 100;

      // Both instances attempt recovery simultaneously
      const [res1, res2] = await Promise.all([
        instance1.executePayment({
          authorization,
          purchaseOrder,
          provider,
          idempotencyKey: dedupeKey,
        }),
        instance2.executePayment({
          authorization,
          purchaseOrder,
          provider,
          idempotencyKey: dedupeKey,
        }),
      ]);

      expect(res1.status).toBe('SUCCEEDED');
      expect(res2.status).toBe('SUCCEEDED');
      expect(res1.providerTransactionId).toBe(res2.providerTransactionId);

      // Exactly once external charge
      expect(providerAuthorizeSpy).toHaveBeenCalledTimes(1);
      // Exactly once mandate spending
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(7500);
    });

    it('P7: safe retry succeeds for definitive failure, but uncertain failure rejects without acknowledgement', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 1800,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const dedupeKey = `pay_crash_p7_${Date.now()}`;

      // 1. Definitive Failure: retryable provider gateway error
      provider.simulateFailure(dedupeKey, 'GATEWAY_ERROR', 'Temporary gateway error', true);

      const service = new PaymentExecutionService(provider, mandates);
      const failedPayment = await service.executePayment({
        authorization,
        purchaseOrder,
        provider,
        idempotencyKey: dedupeKey,
      });

      expect(failedPayment.status).toBe('FAILED');
      expect(failedPayment.failureCode).toBe('GATEWAY_ERROR');

      const claim = await prisma.paymentIdempotencyClaim.findUnique({
        where: { key: dedupeKey },
      });
      expect(claim?.status).toBe('FAILED');
      expect(claim?.failureCode).toBe('GATEWAY_ERROR');

      // Clear decline override so provider now succeeds
      provider.clearOverrides();

      // Safe retry using retryPayment succeeds without double charge
      const retriedPayment = await service.retryPayment(failedPayment.id, { provider });
      expect(retriedPayment.status).toBe('SUCCEEDED');
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(1800);

      // 2. Uncertain Failure: TIMEOUT
      const dedupeKeyUncertain = `pay_crash_p7_unc_${Date.now()}`;
      provider.simulateTimeout(dedupeKeyUncertain);

      const auth2: PaymentAuthorization = {
        ...authorization,
        id: `auth_unc_${Date.now()}`,
      };

      const uncertainPayment = await service.executePayment({
        authorization: auth2,
        purchaseOrder,
        provider,
        idempotencyKey: dedupeKeyUncertain,
      });
      expect(uncertainPayment.status).toBe('FAILED');
      expect(uncertainPayment.failureCode).toBe('PROVIDER_TIMEOUT');

      // Retry without operator acknowledgement is strictly rejected
      await expect(
        service.retryPayment(uncertainPayment.id, { provider })
      ).rejects.toThrow('uncertain outcome');

      // Calling executePayment with the same idempotency key post-restart is also rejected
      const instancePostRestart = new PaymentExecutionService(provider, mandates);
      await expect(
        instancePostRestart.executePayment({
          authorization: auth2,
          purchaseOrder,
          provider,
          idempotencyKey: dedupeKeyUncertain,
        })
      ).rejects.toThrow('CANNOT_RETRY_UNCERTAIN_PAYMENT');

      // Safe retry WITH operator acknowledgment succeeds
      provider.clearOverrides();
      const ackPayment = await service.retryPayment(uncertainPayment.id, {
        provider,
        acknowledgeUncertainOutcome: true,
      });
      expect(ackPayment.status).toBe('SUCCEEDED');
    });
  });

  // =========================================================================
  // CONTROL 2: REFUND & MANDATE CREDIT CRASH RECOVERY
  // =========================================================================
  describe('Control 2: Refund & Mandate Credit Recovery', () => {
    it('R1: recovers stalled CLAIMED refund claim when crash occurs before provider refund invocation', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 5000,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const service = new PaymentExecutionService(provider, mandates);
      const payment = await service.executePayment({
        authorization,
        purchaseOrder,
        provider,
      });
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(5000);

      // Simulate crash after CLAIMED claim insertion but before provider refund was called
      await prisma.paymentRefundClaim.create({
        data: {
          paymentId: payment.id,
          status: 'CLAIMED',
          amount: payment.amount,
          mandateId: payment.mandateId,
          providerTxId: payment.providerTransactionId!,
          updatedAt: new Date(Date.now() - 10000), // Stalled
        },
      });

      // Provider has not refunded yet
      expect(provider.refundedTransactions.has(payment.providerTransactionId!)).toBe(false);

      const recoveredService = new PaymentExecutionService(provider, mandates);
      recoveredService.staleClaimThresholdMs = 100;

      const refunded = await recoveredService.refundPayment(payment.id, provider);
      expect(refunded.status).toBe('REFUNDED');
      // Mandate spending credited exactly once
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(0);
      expect(provider.refundedTransactions.has(payment.providerTransactionId!)).toBe(true);

      const dbClaim = await prisma.paymentRefundClaim.findUnique({
        where: { paymentId: payment.id },
      });
      expect(dbClaim?.status).toBe('REFUNDED');
      expect(dbClaim?.mandateCredited).toBe(true);
    });

    it('R2: recovers when provider refund succeeded but backend crashed before REFUNDED persistence', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 8000,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const service = new PaymentExecutionService(provider, mandates);
      const payment = await service.executePayment({
        authorization,
        purchaseOrder,
        provider,
      });

      // Provider already executed the refund
      await provider.refund({
        providerTransactionId: payment.providerTransactionId!,
        amount: payment.amount,
        currency: payment.currency,
      });
      expect(provider.refundedTransactions.has(payment.providerTransactionId!)).toBe(true);

      const providerRefundSpy = vi.spyOn(provider, 'refund');

      // Stalled claim left as CLAIMED
      await prisma.paymentRefundClaim.create({
        data: {
          paymentId: payment.id,
          status: 'CLAIMED',
          amount: payment.amount,
          mandateId: payment.mandateId,
          providerTxId: payment.providerTransactionId!,
          updatedAt: new Date(Date.now() - 10000),
        },
      });

      const recoveredService = new PaymentExecutionService(provider, mandates);
      recoveredService.staleClaimThresholdMs = 100;

      const refunded = await recoveredService.refundPayment(payment.id, provider);
      expect(refunded.status).toBe('REFUNDED');
      // Provider refund was NOT called a second time
      expect(providerRefundSpy).not.toHaveBeenCalled();
      // Mandate spending restored
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(0);

      const dbClaim = await prisma.paymentRefundClaim.findUnique({
        where: { paymentId: payment.id },
      });
      expect(dbClaim?.status).toBe('REFUNDED');
      expect(dbClaim?.mandateCredited).toBe(true);
    });

    it('R3: outbox recovery ensures mandate credit is never lost when crash occurs after provider refund and REFUNDED persistence', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 4000,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const service = new PaymentExecutionService(provider, mandates);
      const payment = await service.executePayment({
        authorization,
        purchaseOrder,
        provider,
      });
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(4000);

      // Provider already refunded
      provider.refundedTransactions.add(payment.providerTransactionId!);

      // Database marked REFUNDED, but crash happened before mandate credit: mandateCredited: false
      await prisma.paymentRefundClaim.create({
        data: {
          paymentId: payment.id,
          status: 'REFUNDED',
          amount: payment.amount,
          mandateId: payment.mandateId,
          providerTxId: payment.providerTransactionId!,
          mandateCredited: false, // Pending outbox credit!
          refundedAt: new Date(),
        },
      });

      const recoveredService = new PaymentExecutionService(provider, mandates);

      // Caller invokes refundPayment on the refunded transaction
      await expect(
        recoveredService.refundPayment(payment.id, provider)
      ).rejects.toThrow('REFUND_NOT_POSSIBLE');

      // The unfinalized outbox mandate credit was executed!
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(0);

      const dbClaim = await prisma.paymentRefundClaim.findUnique({
        where: { paymentId: payment.id },
      });
      expect(dbClaim?.mandateCredited).toBe(true);

      // Calling again does not credit mandate again
      await expect(
        recoveredService.refundPayment(payment.id, provider)
      ).rejects.toThrow('REFUND_NOT_POSSIBLE');
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(0);
    });

    it('R4: serializes concurrent refunds across 2 instances with exactly one provider call and mandate credit', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 3500,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const providerRefundSpy = vi.spyOn(provider, 'refund');

      const service = new PaymentExecutionService(provider, mandates);
      const payment = await service.executePayment({
        authorization,
        purchaseOrder,
        provider,
      });
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(3500);

      const instance1 = new PaymentExecutionService(provider, mandates);
      const instance2 = new PaymentExecutionService(provider, mandates);

      const [res1, res2] = await Promise.all([
        instance1.refundPayment(payment.id, provider),
        instance2.refundPayment(payment.id, provider),
      ]);

      expect(res1.status).toBe('REFUNDED');
      expect(res2.status).toBe('REFUNDED');
      expect(providerRefundSpy).toHaveBeenCalledTimes(1);
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(0);
    });

    it('R5: restart and retry after completed refund rejects and never credits mandate twice', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 2200,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const service1 = new PaymentExecutionService(provider, mandates);
      const payment = await service1.executePayment({
        authorization,
        purchaseOrder,
        provider,
      });
      await service1.refundPayment(payment.id, provider);
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(0);

      // Fresh instance post-restart
      const service2 = new PaymentExecutionService(provider, mandates);
      await expect(
        service2.refundPayment(payment.id, provider)
      ).rejects.toThrow('REFUND_NOT_POSSIBLE');

      // Mandate spent amount must stay 0, never negative or double-credited
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(0);
    });

    it('R6: marks refund claim UNCERTAIN on provider timeout and does NOT restore spending capacity', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 5500,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const service = new PaymentExecutionService(provider, mandates);
      const payment = await service.executePayment({
        authorization,
        purchaseOrder,
        provider,
      });
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(5500);

      // Provider timeout during refund
      provider.simulateTimeout(payment.providerTransactionId!);

      await expect(
        service.refundPayment(payment.id, provider)
      ).rejects.toThrow('REFUND_TIMEOUT');

      // SPENDING CAPACITY MUST NOT BE RESTORED BEFORE CONFIRMED SETTLEMENT!
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(5500);

      const dbClaim = await prisma.paymentRefundClaim.findUnique({
        where: { paymentId: payment.id },
      });
      expect(dbClaim?.status).toBe('UNCERTAIN');
      expect(dbClaim?.mandateCredited).toBe(false);

      // Retrying uncertain refund is rejected to prevent double reversal
      await expect(
        service.refundPayment(payment.id, provider)
      ).rejects.toThrow('CANNOT_RETRY_UNCERTAIN_REFUND');
    });

    it('R7: provider failure marks FAILED without crediting mandate, and safe retry restores capacity upon confirmed settlement', async () => {
      const { mandates, mandate, purchaseOrder, authorization } = createTestPaymentContext({
        amount: 4200,
        mandateLimit: 50000,
      });

      const provider = new MockPaymentProvider();
      const service = new PaymentExecutionService(provider, mandates);
      const payment = await service.executePayment({
        authorization,
        purchaseOrder,
        provider,
      });
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(4200);

      // Provider fails refund
      provider.simulateFailure(payment.providerTransactionId!, 'GATEWAY_ERROR', 'Provider internal error');

      await expect(
        service.refundPayment(payment.id, provider)
      ).rejects.toThrow('REFUND_FAILED');

      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(4200);

      let dbClaim = await prisma.paymentRefundClaim.findUnique({
        where: { paymentId: payment.id },
      });
      expect(dbClaim?.status).toBe('FAILED');
      expect(dbClaim?.mandateCredited).toBe(false);

      // Fix provider issue
      provider.clearOverrides();

      // Safe retry succeeds
      const refunded = await service.refundPayment(payment.id, provider);
      expect(refunded.status).toBe('REFUNDED');
      expect(mandates.getMandate(mandate.id)?.spentAmount).toBe(0);

      dbClaim = await prisma.paymentRefundClaim.findUnique({
        where: { paymentId: payment.id },
      });
      expect(dbClaim?.status).toBe('REFUNDED');
      expect(dbClaim?.mandateCredited).toBe(true);
    });
  });
});
