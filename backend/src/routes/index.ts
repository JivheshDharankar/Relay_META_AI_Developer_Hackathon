import { Router } from 'express';
import { healthRoutes } from './health.routes';
import { procurementRoutes } from './procurement.routes';
import { agentRoutes } from './agent.routes';
import { executionRoutes } from './execution.routes';
import { portalRoutes } from './portal.routes';
import { authRoutes } from './auth.routes';
import { onboardingRoutes } from './onboarding.routes';
import { societyRoutes } from './society.routes';
import { optionalAuth } from '../middleware/auth.middleware';

const router = Router();

// Foundational health endpoint: GET /health, POST /api/health/integrations
router.use('/health', healthRoutes);
router.use('/api/health', healthRoutes);

// Phase 12 Authentication & Real User Identity endpoints
router.use('/api/auth', authRoutes);
router.use('/auth', authRoutes);

// Phase 12 First-Time User Onboarding endpoints
router.use('/api/onboarding', onboardingRoutes);

// Phase 12 Dynamic Society Search & Registration endpoints
router.use('/api/societies', societyRoutes);

// Deterministic Procurement Engine endpoints
router.use('/api/procurement', procurementRoutes);

// Relay Autonomous Agent development endpoint
router.use('/api/agent', agentRoutes);

// Relay Execution Layer endpoints (Payment, Supplier PO, Delivery, Full Cycle)
router.use('/api/execution', executionRoutes);

// Relay Resident & Community Portal endpoints (Orders, Community, Payments, Profile)
router.use('/api/portal', optionalAuth, portalRoutes);

export const appRouter = router;
