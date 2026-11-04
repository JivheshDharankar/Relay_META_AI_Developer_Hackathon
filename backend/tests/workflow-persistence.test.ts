import { describe, it, expect, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { RelayOrchestrator } from '../src/orchestration/RelayOrchestrator';
import { workflowPersistenceService } from '../src/orchestration/WorkflowPersistenceService';
import { prisma } from '../src/config/prisma';
import { mandateService } from '../src/payment/mandate/MandateService';

const direct = new PrismaClient();
const createdWorkflowIds: string[] = [];

afterEach(async () => {
  for (const id of createdWorkflowIds.splice(0)) {
    await direct.relayWorkflow.deleteMany({ where: { id } }).catch(() => {});
  }
  vi.restoreAllMocks();
});

async function waitForRow<T>(fn: () => Promise<T | null>, label: string): Promise<T> {
  await vi.waitFor(
    async () => {
      const row = await fn();
      expect(row, label).not.toBeNull();
    },
    { timeout: 5000, interval: 50 }
  );
  return (await fn()) as T;
}

describe('Workflow durable persistence (§2 mission persistence)', () => {
  it('1. submitRequest persists the DRAFT mission row before returning', async () => {
    const orchestrator = new RelayOrchestrator();
    const wf = await orchestrator.submitRequest({
      residentReference: 'res_persist_1',
      societyReference: 'soc_persist_1',
      requestText: '2 kg rice',
      location: { latitude: 18.5204, longitude: 73.8567 },
    });
    createdWorkflowIds.push(wf.id);

    const row = await direct.relayWorkflow.findUnique({ where: { id: wf.id } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('DRAFT');
    expect(row!.currentStage).toBe('UNDERSTAND');
    expect(row!.requestText).toBe('2 kg rice');
    expect(row!.residentReference).toBe('res_persist_1');
    expect(row!.societyReference).toBe('soc_persist_1');
  });

  it('2. every executed step updates the durable status/stage', async () => {
    const orchestrator = new RelayOrchestrator();
    const wf = await orchestrator.createWorkflow({
      requestText: '5 Dairy Milk',
      location: { latitude: 18.5204, longitude: 73.8567 },
    });
    createdWorkflowIds.push(wf.id);

    const stepped = await orchestrator.executeWorkflowStep(wf.id);
    expect(stepped.status).toBe('DEMAND_CREATED');

    const row = await direct.relayWorkflow.findUnique({ where: { id: wf.id } });
    expect(row!.status).toBe('DEMAND_CREATED');
    expect(row!.currentStage).toBe(stepped.currentStage);
  });

  it('2b. the autonomous loop persists the terminal row (not just single steps)', async () => {
    // Real mandate fixture: PAY never auto-creates consent.
    mandateService.createMandate({
      ownerReference: 'res_persist_2b',
      purpose: 'COMMUNITY_PROCUREMENT',
      spendingLimit: 1000000,
      currency: 'INR',
    });
    const orchestrator = new RelayOrchestrator();
    const wf = await orchestrator.startWorkflow({
      requestText: '5 Dairy Milk',
      location: { latitude: 18.5204, longitude: 73.8567 },
      residentReference: 'res_persist_2b',
    });
    createdWorkflowIds.push(wf.id);
    expect(wf.status).toBe('COMPLETED');

    const row = await direct.relayWorkflow.findUnique({ where: { id: wf.id } });
    expect(row!.status).toBe('COMPLETED');
    expect(row!.currentStage).toBe('COMPLETE');
    expect(row!.completedAt).not.toBeNull();
  });

  it('3. audit events land in the durable event table', async () => {
    const orchestrator = new RelayOrchestrator();
    const wf = await orchestrator.submitRequest({
      requestText: '1 kg sugar',
      location: { latitude: 18.5204, longitude: 73.8567 },
    });
    createdWorkflowIds.push(wf.id);

    const event = await waitForRow(
      () =>
        direct.relayWorkflowEvent.findFirst({
          where: { workflowId: wf.id, eventName: 'WORKFLOW_CREATED' },
        }),
      'WORKFLOW_CREATED event row'
    );
    expect(event.stage).toBe('UNDERSTAND');
  });

  it('4. checkpoints land with a full rehydratable snapshot', async () => {
    const orchestrator = new RelayOrchestrator();
    const wf = await orchestrator.submitRequest({
      requestText: '2 packs Maggi',
      location: { latitude: 18.5204, longitude: 73.8567 },
    });
    createdWorkflowIds.push(wf.id);

    const checkpoint = await waitForRow(
      () => direct.relayWorkflowCheckpoint.findFirst({ where: { workflowId: wf.id } }),
      'checkpoint row'
    );
    const snapshot = checkpoint.stateSnapshot as Record<string, unknown>;
    expect(snapshot['id']).toBe(wf.id);
    expect(snapshot['requestText']).toBe('2 packs Maggi');
    expect(Array.isArray(snapshot['stages'])).toBe(true);
  });

  it('5. a fresh orchestrator restores a mid-run mission from the durable record', async () => {
    const first = new RelayOrchestrator();
    const wf = await first.createWorkflow({
      residentReference: 'res_restart_5',
      requestText: '5 Dairy Milk',
      location: { latitude: 18.5204, longitude: 73.8567 },
    });
    createdWorkflowIds.push(wf.id);
    const stepped = await first.executeWorkflowStep(wf.id);
    expect(stepped.status).toBe('DEMAND_CREATED');

    // Simulate a backend restart: brand-new orchestrator, empty registries.
    const restarted = new RelayOrchestrator();
    expect(restarted.getWorkflow(wf.id)).toBeUndefined();
    const restored = await restarted.restoreWorkflow(wf.id);

    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(wf.id);
    expect(restored!.status).toBe('DEMAND_CREATED');
    expect(restored!.currentStage).toBe(stepped.currentStage);
    expect(restored!.requestText).toBe('5 Dairy Milk');
    expect(restored!.residentReference).toBe('res_restart_5');
    expect(restored!.entities.supplierCandidateIds).toEqual(
      stepped.entities.supplierCandidateIds
    );
    expect(restored!.startedAt instanceof Date).toBe(true);
    expect(restored!.updatedAt instanceof Date).toBe(true);
    // Registered live: execution can continue from the restored state.
    expect(restarted.getWorkflow(wf.id)?.id).toBe(wf.id);
  });

  it('6. restore returns null for unknown missions, live instances as-is', async () => {
    const orchestrator = new RelayOrchestrator();
    await expect(orchestrator.restoreWorkflow('wf_does_not_exist')).resolves.toBeNull();

    const wf = await orchestrator.submitRequest({
      requestText: '1 kg sugar',
      location: { latitude: 18.5204, longitude: 73.8567 },
    });
    createdWorkflowIds.push(wf.id);
    await expect(orchestrator.restoreWorkflow(wf.id)).resolves.toBe(wf);
  });

  it('7. corrupt durable snapshots refuse to load instead of resuming wrong state', async () => {
    const id = `wf_corrupt_${Date.now()}`;
    createdWorkflowIds.push(id);
    await direct.relayWorkflow.create({
      data: {
        id,
        residentReference: 'res_x',
        societyReference: 'soc_x',
        requestText: 'corrupt',
        status: 'UNDERSTANDING',
        currentStage: 'UNDERSTAND',
        workflowVersion: 1,
        startedAt: new Date(),
      },
    });
    await direct.relayWorkflowCheckpoint.create({
      data: {
        workflowId: id,
        stage: 'UNDERSTAND',
        status: 'UNDERSTANDING',
        entityIds: {},
        stateSnapshot: { id: 'wf_WRONG_ID', requestText: 'tampered' },
        workflowVersion: 1,
      },
    });

    await expect(workflowPersistenceService.loadWorkflowSnapshot(id)).rejects.toThrow(
      /Corrupt durable workflow snapshot/
    );
  });

  it('8. a persistence outage never fails live procurement', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(prisma.relayWorkflow, 'upsert').mockRejectedValueOnce(new Error('DB down'));

    const orchestrator = new RelayOrchestrator();
    const wf = await orchestrator.submitRequest({
      requestText: '2 kg rice',
      location: { latitude: 18.5204, longitude: 73.8567 },
    });
    createdWorkflowIds.push(wf.id);

    expect(wf.id).toMatch(/^wf_/);
    expect(orchestrator.getWorkflow(wf.id)?.requestText).toBe('2 kg rice');
    expect(console.warn).toHaveBeenCalled();
  });
});
