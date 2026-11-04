import { describe, it, expect } from 'vitest';
import { resolveDatabaseUrl } from '../src/config/prisma';
import { WorkflowExecutor } from '../src/orchestration/WorkflowExecutor';
import { RelayWorkflow } from '../src/orchestration/stateMachine';

describe('Defect 01: Test Database Isolation & Protection', () => {
  it('strictly rejects connecting to the live demo database (relay_db) in test environment', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalTestDb = process.env.TEST_DATABASE_URL;

    try {
      process.env.NODE_ENV = 'test';
      process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/relay_db';

      expect(() => resolveDatabaseUrl()).toThrowError(
        /TEST_DATABASE_ISOLATION_VIOLATION.*relay_db/
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      process.env.TEST_DATABASE_URL = originalTestDb;
    }
  });

  it('resolves dedicated TEST_DATABASE_URL in test environment', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalTestDb = process.env.TEST_DATABASE_URL;

    try {
      process.env.NODE_ENV = 'test';
      process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/relay_test';

      const url = resolveDatabaseUrl();
      expect(url).toBe('postgresql://postgres:postgres@localhost:5432/relay_test');
      expect(url).not.toContain('/relay_db');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      process.env.TEST_DATABASE_URL = originalTestDb;
    }
  });

  it('blocks fallback to demo database when TEST_DATABASE_URL is unset', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    try {
      process.env.NODE_ENV = 'test';
      const url = resolveDatabaseUrl(null);
      expect(url).toBe('postgresql://isolated_test_guard:blocked@localhost:5432/blocked_test_db');
      expect(url).not.toContain('relay_db');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('WorkflowExecutor.syncToPrisma halts before writing if pointed at demo database in test mode', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalDbUrl = process.env.DATABASE_URL;
    const originalTestDb = process.env.TEST_DATABASE_URL;

    try {
      process.env.NODE_ENV = 'test';
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/relay_db';
      process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/relay_db';

      const executor = new WorkflowExecutor();
      const mockWorkflow = {
        id: 'wf_test_guard',
        _commitment: { id: 'comm_123', totalAmount: 100 },
      } as unknown as RelayWorkflow;

      await expect(executor.syncToPrisma(mockWorkflow)).rejects.toThrowError(
        /TEST_DATABASE_ISOLATION_VIOLATION/
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      process.env.DATABASE_URL = originalDbUrl;
      process.env.TEST_DATABASE_URL = originalTestDb;
    }
  });
});
