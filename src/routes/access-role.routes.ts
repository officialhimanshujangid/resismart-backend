import { Router } from 'express';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/access.middleware';
import { validate } from '../middlewares/validate.middleware';
import { UserRole } from '../constants/roles';
import * as controller from '../controllers/access-role.controller';
import { createAccessRoleSchema, updateAccessRoleSchema, assignAccessRoleSchema } from '../validators/access-role.validator';

const router = Router();
router.use(authenticateJWT);
router.use(enforceTenantAccess);

/**
 * Who can do what, inside one society.
 *
 * Mounted at its own path rather than under `/societies/:id` so it does not
 * collide with that router's `/:id` catch — the same reason `/committee` sits
 * on its own.
 *
 * Note what guards the mutations: `ACCESS_MANAGE` at FULL, which no seeded role
 * carries — not even the Chairman's. Handing out access is admin work, and a
 * role that can widen itself is not a permission system. `authorizeRoles` still
 * fronts it so a resident never reaches the permission check at all.
 */
const canRead = [
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  requirePermission('ACCESS_MANAGE', 'READ'),
];
const canManage = [
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  requirePermission('ACCESS_MANAGE', 'FULL'),
];

// Anyone signed in to a society may ask what THEY can do. Not gated on
// ACCESS_MANAGE — a guard has to be able to render their own sidebar.
router.get('/me', controller.mine);

router.get('/', ...canRead, controller.list);
router.get('/members', ...canRead, controller.members);

router.post('/', ...canManage, validate(createAccessRoleSchema), controller.create);
router.put('/:id', ...canManage, validate(updateAccessRoleSchema), controller.update);
router.delete('/:id', ...canManage, controller.remove);
router.put('/members/:memberId', ...canManage, validate(assignAccessRoleSchema), controller.assignToMember);

export default router;
