import { Router } from 'express';
import { authenticateJWT, enforceTenantAccess, authorizeRoles } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';
import * as flatSizeController from '../controllers/flat-size.controller';

const router = Router();

// Base middleware for society access
router.use(authenticateJWT);
router.use(enforceTenantAccess);

// CRUD routes
router.post(
  '/',
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  flatSizeController.createFlatSize
);

router.get(
  '/',
  flatSizeController.getFlatSizes
);

router.put(
  '/:sizeId',
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  flatSizeController.updateFlatSize
);

router.delete(
  '/:sizeId',
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  flatSizeController.deleteFlatSize
);

export default router;
