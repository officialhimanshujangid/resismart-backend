import { Router } from 'express';
import { createRentalAgreement, updateRentalAgreement, getRentalAgreements } from '../controllers/rental.controller';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

router.post(
  '/',
  authenticateJWT,
  enforceTenantAccess,
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  createRentalAgreement
);

router.put(
  '/:leaseId',
  authenticateJWT,
  enforceTenantAccess,
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  updateRentalAgreement
);

router.get(
  '/',
  authenticateJWT,
  enforceTenantAccess,
  getRentalAgreements
);

export default router;
