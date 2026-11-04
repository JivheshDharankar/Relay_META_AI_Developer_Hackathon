import { Router } from 'express';
import { healthController } from '../controllers/health.controller';

const router = Router();

router.get('/', (req, res, next) => {
  healthController.getHealth(req, res, next);
});

// Authenticated diagnostics for deployed providers (Meta AI + Geoapify)
router.post('/integrations', (req, res, next) => {
  healthController.testIntegrations(req, res, next);
});

export const healthRoutes = router;

