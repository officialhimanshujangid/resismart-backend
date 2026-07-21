import { Router } from 'express';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { requirePermission, attachAccess } from '../middlewares/access.middleware';
import { validate } from '../middlewares/validate.middleware';
import { UserRole } from '../constants/roles';
import * as controller from '../controllers/complaint.controller';
import {
  raiseComplaintSchema, assignComplaintSchema, respondSchema, pauseSchema,
  workDoneSchema, reopenSchema, rateSchema, createAssetSchema, updateAssetSchema,
} from '../validators/complaint.validator';

const router = Router();
router.use(authenticateJWT);
router.use(enforceTenantAccess);

const EVERYONE = [
  UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.SOCIETY_EMPLOYEE,
  UserRole.RESIDENT_OWNER, UserRole.RESIDENT_TENANT, UserRole.FAMILY_MEMBER,
];
const STAFF_SIDE = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.SOCIETY_EMPLOYEE];

/**
 * Reading is open to everyone signed in, and the CONTROLLER narrows it — a
 * resident to their own flat plus community items, a technician to their own
 * queue, a wing-scoped member to their wings. One door, one place where the
 * narrowing is decided, so no two endpoints can answer it differently.
 */
router.get('/', authorizeRoles(EVERYONE), attachAccess, controller.list);
router.get('/options', authorizeRoles(EVERYONE), attachAccess, controller.options);
router.get('/escalations', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'READ'), controller.escalations);

// Managing the categories a society complains about, and their SLAs. Declared
// before /:id so "categories" is never read as an id.
router.get('/categories', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'READ'), controller.listCategories);
router.post('/categories', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), controller.saveCategory);
router.put('/categories/:id', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), controller.saveCategory);

// Assets. Declared before /:id so "assets" is never read as an id.
router.get('/assets', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'READ'), controller.listAssets);
router.post('/assets', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), validate(createAssetSchema), controller.createAsset);
router.put('/assets/:id', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), validate(updateAssetSchema), controller.updateAsset);
router.get('/assets/:id/history', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'READ'), controller.assetHistory);

// Scanning a sticker. Any signed-in member of the society — the whole point is
// that a resident standing in front of a broken lift can report it without
// hunting for the right category.
router.get('/scan/:token', authorizeRoles(EVERYONE), controller.scan);

router.get('/:id', authorizeRoles(EVERYONE), attachAccess, controller.detail);

// Raising is open to everyone; a manager or guard may file on somebody's behalf.
router.post('/', authorizeRoles(EVERYONE), validate(raiseComplaintSchema), controller.raise);
router.post('/:id/me-too', authorizeRoles(EVERYONE), controller.meToo);
router.post('/:id/rate', authorizeRoles(EVERYONE), validate(rateSchema), controller.rate);
router.post('/:id/reopen', authorizeRoles(EVERYONE), validate(reopenSchema), controller.reopen);
// The resident confirms it is fixed. Deliberately open to them: the whole point
// is that the person who did the work does not get to declare it finished.
router.post('/:id/resolve', authorizeRoles(EVERYONE), controller.resolve);

// Doing the work. COMPLAINTS_OWN is enough — a technician needs to reply, pause
// and report done on their own queue without seeing everyone else's.
router.post('/:id/respond', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_OWN', 'FULL'), validate(respondSchema), controller.respond);
router.post('/:id/pause', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_OWN', 'FULL'), validate(pauseSchema), controller.pause);
router.post('/:id/resume', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_OWN', 'FULL'), controller.resume);
router.post('/:id/work-done', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_OWN', 'FULL'), validate(workDoneSchema), controller.workDone);

// Managing it. Assigning and closing need the wider permission.
router.post('/:id/assign', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), validate(assignComplaintSchema), controller.assign);
router.post('/:id/close', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), controller.close);
router.post('/:id/escalate', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), controller.escalate);

export default router;
