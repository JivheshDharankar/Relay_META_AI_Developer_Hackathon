import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { onboardFreshUser, FreshUser } from './helpers/onboardFreshUser';
import { relayOrchestrator } from '../src/orchestration/RelayOrchestrator';

describe('Defect 02: Run History & Deep Links Endpoints', () => {
  let userA: FreshUser;
  let userB: FreshUser;

  beforeAll(async () => {
    userA = await onboardFreshUser({
      emailPrefix: 'resident.alice',
      societyName: 'Greenview Society A',
      mandateLimit: 25000,
    });

    userB = await onboardFreshUser({
      emailPrefix: 'resident.bob',
      societyName: 'Greenview Society B',
      mandateLimit: 25000,
    });
  });

  it('allows workflow owner to fetch completed/in-flight run by workflow ID with canonical proof payload', async () => {
    const runId = 'RUN-A1B2C3D4';
    const wf = await relayOrchestrator.createWorkflow({
      requestText: '2 dozen eggs and 5 kg rice',
      residentReference: userA.residentId,
      societyReference: userA.societyId,
      metadata: { runId },
    });

    const res = await request(app)
      .get(`/api/agent/workflow/${wf.id}`)
      .set('Authorization', `Bearer ${userA.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.prompt).toBe('2 dozen eggs and 5 kg rice');
    expect(res.body.data.agentResponse).toBeDefined();
    expect(res.body.data.agentResponse.runId).toBe(runId);
    expect(res.body.data.agentResponse.steps).toBeInstanceOf(Array);
    expect(res.body.data.agentResponse.steps[0].toolCall.result.commercial).toBeDefined();
    expect(res.body.data.agentResponse.steps[0].toolCall.result.financialProof).toBeDefined();
    expect(res.body.data.agentResponse.steps[0].toolCall.result.sla).toBeDefined();
  });

  it('allows workflow owner to fetch via /runs/:id and RUN- prefix format', async () => {
    const runId = 'RUN-99887766';
    const wf = await relayOrchestrator.createWorkflow({
      requestText: '10 kg wheat flour',
      residentReference: userA.residentId,
      societyReference: userA.societyId,
      metadata: { runId },
    });

    const res = await request(app)
      .get(`/api/agent/runs/${runId}`)
      .set('Authorization', `Bearer ${userA.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.prompt).toBe('10 kg wheat flour');
    expect(res.body.data.agentResponse.runId).toBe(runId);
  });

  it('denies access (403 Forbidden) when another resident attempts to inspect the run', async () => {
    const wf = await relayOrchestrator.createWorkflow({
      requestText: 'Confidential resident procurement',
      residentReference: userA.residentId,
      societyReference: userA.societyId,
    });

    // User B tries to view User A's workflow
    const res = await request(app)
      .get(`/api/agent/workflow/${wf.id}`)
      .set('Authorization', `Bearer ${userB.token}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('returns 404 for non-existent mission identifier', async () => {
    const res = await request(app)
      .get('/api/agent/workflow/wf_definitely_nonexistent_999')
      .set('Authorization', `Bearer ${userA.token}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('requires authentication (401 Unauthorized) when token is missing', async () => {
    const res = await request(app).get('/api/agent/workflow/wf_any');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});
