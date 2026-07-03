import { Router } from 'express';
import { DashboardController } from '../controllers/dashboard.controller';
import { authenticateJWT } from '../middlewares/auth.middleware';

const router = Router();

// Dashboard overview metrics for SYSTEM_OWNER
router.get('/metrics', authenticateJWT, DashboardController.getOwnerMetrics);

export default router;
