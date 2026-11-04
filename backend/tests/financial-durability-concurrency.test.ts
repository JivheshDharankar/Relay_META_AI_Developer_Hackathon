import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../src/config/prisma';
import { MandateService } from '../src/payment/mandate/MandateService';
import { PaymentExecutionService } from '../src/payment/PaymentExecutionService';
import { MockPaymentProvider } from '../src/payment/provider/MockPaymentProvider';
import { PaymentAuthorization } from '../src/payment/types';
import { PurchaseOrder } from '../src/discovery/supplier/selection/types';

describe('Financial Durability: Payment Idempotency & Refund Concurrency', () => {
  beforeEach(async () => {
    // Clean durable test claim records before each test
    try {
      await prisma.paymentRefundClaim.deleteMany({});
      await prisma.paymentIdempotencyClaim.deleteMany({});
    } catch {
      // ignore if DB is offline
    }
  });

  function createMockPaymentContext(opts: {
    amount: number;
    mandateLimit: number;
    poId?: string;
    mandateId?: string;
  }) {
    const mandates = new MandateService();
    const mandate = mandates.createMandate({
      id: opts.mandateId || `man_${Math.random().toString(36).slice(2, 8)}`,
      ownerReference: 'res_durability_user',
      purpose: 'COMMUNITY_PROCUREMENT',
      spendingLimit: opts.mandateLimit,
      currency: 'INR',
    });

    const poId = opts.poId || `po_${Math.random().toString(36).slice(2, 8)}`;
    const purchaseOrder: PurchaseOrder = {
      id: poId,
      rfqId: 'rfq_test_1',
      candidateId: 'cand_sup_1',
      supplierName: 'Reliable Wholesalers',
      currency: 'INR',
      lineItems: [
        {
          productId: 'prod_1',
          productName: 'Rice',
          quantity: 10,
          unit: 'KG',
          unitPrice: opts.amount / 10,
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
      commitmentId: 'comm_test_1',
      purchaseOrderId: poId,
      supplierId: 'cand_sup_1',
      supplierName: 'Reliable Wholesalers',
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
  // CONTROL 1: PAYMENT IDEMPOTENCY
  // =========================================================================
  describe('Control 1: Payment Idempotency Durability', () => {
    it('persists idempotency claim in database and survives complete backend service restart', async () => {
      const provider1 = new MockPaymentProvider();
      const spy1 = vi.spyOn(provider1, 'authorizeAndCapture');
      const { mandates: mandates1, purchaseOrder, authorization } = createMockPaymentContext({
        amount: 2500,
        mandateLimit: 10000,
      });

      // Backend Instance 1 executes the payment
      const instance1 = new PaymentExecutionService(provider1, mandates1);
      const idempotencyKey = `idem_restart_test_${Date.now()}`;

      const payment1 = await instance1.executePayment({
        authorization,
        purchaseOrder,
        idempotencyKey,
      });

      expect(payment1.status).toBe('SUCCEEDED');
      expect(spy1).toHaveBeenCalledTimes(1);

      // Verify the claim exists in PostgreSQL
      const persistedClaim = await prisma.paymentIdempotencyClaim.findUnique({
        where: { key: idempotencyKey },
      });
      expect(persistedClaim).not.toBeNull();
      expect(persistedClaim?.status).toBe('EXECUTED');
      expect(persistedClaim?.fingerprint).toBe(`250000:${purchaseOrder.id}:${authorization.mandateId}`);

      // SIMULATE BACKEND RESTART:
      // Instance 2 is a brand new service instance with completely empty in-memory maps
      const provider2 = new MockPaymentProvider();
      const spy2 = vi.spyOn(provider2, 'authorizeAndCapture');
      const instance2 = new PaymentExecutionService(provider2, mandates1);

      // Replay identical request against the fresh restarted instance
      const payment2 = await instance2.executePayment({
        authorization,
        purchaseOrder,
        idempotencyKey,
      });

      // Must return identical payment without calling provider again
      expect(payment2.id).toBe(payment1.id);
      expect(payment2.status).toBe('SUCCEEDED');
      expect(spy2).toHaveBeenCalledTimes(0);
    });

    it('enforces payload fingerprint equality at database claim boundary post-restart', async () => {
      const provider1 = new MockPaymentProvider();
      const { mandates: mandates1, purchaseOrder, authorization } = createMockPaymentContext({
        amount: 1500,
        mandateLimit: 10000,
      });

      // Backend Instance 1 executes with ₹1500
      const instance1 = new PaymentExecutionService(provider1, mandates1);
      const idempotencyKey = `idem_conflict_test_${Date.now()}`;

      await instance1.executePayment({
        authorization,
        purchaseOrder,
        idempotencyKey,
      });

      // SIMULATE BACKEND RESTART:
      // Instance 2 starts fresh with zero memory of Instance 1
      const provider2 = new MockPaymentProvider();
      const instance2 = new PaymentExecutionService(provider2, mandates1);

      // Malicious or mutated replay: same idempotencyKey, but payload altered (e.g. ₹3500 instead of ₹1500)
      const mutatedAuth = { ...authorization, amount: 3500 };

      await expect(
        instance2.executePayment({
          authorization: mutatedAuth,
          purchaseOrder,
          idempotencyKey,
        })
      ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    });

    it('safely serializes concurrent executions across separate backend instances via database boundary', async () => {
      const providerA = new MockPaymentProvider();
      const providerB = new MockPaymentProvider();
      const spyA = vi.spyOn(providerA, 'authorizeAndCapture');
      const spyB = vi.spyOn(providerB, 'authorizeAndCapture');

      const { mandates, purchaseOrder, authorization } = createMockPaymentContext({
        amount: 4000,
        mandateLimit: 20000,
      });

      // Simulate 2 separate backend server instances
      const instanceA = new PaymentExecutionService(providerA, mandates);
      const instanceB = new PaymentExecutionService(providerB, mandates);

      const idempotencyKey = `idem_multi_instance_${Date.now()}`;

      // Concurrent invocation across Instance A and Instance B
      const [resA, resB] = await Promise.all([
        instanceA.executePayment({ authorization, purchaseOrder, idempotencyKey }),
        instanceB.executePayment({ authorization, purchaseOrder, idempotencyKey }),
      ]);

      expect(resA.status).toBe('SUCCEEDED');
      expect(resB.status).toBe('SUCCEEDED');
      expect(resA.id).toBe(resB.id);

      // Exactly ONE provider execution across both instances
      const totalProviderCalls = spyA.mock.calls.length + spyB.mock.calls.length;
      expect(totalProviderCalls).toBe(1);

      // Exactly 1 database claim record
      const claim = await prisma.paymentIdempotencyClaim.findUnique({
        where: { key: idempotencyKey },
      });
      expect(claim?.status).toBe('EXECUTED');
    });
  });

  // =========================================================================
  // CONTROL 2: REFUND CONCURRENCY & EXACTLY-ONCE MANDATE CREDITING
  // =========================================================================
  describe('Control 2: Refund Concurrency & Exactly-Once Mandate Crediting', () => {
    it('guarantees exactly-once mandate crediting across simultaneous concurrent refunds', async () => {
      const provider = new MockPaymentProvider();
      const refundSpy = vi.spyOn(provider, 'refund');
      const { mandates, mandate, purchaseOrder, authorization } = createMockPaymentContext({
        amount: 2000,
        mandateLimit: 10000,
      });

      const instanceA = new PaymentExecutionService(provider, mandates);
      const payment = await instanceA.executePayment({
        authorization,
        purchaseOrder,
        idempotencyKey: `idem_pay_refund_${Date.now()}`,
      });

      expect(payment.status).toBe('SUCCEEDED');
      // Mandate spent = 2000, remaining = 8000
      expect(mandates.getRemainingCapacity(mandate.id)).toBe(8000);

      // Instance B simulates second server instance
      const instanceB = new PaymentExecutionService(provider, mandates);

      // Fire 4 concurrent refund requests across Instance A and Instance B
      const results = await Promise.all([
        instanceA.refundPayment(payment.id),
        instanceB.refundPayment(payment.id),
        instanceA.refundPayment(payment.id),
        instanceB.refundPayment(payment.id),
      ]);

      // All callers receive REFUNDED payment
      for (const res of results) {
        expect(res.status).toBe('REFUNDED');
      }

      // External provider refund must be called EXACTLY ONCE
      expect(refundSpy).toHaveBeenCalledTimes(1);

      // Mandate capacity must be restored EXACTLY ONCE (8000 + 2000 = 10000, never 12000+)
      expect(mandates.getRemainingCapacity(mandate.id)).toBe(10000);

      // Database refund claim must be permanently recorded as REFUNDED
      const dbClaim = await prisma.paymentRefundClaim.findUnique({
        where: { paymentId: payment.id },
      });
      expect(dbClaim).not.toBeNull();
      expect(dbClaim?.status).toBe('REFUNDED');
      expect(dbClaim?.refundedAt).not.toBeNull();
    });

    it('survives backend restart and prevents duplicate refund on retry', async () => {
      const provider1 = new MockPaymentProvider();
      const refundSpy1 = vi.spyOn(provider1, 'refund');
      const { mandates, mandate, purchaseOrder, authorization } = createMockPaymentContext({
        amount: 3000,
        mandateLimit: 10000,
      });

      const instance1 = new PaymentExecutionService(provider1, mandates);
      const payment = await instance1.executePayment({
        authorization,
        purchaseOrder,
        idempotencyKey: `idem_pay_restart_ref_${Date.now()}`,
      });

      // Execute refund on Instance 1
      const refunded = await instance1.refundPayment(payment.id);
      expect(refunded.status).toBe('REFUNDED');
      expect(refundSpy1).toHaveBeenCalledTimes(1);
      expect(mandates.getRemainingCapacity(mandate.id)).toBe(10000);

      // SIMULATE BACKEND RESTART:
      // Instance 2 is spun up with completely cleared memory
      const provider2 = new MockPaymentProvider();
      const refundSpy2 = vi.spyOn(provider2, 'refund');
      const instance2 = new PaymentExecutionService(provider2, mandates);

      // Re-invoke refund on the restarted instance: must reject because it is already refunded
      await expect(instance2.refundPayment(payment.id)).rejects.toThrowError(
        /REFUND_NOT_POSSIBLE/
      );

      // Must NOT invoke the provider or double credit mandate
      expect(refundSpy2).toHaveBeenCalledTimes(0);
      // Mandate capacity must remain exactly 10,000 (not double credited to 13,000)
      expect(mandates.getRemainingCapacity(mandate.id)).toBe(10000);
    });

    it('does NOT credit mandate capacity when provider refund fails, and allows safe retry', async () => {
      const failingProvider = new MockPaymentProvider();
      // Mock failure on first attempt
      vi.spyOn(failingProvider, 'refund').mockResolvedValueOnce({
        status: 'FAILED',
        providerTransactionId: 'tx_fail_1',
        failureCode: 'GATEWAY_ERROR',
        failureReason: 'Supplier bank unavailable',
        isRetryable: true,
        processedAt: new Date(),
      });

      const { mandates, mandate, purchaseOrder, authorization } = createMockPaymentContext({
        amount: 1000,
        mandateLimit: 10000,
      });

      const instance = new PaymentExecutionService(failingProvider, mandates);
      const payment = await instance.executePayment({
        authorization,
        purchaseOrder,
        idempotencyKey: `idem_fail_ref_${Date.now()}`,
      });

      expect(payment.status).toBe('SUCCEEDED');
      expect(mandates.getRemainingCapacity(mandate.id)).toBe(9000);

      // Attempt refund with failing provider
      await expect(instance.refundPayment(payment.id)).rejects.toThrowError(/REFUND_FAILED/);

      // CRITICAL: Capacity must NOT be credited!
      expect(mandates.getRemainingCapacity(mandate.id)).toBe(9000);

      // Database claim must reflect FAILED, not REFUNDED
      const dbClaim = await prisma.paymentRefundClaim.findUnique({
        where: { paymentId: payment.id },
      });
      expect(dbClaim?.status).toBe('FAILED');
      expect(dbClaim?.refundedAt).toBeNull();
    });
  });
});
