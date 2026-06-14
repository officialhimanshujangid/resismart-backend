import { Router } from 'express';
import { getAuditLogs } from '../controllers/audit.controller';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

router.get(
  '/',
  authenticateJWT,
  enforceTenantAccess,
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SHOP_OWNER, UserRole.SYSTEM_OWNER]),
  getAuditLogs
);

export default router;
