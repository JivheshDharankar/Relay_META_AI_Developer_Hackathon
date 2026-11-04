import { describe, it, expect, beforeEach } from 'vitest';
import {
  CostAllocationService,
  LineCostInput,
  ProcurementFinancialsInput,
} from '../src/allocation/CostAllocationService';
import { QuantityAllocationResultItem } from '../src/allocation/AllocationEngine';

describe('CostAllocationService & AllocationService Line-Matching Remediation Suite', () => {
  let costService: CostAllocationService;

  beforeEach(() => {
    costService = new CostAllocationService();
  });

  // Production data fixtures from RUN-C3580C34
  const residentOrderId = 'ro_d28de265';
  const residentReference = 'Flat 402';

  const line0_egg: LineCostInput = {
    demandLineId: 'dl_egg_01',
    residentOrderId,
    productId: 'prod_egg',
    productName: 'Farm Fresh Eggs (pack of 12)',
    unitPrice: 84.65,
    subtotal: 3047.40,
    tax: 152.37,
    deliveryFee: 28.16,
    otherCharges: 0,
  };

  const line1_banana: LineCostInput = {
    demandLineId: 'dl_banana_02',
    residentOrderId,
    productId: 'prod_banana',
    productName: 'Fresh Banana Robusta',
    unitPrice: 39.50,
    subtotal: 158.00,
    tax: 7.90,
    deliveryFee: 1.46,
    otherCharges: 0,
  };

  const line2_atta: LineCostInput = {
    demandLineId: 'dl_atta_03',
    residentOrderId,
    productId: 'prod_atta',
    productName: 'Chakki Fresh Atta',
    unitPrice: 64.20,
    subtotal: 449.40,
    tax: 22.47,
    deliveryFee: 4.15,
    otherCharges: 0,
  };

  const line3_rice: LineCostInput = {
    demandLineId: 'dl_rice_04',
    residentOrderId,
    productId: 'prod_rice',
    productName: 'Indrayani Rice',
    unitPrice: 82.27,
    subtotal: 1645.40,
    tax: 82.27,
    deliveryFee: 15.21,
    otherCharges: 0,
  };

  const prodLineCosts: LineCostInput[] = [
    line0_egg,
    line1_banana,
    line2_atta,
    line3_rice,
  ];

  const prodFinancials: ProcurementFinancialsInput = {
    subtotal: 5300.20,
    tax: 265.01,
    deliveryFee: 48.98,
    otherCharges: 0,
    total: 5614.19,
    lineCosts: prodLineCosts,
  };

  const prodQuantityAllocations: QuantityAllocationResultItem[] = [
    {
      residentOrderId,
      residentReference,
      demandLineId: 'dl_egg_01',
      requestedQuantity: 36,
      allocatedQuantity: 36,
    },
    {
      residentOrderId,
      residentReference,
      demandLineId: 'dl_banana_02',
      requestedQuantity: 4,
      allocatedQuantity: 4,
    },
    {
      residentOrderId,
      residentReference,
      demandLineId: 'dl_atta_03',
      requestedQuantity: 7,
      allocatedQuantity: 7,
    },
    {
      residentOrderId,
      residentReference,
      demandLineId: 'dl_rice_04',
      requestedQuantity: 20,
      allocatedQuantity: 20,
    },
  ];

  // ---------------------------------------------------------------------------
  // Condition 1 & 2: 4 lines with same residentOrderId and distinct demandLineIds
  // ---------------------------------------------------------------------------
  it('1 & 2. correctly matches 4 lines sharing the same residentOrderId to exact line costs without negative values', () => {
    const allocations = costService.allocateCosts(prodQuantityAllocations, prodFinancials);

    expect(allocations).toHaveLength(4);

    const eggAlloc = allocations.find((a) => a.demandLineId === 'dl_egg_01');
    const bananaAlloc = allocations.find((a) => a.demandLineId === 'dl_banana_02');
    const attaAlloc = allocations.find((a) => a.demandLineId === 'dl_atta_03');
    const riceAlloc = allocations.find((a) => a.demandLineId === 'dl_rice_04');

    expect(eggAlloc).toBeDefined();
    expect(bananaAlloc).toBeDefined();
    expect(attaAlloc).toBeDefined();
    expect(riceAlloc).toBeDefined();

    // Verify exact line cost mapping
    expect(eggAlloc!.subtotal).toBe(3047.40);
    expect(eggAlloc!.allocatedTax).toBe(152.37);
    expect(eggAlloc!.allocatedDeliveryFee).toBe(28.16);
    expect(eggAlloc!.totalAmount).toBe(3227.93);

    expect(bananaAlloc!.subtotal).toBe(158.00);
    expect(bananaAlloc!.allocatedTax).toBe(7.90);
    expect(bananaAlloc!.allocatedDeliveryFee).toBe(1.46);
    expect(bananaAlloc!.totalAmount).toBe(167.36);

    expect(attaAlloc!.subtotal).toBe(449.40);
    expect(attaAlloc!.allocatedTax).toBe(22.47);
    expect(attaAlloc!.allocatedDeliveryFee).toBe(4.15);
    expect(attaAlloc!.totalAmount).toBe(476.02);

    expect(riceAlloc!.subtotal).toBe(1645.40);
    expect(riceAlloc!.allocatedTax).toBe(82.27);
    expect(riceAlloc!.allocatedDeliveryFee).toBe(15.21);
    expect(riceAlloc!.totalAmount).toBe(1742.88);

    // Verify totals match authoritative financials exactly to the paise
    const totalSubtotal = allocations.reduce((sum, a) => sum + a.subtotal, 0);
    const totalTax = allocations.reduce((sum, a) => sum + a.allocatedTax, 0);
    const totalDelivery = allocations.reduce((sum, a) => sum + a.allocatedDeliveryFee, 0);
    const grandTotal = allocations.reduce((sum, a) => sum + a.totalAmount, 0);

    expect(Math.round(totalSubtotal * 100)).toBe(Math.round(prodFinancials.subtotal * 100));
    expect(Math.round(totalTax * 100)).toBe(Math.round(prodFinancials.tax * 100));
    expect(Math.round(totalDelivery * 100)).toBe(Math.round(prodFinancials.deliveryFee * 100));
    expect(Math.round(grandTotal * 100)).toBe(Math.round(prodFinancials.total * 100));

    // Zero negative values
    for (const alloc of allocations) {
      expect(alloc.subtotal).toBeGreaterThan(0);
      expect(alloc.allocatedTax).toBeGreaterThan(0);
      expect(alloc.allocatedDeliveryFee).toBeGreaterThan(0);
      expect(alloc.totalAmount).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Condition 3: Reordered financial line costs still match correctly by demandLineId
  // ---------------------------------------------------------------------------
  it('3. reordered financial line costs still match correctly by demandLineId', () => {
    // Reverse line costs order
    const reorderedLineCosts = [...prodLineCosts].reverse();
    const reorderedFinancials: ProcurementFinancialsInput = {
      ...prodFinancials,
      lineCosts: reorderedLineCosts,
    };

    const allocations = costService.allocateCosts(prodQuantityAllocations, reorderedFinancials);

    const eggAlloc = allocations.find((a) => a.demandLineId === 'dl_egg_01');
    const bananaAlloc = allocations.find((a) => a.demandLineId === 'dl_banana_02');
    const attaAlloc = allocations.find((a) => a.demandLineId === 'dl_atta_03');
    const riceAlloc = allocations.find((a) => a.demandLineId === 'dl_rice_04');

    expect(eggAlloc!.subtotal).toBe(3047.40);
    expect(bananaAlloc!.subtotal).toBe(158.00);
    expect(attaAlloc!.subtotal).toBe(449.40);
    expect(riceAlloc!.subtotal).toBe(1645.40);
  });

  // ---------------------------------------------------------------------------
  // Condition 4: Multi-item allocations fail closed if demandLineId is missing or ambiguous
  // ---------------------------------------------------------------------------
  it('4. fails closed if demandLineId is missing on multi-item allocations', () => {
    const corruptAllocations: QuantityAllocationResultItem[] = [
      ...prodQuantityAllocations.slice(0, 3),
      {
        ...prodQuantityAllocations[3],
        demandLineId: undefined, // missing
      },
    ];

    expect(() => {
      costService.allocateCosts(corruptAllocations, prodFinancials);
    }).toThrow('DEMAND_LINE_COST_UNMATCHED');
  });

  it('4. fails closed if demandLineId has ambiguous matches in lineCosts', () => {
    const ambiguousLineCosts: LineCostInput[] = [
      ...prodLineCosts,
      {
        ...line0_egg,
        // Duplicate demandLineId
        demandLineId: 'dl_egg_01',
      },
    ];

    const ambiguousFinancials: ProcurementFinancialsInput = {
      ...prodFinancials,
      lineCosts: ambiguousLineCosts,
    };

    expect(() => {
      costService.allocateCosts(prodQuantityAllocations, ambiguousFinancials);
    }).toThrow('DEMAND_LINE_COST_AMBIGUOUS');
  });

  // ---------------------------------------------------------------------------
  // Condition 5: Legitimate single-item legacy fallback still works
  // ---------------------------------------------------------------------------
  it('5. legitimate single-item legacy fallback works when demandLineId is omitted', () => {
    const singleQuantityAlloc: QuantityAllocationResultItem[] = [
      {
        residentOrderId: 'ro_legacy_01',
        residentReference: 'Flat 101',
        // demandLineId omitted
        requestedQuantity: 2,
        allocatedQuantity: 2,
      },
    ];

    const singleFinancials: ProcurementFinancialsInput = {
      subtotal: 100.00,
      tax: 5.00,
      deliveryFee: 10.00,
      otherCharges: 0,
      total: 115.00,
      lineCosts: [
        {
          residentOrderId: 'ro_legacy_01',
          productId: 'prod_sugar',
          productName: 'Sugar M30',
          unitPrice: 50.00,
          subtotal: 100.00,
          tax: 5.00,
          deliveryFee: 10.00,
          otherCharges: 0,
        },
      ],
    };

    const allocations = costService.allocateCosts(singleQuantityAlloc, singleFinancials);

    expect(allocations).toHaveLength(1);
    expect(allocations[0].subtotal).toBe(100.00);
    expect(allocations[0].allocatedTax).toBe(5.00);
    expect(allocations[0].allocatedDeliveryFee).toBe(10.00);
    expect(allocations[0].totalAmount).toBe(115.00);
  });

  // ---------------------------------------------------------------------------
  // Condition 6: RUN-C3580C34 exact production numbers pass without failure
  // ---------------------------------------------------------------------------
  it('6. RUN-C3580C34 exact production numbers pass without NEGATIVE_VALUE_REJECTED', () => {
    expect(() => {
      const res = costService.allocateCosts(prodQuantityAllocations, prodFinancials);
      expect(res.length).toBe(4);
      for (const item of res) {
        expect(item.subtotal).toBeGreaterThan(0);
        expect(item.allocatedTax).toBeGreaterThan(0);
        expect(item.allocatedDeliveryFee).toBeGreaterThan(0);
        expect(item.totalAmount).toBeGreaterThan(0);
      }
    }).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Condition 7: No line receives another product's price or subtotal
  // ---------------------------------------------------------------------------
  it('7. no line receives another product price or subtotal', () => {
    const allocations = costService.allocateCosts(prodQuantityAllocations, prodFinancials);

    const eggAlloc = allocations.find((a) => a.demandLineId === 'dl_egg_01')!;
    const bananaAlloc = allocations.find((a) => a.demandLineId === 'dl_banana_02')!;
    const attaAlloc = allocations.find((a) => a.demandLineId === 'dl_atta_03')!;
    const riceAlloc = allocations.find((a) => a.demandLineId === 'dl_rice_04')!;

    // Banana was previously getting egg's 3047.40
    expect(bananaAlloc.subtotal).toBe(158.00);
    expect(bananaAlloc.subtotal).not.toBe(eggAlloc.subtotal);
    expect(bananaAlloc.subtotal).not.toBe(attaAlloc.subtotal);
    expect(bananaAlloc.subtotal).not.toBe(riceAlloc.subtotal);

    // Rice subtotal must not be egg's or atta's
    expect(riceAlloc.subtotal).toBe(1645.40);
    expect(riceAlloc.subtotal).not.toBe(eggAlloc.subtotal);

    // Atta subtotal
    expect(attaAlloc.subtotal).toBe(449.40);
    expect(attaAlloc.subtotal).not.toBe(eggAlloc.subtotal);
  });
});
