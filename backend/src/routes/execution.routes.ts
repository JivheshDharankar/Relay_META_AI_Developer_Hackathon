import { Router } from 'express';
import { executionController } from '../controllers/execution.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { requireProcurementScope } from '../middleware/authorization.middleware';
import { createRateLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

// All execution endpoints move money or mutate shared orders: authenticated
// callers only, with targets bound to the session resident/society.
router.use(requireAuth, requireProcurementScope(), createRateLimiter('PAYMENT_EXECUTION'));

// Payment execution
router.post('/payment', (req, res, next) => executionController.executePayment(req, res, next));

// Supplier purchase order submission
router.post('/supplier/order', (req, res, next) => executionController.executeSupplierPO(req, res, next));

// Delivery simulation & tracking
router.post('/delivery/advance', (req, res, next) => executionController.advanceDelivery(req, res, next));
router.get('/delivery/:communityOrderId', (req, res, next) => executionController.getDeliveryStatus(req, res, next));

// Full procurement execution cycle
router.post('/full-cycle', (req, res, next) => executionController.executeFullCycle(req, res, next));

export const executionRoutes = router;
