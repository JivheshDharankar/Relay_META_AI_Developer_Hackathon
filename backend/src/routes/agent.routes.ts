import { Router } from 'express';
import { agentController } from '../controllers/agent.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { createRateLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

// POST /api/agent/run (session owner only: starts a money-moving mission)
router.post('/run', requireAuth, createRateLimiter('AGENT_RUN'), (req, res, next) => agentController.run(req, res, next));

// GET /api/agent/workflow/:id (session owner only: retrieves persisted/active mission)
router.get('/workflow/:id', requireAuth, (req, res, next) =>
  agentController.getWorkflow(req, res, next)
);

// GET /api/agent/runs/:id (alias for canonical run retrieval)
router.get('/runs/:id', requireAuth, (req, res, next) =>
  agentController.getWorkflow(req, res, next)
);

// POST /api/agent/workflow/:id/cancel (session owner only)
router.post('/workflow/:id/cancel', requireAuth, (req, res, next) =>
  agentController.cancelWorkflow(req, res, next)
);

// POST /api/agent/workflow/:id/restore (session owner only)
// Re-registers a mission from its durable record after a backend restart.
router.post('/workflow/:id/restore', requireAuth, (req, res, next) =>
  agentController.restoreWorkflow(req, res, next)
);

export const agentRoutes = router;

