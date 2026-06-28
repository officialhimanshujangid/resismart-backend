import { Router } from 'express';
import { PlanController } from '../controllers/plan.controller';
import { authenticateJWT, authorizeRoles } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

const OWNER = [UserRole.SYSTEM_OWNER, UserRole.SYSTEM_EMPLOYEE];

// Public: active customer-facing plans (landing page + society billing screen)
router.get('/public', PlanController.getActivePlans);

// Owner plan management
router.post('/', authenticateJWT, authorizeRoles(OWNER), PlanController.createPlan);
router.get('/', authenticateJWT, authorizeRoles(OWNER), PlanController.getPlans);
router.get('/:id', authenticateJWT, authorizeRoles(OWNER), PlanController.getPlanById);
router.put('/:id', authenticateJWT, authorizeRoles(OWNER), PlanController.updatePlan);
router.delete('/:id', authenticateJWT, authorizeRoles(OWNER), PlanController.deletePlan);

export default router;
