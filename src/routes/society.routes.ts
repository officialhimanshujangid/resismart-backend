import { Router } from 'express';
import { createSociety, createFlat, updateFlat, getFlats } from '../controllers/society.controller';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

// Society endpoints
router.post(
  '/',
  authenticateJWT,
  authorizeRoles([UserRole.SYSTEM_OWNER, UserRole.SYSTEM_EMPLOYEE]),
  createSociety
);

// Flat endpoints (within the active tenant context)
router.post(
  '/flats',
  authenticateJWT,
  enforceTenantAccess,
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  createFlat
);

router.put(
  '/flats/:flatId',
  authenticateJWT,
  enforceTenantAccess,
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  updateFlat
);

router.get(
  '/flats',
  authenticateJWT,
  enforceTenantAccess,
  getFlats
);

export default router;
