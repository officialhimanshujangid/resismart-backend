import { Router } from 'express';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/access.middleware';
import { validate } from '../middlewares/validate.middleware';
import { UserRole } from '../constants/roles';
import * as controller from '../controllers/staff.controller';
import {
  createStaffSchema, updateStaffSchema, endEmploymentSchema, assignStaffSchema,
} from '../validators/staff.validator';

const router = Router();
router.use(authenticateJWT);
router.use(enforceTenantAccess);

const ROLES = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.SOCIETY_EMPLOYEE];
const view = [authorizeRoles(ROLES), requirePermission('STAFF_VIEW', 'READ')];
const manage = [authorizeRoles(ROLES), requirePermission('STAFF_MANAGE', 'FULL')];

router.get('/', ...view, controller.list);
router.get('/alerts', ...view, controller.alerts);
router.get('/coverage', ...view, controller.coverage);
// Declared AFTER the fixed paths, or `/coverage` would be read as an id.
router.get('/:id', ...view, controller.detail);

router.post('/', ...manage, validate(createStaffSchema), controller.create);
router.put('/:id', ...manage, validate(updateStaffSchema), controller.update);
router.post('/:id/end', ...manage, validate(endEmploymentSchema), controller.endEmployment);
router.post('/:id/login', ...manage, controller.provisionLogin);

router.post('/assignments', ...manage, validate(assignStaffSchema), controller.assign);
router.delete('/assignments/:id', ...manage, controller.unassign);

export default router;
