import { Router } from 'express';
import {
  createDesignation,
  getDesignations,
  getDesignationById,
  updateDesignation,
  deleteDesignation,
} from '../controllers/designation.controller';
import { authenticateJWT, authorizeRoles } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

const ownerOnly = [authenticateJWT, authorizeRoles([UserRole.SYSTEM_OWNER])];

router.post('/', ...ownerOnly, createDesignation);
router.get('/', ...ownerOnly, getDesignations);
router.get('/:id', ...ownerOnly, getDesignationById);
router.put('/:id', ...ownerOnly, updateDesignation);
router.delete('/:id', ...ownerOnly, deleteDesignation);

export default router;
