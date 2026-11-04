import { PrismaClient } from '@prisma/client';
import { env } from './env';

export function resolveDatabaseUrl(overrideTestUrl?: string | null): string {
  const isTest = process.env.NODE_ENV === 'test' || env.NODE_ENV === 'test';
  if (isTest) {
    const testUrl =
      overrideTestUrl !== undefined
        ? (overrideTestUrl ?? undefined)
        : process.env.TEST_DATABASE_URL || env.TEST_DATABASE_URL;
    if (!testUrl) {
      // In test mode without TEST_DATABASE_URL, return an isolated sentinel URL
      // so queries fail closed and never touch the live demo database.
      return 'postgresql://isolated_test_guard:blocked@localhost:5432/blocked_test_db';
    }
    if (testUrl.includes('/relay_db')) {
      throw new Error(
        "TEST_DATABASE_ISOLATION_VIOLATION: TEST_DATABASE_URL cannot point to the live demo database ('relay_db')."
      );
    }
    return testUrl;
  }
  return env.DATABASE_URL;
}

const activeUrl = resolveDatabaseUrl();

// Synchronize process.env.DATABASE_URL so any direct Prisma or raw pg connections in tests use activeUrl
if (process.env.NODE_ENV === 'test' || env.NODE_ENV === 'test') {
  process.env.DATABASE_URL = activeUrl;
}

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasources: {
      db: {
        url: activeUrl,
      },
    },
    log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

