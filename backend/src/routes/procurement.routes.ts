import { Router } from 'express';
import { procurementController } from '../controllers/procurement.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { requireProcurementScope } from '../middleware/authorization.middleware';
import { createRateLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

// All procurement endpoints move money or mutate shared orders: authenticated
// callers only, with targets bound to the session resident/society.
router.use(requireAuth, requireProcurementScope(), createRateLimiter('PROCUREMENT_MUTATION'));

router.post('/validate', (req, res, next) => procurementController.validateRequest(req, res, next));
router.post('/authorize', (req, res, next) => procurementController.checkAuthorization(req, res, next));
router.post('/aggregate', (req, res, next) => procurementController.aggregateDemand(req, res, next));
router.post('/evaluate', (req, res, next) => procurementController.evaluateOffers(req, res, next));
router.post('/orders', (req, res, next) => procurementController.createCommunityOrder(req, res, next));
router.post('/reconcile', (req, res, next) => procurementController.reconcileOrder(req, res, next));

export const procurementRoutes = router;
