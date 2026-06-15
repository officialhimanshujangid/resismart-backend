import { Router } from 'express';
import {
  createPermissionRole,
  getPermissionRoles,
  getPermissionRoleById,
  updatePermissionRole,
  deletePermissionRole,
} from '../controllers/permission-role.controller';
import { authenticateJWT, authorizeRoles } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

const ownerOnly = [authenticateJWT, authorizeRoles([UserRole.SYSTEM_OWNER])];

router.post('/', ...ownerOnly, createPermissionRole);
router.get('/', ...ownerOnly, getPermissionRoles);
router.get('/:id', ...ownerOnly, getPermissionRoleById);
router.put('/:id', ...ownerOnly, updatePermissionRole);
router.delete('/:id', ...ownerOnly, deletePermissionRole);

export default router;
