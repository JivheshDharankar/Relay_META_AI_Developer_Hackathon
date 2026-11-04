import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { healthService } from '../src/services/health.service';
import { env } from '../src/config/env';

const TEST_DIAGNOSTIC_TOKEN = 'diag_token_super_secret_test_12345';

describe('POST /api/health/integrations (Production Diagnostics)', () => {
  const originalToken = env.INTEGRATION_DIAGNOSTIC_TOKEN;

  beforeEach(() => {
    (env as any).INTEGRATION_DIAGNOSTIC_TOKEN = TEST_DIAGNOSTIC_TOKEN;
    process.env.INTEGRATION_DIAGNOSTIC_TOKEN = TEST_DIAGNOSTIC_TOKEN;
  });

  afterEach(() => {
    (env as any).INTEGRATION_DIAGNOSTIC_TOKEN = originalToken;
    if (originalToken !== undefined) {
      process.env.INTEGRATION_DIAGNOSTIC_TOKEN = originalToken;
    } else {
      delete process.env.INTEGRATION_DIAGNOSTIC_TOKEN;
    }
    vi.restoreAllMocks();
  });

  describe('Authentication & Authorization Security', () => {
    it('returns 401 UNAUTHORIZED when Authorization header is missing', async () => {
      const res = await request(app).post('/api/health/integrations');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toHaveProperty('code', 'UNAUTHORIZED');
      expect(res.body).not.toHaveProperty('diagnostics');
    });

    it('returns 401 UNAUTHORIZED on /health/integrations alias when Authorization header is missing', async () => {
      const res = await request(app).post('/health/integrations');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toHaveProperty('code', 'UNAUTHORIZED');
    });

    it('returns 401 UNAUTHORIZED when Authorization scheme is not Bearer', async () => {
      const res = await request(app)
        .post('/api/health/integrations')
        .set('Authorization', `Basic ${TEST_DIAGNOSTIC_TOKEN}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toHaveProperty('code', 'UNAUTHORIZED');
    });

    it('returns 401 UNAUTHORIZED when Bearer token is incorrect', async () => {
      const res = await request(app)
        .post('/api/health/integrations')
        .set('Authorization', 'Bearer invalid_wrong_token');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toHaveProperty('code', 'UNAUTHORIZED');
    });

    it('fails closed with 401 when INTEGRATION_DIAGNOSTIC_TOKEN is unconfigured in environment', async () => {
      (env as any).INTEGRATION_DIAGNOSTIC_TOKEN = undefined;
      delete process.env.INTEGRATION_DIAGNOSTIC_TOKEN;

      const res = await request(app)
        .post('/api/health/integrations')
        .set('Authorization', `Bearer ${TEST_DIAGNOSTIC_TOKEN}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toHaveProperty('code', 'UNAUTHORIZED');
    });

    it('fails closed with 401 when INTEGRATION_DIAGNOSTIC_TOKEN is empty whitespace', async () => {
      (env as any).INTEGRATION_DIAGNOSTIC_TOKEN = '   ';
      process.env.INTEGRATION_DIAGNOSTIC_TOKEN = '   ';

      const res = await request(app)
        .post('/api/health/integrations')
        .set('Authorization', 'Bearer    ');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toHaveProperty('code', 'UNAUTHORIZED');
    });
  });

  describe('Diagnostic Execution & Parallel Settlement', () => {
    it('returns 200 with diagnostics when both probes succeed', async () => {
      const spy = vi.spyOn(healthService, 'testIntegrations').mockResolvedValueOnce({
        meta: {
          status: 'success',
          configured: true,
          model: 'muse-spark-1.3',
          detail: 'Meta Model API reachable (model=muse-spark-1.3); response: READY',
        },
        geoapify: {
          status: 'success',
          configured: true,
          suppliersCount: 3,
          detail: 'Successfully discovered 3 supplier candidate(s) in search radius.',
        },
      });

      const res = await request(app)
        .post('/api/health/integrations')
        .set('Authorization', `Bearer ${TEST_DIAGNOSTIC_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('diagnostics');

      // Meta assertions
      expect(res.body.diagnostics.meta).toEqual({
        status: 'success',
        configured: true,
        model: 'muse-spark-1.3',
        detail: 'Meta Model API reachable (model=muse-spark-1.3); response: READY',
      });

      // Geoapify assertions
      expect(res.body.diagnostics.geoapify).toEqual({
        status: 'success',
        configured: true,
        suppliersCount: 3,
        detail: 'Successfully discovered 3 supplier candidate(s) in search radius.',
      });

      // Never leak secrets
      const rawText = JSON.stringify(res.body);
      expect(rawText).not.toContain(TEST_DIAGNOSTIC_TOKEN);

      spy.mockRestore();
    });

    it('returns 200 and captures partial/unconfigured provider status via Promise.allSettled', async () => {
      const spy = vi.spyOn(healthService, 'testIntegrations').mockResolvedValueOnce({
        meta: {
          status: 'success',
          configured: true,
          model: 'muse-spark-1.3',
          detail: 'Meta Model API reachable; response: READY',
        },
        geoapify: {
          status: 'not_configured',
          configured: false,
          suppliersCount: 0,
          detail: 'Geoapify API key is required but not configured. Set GEOAPIFY_API_KEY in the environment.',
        },
      });

      const res = await request(app)
        .post('/api/health/integrations')
        .set('Authorization', `Bearer ${TEST_DIAGNOSTIC_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.diagnostics.meta.status).toBe('success');
      expect(res.body.diagnostics.geoapify.status).toBe('not_configured');
      expect(res.body.diagnostics.geoapify.configured).toBe(false);

      spy.mockRestore();
    });

    it('runs the actual healthService.testIntegrations() implementation safely without throwing', async () => {
      // Execute without mocks to verify real service instantiation and Promise.allSettled logic
      const result = await healthService.testIntegrations();

      expect(result).toHaveProperty('meta');
      expect(result).toHaveProperty('geoapify');
      expect(['success', 'error', 'not_configured']).toContain(result.meta.status);
      expect(['success', 'error', 'not_configured']).toContain(result.geoapify.status);
      expect(typeof result.meta.detail).toBe('string');
      expect(typeof result.geoapify.detail).toBe('string');
      expect(typeof result.geoapify.suppliersCount).toBe('number');
    });
  });
});
