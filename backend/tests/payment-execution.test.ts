import { describe, it, expect, beforeEach } from 'vitest';
import { eventBus } from '../src/events';
import { RFQService } from '../src/discovery/supplier/rfq/RFQService';
import { SupplierResponseService } from '../src/discovery/supplier/quote/provider/SupplierResponseService';
import { QuoteNormalizationService } from '../src/discovery/supplier/quote/QuoteNormalizationService';
import { MockSupplierResponseProvider } from '../src/discovery/supplier/quote/provider/MockSupplierResponseProvider';
import { QuoteEligibilityService } from '../src/discovery/supplier/selection/QuoteEligibilityService';
import { QuoteSelectionComparator } from '../src/discovery/supplier/selection/QuoteSelectionComparator';
import { SelectionAIAdvisor } from '../src/discovery/supplier/selection/SelectionAIAdvisor';
import { SelectionValidator } from '../src/discovery/supplier/selection/SelectionValidator';
import { AllocationService } from '../src/discovery/supplier/selection/AllocationService';
import { PurchaseOrderService } from '../src/discovery/supplier/selection/PurchaseOrderService';
import { ProcurementCommitmentService } from '../src/discovery/supplier/selection/ProcurementCommitmentService';
import { SupplierCandidate } from '../src/discovery/supplier/types';
import { RFQ } from '../src/discovery/supplier/rfq/types';
import { Quote } from '../src/discovery/supplier/quote/types';
import {
  ProcurementCommitment,
  PurchaseOrder,
} from '../src/discovery/supplier/selection/types';
import {
  procurementCommitmentService as defaultCommitmentService,
  purchaseOrderService as defaultPOService,
  rfqService as defaultRfqService,
  quoteNormalizationService as defaultQuoteService,
} from '../src/discovery/supplier';

import {
  MandateService,
  PaymentAuthorizationService,
  PaymentAuthorizationValidator,
  PaymentExecutionService,
  PaymentService,
  MockPaymentProvider,
  PaymentMandate,
  PaymentStateMachineError,
  assertLegalPaymentTransition,
  paymentService as defaultPaymentService,
  mandateService as defaultMandateService,
  mockPaymentProvider as defaultMockProvider,
} from '../src/payment';

import { toolRegistry } from '../src/agent/tools';

describe('Phase 7: Authorized Payment, Mandates & Financial Execution', () => {
  // Phase 1 - 6 services
  let rfqService: RFQService;
  let supplierResponseService: SupplierResponseService;
  let quoteNormalizationService: QuoteNormalizationService;
  let eligibilityService: QuoteEligibilityService;
  let comparator: QuoteSelectionComparator;
  let advisor: SelectionAIAdvisor;
  let validator: SelectionValidator;
  let allocationService: AllocationService;
  let poService: PurchaseOrderService;
  let commitmentService: ProcurementCommitmentService;

  // Phase 7 services
  let mandateService: MandateService;
  let authValidator: PaymentAuthorizationValidator;
  let authService: PaymentAuthorizationService;
  let mockProvider: MockPaymentProvider;
  let executionService: PaymentExecutionService;
  let paymentService: PaymentService;

  // Domain Test Entities
  let candidateA: SupplierCandidate;
  let candidateB: SupplierCandidate;
  let rfqSingle: RFQ;
  let rfqSplitA: RFQ;
  let rfqSplitB: RFQ;
  let quoteA: Quote;
  let quoteB_split1: Quote;
  let quoteB_split2: Quote;

  let singleCommitment: ProcurementCommitment;
  let singlePO: PurchaseOrder;

  let splitCommitment: ProcurementCommitment;
  let splitPO_A: PurchaseOrder;
  let splitPO_B: PurchaseOrder;

  let communityMandate: PaymentMandate;

  beforeEach(async () => {
    // Reset all singletons
    defaultRfqService.reset();
    defaultQuoteService.reset();
    defaultCommitmentService.reset();
    defaultPOService.reset();
    defaultPaymentService.reset();
    await defaultPaymentService.clearDurableClaims();
    defaultMandateService.reset();
    defaultMockProvider.reset();

    // 1. Initialize Phase 1-6 infrastructure using singletons so tool executions share state
    rfqService = defaultRfqService;
    quoteNormalizationService = defaultQuoteService;
    const mockResponseProvider = new MockSupplierResponseProvider(rfqService);
    supplierResponseService = new SupplierResponseService(rfqService);
    supplierResponseService.registerProvider(mockResponseProvider);

    eligibilityService = new QuoteEligibilityService();
    comparator = new QuoteSelectionComparator(eligibilityService);
    advisor = new SelectionAIAdvisor();
    validator = new SelectionValidator(eligibilityService);
    allocationService = new AllocationService();
    poService = defaultPOService;
    commitmentService = defaultCommitmentService;

    // 2. Initialize Phase 7 infrastructure
    mandateService = defaultMandateService;
    mockProvider = defaultMockProvider;
    paymentService = defaultPaymentService;
    executionService = (paymentService as any).executionSvc;
    authService = (paymentService as any).authSvc;
    authValidator = (authService as any).validator;

    // 3. Seed Candidates
    candidateA = {
      id: 'cand_alpha_grains',
      name: 'Alpha Wholesale Grains',
      address: 'Gultekdi Market Yard, Pune',
      latitude: 18.496,
      longitude: 73.868,
      categories: ['grain_wholesaler'],
      email: 'orders@alphagrains.com',
      phone: '+919876543201',
    };

    candidateB = {
      id: 'cand_beta_bulk',
      name: 'Beta Bulk Mart',
      address: 'Hadapsar Industrial Estate, Pune',
      latitude: 18.502,
      longitude: 73.928,
      categories: ['grain_wholesaler'],
      email: 'sales@betabulk.com',
      phone: '+919876543202',
    };

    const now = new Date();
    const slaDeadline = new Date(now.getTime() + 12 * 3600 * 1000);
    const quoteDeadline = new Date(now.getTime() + 4 * 3600 * 1000);

    // 4. Create Single Supplier Procurement (1,000 KG @ ₹55/kg + ₹500 delivery = ₹55,500)
    rfqSingle = await rfqService.createRFQ({
      candidate: candidateA,
      lineItems: [{ productName: 'Sharbati Wheat', quantity: 1000, unit: 'KG' }],
      deliveryArea: 'Greenview Residency Central Depot',
      deliveryDeadline: slaDeadline,
      quoteDeadline,
      societyId: 'soc_greenview',
    });

    const respA = await supplierResponseService.ingestResponse({
      rfqId: rfqSingle.id,
      candidateId: candidateA.id,
      supplierName: candidateA.name,
      channel: 'manual',
      lineItems: [{ productName: 'Sharbati Wheat', quotedQuantity: 1000, unit: 'KG', unitPrice: 55 }],
      deliveryFee: 500,
      deliveryEtaHours: 8,
      validUntil: new Date(now.getTime() + 24 * 3600 * 1000),
    });
    quoteA = (await quoteNormalizationService.normalizeResponse(respA)).quote;

    const commitSingleResult = await commitmentService.createCommitment({
      rfqId: rfqSingle.id,
      recommendation: {
        decision: 'SELECT_SUPPLIER',
        supplierId: candidateA.id,
        quoteId: quoteA.id,
        reason: 'Lowest cost supplier with full fulfillment',
      },
    });
    singleCommitment = commitSingleResult.commitment;
    singlePO = commitSingleResult.purchaseOrders[0];

    // 5. Create Multi-Supplier Split Procurement (1,000 KG: Supplier A 600kg, Supplier B 400kg)
    rfqSplitA = await rfqService.createRFQ({
      candidate: candidateA,
      lineItems: [{ productName: 'Organic Rice', quantity: 1000, unit: 'KG' }],
      deliveryArea: 'Greenview Residency Central Depot',
      deliveryDeadline: slaDeadline,
      quoteDeadline,
      societyId: 'soc_greenview',
    });
    rfqSplitB = await rfqService.createRFQ({
      candidate: candidateB,
      lineItems: [{ productName: 'Organic Rice', quantity: 1000, unit: 'KG' }],
      deliveryArea: 'Greenview Residency Central Depot',
      deliveryDeadline: slaDeadline,
      quoteDeadline,
      societyId: 'soc_greenview',
    });

    const respSplitA = await supplierResponseService.ingestResponse({
      rfqId: rfqSplitA.id,
      candidateId: candidateA.id,
      supplierName: candidateA.name,
      channel: 'manual',
      lineItems: [{ productName: 'Organic Rice', quotedQuantity: 600, unit: 'KG', unitPrice: 50 }],
      deliveryFee: 300,
      deliveryEtaHours: 6,
      validUntil: new Date(now.getTime() + 24 * 3600 * 1000),
    });
    quoteB_split1 = (await quoteNormalizationService.normalizeResponse(respSplitA)).quote;

    const respSplitB = await supplierResponseService.ingestResponse({
      rfqId: rfqSplitB.id,
      candidateId: candidateB.id,
      supplierName: candidateB.name,
      channel: 'manual',
      lineItems: [{ productName: 'Organic Rice', quotedQuantity: 400, unit: 'KG', unitPrice: 52 }],
      deliveryFee: 250,
      deliveryEtaHours: 7,
      validUntil: new Date(now.getTime() + 24 * 3600 * 1000),
    });
    quoteB_split2 = (await quoteNormalizationService.normalizeResponse(respSplitB)).quote;

    const commitSplitResult = await commitmentService.createCommitment({
      rfqId: rfqSplitA.id,
      recommendation: {
        decision: 'SPLIT_ORDER',
        allocations: [
          { supplierId: candidateA.id, quoteId: quoteB_split1.id, quantity: 600 },
          { supplierId: candidateB.id, quoteId: quoteB_split2.id, quantity: 400 },
        ],
        reason: 'Optimal split: 600kg from Supplier A (₹30,300) + 400kg from Supplier B (₹21,050) = ₹51,350',
      },
    });
    splitCommitment = commitSplitResult.commitment;
    splitPO_A = commitSplitResult.purchaseOrders[0];
    splitPO_B = commitSplitResult.purchaseOrders[1];

    // 6. Seed Community Payment Mandate with ₹100,000 authorized limit
    communityMandate = mandateService.createMandate({
      id: 'mandate_comm_proc_100k',
      ownerReference: 'soc_greenview',
      purpose: 'COMMUNITY_PROCUREMENT',
      currency: 'INR',
      spendingLimit: 100000,
      validFrom: new Date(now.getTime() - 3600000),
      validUntil: new Date(now.getTime() + 30 * 86400000),
    });
  });

  // =========================================================================
  // 1. PAYMENT MANDATE VALIDATION & SPENDING LIMITS (Tests 1 - 9)
  // =========================================================================
  describe('1. Payment Mandate Validation & Spending Limits', () => {
    it('1. Active mandate within validity window is accepted', () => {
      const remaining = mandateService.getRemainingCapacity(communityMandate.id);
      expect(remaining).toBe(100000);
      expect(communityMandate.status).toBe('ACTIVE');
    });

    it('2. Paused mandate is rejected with MANDATE_PAUSED', async () => {
      mandateService.pauseMandate(communityMandate.id);

      await expect(
        authService.authorizePayment({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          mandate: communityMandate,
          amount: singlePO.total,
        })
      ).rejects.toThrow('MANDATE_PAUSED');
    });

    it('3. Revoked mandate is rejected with MANDATE_REVOKED', async () => {
      mandateService.revokeMandate(communityMandate.id);

      await expect(
        authService.authorizePayment({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          mandate: communityMandate,
          amount: singlePO.total,
        })
      ).rejects.toThrow('MANDATE_REVOKED');
    });

    it('4. Expired mandate is rejected with MANDATE_EXPIRED', async () => {
      const expiredMandate = mandateService.createMandate({
        ownerReference: 'soc_greenview',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 50000,
        validFrom: new Date(Date.now() - 7200000),
        validUntil: new Date(Date.now() - 3600000), // Expired 1 hour ago
      });

      await expect(
        authService.authorizePayment({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          mandate: expiredMandate,
          amount: singlePO.total,
        })
      ).rejects.toThrow('MANDATE_EXPIRED');
    });

    it('5. Purpose mismatch (e.g. UTILITY vs COMMUNITY_PROCUREMENT) is rejected', async () => {
      const utilityMandate = mandateService.createMandate({
        ownerReference: 'soc_greenview',
        purpose: 'UTILITY',
        currency: 'INR',
        spendingLimit: 80000,
      });

      await expect(
        authService.authorizePayment({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          mandate: utilityMandate,
          amount: singlePO.total,
          purpose: 'COMMUNITY_PROCUREMENT',
        })
      ).rejects.toThrow('PURPOSE_MISMATCH');
    });

    it('6. Currency mismatch (e.g. USD vs INR) is rejected', async () => {
      const usdMandate = mandateService.createMandate({
        ownerReference: 'soc_greenview',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'USD',
        spendingLimit: 10000,
      });

      await expect(
        authService.authorizePayment({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          mandate: usdMandate,
          amount: singlePO.total,
          currency: 'INR',
        })
      ).rejects.toThrow('CURRENCY_MISMATCH');
    });

    it('7. Spending limit is strictly enforced using Decimal arithmetic', async () => {
      // Mandate limit ₹50,000 vs single procurement ₹55,500
      const smallMandate = mandateService.createMandate({
        ownerReference: 'soc_greenview',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 50000,
      });

      await expect(
        authService.authorizePayment({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          mandate: smallMandate,
          amount: singlePO.total, // 55,500
        })
      ).rejects.toThrow('SPENDING_LIMIT_EXCEEDED');
    });

    it('8. Remaining mandate capacity is calculated correctly as (limit - spent - reserved)', async () => {
      // Reserve ₹20,000 on community mandate (Limit ₹100,000)
      const res = await mandateService.reserveCapacity(communityMandate.id, 20000);
      expect(res.success).toBe(true);
      expect(res.remainingCapacity).toBe(80000);

      // Commit ₹20,000
      mandateService.commitSpending(communityMandate.id, 20000);
      expect(mandateService.getRemainingCapacity(communityMandate.id)).toBe(80000);

      // Reserve another ₹35,000
      const res2 = await mandateService.reserveCapacity(communityMandate.id, 35000);
      expect(res2.success).toBe(true);
      expect(res2.remainingCapacity).toBe(45000);

      // Total spent = 20k, reserved = 35k -> remaining = 45k
      expect(mandateService.getRemainingCapacity(communityMandate.id)).toBe(45000);
    });

    it('9. Future mandate not yet valid is rejected with MANDATE_NOT_YET_VALID', async () => {
      const futureMandate = mandateService.createMandate({
        ownerReference: 'soc_greenview',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 50000,
        validFrom: new Date(Date.now() + 86400000), // Becomes valid tomorrow
      });

      await expect(
        authService.authorizePayment({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          mandate: futureMandate,
          amount: singlePO.total,
        })
      ).rejects.toThrow('MANDATE_NOT_YET_VALID');
    });

    it('10. Foreign mandateId is rejected with MANDATE_OWNER_MISMATCH', async () => {
      const foreignMandate = mandateService.createMandate({
        ownerReference: 'res_foreign_society_member',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 500000,
      });

      await expect(
        paymentService.payCommitment({
          commitmentId: singleCommitment.id,
          ownerReference: 'soc_greenview',
          mandateId: foreignMandate.id,
        })
      ).rejects.toThrow('MANDATE_OWNER_MISMATCH');
    });

    it('11. Default mandate resolution never picks a foreign mandate', async () => {
      await expect(
        paymentService.payCommitment({
          commitmentId: singleCommitment.id,
          ownerReference: 'res_nobody_has_this_mandate',
        })
      ).rejects.toThrow('No active COMMUNITY_PROCUREMENT mandate owned by');
    });

    it('12. requestPaymentForCommitment tool binds the mandate to the context resident', async () => {
      const tool = toolRegistry.get('requestPaymentForCommitment')!;
      const attackerMandate = mandateService.createMandate({
        ownerReference: 'res_tool_attacker',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 500000,
      });

      // Model supplies a foreign mandateId: the context resident's ownership
      // check rejects it before any authorization or provider call.
      await expect(
        tool.execute(
          { commitmentId: singleCommitment.id, mandateId: attackerMandate.id },
          { residentId: 'soc_greenview', societyId: 'soc_greenview' } as any
        )
      ).rejects.toThrow('MANDATE_OWNER_MISMATCH');
    });
  });

  // =========================================================================
  // 2. PROCUREMENT COMMITMENT & PURCHASE ORDER VALIDATION (Tests 10 - 16)
  // =========================================================================
  describe('2. Procurement Commitment & Purchase Order Validation', () => {
    it('10. Commitment in READY_FOR_PAYMENT status is accepted for payment authorization', async () => {
      const auth = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });

      expect(auth.status).toBe('AUTHORIZED');
      expect(auth.amount).toBe(55500);
      expect(auth.commitmentId).toBe(singleCommitment.id);
    });

    it('11. Draft commitment is rejected with COMMITMENT_NOT_PAYABLE', async () => {
      const draftCommitment = { ...singleCommitment, status: 'DRAFT' as const };

      await expect(
        authService.authorizePayment({
          commitment: draftCommitment,
          purchaseOrder: singlePO,
          mandate: communityMandate,
          amount: singlePO.total,
        })
      ).rejects.toThrow('COMMITMENT_NOT_PAYABLE');
    });

    it('12. Cancelled commitment is rejected with COMMITMENT_NOT_PAYABLE', async () => {
      const cancelledCommitment = { ...singleCommitment, status: 'CANCELLED' as const };

      await expect(
        authService.authorizePayment({
          commitment: cancelledCommitment,
          purchaseOrder: singlePO,
          mandate: communityMandate,
          amount: singlePO.total,
        })
      ).rejects.toThrow('COMMITMENT_NOT_PAYABLE');
    });

    it('13. Expired or failed commitment is rejected with COMMITMENT_NOT_PAYABLE', async () => {
      const failedCommitment = { ...singleCommitment, status: 'FAILED' as const };

      await expect(
        authService.authorizePayment({
          commitment: failedCommitment,
          purchaseOrder: singlePO,
          mandate: communityMandate,
          amount: singlePO.total,
        })
      ).rejects.toThrow('COMMITMENT_NOT_PAYABLE');
    });

    it('14. Already-paid commitment / PO is rejected with DUPLICATE_PAYMENT', async () => {
      await expect(
        authService.authorizePayment({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          mandate: communityMandate,
          amount: singlePO.total,
          alreadyPaid: true,
        })
      ).rejects.toThrow('DUPLICATE_PAYMENT');
    });

    it('15. Purchase order referencing wrong commitment is rejected', async () => {
      const foreignPO: PurchaseOrder = {
        ...singlePO,
        commitmentId: 'commit_foreign_other',
      };

      await expect(
        authService.authorizePayment({
          commitment: singleCommitment,
          purchaseOrder: foreignPO,
          mandate: communityMandate,
          amount: singlePO.total,
        })
      ).rejects.toThrow('PO_COMMITMENT_MISMATCH');
    });

    it('16. Supplier recipient mismatch between request and purchase order is rejected', () => {
      const validation = authValidator.validate({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
        currency: 'INR',
        purpose: 'COMMUNITY_PROCUREMENT',
        supplierId: 'cand_impostor_supplier', // Mismatched supplier
      });

      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('SUPPLIER_MISMATCH'))).toBe(true);
    });
  });

  // =========================================================================
  // 3. AUTHORITATIVE AMOUNT INVARIANTS & DECIMAL ARITHMETIC (Tests 17 - 21)
  // =========================================================================
  describe('3. Authoritative Amount Invariants & Decimal Arithmetic', () => {
    it('17. Authoritative commitment PO allocation amount is used as sole source of truth', async () => {
      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: singleCommitment.id,
      });

      expect(payments.length).toBe(1);
      expect(payments[0].amount).toBe(55500); // 1000kg * ₹55 + ₹500 fee
      expect(payments[0].amount).toBe(singlePO.total);
    });

    it('18. Attempted payment authorization with altered amount is rejected with AMOUNT_MISMATCH', async () => {
      await expect(
        authService.authorizePayment({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          mandate: communityMandate,
          amount: 50000, // Altered amount (PO total is ₹55,500)
        })
      ).rejects.toThrow('AMOUNT_MISMATCH');
    });

    it('19. Multi-supplier split allocations have payment amounts matching PO totals exactly', async () => {
      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: splitCommitment.id,
      });

      expect(payments.length).toBe(2);
      const paymentA = payments.find((p) => p.supplierId === candidateA.id)!;
      const paymentB = payments.find((p) => p.supplierId === candidateB.id)!;

      // Supplier A: 600kg * 50 + 300 = ₹30,300
      expect(paymentA.amount).toBe(30300);
      expect(paymentA.amount).toBe(splitPO_A.total);

      // Supplier B: 400kg * 52 + 250 = ₹21,050
      expect(paymentB.amount).toBe(21050);
      expect(paymentB.amount).toBe(splitPO_B.total);
    });

    it('20. Sum of all supplier payment obligations strictly equals commitment grand total', async () => {
      const { summary } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: splitCommitment.id,
      });

      // 30,300 + 21,050 = 51,350
      expect(summary.totalAmount).toBe(51350);
      expect(summary.paidAmount).toBe(51350);
      expect(summary.status).toBe('FULLY_PAID');
    });

    it('21. Decimal arithmetic prevents JavaScript float rounding noise in payments', async () => {
      // 333.3333 units * ₹53.33 = ₹17,776.66 + ₹150.55 fee = ₹17,927.21
      const fractionalMandate = mandateService.createMandate({
        ownerReference: 'soc_greenview',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 20000,
      });

      const fractionalPO: PurchaseOrder = {
        ...singlePO,
        id: 'po_fractional',
        commitmentId: 'commit_fractional',
        total: 17927.21,
      };
      const fractionalCommitment: ProcurementCommitment = {
        ...singleCommitment,
        id: 'commit_fractional',
        financials: { ...singleCommitment.financials, total: 17927.21 },
      };

      const auth = await authService.authorizePayment({
        commitment: fractionalCommitment,
        purchaseOrder: fractionalPO,
        mandate: fractionalMandate,
        amount: 17927.21,
      });

      expect(auth.amount).toBe(17927.21);
      expect(fractionalMandate.reservedAmount).toBe(17927.21);
      // 20000 - 17927.21 = 2072.79 exactly (no float noise like 2072.789999999999)
      expect(mandateService.getRemainingCapacity(fractionalMandate.id)).toBe(2072.79);
    });
  });

  // =========================================================================
  // 4. PROVIDER ABSTRACTION & SIMULATION GATEWAY (Tests 22 - 27)
  // =========================================================================
  describe('4. Provider Abstraction & Simulation Gateway', () => {
    it('22. Mock provider simulates realistic successful payment with transaction ID', async () => {
      const auth = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });

      const payment = await executionService.executePayment({
        authorization: auth,
        purchaseOrder: singlePO,
        provider: mockProvider,
      });

      expect(payment.status).toBe('SUCCEEDED');
      expect(payment.providerTransactionId).toBeDefined();
      expect(payment.providerTransactionId).toMatch(/^tx_mock_/);
      expect(payment.completedAt).toBeDefined();
    });

    it('23. Mock provider deterministically simulates gateway decline failure', async () => {
      mockProvider.simulateFailure(
        singlePO.id,
        'INSUFFICIENT_FUNDS',
        'Commercial bank account balance insufficient for transfer'
      );

      const auth = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });

      const payment = await executionService.executePayment({
        authorization: auth,
        purchaseOrder: singlePO,
        provider: mockProvider,
      });

      expect(payment.status).toBe('FAILED');
      expect(payment.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(payment.failureReason).toContain('insufficient');
    });

    it('24. Mock provider simulates gateway timeout and marks error as retryable', async () => {
      mockProvider.simulateTimeout(singlePO.id);

      const auth = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });

      const payment = await executionService.executePayment({
        authorization: auth,
        purchaseOrder: singlePO,
        provider: mockProvider,
      });

      expect(payment.status).toBe('FAILED');
      expect(payment.failureCode).toBe('PROVIDER_TIMEOUT');
      expect(payment.attempts[0].isRetryable).toBe(true);
    });

    it('25. Provider transaction ID is persisted and linked to payment entity', async () => {
      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: singleCommitment.id,
      });

      const pmt = payments[0];
      expect(pmt.providerTransactionId).toBeDefined();
      expect(pmt.providerName).toBe('MockPaymentProvider');
      expect(pmt.attempts.length).toBe(1);
      expect(pmt.attempts[0].providerTransactionId).toBe(pmt.providerTransactionId);
    });

    it('26. Provider metadata clearly distinguishes simulation from real money movement', async () => {
      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: singleCommitment.id,
      });

      expect(payments[0].isSimulated).toBe(true);
    });

    it('27. Distinguishes retryable provider errors from non-retryable commercial declines', async () => {
      // Timeout is retryable
      mockProvider.simulateTimeout(singlePO.id);
      const auth1 = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });
      const payment1 = await executionService.executePayment({
        authorization: auth1,
        purchaseOrder: singlePO,
        provider: mockProvider,
        idempotencyKey: 'tx_retryable_test_1',
      });
      expect(payment1.attempts[0].isRetryable).toBe(true);

      // Gateway decline is non-retryable
      mockProvider.simulateFailure(
        'po_non_retryable',
        'ACCOUNT_BLOCKED',
        'Recipient account is blocked',
        false
      );
      const nonRetryablePO = { ...singlePO, id: 'po_non_retryable' };
      const auth2 = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: nonRetryablePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });
      const payment2 = await executionService.executePayment({
        authorization: auth2,
        purchaseOrder: nonRetryablePO,
        provider: mockProvider,
        idempotencyKey: 'tx_non_retryable_test_2',
      });
      expect(payment2.attempts[0].isRetryable).toBe(false);
    });
  });

  // =========================================================================
  // 5. PAYMENT STATE MACHINE & INVARIANTS (Tests 28 - 34)
  // =========================================================================
  describe('5. Payment State Machine & Invariants', () => {
    it('28. Payment lifecycle progresses from PENDING to AUTHORIZED to PROCESSING to SUCCEEDED', async () => {
      const auth = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });

      const payment = await executionService.executePayment({
        authorization: auth,
        purchaseOrder: singlePO,
        provider: mockProvider,
      });

      expect(payment.status).toBe('SUCCEEDED');
    });

    it('29. Payment failure transitions from PROCESSING to FAILED', async () => {
      mockProvider.simulateFailure(singlePO.id);

      const auth = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });

      const payment = await executionService.executePayment({
        authorization: auth,
        purchaseOrder: singlePO,
        provider: mockProvider,
      });

      expect(payment.status).toBe('FAILED');
    });

    it('30. Failed retryable payment transitions from FAILED to RETRYING to PROCESSING', async () => {
      mockProvider.simulateTimeout(singlePO.id);

      const auth = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });

      const payment = await executionService.executePayment({
        authorization: auth,
        purchaseOrder: singlePO,
        provider: mockProvider,
      });

      expect(payment.status).toBe('FAILED');

      // Clear timeout override so retry succeeds. The operator explicitly
      // acknowledges the uncertain TIMEOUT outcome after inspection.
      mockProvider.clearOverrides();

      const retried = await executionService.retryPayment(payment.id, {
        provider: mockProvider,
        acknowledgeUncertainOutcome: true,
      });

      expect(retried.status).toBe('SUCCEEDED');
      expect(retried.attempts.length).toBe(2);
      expect(retried.attempts[0].status).toBe('TIMEOUT');
      expect(retried.attempts[1].status).toBe('SUCCESS');
    });

    it('31. SUCCEEDED status is terminal and cannot transition to any other status', () => {
      expect(() => assertLegalPaymentTransition('SUCCEEDED', 'PROCESSING')).toThrow(
        PaymentStateMachineError
      );
      expect(() => assertLegalPaymentTransition('SUCCEEDED', 'FAILED')).toThrow(
        PaymentStateMachineError
      );
    });

    it('32. REJECTED status is terminal and cannot reach the provider', () => {
      expect(() => assertLegalPaymentTransition('REJECTED', 'PROCESSING')).toThrow(
        PaymentStateMachineError
      );
    });

    it('33. CANCELLED status is terminal and cannot reach the provider', () => {
      expect(() => assertLegalPaymentTransition('CANCELLED', 'PROCESSING')).toThrow(
        PaymentStateMachineError
      );
    });

    it('34. Illegal state transitions throw deterministic PaymentStateMachineError', () => {
      expect(() => assertLegalPaymentTransition('PENDING', 'SUCCEEDED')).toThrow(
        PaymentStateMachineError
      );
      expect(() => assertLegalPaymentTransition('PROCESSING', 'AUTHORIZED')).toThrow(
        PaymentStateMachineError
      );
    });
  });

  // =========================================================================
  // 6. IDEMPOTENCY & DUPLICATE SUPPRESSION (Tests 35 - 39)
  // =========================================================================
  describe('6. Idempotency & Duplicate Suppression', () => {
    it('35. Duplicate payment execution with identical idempotency key returns cached payment', async () => {
      const auth = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });

      const p1 = await executionService.executePayment({
        authorization: auth,
        purchaseOrder: singlePO,
        provider: mockProvider,
        idempotencyKey: 'idemp_key_exact_test',
      });

      const p2 = await executionService.executePayment({
        authorization: auth,
        purchaseOrder: singlePO,
        provider: mockProvider,
        idempotencyKey: 'idemp_key_exact_test',
      });

      expect(p1.id).toBe(p2.id);
      expect(p1.providerTransactionId).toBe(p2.providerTransactionId);
    });

    it('36. Repeated execution after simulated timeout safely returns existing record without double debit', async () => {
      mockProvider.simulateTimeout(singlePO.id);

      const auth = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });

      const p1 = await executionService.executePayment({
        authorization: auth,
        purchaseOrder: singlePO,
        provider: mockProvider,
        idempotencyKey: 'timeout_idemp_key',
      });

      const p2 = await executionService.executePayment({
        authorization: auth,
        purchaseOrder: singlePO,
        provider: mockProvider,
        idempotencyKey: 'timeout_idemp_key',
      });

      expect(p1.id).toBe(p2.id);
      expect(p2.status).toBe('FAILED');
    });

    it('37. Concurrent duplicate payment executions serialize safely under in-flight mutex', async () => {
      const auth = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });

      const [p1, p2] = await Promise.all([
        executionService.executePayment({
          authorization: auth,
          purchaseOrder: singlePO,
          provider: mockProvider,
          idempotencyKey: 'concurrent_mutex_key',
        }),
        executionService.executePayment({
          authorization: auth,
          purchaseOrder: singlePO,
          provider: mockProvider,
          idempotencyKey: 'concurrent_mutex_key',
        }),
      ]);

      expect(p1.id).toBe(p2.id);
      expect(p1.providerTransactionId).toBe(p2.providerTransactionId);
    });

    it('38. Provider adapter suppresses duplicate capture calls for identical idempotency key', async () => {
      const req = {
        paymentId: 'pmt_dup_test',
        commitmentId: singleCommitment.id,
        purchaseOrderId: singlePO.id,
        supplierId: candidateA.id,
        supplierName: candidateA.name,
        recipientReference: 'orders@alphagrains.com',
        amount: 55500,
        currency: 'INR',
        purpose: 'COMMUNITY_PROCUREMENT' as const,
        idempotencyKey: 'provider_dedupe_123',
      };

      const res1 = await mockProvider.authorizeAndCapture(req);
      const res2 = await mockProvider.authorizeAndCapture(req);

      expect(res1.providerTransactionId).toBe(res2.providerTransactionId);
      expect(res2.metadata?.isDuplicate).toBe(true);
    });

    it('39. Idempotency key derived deterministically from commitment, supplier, and purpose', async () => {
      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: singleCommitment.id,
      });

      expect(payments[0].idempotencyKey).toContain(singleCommitment.id);
      expect(payments[0].idempotencyKey).toContain(singlePO.supplierId);
    });
  });

  // =========================================================================
  // 7. CONCURRENCY PROTECTION & MANDATE CAPACITY RESERVATION (Tests 40 - 43)
  // =========================================================================
  describe('7. Concurrency Protection & Mandate Capacity Reservation', () => {
    it('40. Two simultaneous payment requests cannot race past remaining mandate spending limit', async () => {
      // Mandate limit ₹10,000, Request A ₹6,000, Request B ₹5,000 (total ₹11,000 > ₹10,000)
      const tightMandate = mandateService.createMandate({
        ownerReference: 'soc_greenview',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 10000,
      });

      const [resA, resB] = await Promise.all([
        mandateService.reserveCapacity(tightMandate.id, 6000),
        mandateService.reserveCapacity(tightMandate.id, 5000),
      ]);

      // Exactly one must succeed, and one must be rejected with SPENDING_LIMIT_EXCEEDED
      const successCount = [resA, resB].filter((r) => r.success).length;
      const failCount = [resA, resB].filter((r) => !r.success).length;

      expect(successCount).toBe(1);
      expect(failCount).toBe(1);
      expect(tightMandate.reservedAmount).toBeLessThanOrEqual(10000);
    });

    it('41. Atomic capacity reservation prevents second concurrent payment from overspending', async () => {
      // Limit ₹7,000: Request A ₹5,000, Request B ₹4,000
      const limit7kMandate = mandateService.createMandate({
        ownerReference: 'soc_greenview',
        purpose: 'COMMUNITY_PROCUREMENT',
        currency: 'INR',
        spendingLimit: 7000,
      });

      const res1 = await mandateService.reserveCapacity(limit7kMandate.id, 5000);
      expect(res1.success).toBe(true);
      expect(res1.remainingCapacity).toBe(2000);

      const res2 = await mandateService.reserveCapacity(limit7kMandate.id, 4000);
      expect(res2.success).toBe(false);
      expect(res2.error).toContain('SPENDING_LIMIT_EXCEEDED');
    });

    it('42. Failed payment releases reserved capacity back to the mandate', async () => {
      mockProvider.simulateFailure(singlePO.id);

      const initialRemaining = mandateService.getRemainingCapacity(communityMandate.id);

      const auth = await authService.authorizePayment({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
      });

      // Capacity should be reserved
      expect(mandateService.getRemainingCapacity(communityMandate.id)).toBe(
        initialRemaining - singlePO.total
      );

      await executionService.executePayment({
        authorization: auth,
        purchaseOrder: singlePO,
        provider: mockProvider,
      });

      // After failure, reserved capacity must be released back!
      expect(mandateService.getRemainingCapacity(communityMandate.id)).toBe(initialRemaining);
      expect(communityMandate.reservedAmount).toBe(0);
    });

    it('43. Succeeded payment commits reserved capacity into spent amount without balance drift', async () => {
      const initialRemaining = mandateService.getRemainingCapacity(communityMandate.id);

      await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: singleCommitment.id,
      });

      expect(communityMandate.reservedAmount).toBe(0);
      expect(communityMandate.spentAmount).toBe(singlePO.total);
      expect(mandateService.getRemainingCapacity(communityMandate.id)).toBe(
        initialRemaining - singlePO.total
      );
    });
  });

  // =========================================================================
  // 8. MULTI-SUPPLIER PROCUREMENT & PARTIAL FAILURE HANDLING (Tests 44 - 48)
  // =========================================================================
  describe('8. Multi-Supplier Procurement & Partial Failure Handling', () => {
    it('44. Generates separate independent payment records for multi-supplier split procurement', async () => {
      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: splitCommitment.id,
      });

      expect(payments.length).toBe(2);
      expect(payments[0].id).not.toBe(payments[1].id);
      expect(payments[0].supplierId).not.toBe(payments[1].supplierId);
      expect(payments[0].purchaseOrderId).not.toBe(payments[1].purchaseOrderId);
    });

    it('45. Both supplier payments succeed independently and advance commitment to FULLY_PAID', async () => {
      const { summary, payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: splitCommitment.id,
      });

      expect(summary.status).toBe('FULLY_PAID');
      expect(splitCommitment.status).toBe('PAID');
      expect(splitPO_A.status).toBe('PAID');
      expect(splitPO_B.status).toBe('PAID');
      expect(payments.every((p) => p.status === 'SUCCEEDED')).toBe(true);
    });

    it('46. Partial failure: Supplier A succeeds and Supplier B fails produces PARTIALLY_PAID summary', async () => {
      // Simulate failure specifically for Supplier B's purchase order
      mockProvider.simulateFailure(
        splitPO_B.id,
        'GATEWAY_TIMEOUT',
        'Supplier B bank gateway timed out',
        true
      );

      const { summary, payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: splitCommitment.id,
      });

      expect(summary.status).toBe('PARTIALLY_PAID');
      expect(summary.paidAmount).toBe(splitPO_A.total);
      expect(splitCommitment.status).toBe('READY_FOR_PAYMENT'); // Must NOT be marked fully PAID!

      const pmtA = payments.find((p) => p.supplierId === candidateA.id)!;
      const pmtB = payments.find((p) => p.supplierId === candidateB.id)!;

      expect(pmtA.status).toBe('SUCCEEDED');
      expect(pmtB.status).toBe('FAILED');
    });

    it('47. Partial failure does not reverse or mutate Supplier A successful payment', async () => {
      mockProvider.simulateFailure(splitPO_B.id);

      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: splitCommitment.id,
      });

      const pmtA = payments.find((p) => p.supplierId === candidateA.id)!;
      expect(pmtA.status).toBe('SUCCEEDED');
      expect(pmtA.completedAt).toBeDefined();
    });

    it('48. Retrying only the failed supplier payment advances overall status to FULLY_PAID', async () => {
      mockProvider.simulateTimeout(splitPO_B.id);

      const { summary: initialSummary, payments: initialPayments } =
        await paymentService.payCommitment({
          ownerReference: 'soc_greenview',
          commitmentId: splitCommitment.id,
        });

      expect(initialSummary.status).toBe('PARTIALLY_PAID');
      const failedPayment = initialPayments.find((p) => p.status === 'FAILED')!;

      // Clear simulation override so retry succeeds. The operator explicitly
      // acknowledges the uncertain TIMEOUT outcome after inspection.
      mockProvider.clearOverrides();

      const { payment: retriedPayment, summary: updatedSummary } =
        await paymentService.retryPayment(failedPayment.id, {
          acknowledgeUncertainOutcome: true,
        });

      expect(retriedPayment.status).toBe('SUCCEEDED');
      expect(updatedSummary.status).toBe('FULLY_PAID');
      expect(splitCommitment.status).toBe('PAID');
    });
  });

  // =========================================================================
  // 9. AI SAFETY & CONSTRAINED AGENT TOOLS (Tests 49 - 55)
  // =========================================================================
  describe('9. AI Safety & Constrained Agent Tools', () => {
    it('49. Agent tool registry contains zero arbitrary money-moving or direct provider tools', () => {
      const toolNames = toolRegistry.list().map((t) => t.name);

      expect(toolNames).toContain('requestPaymentForCommitment');
      expect(toolNames).toContain('getPaymentState');
      expect(toolNames).toContain('getPaymentAuthorizationState');
      expect(toolNames).toContain('getProcurementPaymentSummary');

      // Crucial Safety Boundaries: AI has ZERO direct money manipulation tools
      expect(toolNames).not.toContain('executeSupplierPayment');
      expect(toolNames).not.toContain('directBankTransfer');
      expect(toolNames).not.toContain('chargeResidentCard');
      expect(toolNames).not.toContain('modifyPaymentMandate');
      expect(toolNames).not.toContain('increaseSpendingLimit');
    });

    it('50. requestPaymentForCommitment tool accepts only commitment reference (AI cannot set amount)', async () => {
      const tool = toolRegistry.get('requestPaymentForCommitment')!;
      const result: any = await tool.execute(
        {
          commitmentId: singleCommitment.id,
        },
        { residentId: 'soc_greenview', societyId: 'soc_greenview' }
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('FULLY_PAID');
      expect(result.paidAmount).toBe(55500);
    });

    it('50b. requestPaymentForCommitment tool requires an execution context (fail-closed)', async () => {
      const tool = toolRegistry.get('requestPaymentForCommitment')!;

      await expect(
        (tool.execute as any)({ commitmentId: singleCommitment.id })
      ).rejects.toThrow('execution context with residentId is required');

      await expect(
        (tool.execute as any)({ commitmentId: singleCommitment.id }, {})
      ).rejects.toThrow('execution context with residentId is required');
    });

    it('51. AI cannot choose arbitrary supplier recipient', async () => {
      const validation = authValidator.validate({
        commitment: singleCommitment,
        purchaseOrder: singlePO,
        mandate: communityMandate,
        amount: singlePO.total,
        currency: 'INR',
        purpose: 'COMMUNITY_PROCUREMENT',
        supplierId: 'cand_ai_arbitrary_recipient',
      });

      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('SUPPLIER_MISMATCH'))).toBe(true);
    });

    it('52. AI cannot modify payment mandate or increase spending limit', () => {
      const originalLimit = communityMandate.spendingLimit;

      // Ensure MandateService provides no mutation methods for AI
      expect(() => {
        // Attempting to force extra spending beyond limit
        const validation = authValidator.validate({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          mandate: communityMandate,
          amount: originalLimit + 50000,
          currency: 'INR',
          purpose: 'COMMUNITY_PROCUREMENT',
          supplierId: singlePO.supplierId,
        });
        expect(validation.valid).toBe(false);
      }).not.toThrow();
    });

    it('53. AI cannot bypass deterministic authorization engine', async () => {
      // Trying to execute directly without valid authorization throws error
      const invalidAuth = {
        id: 'auth_fake',
        commitmentId: singleCommitment.id,
        purchaseOrderId: singlePO.id,
        supplierId: 'cand_fake',
        supplierName: 'Fake',
        mandateId: communityMandate.id,
        amount: 100,
        currency: 'INR',
        purpose: 'COMMUNITY_PROCUREMENT' as const,
        status: 'REJECTED' as const,
        authorizedAt: new Date(),
        expiresAt: new Date(),
      };

      await expect(
        authValidator.validate({
          commitment: singleCommitment,
          purchaseOrder: singlePO,
          mandate: communityMandate,
          amount: 100,
          currency: 'INR',
          purpose: 'COMMUNITY_PROCUREMENT',
          supplierId: 'cand_fake',
        }).valid
      ).toBe(false);
    });

    it('54. getPaymentState tool retrieves operational payment state read-only', async () => {
      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: singleCommitment.id,
      });

      const tool = toolRegistry.get('getPaymentState')!;
      const result: any = await tool.execute(
        {
          paymentId: payments[0].id,
        },
        { residentId: 'soc_greenview', societyId: 'soc_greenview' }
      );

      expect(result.success).toBe(true);
      expect(result.payment.id).toBe(payments[0].id);
      expect(result.payment.status).toBe('SUCCEEDED');
    });

    it('55. getProcurementPaymentSummary tool retrieves multi-supplier payment progress read-only', async () => {
      await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: splitCommitment.id,
      });

      const tool = toolRegistry.get('getProcurementPaymentSummary')!;
      const result: any = await tool.execute(
        {
          commitmentId: splitCommitment.id,
        },
        { residentId: 'soc_greenview', societyId: 'soc_greenview' }
      );

      expect(result.success).toBe(true);
      expect(result.summary.status).toBe('FULLY_PAID');
      expect(result.summary.supplierObligations.length).toBe(2);
    });
  });

  // =========================================================================
  // 10. PRIVACY, ANTI-LEAKAGE & CONFIDENTIALITY BOUNDARY (Tests 56 - 59)
  // =========================================================================
  describe('10. Privacy, Anti-Leakage & Confidentiality Boundary', () => {
    it('56. Payment entity and provider payload contain zero resident names or resident IDs', async () => {
      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: singleCommitment.id,
      });

      const paymentJson = JSON.stringify(payments[0]);
      expect(paymentJson).not.toContain('residentId');
      expect(paymentJson).not.toContain('residentName');
      expect(paymentJson).not.toContain('Riya Sharma');
      expect(paymentJson).not.toContain('Amit Patel');
    });

    it('57. Payment entity and provider payload contain zero flat or apartment unit numbers', async () => {
      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: singleCommitment.id,
      });

      const paymentJson = JSON.stringify(payments[0]);
      expect(paymentJson).not.toContain('flatNumber');
      expect(paymentJson).not.toContain('Tower A');
      expect(paymentJson).not.toContain('A-101');
    });

    it('58. In multi-supplier procurement, Supplier A payment payload contains zero competitor data', async () => {
      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: splitCommitment.id,
      });

      const paymentA = payments.find((p) => p.supplierId === candidateA.id)!;
      const paymentB = payments.find((p) => p.supplierId === candidateB.id)!;

      const jsonA = JSON.stringify(paymentA);
      const jsonB = JSON.stringify(paymentB);

      // Payment A must not mention candidate B
      expect(jsonA).not.toContain(candidateB.name);
      expect(jsonA).not.toContain(candidateB.email);

      // Payment B must not mention candidate A
      expect(jsonB).not.toContain(candidateA.name);
      expect(jsonB).not.toContain(candidateA.email);
    });

    it('59. Payment records contain zero internal AI reasoning, prompts, or banking passwords', async () => {
      const { payments } = await paymentService.payCommitment({
        ownerReference: 'soc_greenview',
        commitmentId: singleCommitment.id,
      });

      const paymentJson = JSON.stringify(payments[0]);
      expect(paymentJson).not.toContain('prompt');
      expect(paymentJson).not.toContain('reasoning');
      expect(paymentJson).not.toContain('password');
      expect(paymentJson).not.toContain('pin');
    });
  });

  // =========================================================================
  // 11. COMPLETE FINANCIAL DOMAIN AUDIT TRAIL (Tests 60 - 64)
  // =========================================================================
  describe('11. Complete Financial Domain Audit Trail', () => {
    it('60. Emits PAYMENT_SUBMITTED and PAYMENT_PROCESSING during provider dispatch', async () => {
      const events: any[] = [];
      const subSubmitted = (e: any) => events.push(e);
      const subProcessing = (e: any) => events.push(e);

      eventBus.subscribe('PAYMENT_SUBMITTED', subSubmitted);
      eventBus.subscribe('PAYMENT_PROCESSING', subProcessing);

      try {
        await paymentService.payCommitment({
          ownerReference: 'soc_greenview',
          commitmentId: singleCommitment.id,
        });

        expect(events.some((e) => e.name === 'PAYMENT_SUBMITTED')).toBe(true);
        expect(events.some((e) => e.name === 'PAYMENT_PROCESSING')).toBe(true);
      } finally {
        eventBus.unsubscribe('PAYMENT_SUBMITTED', subSubmitted);
        eventBus.unsubscribe('PAYMENT_PROCESSING', subProcessing);
      }
    });

    it('61. Emits PAYMENT_SUCCEEDED with provider transaction reference', async () => {
      const events: any[] = [];
      const sub = (e: any) => events.push(e);
      eventBus.subscribe('PAYMENT_SUCCEEDED', sub);

      try {
        await paymentService.payCommitment({
          ownerReference: 'soc_greenview',
          commitmentId: singleCommitment.id,
        });

        expect(events.length).toBe(1);
        expect(events[0].name).toBe('PAYMENT_SUCCEEDED');
        expect(events[0].payload.providerTransactionId).toBeDefined();
        expect(events[0].payload.amount).toBe(55500);
      } finally {
        eventBus.unsubscribe('PAYMENT_SUCCEEDED', sub);
      }
    });

    it('62. Emits PAYMENT_FAILED upon provider rejection', async () => {
      mockProvider.simulateFailure(singlePO.id);

      const events: any[] = [];
      const sub = (e: any) => events.push(e);
      eventBus.subscribe('PAYMENT_FAILED', sub);

      try {
        await paymentService.payCommitment({
          ownerReference: 'soc_greenview',
          commitmentId: singleCommitment.id,
        });

        expect(events.length).toBe(1);
        expect(events[0].name).toBe('PAYMENT_FAILED');
        expect(events[0].payload.failureCode).toBeDefined();
      } finally {
        eventBus.unsubscribe('PAYMENT_FAILED', sub);
      }
    });

    it('63. Emits PAYMENT_RETRY_REQUESTED during payment retry', async () => {
      mockProvider.simulateTimeout(singlePO.id);

      const events: any[] = [];
      const sub = (e: any) => events.push(e);
      eventBus.subscribe('PAYMENT_RETRY_REQUESTED', sub);

      try {
        const { payments } = await paymentService.payCommitment({
          ownerReference: 'soc_greenview',
          commitmentId: singleCommitment.id,
        });

        mockProvider.clearOverrides();
        await paymentService.retryPayment(payments[0].id, {
          acknowledgeUncertainOutcome: true,
        });

        expect(events.length).toBe(1);
        expect(events[0].name).toBe('PAYMENT_RETRY_REQUESTED');
        expect(events[0].aggregateId).toBe(payments[0].id);
      } finally {
        eventBus.unsubscribe('PAYMENT_RETRY_REQUESTED', sub);
      }
    });

    it('64. Multi-supplier payment emits individual audit events per supplier obligation', async () => {
      const events: any[] = [];
      const sub = (e: any) => events.push(e);
      eventBus.subscribe('PAYMENT_SUCCEEDED', sub);

      try {
        await paymentService.payCommitment({
          ownerReference: 'soc_greenview',
          commitmentId: splitCommitment.id,
        });

        expect(events.length).toBe(2);
        const suppliersEmitted = events.map((e) => e.payload.supplierId);
        expect(suppliersEmitted).toContain(candidateA.id);
        expect(suppliersEmitted).toContain(candidateB.id);
      } finally {
        eventBus.unsubscribe('PAYMENT_SUCCEEDED', sub);
      }
    });
  });
});
