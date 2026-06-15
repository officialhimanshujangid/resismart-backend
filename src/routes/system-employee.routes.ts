import { Router } from 'express';
import {
  createSystemEmployee,
  getSystemEmployees,
  getSystemEmployeeById,
  updateSystemEmployee,
  deleteSystemEmployee,
  getMyPermissions,
  getReportingManagers,
} from '../controllers/system-employee.controller';
import { authenticateJWT, authorizeRoles } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

const ownerOnly = [authenticateJWT, authorizeRoles([UserRole.SYSTEM_OWNER])];
const employeeOnly = [authenticateJWT, authorizeRoles([UserRole.SYSTEM_EMPLOYEE])];

// Self-service: employee fetches their own permissions on login
router.get('/me/permissions', ...employeeOnly, getMyPermissions);

// SYSTEM_OWNER CRUD
router.post('/', ...ownerOnly, createSystemEmployee);
router.get('/', ...ownerOnly, getSystemEmployees);
router.get('/reporting-managers', ...ownerOnly, getReportingManagers);
router.get('/:id', ...ownerOnly, getSystemEmployeeById);
router.put('/:id', ...ownerOnly, updateSystemEmployee);
router.delete('/:id', ...ownerOnly, deleteSystemEmployee);

export default router;
