import { Router } from 'express';
import { DashboardController } from '../controllers/dashboard.controller';
import { authenticateJWT, authorizeRoles } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

/**
 * Platform-wide numbers: every society, every shop, total revenue, and the
 * most recent invoices with their tenants' names and email addresses.
 *
 * The comment said "for SYSTEM_OWNER" and the code said `authenticateJWT`
 * alone — so any resident who could sign in could read the whole platform's
 * financials. A comment is not a guard.
 */
router.get(
  '/metrics',
  authenticateJWT,
  authorizeRoles([UserRole.SYSTEM_OWNER, UserRole.SYSTEM_EMPLOYEE]),
  DashboardController.getOwnerMetrics,
);

export default router;
