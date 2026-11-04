import { describe, it, expect } from 'vitest';
import { MandateService } from '../src/payment/mandate/MandateService';
import { PaymentExecutionService } from '../src/payment/PaymentExecutionService';
import { MockPaymentProvider } from '../src/payment/provider/MockPaymentProvider';

describe('Payment refund safety', () => {
  it('credits mandate capacity back exactly once on refund', async () => {
    const mandates = new MandateService();
    const mandate = mandates.createMandate({
      ownerReference: 'res_refund_1',
      purpose: 'COMMUNITY_PROCUREMENT',
      spendingLimit: 10000,
      currency: 'INR',
    });
    mandates.commitSpending(mandate.id, 3000);
    expect(mandates.getRemainingCapacity(mandate.id)).toBe(7000);

    mandates.refundSpending(mandate.id, 3000);
    expect(mandates.getRemainingCapacity(mandate.id)).toBe(10000);
  });

  it('refunds only transactions the provider actually captured', async () => {
    const provider = new MockPaymentProvider();
    const captured = await provider.authorizeAndCapture({
      paymentId: 'pay_refund_1',
      purchaseOrderId: 'po_refund_1',
      supplierId: 'sup_1',
      amount: 500,
      currency: 'INR',
      idempotencyKey: 'idem_refund_1',
      recipientReference: 'supplier:sup_1',
    } as any);
    expect(captured.status).toBe('SUCCESS');

    const ok = await provider.refund({
      providerTransactionId: captured.providerTransactionId,
      amount: 500,
      currency: 'INR',
    });
    expect(ok.status).toBe('REFUNDED');

    const missing = await provider.refund({
      providerTransactionId: 'tx_does_not_exist',
      amount: 500,
      currency: 'INR',
    });
    expect(missing.status).toBe('FAILED');
  });

  it('transitions SUCCEEDED -> REFUNDED once and restores mandate spent', async () => {
    const mandates = new MandateService();
    const mandate = mandates.createMandate({
      ownerReference: 'res_refund_2',
      purpose: 'COMMUNITY_PROCUREMENT',
      spendingLimit: 10000,
      currency: 'INR',
    });
    mandates.commitSpending(mandate.id, 500);

    const provider = new MockPaymentProvider();
    const captured = await provider.authorizeAndCapture({
      paymentId: 'pay_refund_2',
      purchaseOrderId: 'po_refund_2',
      supplierId: 'sup_1',
      amount: 500,
      currency: 'INR',
      idempotencyKey: 'idem_refund_2',
      recipientReference: 'supplier:sup_1',
    } as any);

    const execution = new PaymentExecutionService(provider, mandates);
    (execution as any).payments.set('pay_refund_2', {
      id: 'pay_refund_2',
      commitmentId: 'comm_1',
      purchaseOrderId: 'po_refund_2',
      supplierId: 'sup_1',
      supplierName: 'Supplier',
      supplierContact: 's@example.com',
      mandateId: mandate.id,
      amount: 500,
      currency: 'INR',
      purpose: 'SUPPLIER_PAYMENT',
      status: 'SUCCEEDED',
      idempotencyKey: 'idem_refund_2',
      providerName: provider.providerName,
      providerTransactionId: captured.providerTransactionId,
      attempts: [],
      isSimulated: true,
      authorizedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const refunded = await execution.refundPayment('pay_refund_2');
    expect(refunded.status).toBe('REFUNDED');
    expect(mandates.getRemainingCapacity(mandate.id)).toBe(10000);

    await expect(execution.refundPayment('pay_refund_2')).rejects.toThrow();
    await expect(execution.refundPayment('pay_missing')).rejects.toThrow(/PAYMENT_NOT_FOUND/);
  });

  it('safely coalesces concurrent simultaneous refund requests with exactly one mandate credit', async () => {
    const mandates = new MandateService();
    const mandate = mandates.createMandate({
      ownerReference: 'res_refund_concurrent',
      purpose: 'COMMUNITY_PROCUREMENT',
      spendingLimit: 10000,
      currency: 'INR',
    });
    mandates.commitSpending(mandate.id, 1000);
    expect(mandates.getRemainingCapacity(mandate.id)).toBe(9000);

    let refundCalls = 0;
    const provider = new MockPaymentProvider();
    const captured = await provider.authorizeAndCapture({
      paymentId: 'pay_refund_concurrent',
      purchaseOrderId: 'po_refund_conc',
      supplierId: 'sup_1',
      amount: 1000,
      currency: 'INR',
      idempotencyKey: 'idem_refund_conc',
      recipientReference: 'supplier:sup_1',
    } as any);

    const spyProvider = {
      ...provider,
      providerName: 'mock',
      refund: async (arg: any) => {
        refundCalls++;
        await new Promise((r) => setTimeout(r, 25)); // simulate network delay
        return provider.refund(arg);
      },
    };

    const execution = new PaymentExecutionService(spyProvider as any, mandates);
    (execution as any).payments.set('pay_refund_concurrent', {
      id: 'pay_refund_concurrent',
      commitmentId: 'comm_conc',
      purchaseOrderId: 'po_refund_conc',
      supplierId: 'sup_1',
      supplierName: 'Supplier',
      supplierContact: 's@example.com',
      mandateId: mandate.id,
      amount: 1000,
      currency: 'INR',
      purpose: 'SUPPLIER_PAYMENT',
      status: 'SUCCEEDED',
      idempotencyKey: 'idem_refund_conc',
      providerName: 'mock',
      providerTransactionId: captured.providerTransactionId,
      attempts: [],
      isSimulated: true,
      authorizedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Fire 3 simultaneous concurrent refund requests
    const results = await Promise.all([
      execution.refundPayment('pay_refund_concurrent'),
      execution.refundPayment('pay_refund_concurrent'),
      execution.refundPayment('pay_refund_concurrent'),
    ]);

    expect(results).toHaveLength(3);
    for (const res of results) {
      expect(res.status).toBe('REFUNDED');
    }
    // Provider must be called exactly once
    expect(refundCalls).toBe(1);
    // Mandate capacity must be restored exactly once (9000 + 1000 = 10000, NOT 12000)
    expect(mandates.getRemainingCapacity(mandate.id)).toBe(10000);
  });
});

describe('Payment idempotency payload fingerprint validation (DEFECT-03)', () => {
  it('allows identical replay and rejects conflicting amounts, purchase orders, or mandates', async () => {
    const mandates = new MandateService();
    const mandateA = mandates.createMandate({
      ownerReference: 'res_idem_1',
      purpose: 'COMMUNITY_PROCUREMENT',
      spendingLimit: 20000,
      currency: 'INR',
    });
    const mandateB = mandates.createMandate({
      ownerReference: 'res_idem_2',
      purpose: 'COMMUNITY_PROCUREMENT',
      spendingLimit: 20000,
      currency: 'INR',
    });

    const provider = new MockPaymentProvider();
    const execution = new PaymentExecutionService(provider, mandates);

    const auth1 = {
      id: 'auth_1',
      mandateId: mandateA.id,
      commitmentId: 'comm_1',
      supplierId: 'sup_1',
      supplierName: 'Supplier 1',
      amount: 1500,
      currency: 'INR',
      purpose: 'SUPPLIER_PAYMENT' as const,
      status: 'AUTHORIZED' as const,
      commercialBasisSimulated: false,
      authorizedAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
    };
    const po1 = { id: 'po_1', supplierContact: 's@example.com' } as any;

    // 1. Initial payment with idempotency key
    const payment1 = await execution.executePayment({
      authorization: auth1,
      purchaseOrder: po1,
      idempotencyKey: 'idem_key_42',
    });
    expect(payment1.status).toBe('SUCCEEDED');
    expect(payment1.amount).toBe(1500);

    // 2. Identical replay: returns same cached payment
    const replayIdentical = await execution.executePayment({
      authorization: auth1,
      purchaseOrder: po1,
      idempotencyKey: 'idem_key_42',
    });
    expect(replayIdentical.id).toBe(payment1.id);
    expect(replayIdentical.amount).toBe(1500);

    // 3. Conflicting amount replay: rejected with IDEMPOTENCY_PAYLOAD_MISMATCH
    await expect(
      execution.executePayment({
        authorization: { ...auth1, amount: 2500 },
        purchaseOrder: po1,
        idempotencyKey: 'idem_key_42',
      })
    ).rejects.toThrow(/IDEMPOTENCY_PAYLOAD_MISMATCH/);

    // 4. Conflicting purchaseOrder replay: rejected with IDEMPOTENCY_PAYLOAD_MISMATCH
    await expect(
      execution.executePayment({
        authorization: auth1,
        purchaseOrder: { ...po1, id: 'po_different' },
        idempotencyKey: 'idem_key_42',
      })
    ).rejects.toThrow(/IDEMPOTENCY_PAYLOAD_MISMATCH/);

    // 5. Conflicting mandate replay: rejected with IDEMPOTENCY_PAYLOAD_MISMATCH
    await expect(
      execution.executePayment({
        authorization: { ...auth1, mandateId: mandateB.id },
        purchaseOrder: po1,
        idempotencyKey: 'idem_key_42',
      })
    ).rejects.toThrow(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
  });
});
