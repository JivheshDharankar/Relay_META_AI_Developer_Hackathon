import { app } from './app';
import { env } from './config/env';
import { assertPilotReadiness } from './config/pilotReadiness';

if (env.RELAY_RUNTIME_MODE === 'pilot') {
  assertPilotReadiness();
}
import { disconnectPrisma } from './config/prisma';
import { relayOrchestrator } from './orchestration';
import { StaleWorkflowSweeper } from './resilience/StaleWorkflowService';

const server = app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[Relay Backend] Server running on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Detection-only stale-mission sweeper (see StaleWorkflowSweeper): flags
// stuck missions for operators, never mutates them.
const staleSweeper = new StaleWorkflowSweeper(relayOrchestrator);
staleSweeper.start();

async function gracefulShutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`[Relay Backend] Received ${signal}. Closing HTTP server...`);
  staleSweeper.stop();
  server.close(async () => {
    // eslint-disable-next-line no-console
    console.log('[Relay Backend] HTTP server closed.');
    try {
      await disconnectPrisma();
      // eslint-disable-next-line no-console
      console.log('[Relay Backend] Database disconnected. Exiting cleanly.');
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Relay Backend] Error disconnecting database during shutdown:', err);
      process.exit(1);
    }
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

