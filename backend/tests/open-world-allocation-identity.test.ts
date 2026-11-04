import { describe, it, expect, beforeEach } from 'vitest';
import {
  AllocationService,
  getProductGroupingKey,
  isCatalogProductId,
} from '../src/allocation/AllocationService';
import { AllocationValidationError } from '../src/allocation/validation';
import { ResidentDemand } from '../src/allocation/types';
import { ProcurementCommitment } from '../src/discovery/supplier/selection/types';
import { FulfillmentOrder } from '../src/fulfillment/types';

describe('P0 Open-World Multi-Product Allocation Identity Remediation Suite', () => {
  let service: AllocationService;

  beforeEach(() => {
    service = new AllocationService();
  });

  const baseFinancials = {
    subtotal: 324,
    tax: 16.2,
    deliveryFee: 43,
    otherCharges: 0,
    total: 383.2,
    currency: 'INR',
  };

  const createCommitment = (
    id: string,
    items: Array<{
      lineNumber: number;
      productId?: string | null;
      productName: string;
      requestedQuantity: number;
      committedQuantity: number;
      unitPrice: number;
      lineSubtotal: number;
      unit: string;
    }>
  ): ProcurementCommitment => ({
    id,
    rfqId: `rfq_${id}`,
    supplierIds: ['mock_sup_2'],
    selectedQuoteIds: ['quote_5310a69f'],
    purchaseOrderIds: ['po_4242d0ba'],
    status: 'CONFIRMED',
    product: {
      productId: items[0]?.productId as any,
      productName: items[0]?.productName || 'Multi-Item Order',
      unit: items[0]?.unit || 'packs',
    },
    items: items.map((it) => ({
      ...it,
      productId: it.productId as any,
    })),
    financials: baseFinancials,
    allocations: [],
    idempotencyKey: `idemp_${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const createFulfillment = (
    id: string,
    commitmentId: string,
    lines: Array<{
      lineNumber: number;
      productId?: string | null;
      productName: string;
      requestedQuantity: number;
      fulfilledQuantity: number;
      unit: string;
    }>
  ): FulfillmentOrder => ({
    id,
    purchaseOrderId: 'po_4242d0ba',
    commitmentId,
    supplierId: 'mock_sup_2',
    supplierName: 'Community Grain & Oil Depot',
    fulfillmentType: 'PHYSICAL_GOODS',
    status: 'VERIFIED',
    productName: lines[0]?.productName || 'Order',
    requestedQuantity: lines.reduce((acc, l) => acc + l.requestedQuantity, 0),
    fulfilledQuantity: lines.reduce((acc, l) => acc + l.fulfilledQuantity, 0),
    remainingQuantity: 0,
    unit: lines[0]?.unit || 'packs',
    lines: lines.map((l) => ({
      ...l,
      remainingQuantity: 0,
    })),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // ---------------------------------------------------------------------------
  // Condition A: Three open-world products, all with productId=null (RUN-8C4C778B)
  // ---------------------------------------------------------------------------
  it('A. allocates three open-world products with productId=null exactly without under-allocation', () => {
    const commitment = createCommitment('commit_marathi_8c4c778b', [
      {
        lineNumber: 1,
        productId: null,
        productName: 'Harpic',
        requestedQuantity: 2,
        committedQuantity: 2,
        unitPrice: 50,
        lineSubtotal: 100,
        unit: 'packs',
      },
      {
        lineNumber: 2,
        productId: null,
        productName: 'room cleaner',
        requestedQuantity: 1,
        committedQuantity: 1,
        unitPrice: 71,
        lineSubtotal: 71,
        unit: 'units',
      },
      {
        lineNumber: 3,
        productId: null,
        productName: 'fragrance spray',
        requestedQuantity: 3,
        committedQuantity: 3,
        unitPrice: 51,
        lineSubtotal: 153,
        unit: 'units',
      },
    ]);

    const fulfillment = createFulfillment('ful_marathi', commitment.id, [
      {
        lineNumber: 1,
        productId: null,
        productName: 'Harpic',
        requestedQuantity: 2,
        fulfilledQuantity: 2,
        unit: 'packs',
      },
      {
        lineNumber: 2,
        productId: null,
        productName: 'room cleaner',
        requestedQuantity: 1,
        fulfilledQuantity: 1,
        unit: 'units',
      },
      {
        lineNumber: 3,
        productId: null,
        productName: 'fragrance spray',
        requestedQuantity: 3,
        fulfilledQuantity: 3,
        unit: 'units',
      },
    ]);

    const demands: ResidentDemand[] = [
      {
        residentOrderId: 'ro_marathi_1',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: '', // Open-world line without catalog ID
        productName: 'Harpic',
        requestedQuantity: 2,
        unit: 'packs',
      },
      {
        residentOrderId: 'ro_marathi_1',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: '',
        productName: 'room cleaner',
        requestedQuantity: 1,
        unit: 'units',
      },
      {
        residentOrderId: 'ro_marathi_1',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: '',
        productName: 'fragrance spray',
        requestedQuantity: 3,
        unit: 'units',
      },
    ];

    const summary = service.prepareAllocation({
      commitment,
      fulfillments: [fulfillment],
      residentDemands: demands,
    });

    expect(summary.allocations).toHaveLength(3);

    const harpicAlloc = summary.allocations.find((a) => a.productName.toLowerCase() === 'harpic');
    const roomAlloc = summary.allocations.find((a) => a.productName.toLowerCase() === 'room cleaner');
    const sprayAlloc = summary.allocations.find((a) => a.productName.toLowerCase() === 'fragrance spray');

    expect(harpicAlloc).toBeDefined();
    expect(harpicAlloc!.allocatedQuantity).toBe(2);
    expect(harpicAlloc!.requestedQuantity).toBe(2);

    expect(roomAlloc).toBeDefined();
    expect(roomAlloc!.allocatedQuantity).toBe(1);
    expect(roomAlloc!.requestedQuantity).toBe(1);

    expect(sprayAlloc).toBeDefined();
    expect(sprayAlloc!.allocatedQuantity).toBe(3);
    expect(sprayAlloc!.requestedQuantity).toBe(3);

    // Validation must succeed without UNDER_ALLOCATION_MISMATCH
    expect(() => {
      service.validateAllocation(commitment.id);
    }).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Condition B: Three open-world products incorrectly supplied with same prod_dynamic
  // ---------------------------------------------------------------------------
  it('B. keeps three open-world products distinct even if all are supplied with prod_dynamic', () => {
    // 1. Verify getProductGroupingKey rejects prod_dynamic as catalog key
    const k1 = getProductGroupingKey('prod_dynamic', 'Harpic');
    const k2 = getProductGroupingKey('prod_dynamic', 'room cleaner');
    const k3 = getProductGroupingKey('prod_dynamic', 'fragrance spray');

    expect(k1).toBe('open_world::harpic');
    expect(k2).toBe('open_world::room cleaner');
    expect(k3).toBe('open_world::fragrance spray');
    expect(new Set([k1, k2, k3]).size).toBe(3);

    // 2. Full allocation pipeline test
    const commitment = createCommitment('commit_prod_dynamic_test', [
      {
        lineNumber: 1,
        productId: 'prod_dynamic',
        productName: 'Harpic',
        requestedQuantity: 2,
        committedQuantity: 2,
        unitPrice: 50,
        lineSubtotal: 100,
        unit: 'packs',
      },
      {
        lineNumber: 2,
        productId: 'prod_dynamic',
        productName: 'room cleaner',
        requestedQuantity: 1,
        committedQuantity: 1,
        unitPrice: 71,
        lineSubtotal: 71,
        unit: 'units',
      },
      {
        lineNumber: 3,
        productId: 'prod_dynamic',
        productName: 'fragrance spray',
        requestedQuantity: 3,
        committedQuantity: 3,
        unitPrice: 51,
        lineSubtotal: 153,
        unit: 'units',
      },
    ]);

    const fulfillment = createFulfillment('ful_prod_dynamic', commitment.id, [
      {
        lineNumber: 1,
        productId: 'prod_dynamic',
        productName: 'Harpic',
        requestedQuantity: 2,
        fulfilledQuantity: 2,
        unit: 'packs',
      },
      {
        lineNumber: 2,
        productId: 'prod_dynamic',
        productName: 'room cleaner',
        requestedQuantity: 1,
        fulfilledQuantity: 1,
        unit: 'units',
      },
      {
        lineNumber: 3,
        productId: 'prod_dynamic',
        productName: 'fragrance spray',
        requestedQuantity: 3,
        fulfilledQuantity: 3,
        unit: 'units',
      },
    ]);

    const demands: ResidentDemand[] = [
      {
        residentOrderId: 'ro_test',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: 'prod_dynamic',
        productName: 'Harpic',
        requestedQuantity: 2,
        unit: 'packs',
      },
      {
        residentOrderId: 'ro_test',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: 'prod_dynamic',
        productName: 'room cleaner',
        requestedQuantity: 1,
        unit: 'units',
      },
      {
        residentOrderId: 'ro_test',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: 'prod_dynamic',
        productName: 'fragrance spray',
        requestedQuantity: 3,
        unit: 'units',
      },
    ];

    const summary = service.prepareAllocation({
      commitment,
      fulfillments: [fulfillment],
      residentDemands: demands,
    });

    const harpicAlloc = summary.allocations.find((a) => a.productName.toLowerCase() === 'harpic')!;
    const roomAlloc = summary.allocations.find((a) => a.productName.toLowerCase() === 'room cleaner')!;
    const sprayAlloc = summary.allocations.find((a) => a.productName.toLowerCase() === 'fragrance spray')!;

    expect(harpicAlloc.allocatedQuantity).toBe(2);
    expect(roomAlloc.allocatedQuantity).toBe(1);
    expect(sprayAlloc.allocatedQuantity).toBe(3);

    expect(() => {
      service.validateAllocation(commitment.id);
    }).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Condition C: Two catalog products with distinct real IDs
  // ---------------------------------------------------------------------------
  it('C. groups and allocates two catalog products by their distinct catalog IDs', () => {
    const riceId = '44444444-4444-4444-8444-444444444401';
    const bananaId = '44444444-4444-4444-8444-444444444409';

    expect(isCatalogProductId(riceId)).toBe(true);
    expect(isCatalogProductId(bananaId)).toBe(true);

    const commitment = createCommitment('commit_catalog_test', [
      {
        lineNumber: 1,
        productId: riceId,
        productName: 'Indrayani Rice',
        requestedQuantity: 20,
        committedQuantity: 20,
        unitPrice: 80,
        lineSubtotal: 1600,
        unit: 'kg',
      },
      {
        lineNumber: 2,
        productId: bananaId,
        productName: 'Banana Robusta',
        requestedQuantity: 4,
        committedQuantity: 4,
        unitPrice: 40,
        lineSubtotal: 160,
        unit: 'kg',
      },
    ]);

    const fulfillment = createFulfillment('ful_catalog', commitment.id, [
      {
        lineNumber: 1,
        productId: riceId,
        productName: 'Indrayani Rice',
        requestedQuantity: 20,
        fulfilledQuantity: 20,
        unit: 'kg',
      },
      {
        lineNumber: 2,
        productId: bananaId,
        productName: 'Banana Robusta',
        requestedQuantity: 4,
        fulfilledQuantity: 4,
        unit: 'kg',
      },
    ]);

    const demands: ResidentDemand[] = [
      {
        residentOrderId: 'ro_catalog_1',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: riceId,
        productName: 'Indrayani Rice',
        requestedQuantity: 20,
        unit: 'kg',
      },
      {
        residentOrderId: 'ro_catalog_1',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: bananaId,
        productName: 'Banana Robusta',
        requestedQuantity: 4,
        unit: 'kg',
      },
    ];

    const summary = service.prepareAllocation({
      commitment,
      fulfillments: [fulfillment],
      residentDemands: demands,
    });

    const riceAlloc = summary.allocations.find((a) => a.productId === riceId)!;
    const bananaAlloc = summary.allocations.find((a) => a.productId === bananaId)!;

    expect(riceAlloc.allocatedQuantity).toBe(20);
    expect(bananaAlloc.allocatedQuantity).toBe(4);

    expect(() => {
      service.validateAllocation(commitment.id);
    }).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Condition D: Mixed catalog and open-world products
  // ---------------------------------------------------------------------------
  it('D. handles mixed catalog and open-world products with zero grouping collisions', () => {
    const catalogFlourId = '44444444-4444-4444-8444-444444444402';

    const commitment = createCommitment('commit_mixed_test', [
      {
        lineNumber: 1,
        productId: catalogFlourId,
        productName: 'Chakki Fresh Atta',
        requestedQuantity: 5,
        committedQuantity: 5,
        unitPrice: 60,
        lineSubtotal: 300,
        unit: 'kg',
      },
      {
        lineNumber: 2,
        productId: null,
        productName: 'Organic Dishwash Liquid',
        requestedQuantity: 2,
        committedQuantity: 2,
        unitPrice: 90,
        lineSubtotal: 180,
        unit: 'units',
      },
    ]);

    const fulfillment = createFulfillment('ful_mixed', commitment.id, [
      {
        lineNumber: 1,
        productId: catalogFlourId,
        productName: 'Chakki Fresh Atta',
        requestedQuantity: 5,
        fulfilledQuantity: 5,
        unit: 'kg',
      },
      {
        lineNumber: 2,
        productId: null,
        productName: 'Organic Dishwash Liquid',
        requestedQuantity: 2,
        fulfilledQuantity: 2,
        unit: 'units',
      },
    ]);

    const demands: ResidentDemand[] = [
      {
        residentOrderId: 'ro_mixed_1',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: catalogFlourId,
        productName: 'Chakki Fresh Atta',
        requestedQuantity: 5,
        unit: 'kg',
      },
      {
        residentOrderId: 'ro_mixed_1',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: '',
        productName: 'Organic Dishwash Liquid',
        requestedQuantity: 2,
        unit: 'units',
      },
    ];

    const summary = service.prepareAllocation({
      commitment,
      fulfillments: [fulfillment],
      residentDemands: demands,
    });

    expect(summary.allocations).toHaveLength(2);

    const flourAlloc = summary.allocations.find((a) => a.productId === catalogFlourId)!;
    const dishAlloc = summary.allocations.find((a) => a.productName.toLowerCase().includes('dishwash'))!;

    expect(flourAlloc.allocatedQuantity).toBe(5);
    expect(dishAlloc.allocatedQuantity).toBe(2);

    expect(() => {
      service.validateAllocation(commitment.id);
    }).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Condition E: Duplicate product names with different casing/whitespace
  // ---------------------------------------------------------------------------
  it('E. normalizes whitespace and casing safely without merging different products', () => {
    // Equivalent names pool into the same product group
    const k1 = getProductGroupingKey(null, '  Harpic  Power Plus  ');
    const k2 = getProductGroupingKey(null, 'harpic   power plus');
    expect(k1).toBe('open_world::harpic power plus');
    expect(k1).toBe(k2);

    // Genuinely different products remain distinct
    const kDifferent = getProductGroupingKey(null, 'Harpic Bathroom Cleaner');
    expect(kDifferent).toBe('open_world::harpic bathroom cleaner');
    expect(k1).not.toBe(kDifferent);

    // Multiple resident orders for the same open-world product correctly pool together
    const commitment = createCommitment('commit_normalize_pool', [
      {
        lineNumber: 1,
        productId: null,
        productName: 'Harpic Power Plus',
        requestedQuantity: 4,
        committedQuantity: 4,
        unitPrice: 50,
        lineSubtotal: 200,
        unit: 'packs',
      },
    ]);

    const fulfillment = createFulfillment('ful_pool', commitment.id, [
      {
        lineNumber: 1,
        productId: null,
        productName: 'Harpic Power Plus',
        requestedQuantity: 4,
        fulfilledQuantity: 4,
        unit: 'packs',
      },
    ]);

    const demands: ResidentDemand[] = [
      {
        residentOrderId: 'ro_res1',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: '',
        productName: '  Harpic  Power Plus  ',
        requestedQuantity: 2,
        unit: 'packs',
      },
      {
        residentOrderId: 'ro_res2',
        residentId: 'res_2',
        residentReference: 'Flat 202',
        productId: '',
        productName: 'harpic power plus',
        requestedQuantity: 2,
        unit: 'packs',
      },
    ];

    const summary = service.prepareAllocation({
      commitment,
      fulfillments: [fulfillment],
      residentDemands: demands,
    });

    expect(summary.allocations).toHaveLength(2);
    expect(summary.allocations[0].allocatedQuantity).toBe(2);
    expect(summary.allocations[1].allocatedQuantity).toBe(2);
    expect(summary.totalAllocatedQuantity).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // Condition F: Missing or ambiguous fulfillment-line identity fails closed
  // ---------------------------------------------------------------------------
  it('F. fails closed when a fulfillment line cannot be matched to demand', () => {
    const commitment = createCommitment('commit_unmatched_test', [
      {
        lineNumber: 1,
        productId: null,
        productName: 'Harpic',
        requestedQuantity: 2,
        committedQuantity: 2,
        unitPrice: 50,
        lineSubtotal: 100,
        unit: 'packs',
      },
      {
        lineNumber: 2,
        productId: null,
        productName: 'Floor Cleaner',
        requestedQuantity: 1,
        committedQuantity: 1,
        unitPrice: 70,
        lineSubtotal: 70,
        unit: 'units',
      },
    ]);

    // Fulfillment line for Floor Cleaner is missing; replaced by unrelated Toilet Brush
    const fulfillment = createFulfillment('ful_unmatched', commitment.id, [
      {
        lineNumber: 1,
        productId: null,
        productName: 'Harpic',
        requestedQuantity: 2,
        fulfilledQuantity: 2,
        unit: 'packs',
      },
      {
        lineNumber: 2,
        productId: null,
        productName: 'Toilet Brush',
        requestedQuantity: 1,
        fulfilledQuantity: 1,
        unit: 'units',
      },
    ]);

    const demands: ResidentDemand[] = [
      {
        residentOrderId: 'ro_fail',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: '',
        productName: 'Harpic',
        requestedQuantity: 2,
        unit: 'packs',
      },
      {
        residentOrderId: 'ro_fail',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: '',
        productName: 'Floor Cleaner',
        requestedQuantity: 1,
        unit: 'units',
      },
    ];

    expect(() => {
      service.prepareAllocation({
        commitment,
        fulfillments: [fulfillment],
        residentDemands: demands,
      });
    }).toThrow(AllocationValidationError);
  });

  it('F. fails closed when fulfillment line matching is ambiguous', () => {
    const commitment = createCommitment('commit_ambiguous_test', [
      {
        lineNumber: 1,
        productId: null,
        productName: 'Harpic',
        requestedQuantity: 2,
        committedQuantity: 2,
        unitPrice: 50,
        lineSubtotal: 100,
        unit: 'packs',
      },
    ]);

    // Two ambiguous fulfillment lines matching "Harpic"
    const fulfillment = createFulfillment('ful_ambiguous', commitment.id, [
      {
        lineNumber: 1,
        productId: null,
        productName: 'Harpic',
        requestedQuantity: 2,
        fulfilledQuantity: 2,
        unit: 'packs',
      },
      {
        lineNumber: 2,
        productId: null,
        productName: 'Harpic',
        requestedQuantity: 2,
        fulfilledQuantity: 2,
        unit: 'packs',
      },
    ]);

    const demands: ResidentDemand[] = [
      {
        residentOrderId: 'ro_ambiguous_1',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: '',
        productName: 'Harpic',
        requestedQuantity: 2,
        unit: 'packs',
      },
      {
        residentOrderId: 'ro_ambiguous_2',
        residentId: 'res_2',
        residentReference: 'Flat 202',
        productId: '',
        productName: 'Other Item',
        requestedQuantity: 1,
        unit: 'units',
      },
    ];

    expect(() => {
      service.prepareAllocation({
        commitment,
        fulfillments: [fulfillment],
        residentDemands: demands,
      });
    }).toThrow('AMBIGUOUS_FULFILLMENT_LINE');
  });

  // ---------------------------------------------------------------------------
  // Condition G: Existing single-item legacy allocation continues to work
  // ---------------------------------------------------------------------------
  it('G. preserves existing single-item legacy allocation behavior', () => {
    const singleCommitment: ProcurementCommitment = {
      id: 'commit_legacy_single',
      rfqId: 'rfq_single',
      supplierIds: ['sup_single'],
      selectedQuoteIds: ['quote_single'],
      purchaseOrderIds: ['po_single'],
      status: 'CONFIRMED',
      product: {
        productId: 'prod_dynamic',
        productName: 'Sugar M30',
        unit: 'kg',
      },
      financials: {
        subtotal: 100,
        tax: 5,
        deliveryFee: 10,
        otherCharges: 0,
        total: 115,
        currency: 'INR',
      },
      allocations: [],
      idempotencyKey: 'idemp_single',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const singleFulfillment: FulfillmentOrder = {
      id: 'ful_single',
      purchaseOrderId: 'po_single',
      commitmentId: 'commit_legacy_single',
      supplierId: 'sup_single',
      supplierName: 'Sugar Supplier',
      fulfillmentType: 'PHYSICAL_GOODS',
      status: 'VERIFIED',
      productName: 'Sugar M30',
      requestedQuantity: 2,
      fulfilledQuantity: 2,
      remainingQuantity: 0,
      unit: 'kg',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const singleDemand: ResidentDemand[] = [
      {
        residentOrderId: 'ro_single_legacy',
        residentId: 'res_1',
        residentReference: 'Flat 101',
        productId: 'prod_dynamic',
        productName: 'Sugar M30',
        requestedQuantity: 2,
        unit: 'kg',
      },
    ];

    const summary = service.prepareAllocation({
      commitment: singleCommitment,
      fulfillments: [singleFulfillment],
      residentDemands: singleDemand,
    });

    expect(summary.allocations).toHaveLength(1);
    expect(summary.allocations[0].allocatedQuantity).toBe(2);
    expect(summary.allocations[0].totalAmount).toBe(115);

    expect(() => {
      service.validateAllocation('commit_legacy_single');
    }).not.toThrow();
  });
});
