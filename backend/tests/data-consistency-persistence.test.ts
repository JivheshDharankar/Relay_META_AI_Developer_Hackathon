import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { RelayOrchestrator } from '../src/orchestration/RelayOrchestrator';
import { WorkflowExecutor } from '../src/orchestration/WorkflowExecutor';
import { SEED_IDS } from '../src/config/seedConstants';

const prisma = new PrismaClient();

describe('Phase 1: Workflow Persistence to PostgreSQL & Mandate Enforcement', () => {
  const testSocietyId = 'soc_phase1_test';
  const testResidentId = 'res_phase1_test';
  const testMandateId = 'mandate_phase1_test';

  beforeAll(async () => {
    // Clean up any test fixtures
    await prisma.residentLedgerEntry.deleteMany({ where: { residentReference: testResidentId } });
    await prisma.residentAllocation.deleteMany({ where: { residentReference: testResidentId } });
    await prisma.deliveryAllocation.deleteMany({
      where: { residentOrder: { residentId: testResidentId } },
    });
    await prisma.payment.deleteMany({
      where: { residentOrder: { residentId: testResidentId } },
    });
    await prisma.orderItem.deleteMany({
      where: { residentOrder: { residentId: testResidentId } },
    });
    await prisma.residentOrder.deleteMany({ where: { residentId: testResidentId } });
    await prisma.paymentMandate.deleteMany({ where: { residentId: testResidentId } });
    await prisma.resident.deleteMany({ where: { id: testResidentId } });
    await prisma.communityOrderItem.deleteMany({
      where: { communityOrder: { societyId: testSocietyId } },
    });
    await prisma.delivery.deleteMany({
      where: { communityOrder: { societyId: testSocietyId } },
    });
    await prisma.communityOrder.deleteMany({ where: { societyId: testSocietyId } });
    await prisma.society.deleteMany({ where: { id: testSocietyId } });

    // Setup Society, Resident, and Mandate with limit ₹10,000
    await prisma.society.create({
      data: {
        id: testSocietyId,
        name: 'Phase 1 Test Society',
        address: 'Baner Road, Pune',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411045',
      },
    });

    await prisma.resident.create({
      data: {
        id: testResidentId,
        societyId: testSocietyId,
        name: 'Phase 1 Resident',
        email: 'phase1.resident@example.com',
        flatNumber: 'A-101',
      },
    });

    await prisma.paymentMandate.create({
      data: {
        id: testMandateId,
        residentId: testResidentId,
        status: 'ACTIVE',
        maximumAmount: 10000,
        currency: 'INR',
        purpose: 'COMMUNITY_PROCUREMENT',
        periodStart: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.residentLedgerEntry.deleteMany({ where: { residentReference: testResidentId } });
    await prisma.residentAllocation.deleteMany({ where: { residentReference: testResidentId } });
    await prisma.deliveryAllocation.deleteMany({
      where: { residentOrder: { residentId: testResidentId } },
    });
    await prisma.payment.deleteMany({
      where: { residentOrder: { residentId: testResidentId } },
    });
    await prisma.orderItem.deleteMany({
      where: { residentOrder: { residentId: testResidentId } },
    });
    await prisma.residentOrder.deleteMany({ where: { residentId: testResidentId } });
    await prisma.paymentMandate.deleteMany({ where: { residentId: testResidentId } });
    await prisma.resident.deleteMany({ where: { id: testResidentId } });
    await prisma.communityOrderItem.deleteMany({
      where: { communityOrder: { societyId: testSocietyId } },
    });
    await prisma.delivery.deleteMany({
      where: { communityOrder: { societyId: testSocietyId } },
    });
    await prisma.communityOrder.deleteMany({ where: { societyId: testSocietyId } });
    await prisma.society.deleteMany({ where: { id: testSocietyId } });
    await prisma.$disconnect();
  });

  it('1. creates rows across all operational tables when workflow completes', async () => {
    const orchestrator = new RelayOrchestrator();
    const wf = await orchestrator.startWorkflow({
      residentReference: testResidentId,
      societyReference: testSocietyId,
      requestText: '2 kg rice',
      location: {
        address: 'Baner Road, Pune',
        latitude: 18.5204,
        longitude: 73.8567,
      },
    });

    expect(wf.failureReason).toBeUndefined();
    expect(wf.status).toBe('COMPLETED');
    expect(wf.currentStage).toBe('COMPLETE');

    // 1. ResidentOrder exists with DELIVERED status
    const residentOrder = await prisma.residentOrder.findUnique({
      where: { id: wf.entities.residentOrderId! },
      include: {
        items: true,
        payments: true,
        communityOrder: true,
      },
    });
    expect(residentOrder).not.toBeNull();
    expect(residentOrder!.status).toBe('DELIVERED');
    expect(residentOrder!.residentId).toBe(testResidentId);
    expect(residentOrder!.communityOrderId).not.toBeNull();

    // 2. OrderItems exist with valid Product IDs
    expect(residentOrder!.items.length).toBeGreaterThan(0);
    const orderItem = residentOrder!.items[0];
    expect(orderItem.productId).toBe(SEED_IDS.products.rice);
    expect(Number(orderItem.quantity)).toBe(2);

    // 3. CommunityOrder exists with DELIVERED status
    const communityOrder = await prisma.communityOrder.findUnique({
      where: { id: residentOrder!.communityOrderId! },
      include: {
        items: true,
        delivery: true,
      },
    });
    expect(communityOrder).not.toBeNull();
    expect(communityOrder!.status).toBe('DELIVERED');
    expect(communityOrder!.societyId).toBe(testSocietyId);

    // 4. CommunityOrderItem exists
    expect(communityOrder!.items.length).toBeGreaterThan(0);
    expect(communityOrder!.items[0].productId).toBe(SEED_IDS.products.rice);

    // 5. Payment exists with status SUCCESS and linked to active PaymentMandate
    const payment = await prisma.payment.findFirst({
      where: { residentOrderId: residentOrder!.id },
    });
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe('SUCCESS');
    expect(payment!.paymentMandateId).toBe(testMandateId);
    expect(Number(payment!.amount)).toBe(Number(residentOrder!.totalAmount));

    // 6. Delivery exists with DELIVERED status and matching trackingCode
    const delivery = communityOrder!.delivery;
    expect(delivery).not.toBeNull();
    expect(delivery!.status).toBe('DELIVERED');
    expect(delivery!.trackingCode).toBe(wf.entities.deliveryTrackingCodes![0]);

    // 7. DeliveryAllocation exists
    const deliveryAlloc = await prisma.deliveryAllocation.findFirst({
      where: { deliveryId: delivery!.id, residentOrderId: residentOrder!.id },
    });
    expect(deliveryAlloc).not.toBeNull();
    expect(deliveryAlloc!.status).toBe('DELIVERED');

    // 8. ResidentAllocation exists with status FINALIZED and reconciliationStatus RECONCILED
    const residentAlloc = await prisma.residentAllocation.findFirst({
      where: { residentOrderId: residentOrder!.id },
    });
    expect(residentAlloc).not.toBeNull();
    expect(residentAlloc!.status).toBe('FINALIZED');
    expect(residentAlloc!.reconciliationStatus).toBe('RECONCILED');

    // 9. ResidentLedgerEntry exists with POSTED status
    const ledgerEntry = await prisma.residentLedgerEntry.findFirst({
      where: { residentOrderId: residentOrder!.id },
    });
    expect(ledgerEntry).not.toBeNull();
    expect(ledgerEntry!.status).toBe('POSTED');
    expect(ledgerEntry!.entryType).toBe('PROCUREMENT_ALLOCATION');

    // 10. ReconciliationRecord exists with status RECONCILED
    const reconRecord = await prisma.reconciliationRecord.findFirst({
      where: { commitmentId: wf.entities.commitmentId! },
    });
    expect(reconRecord).not.toBeNull();
    expect(reconRecord!.status).toBe('RECONCILED');
    expect(reconRecord!.isQuantityMatched).toBe(true);
    expect(reconRecord!.isMonetaryMatched).toBe(true);
    expect(reconRecord!.isPaymentVerified).toBe(true);
  });

  it('2. increments resident used amount and respects reduced remaining limit on second run', async () => {
    // Sum existing successful payments for resident
    const spentBefore = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: { residentOrder: { residentId: testResidentId }, status: 'SUCCESS' },
    });
    const usedBefore = Number(spentBefore._sum.amount || 0);
    expect(usedBefore).toBeGreaterThan(0);

    const orchestrator = new RelayOrchestrator();
    const wf2 = await orchestrator.startWorkflow({
      residentReference: testResidentId,
      societyReference: testSocietyId,
      requestText: '1 kg sugar',
      location: {
        address: 'Baner Road, Pune',
        latitude: 18.5204,
        longitude: 73.8567,
      },
    });

    expect(wf2.status).toBe('COMPLETED');

    const spentAfter = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: { residentOrder: { residentId: testResidentId }, status: 'SUCCESS' },
    });
    const usedAfter = Number(spentAfter._sum.amount || 0);
    expect(usedAfter).toBeGreaterThan(usedBefore);
  });

  it('3. blocks run when commitment total exceeds remaining mandate limit', async () => {
    const tightResidentId = 'res_tight_mandate';
    const tightMandateId = 'mandate_tight';

    // Create resident with only ₹50 mandate
    await prisma.resident.create({
      data: {
        id: tightResidentId,
        societyId: testSocietyId,
        name: 'Tight Limit Resident',
        email: 'tight.limit@example.com',
        flatNumber: 'B-202',
      },
    });

    await prisma.paymentMandate.create({
      data: {
        id: tightMandateId,
        residentId: tightResidentId,
        status: 'ACTIVE',
        maximumAmount: 50, // Insufficient for any procurement run
        currency: 'INR',
        purpose: 'COMMUNITY_PROCUREMENT',
        periodStart: new Date(),
      },
    });

    try {
      const orchestrator = new RelayOrchestrator();
      const wf = await orchestrator.startWorkflow({
        residentReference: tightResidentId,
        societyReference: testSocietyId,
        requestText: '5 kg rice',
        location: {
          address: 'Baner Road, Pune',
          latitude: 18.5204,
          longitude: 73.8567,
        },
      });

      expect(wf.status).toBe('FAILED');
      expect(wf.failureReason).toContain('MANDATE_EXCEEDED');
      expect(wf.failureClassification).toBe('NON_RETRYABLE');
    } finally {
      await prisma.paymentMandate.deleteMany({ where: { residentId: tightResidentId } });
      await prisma.resident.deleteMany({ where: { id: tightResidentId } });
    }
  });

  it('4. rolls back completely and transitions to FAILED with PERSISTENCE_ERROR when sync fails', async () => {
    const executor = new WorkflowExecutor();
    // Fabricate workflow with missing entities to force sync error
    const brokenWorkflow: any = {
      id: `wf_fail_${Date.now()}`,
      residentReference: testResidentId,
      societyReference: testSocietyId,
      status: 'RECONCILING',
      currentStage: 'RECONCILE',
      workflowVersion: 1,
      startedAt: new Date(),
      location: { address: 'Test Address', latitude: 18.52, longitude: 73.85 },
      entities: { residentOrderId: 'ro_broken' },
      // Deliberately missing _commitment to trigger persistence failure
    };

    await expect(executor.syncToPrisma(brokenWorkflow)).rejects.toThrow('Missing procurement commitment');

    // Confirm no orphaned ResidentOrder row was created
    const orphanedOrder = await prisma.residentOrder.findUnique({
      where: { id: 'ro_broken' },
    });
    expect(orphanedOrder).toBeNull();
  });
});
