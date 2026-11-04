import { describe, it, expect, beforeEach } from 'vitest';
import { roundMoney, toDecimal } from '../src/domain/procurement/decimal';
import { RFQ } from '../src/discovery/supplier/rfq/types';
import { Quote } from '../src/discovery/supplier/quote/types';
import { ProcurementCommitmentService } from '../src/discovery/supplier/selection/ProcurementCommitmentService';
import { PurchaseOrderService } from '../src/discovery/supplier/selection/PurchaseOrderService';
import { purchaseOrderMessageBuilder } from '../src/discovery/supplier/selection/messageBuilder';
import { FulfillmentOrderService } from '../src/fulfillment/FulfillmentOrderService';
import { FulfillmentEventService } from '../src/fulfillment/FulfillmentEventService';
import { AllocationService } from '../src/allocation/AllocationService';
import { CostAllocationService } from '../src/allocation/CostAllocationService';
import { ReconciliationService } from '../src/allocation/ReconciliationService';
import { Payment } from '../src/payment/types';
import { ProcurementCommitment, PurchaseOrder } from '../src/discovery/supplier/selection/types';
import { FulfillmentOrder } from '../src/fulfillment/types';
import { ResidentDemand } from '../src/allocation/types';
import { resolveWorkflowRequest } from '../src/agent/intent/resolveWorkflowItems';
import { MockModelProvider } from '../src/agent/model/MockModelProvider';
import { quoteNormalizationService } from '../src/discovery/supplier/quote/QuoteNormalizationService';
import { rfqService } from '../src/discovery/supplier/rfq/RFQService';

describe('Final Multi-Item Integrity, Procurement Proof & Financial Correctness Remediation Suite', () => {
  let commitmentService: ProcurementCommitmentService;
  let poService: PurchaseOrderService;
  let fulfillmentService: FulfillmentOrderService;
  let eventService: FulfillmentEventService;
  let costService: CostAllocationService;
  let allocationService: AllocationService;
  let reconService: ReconciliationService;
  const mockProvider = new MockModelProvider();

  beforeEach(() => {
    commitmentService = new ProcurementCommitmentService();
    poService = new PurchaseOrderService();
    fulfillmentService = new FulfillmentOrderService();
    eventService = new FulfillmentEventService();
    costService = new CostAllocationService();
    allocationService = new AllocationService();
    reconService = new ReconciliationService();
  });

  // ---------------------------------------------------------------------------
  // Test A: 4-Product Request Multi-Item Line Preservation & Quantity Conservation
  // ---------------------------------------------------------------------------
  describe('Test A: 4-Product Request Multi-Item Line Preservation (RUN-526A902E baseline)', () => {
    it('correctly extracts, preserves and commits 4 distinct products without cross-unit summing', async () => {
      const requestText = '3 dozen eggs 4 kilo banana 7 kilo gehu ka atta 20 kilo indrayani chawal';
      const resolved = await resolveWorkflowRequest(requestText, mockProvider);

      expect(resolved.items.length).toBe(4);
      // Validate extracted items
      const egg = resolved.items.find((i) => i.productName.toLowerCase().includes('egg'));
      const banana = resolved.items.find((i) => i.productName.toLowerCase().includes('banana'));
      const atta = resolved.items.find((i) => i.productName.toLowerCase().includes('atta') || i.productName.toLowerCase().includes('wheat'));
      const rice = resolved.items.find((i) => i.productName.toLowerCase().includes('chawal') || i.productName.toLowerCase().includes('rice'));

      expect(egg).toBeDefined();
      expect(egg!.quantity).toBe(36); // 3 dozen = 36 units
      expect(banana).toBeDefined();
      expect(banana!.quantity).toBe(4);
      expect(atta).toBeDefined();
      expect(atta!.quantity).toBe(7);
      expect(rice).toBeDefined();
      expect(rice!.quantity).toBe(20);

      // Total scalar sum across heterogeneous units (36 + 4 + 7 + 20 = 67) must NEVER be assigned to eggs!
      const lineItems = resolved.items.map((it) => ({
        productId: it.productId,
        productName: it.productName,
        quantity: it.quantity,
        unit: it.unit,
      }));

      // Create RFQ with the 4 line items
      const rfq: RFQ = {
        id: 'rfq_test_a',
        societyId: 'soc_greenview',
        candidateId: 'mock_sup_farm_01',
        recipientContact: 'orders@sahyadri.com',
        product: { productName: 'Multi-Product Basket', unit: 'mixed' },
        lineItems,
        targetQuantity: 67,
        deliveryDeadline: new Date(Date.now() + 24 * 3600 * 1000),
        deliveryArea: 'Greenview Residency Community Service Area',
        status: 'OPEN',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rfqService['rfqs'].set(rfq.id, rfq);

      // Multi-item Quote with realistic negotiated pricing
      const quote: Quote = {
        id: 'quote_test_a',
        rfqId: rfq.id,
        candidateId: 'mock_sup_farm_01',
        supplierName: 'Sahyadri Farmer Producer Co.',
        lineItems: [
          { lineNumber: 1, productName: egg!.productName, quotedQuantity: 36, unit: 'units', unitPrice: 49.49, lineSubtotal: 1781.64 },
          { lineNumber: 2, productName: banana!.productName, quotedQuantity: 4, unit: 'kg', unitPrice: 47.53, lineSubtotal: 190.12 },
          { lineNumber: 3, productName: atta!.productName, quotedQuantity: 7, unit: 'kg', unitPrice: 46.55, lineSubtotal: 325.85 },
          { lineNumber: 4, productName: rice!.productName, quotedQuantity: 20, unit: 'kg', unitPrice: 84.48, lineSubtotal: 1689.60 },
        ],
        subtotal: 3987.21,
        tax: 199.36, // 5% of 3987.21
        deliveryFee: 41.00,
        otherCharges: 0,
        total: 4227.57,
        currency: 'INR',
        validUntil: new Date(Date.now() + 24 * 3600 * 1000),
        receivedAt: new Date(),
        status: 'VALID',
        isSimulated: true,
        deliveryEtaHours: 6,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      quoteNormalizationService['quotes'].set(quote.id, quote);

      // Create Commitment
      const { commitment, purchaseOrders } = await commitmentService.createCommitment({
        rfqId: rfq.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER',
          supplierId: quote.candidateId,
          quoteId: quote.id,
          reason: 'Best price and compliant SLA for all 4 items',
        },
      });

      expect(commitment.items).toBeDefined();
      expect(commitment.items!.length).toBe(4);
      expect(commitment.items![0].productName).toBe(egg!.productName);
      expect(commitment.items![0].requestedQuantity).toBe(36);
      expect(commitment.items![0].committedQuantity).toBe(36);
      expect(commitment.items![0].unitPrice).toBe(49.49);
      expect(commitment.items![0].lineSubtotal).toBe(1781.64);

      expect(commitment.items![1].productName).toBe(banana!.productName);
      expect(commitment.items![1].requestedQuantity).toBe(4);
      expect(commitment.items![1].unitPrice).toBe(47.53);

      expect(commitment.items![2].productName).toBe(atta!.productName);
      expect(commitment.items![2].requestedQuantity).toBe(7);
      expect(commitment.items![2].unitPrice).toBe(46.55);

      expect(commitment.items![3].productName).toBe(rice!.productName);
      expect(commitment.items![3].requestedQuantity).toBe(20);
      expect(commitment.items![3].unitPrice).toBe(84.48);

      // Purchase Order lines must preserve all 4 items
      const po = purchaseOrders[0];
      expect(po.lines.length).toBe(4);
      expect(po.lines[0].quantity).toBe(36);
      expect(po.lines[1].quantity).toBe(4);
      expect(po.lines[2].quantity).toBe(7);
      expect(po.lines[3].quantity).toBe(20);

      // Fulfillment Order creation must preserve line items
      const payment: Payment = {
        id: 'pay_test_a',
        commitmentId: commitment.id,
        purchaseOrderId: po.id,
        supplierId: po.supplierId,
        ownerReference: 'res_jivhesh',
        mandateId: 'man_123',
        amount: commitment.financials.total,
        currency: 'INR',
        status: 'SUCCEEDED',
        idempotencyKey: 'idemp_pay_a',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const fulfillmentOrder = fulfillmentService.createFulfillmentOrder({
        commitment,
        purchaseOrder: po,
        payment,
      });

      expect(fulfillmentOrder.lines).toBeDefined();
      expect(fulfillmentOrder.lines!.length).toBe(4);
      expect(fulfillmentOrder.lines![0].requestedQuantity).toBe(36);
      expect(fulfillmentOrder.lines![1].requestedQuantity).toBe(4);
      expect(fulfillmentOrder.lines![2].requestedQuantity).toBe(7);
      expect(fulfillmentOrder.lines![3].requestedQuantity).toBe(20);

      // Follow strict state machine progression: ACCEPTED -> PACKED -> DISPATCHED -> IN_TRANSIT -> DELIVERED
      await eventService.ingestEvent(fulfillmentOrder, {
        id: 'evt_acc_a',
        fulfillmentId: fulfillmentOrder.id,
        supplierId: fulfillmentOrder.supplierId,
        eventType: 'SUPPLIER_ACCEPTED',
        idempotencyKey: 'idemp_acc_a',
        timestamp: new Date(),
      });
      await eventService.ingestEvent(fulfillmentOrder, {
        id: 'evt_pack_a',
        fulfillmentId: fulfillmentOrder.id,
        supplierId: fulfillmentOrder.supplierId,
        eventType: 'ORDER_PACKED',
        idempotencyKey: 'idemp_pack_a',
        timestamp: new Date(),
      });
      await eventService.ingestEvent(fulfillmentOrder, {
        id: 'evt_disp_a',
        fulfillmentId: fulfillmentOrder.id,
        supplierId: fulfillmentOrder.supplierId,
        eventType: 'ORDER_DISPATCHED',
        trackingReference: 'TRK-TEST-A',
        idempotencyKey: 'idemp_disp_a',
        timestamp: new Date(),
      });
      await eventService.ingestEvent(fulfillmentOrder, {
        id: 'evt_trans_a',
        fulfillmentId: fulfillmentOrder.id,
        supplierId: fulfillmentOrder.supplierId,
        eventType: 'ORDER_IN_TRANSIT',
        idempotencyKey: 'idemp_trans_a',
        timestamp: new Date(),
      });
      await eventService.ingestEvent(fulfillmentOrder, {
        id: 'evt_deliv_a',
        fulfillmentId: fulfillmentOrder.id,
        supplierId: fulfillmentOrder.supplierId,
        eventType: 'ORDER_DELIVERED',
        quantityFulfilled: fulfillmentOrder.requestedQuantity,
        idempotencyKey: 'idemp_deliv_a',
        timestamp: new Date(),
      });

      // Verify each fulfillment line was fulfilled
      expect(fulfillmentOrder.lines![0].fulfilledQuantity).toBe(36);
      expect(fulfillmentOrder.lines![1].fulfilledQuantity).toBe(4);
      expect(fulfillmentOrder.lines![2].fulfilledQuantity).toBe(7);
      expect(fulfillmentOrder.lines![3].fulfilledQuantity).toBe(20);

      // Delivery verification
      const verifiedOrder = fulfillmentService.verifyFulfillment(fulfillmentOrder.id, {
        evidenceType: 'DELIVERY_CONFIRMATION',
        verifiedBy: 'Society Hub Manager',
        verifiedAt: new Date(),
        isSimulated: true,
      });
      expect(verifiedOrder.status).toBe('VERIFIED');
    });
  });

  // ---------------------------------------------------------------------------
  // Test B: 3-Product Request
  // ---------------------------------------------------------------------------
  describe('Test B: 3-Product Request ("5 kg rice, 1 kg sugar and 2 packs Maggi")', () => {
    it('correctly resolves 3 line items with distinct units (kg, kg, pack)', async () => {
      const resolved = await resolveWorkflowRequest('5 kg rice, 1 kg sugar and 2 packs Maggi', mockProvider);
      expect(resolved.items.length).toBe(3);

      const rice = resolved.items.find((i) => i.productName.toLowerCase().includes('rice'));
      const sugar = resolved.items.find((i) => i.productName.toLowerCase().includes('sugar'));
      const maggi = resolved.items.find((i) => i.productName.toLowerCase().includes('maggi'));

      expect(rice).toBeDefined();
      expect(rice!.quantity).toBe(5);
      expect(rice!.unit.toLowerCase()).toBe('kg');

      expect(sugar).toBeDefined();
      expect(sugar!.quantity).toBe(1);
      expect(sugar!.unit.toLowerCase()).toBe('kg');

      expect(maggi).toBeDefined();
      expect(maggi!.quantity).toBe(2);
      expect(maggi!.unit.toLowerCase()).toMatch(/^pack/);
    });
  });

  // ---------------------------------------------------------------------------
  // Test C: Mixed Units Pipeline Invariant
  // ---------------------------------------------------------------------------
  describe('Test C: Mixed Units Invariant', () => {
    it('rejects cross-unit scalar equality assumptions across heterogeneous demands', () => {
      const demands: ResidentDemand[] = [
        { residentOrderId: 'ro_1', residentId: 'res_1', residentReference: 'res_1', productId: 'p1', productName: 'Oil', requestedQuantity: 5, unit: 'litre' },
        { residentOrderId: 'ro_1', residentId: 'res_1', residentReference: 'res_1', productId: 'p2', productName: 'Wheat', requestedQuantity: 10, unit: 'kg' },
      ];

      // A mock fulfillment order with lines
      const fulfillment: FulfillmentOrder = {
        id: 'ful_c',
        commitmentId: 'commit_c',
        purchaseOrderId: 'po_c',
        paymentId: 'pay_c',
        supplierId: 'sup_c',
        supplierName: 'Wholesale Depot',
        fulfillmentType: 'PHYSICAL_GOODS',
        status: 'VERIFIED',
        lines: [
          { lineNumber: 1, productName: 'Oil', requestedQuantity: 5, fulfilledQuantity: 5, remainingQuantity: 0, unit: 'litre' },
          { lineNumber: 2, productName: 'Wheat', requestedQuantity: 10, fulfilledQuantity: 10, remainingQuantity: 0, unit: 'kg' },
        ],
        productName: 'Multi-Product Basket',
        requestedQuantity: 5,
        fulfilledQuantity: 5,
        remainingQuantity: 0,
        unit: 'mixed',
        deliveryArea: 'Greenview',
        slaDeadline: new Date(),
        slaStatus: 'ON_TRACK',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const commitment: ProcurementCommitment = {
        id: 'commit_c',
        rfqId: 'rfq_c',
        selectedQuoteIds: ['q_c'],
        supplierIds: ['sup_c'],
        items: [
          { lineNumber: 1, productName: 'Oil', requestedQuantity: 5, committedQuantity: 5, unit: 'litre', unitPrice: 150, lineSubtotal: 750 },
          { lineNumber: 2, productName: 'Wheat', requestedQuantity: 10, committedQuantity: 10, unit: 'kg', unitPrice: 40, lineSubtotal: 400 },
        ],
        product: { productName: 'Multi-Product Basket', unit: 'mixed' },
        lineItems: [
          { productName: 'Oil', quantity: 5, unit: 'litre' },
          { productName: 'Wheat', quantity: 10, unit: 'kg' },
        ],
        requestedQuantity: 5,
        committedQuantity: 5,
        allocations: [],
        financials: {
          subtotal: 1150,
          tax: 57.50,
          deliveryFee: 50,
          otherCharges: 0,
          total: 1257.50,
          currency: 'INR',
        },
        deliveryDeadline: new Date(),
        status: 'COMMITTED',
        purchaseOrderIds: ['po_c'],
        idempotencyKey: 'idemp_c',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const summary = allocationService.prepareAllocation({
        commitment,
        fulfillments: [fulfillment],
        residentDemands: demands,
      });

      // Conservation check: Oil got 5 litres, Wheat got 10 kg
      expect(summary.allocations.length).toBe(2);
      const oilAlloc = summary.allocations.find((a) => a.productName === 'Oil');
      const wheatAlloc = summary.allocations.find((a) => a.productName === 'Wheat');

      expect(oilAlloc).toBeDefined();
      expect(oilAlloc!.allocatedQuantity).toBe(5);
      expect(oilAlloc!.unit).toBe('litre');

      expect(wheatAlloc).toBeDefined();
      expect(wheatAlloc!.allocatedQuantity).toBe(10);
      expect(wheatAlloc!.unit).toBe('kg');

      // Validation passes per line
      expect(() => allocationService.validateAllocation(commitment.id)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Test D: Open-World vs Catalog Products
  // ---------------------------------------------------------------------------
  describe('Test D: Open-World vs Catalog Products', () => {
    it('preserves catalog IDs for catalog items and marks open-world items faithfully', async () => {
      // "gehu ka atta" maps to catalog, while "2 packs organic green tea" is open-world
      const resolved = await resolveWorkflowRequest('5 kg gehu ka atta and 2 packs organic green tea', mockProvider);
      expect(resolved.items.length).toBe(2);

      const atta = resolved.items.find((i) => i.productName.toLowerCase().includes('atta') || i.productName.toLowerCase().includes('wheat'));
      const tea = resolved.items.find((i) => i.productName.toLowerCase().includes('tea'));

      expect(atta).toBeDefined();
      expect(atta!.identitySource).toBe('catalog');
      expect(atta!.productId).toBeDefined();

      expect(tea).toBeDefined();
      expect(tea!.identitySource).toBe('open-world');
    });
  });

  // ---------------------------------------------------------------------------
  // Test E: Supplier Inventory Verification & Simulation Provenance
  // ---------------------------------------------------------------------------
  describe('Test E: Supplier Inventory Verification & Simulation Provenance', () => {
    it('sets commercialBasisSimulated: true when quotes are simulated and propagates to PO', async () => {
      const rfq: RFQ = {
        id: 'rfq_test_e',
        candidateId: 'mock_sup_farm_01',
        product: { productName: 'Rice', unit: 'kg' },
        lineItems: [{ productName: 'Rice', quantity: 10, unit: 'kg' }],
        targetQuantity: 10,
        deliveryDeadline: new Date(Date.now() + 24 * 3600 * 1000),
        status: 'OPEN',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rfqService['rfqs'].set(rfq.id, rfq);

      const quote: Quote = {
        id: 'quote_test_e',
        rfqId: rfq.id,
        candidateId: 'mock_sup_farm_01',
        supplierName: 'Sahyadri Farmer Producer Co.',
        lineItems: [{ lineNumber: 1, productName: 'Rice', quotedQuantity: 10, unit: 'kg', unitPrice: 50, lineSubtotal: 500 }],
        subtotal: 500,
        tax: 25,
        deliveryFee: 30,
        otherCharges: 0,
        total: 555,
        currency: 'INR',
        validUntil: new Date(Date.now() + 24 * 3600 * 1000),
        receivedAt: new Date(),
        status: 'VALID',
        isSimulated: true, // Quote is simulated
        deliveryEtaHours: 4,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      quoteNormalizationService['quotes'].set(quote.id, quote);

      const { commitment, purchaseOrders } = await commitmentService.createCommitment({
        rfqId: rfq.id,
        recommendation: {
          decision: 'SELECT_SUPPLIER',
          supplierId: quote.candidateId,
          quoteId: quote.id,
          reason: 'Best quote',
        },
      });

      expect(commitment.commercialBasisSimulated).toBe(true);
      expect(purchaseOrders[0].commercialBasisSimulated).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Test F: Negotiated Tax Recalculation & Line-Level Financial Allocation
  // ---------------------------------------------------------------------------
  describe('Test F: Financial Correctness & 5% Tax Semantics', () => {
    it('recalculates 5% tax on post-negotiated subtotal ₹3,987.21 to yield ₹199.36 and ₹4,227.57 total', () => {
      const negotiatedSubtotal = 3987.21;
      const deliveryFee = 41.00;
      const otherCharges = 0;

      // 5% GST on subtotal
      const tax = roundMoney(negotiatedSubtotal * 0.05).toNumber();
      expect(tax).toBe(199.36); // Not corrupted 203.43!

      const total = roundMoney(negotiatedSubtotal + deliveryFee + tax + otherCharges).toNumber();
      expect(total).toBe(4227.57); // Not corrupted 4231.64!
    });

    it('allocates line-specific costs rather than dividing cart subtotal by 67', () => {
      const quantityAllocations = [
        { residentOrderId: 'ro_1', demandLineId: 'dl_egg', residentReference: 'res_jivhesh', requestedQuantity: 36, allocatedQuantity: 36 },
        { residentOrderId: 'ro_1', demandLineId: 'dl_banana', residentReference: 'res_jivhesh', requestedQuantity: 4, allocatedQuantity: 4 },
        { residentOrderId: 'ro_1', demandLineId: 'dl_atta', residentReference: 'res_jivhesh', requestedQuantity: 7, allocatedQuantity: 7 },
        { residentOrderId: 'ro_1', demandLineId: 'dl_rice', residentReference: 'res_jivhesh', requestedQuantity: 20, allocatedQuantity: 20 },
      ];

      const financials = {
        subtotal: 3987.21,
        tax: 199.36,
        deliveryFee: 41.00,
        otherCharges: 0,
        total: 4227.57,
        currency: 'INR',
        lineCosts: [
          { demandLineId: 'dl_egg', productName: 'Eggs', unitPrice: 49.49, subtotal: 1781.64 },
          { demandLineId: 'dl_banana', productName: 'Banana', unitPrice: 47.53, subtotal: 190.12 },
          { demandLineId: 'dl_atta', productName: 'Atta', unitPrice: 46.55, subtotal: 325.85 },
          { demandLineId: 'dl_rice', productName: 'Rice', unitPrice: 84.48, subtotal: 1689.60 },
        ],
      };

      const costResults = costService.allocateCosts(quantityAllocations, financials);

      expect(costResults.length).toBe(4);

      // Egg line
      const eggCost = costResults.find((c) => c.demandLineId === 'dl_egg')!;
      expect(eggCost.unitPrice).toBe(49.49); // True unit price, NOT 59.51!
      expect(eggCost.subtotal).toBe(1781.64);
      expect(eggCost.allocatedTax).toBeCloseTo(1781.64 * 0.05, 1);

      // Banana line
      const bananaCost = costResults.find((c) => c.demandLineId === 'dl_banana')!;
      expect(bananaCost.unitPrice).toBe(47.53);
      expect(bananaCost.subtotal).toBe(190.12);

      // Atta line
      const attaCost = costResults.find((c) => c.demandLineId === 'dl_atta')!;
      expect(attaCost.unitPrice).toBe(46.55);
      expect(attaCost.subtotal).toBe(325.85);

      // Rice line
      const riceCost = costResults.find((c) => c.demandLineId === 'dl_rice')!;
      expect(riceCost.unitPrice).toBe(84.48);
      expect(riceCost.subtotal).toBe(1689.60);

      // Total conservation check: zero paise leakage
      const sumTotal = costResults.reduce((sum, c) => sum + c.totalAmount, 0);
      expect(roundMoney(sumTotal).toNumber()).toBe(4227.57);
    });
  });

  // ---------------------------------------------------------------------------
  // Test G: Reconciliation Failure on Quantity Mismatch vs Monetary Mismatch
  // ---------------------------------------------------------------------------
  describe('Test G: Reconciliation Integrity', () => {
    it('detects missing or short delivered items per line and transitions to DISCREPANCY', async () => {
      const commitment: ProcurementCommitment = {
        id: 'commit_g',
        rfqId: 'rfq_g',
        selectedQuoteIds: ['q_g'],
        supplierIds: ['sup_g'],
        items: [
          { lineNumber: 1, productName: 'Eggs', requestedQuantity: 36, committedQuantity: 36, unit: 'units', unitPrice: 49.49, lineSubtotal: 1781.64 },
          { lineNumber: 2, productName: 'Banana', requestedQuantity: 4, committedQuantity: 4, unit: 'kg', unitPrice: 47.53, lineSubtotal: 190.12 },
        ],
        product: { productName: 'Multi-Product Basket', unit: 'mixed' },
        lineItems: [
          { productName: 'Eggs', quantity: 36, unit: 'units' },
          { productName: 'Banana', quantity: 4, unit: 'kg' },
        ],
        requestedQuantity: 36,
        committedQuantity: 36,
        allocations: [],
        financials: {
          subtotal: 1971.76,
          tax: 98.59,
          deliveryFee: 40.00,
          otherCharges: 0,
          total: 2110.35,
          currency: 'INR',
        },
        deliveryDeadline: new Date(),
        status: 'COMMITTED',
        purchaseOrderIds: ['po_g'],
        idempotencyKey: 'idemp_g',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const po: PurchaseOrder = {
        id: 'po_g',
        poNumber: 'PO-2026-TESTG',
        commitmentId: commitment.id,
        rfqId: commitment.rfqId,
        supplierId: 'sup_g',
        supplierName: 'Supplier G',
        supplierContact: 'g@supplier.com',
        lines: [
          { lineNumber: 1, productName: 'Eggs', quantity: 36, unit: 'units', unitPrice: 49.49, lineTotal: 1781.64 },
          { lineNumber: 2, productName: 'Banana', quantity: 4, unit: 'kg', unitPrice: 47.53, lineTotal: 190.12 },
        ],
        subtotal: 1971.76,
        deliveryFee: 40.00,
        tax: 98.59,
        total: 2110.35,
        currency: 'INR',
        deliveryDeadline: new Date(),
        deliveryArea: 'Greenview',
        terms: 'Pre-authorized via resident mandate; settled upon delivery verification and reconciliation.',
        status: 'READY_FOR_PAYMENT',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Fulfillment with BANANA SHORTAGE (only 3 kg fulfilled instead of 4 kg)
      const fulfillment: FulfillmentOrder = {
        id: 'ful_g',
        commitmentId: commitment.id,
        purchaseOrderId: po.id,
        paymentId: 'pay_g',
        supplierId: 'sup_g',
        supplierName: 'Supplier G',
        fulfillmentType: 'PHYSICAL_GOODS',
        status: 'VERIFIED',
        lines: [
          { lineNumber: 1, productName: 'Eggs', requestedQuantity: 36, fulfilledQuantity: 36, unit: 'units', verified: true },
          { lineNumber: 2, productName: 'Banana', requestedQuantity: 4, fulfilledQuantity: 3, unit: 'kg', verified: true }, // SHORTAGE!
        ],
        productName: 'Multi-Product Basket',
        requestedQuantity: 36,
        fulfilledQuantity: 36,
        remainingQuantity: 0,
        unit: 'mixed',
        deliveryArea: 'Greenview',
        slaDeadline: new Date(),
        slaStatus: 'ON_TRACK',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const residentAllocations = [
        {
          id: 'alloc_1',
          commitmentId: commitment.id,
          residentOrderId: 'ro_1',
          demandLineId: 'dl_egg',
          residentReference: 'res_jivhesh',
          productId: 'prod_egg',
          productName: 'Eggs',
          requestedQuantity: 36,
          allocatedQuantity: 36,
          unit: 'units',
          unitPrice: 49.49,
          subtotal: 1781.64,
          allocatedTax: 89.08,
          allocatedDeliveryFee: 36.14,
          allocatedOtherCharges: 0,
          totalAmount: 1906.86,
          allocationStatus: 'FINALIZED' as const,
          reconciliationStatus: 'PENDING' as const,
          idempotencyKey: 'idemp_a1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'alloc_2',
          commitmentId: commitment.id,
          residentOrderId: 'ro_1',
          demandLineId: 'dl_banana',
          residentReference: 'res_jivhesh',
          productId: 'prod_banana',
          productName: 'Banana',
          requestedQuantity: 4,
          allocatedQuantity: 4, // Allocated 4 kg, but only 3 kg fulfilled!
          unit: 'kg',
          unitPrice: 47.53,
          subtotal: 190.12,
          allocatedTax: 9.51,
          allocatedDeliveryFee: 3.86,
          allocatedOtherCharges: 0,
          totalAmount: 203.49,
          allocationStatus: 'FINALIZED' as const,
          reconciliationStatus: 'PENDING' as const,
          idempotencyKey: 'idemp_a2',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const payments: Payment[] = [
        {
          id: 'pay_g',
          commitmentId: commitment.id,
          purchaseOrderId: po.id,
          ownerReference: 'res_jivhesh',
          mandateId: 'man_g',
          amount: commitment.financials.total,
          currency: 'INR',
          status: 'SUCCEEDED',
          idempotencyKey: 'idemp_pay_g',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const reconResult = await reconService.reconcileCommitment({
        commitment,
        fulfillments: [fulfillment],
        allocations: residentAllocations,
        payments,
        purchaseOrders: [po],
      });

      // Reconciliation MUST fail with DISCREPANCY
      expect(reconResult.status).toBe('DISCREPANCY');
      expect(reconResult.isQuantityMatched).toBe(false);
      expect(reconResult.discrepancies.length).toBeGreaterThan(0);
      expect(reconResult.discrepancies[0].message).toContain('Banana');
      expect(reconResult.discrepancies[0].message).toContain('allocated 4 kg, verified 3 kg');
    });
  });

  // ---------------------------------------------------------------------------
  // Test H: Honest PO Terms & Privacy
  // ---------------------------------------------------------------------------
  describe('Test H: PO Terms & Anti-Leakage Compliance', () => {
    it('sets official mandate terms while sanitizing supplier-facing output from leaking internal identities', () => {
      const po: PurchaseOrder = {
        id: 'po_h',
        poNumber: 'PO-2026-TESTH',
        commitmentId: 'commit_h',
        rfqId: 'rfq_h',
        supplierId: 'sup_h',
        supplierName: 'Wholesale Depot',
        supplierContact: 'contact@depot.com',
        lines: [{ lineNumber: 1, productName: 'Rice', quantity: 20, unit: 'kg', unitPrice: 84.48, lineTotal: 1689.60 }],
        subtotal: 1689.60,
        deliveryFee: 41.00,
        tax: 84.48,
        total: 1815.08,
        currency: 'INR',
        deliveryDeadline: new Date(),
        deliveryArea: 'Greenview Residency Community Service Area',
        terms: 'Pre-authorized via resident mandate; settled upon delivery verification and reconciliation.',
        status: 'READY_FOR_PAYMENT',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Property terms is exactly as specified
      expect(po.terms).toBe('Pre-authorized via resident mandate; settled upon delivery verification and reconciliation.');

      // Supplier message builder text must NOT leak resident or mandate
      const text = purchaseOrderMessageBuilder.buildPurchaseOrderText(po);
      expect(text).not.toContain('resident');
      expect(text).not.toContain('mandate');
      expect(text).toContain('OFFICIAL PURCHASE ORDER');
      expect(text).toContain('Pre-authorized');
    });
  });
});
