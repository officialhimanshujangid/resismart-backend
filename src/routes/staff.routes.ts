import { Router } from 'express';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/access.middleware';
import { validate } from '../middlewares/validate.middleware';
import { enforceCapacity, requireModule } from '../middlewares/entitlement.middleware';
import { UserRole } from '../constants/roles';
import * as controller from '../controllers/staff.controller';
import {
  createStaffSchema, updateStaffSchema, endEmploymentSchema, assignStaffSchema,
  reinstateStaffSchema, staffDocumentSchema, staffShiftSchema, staffLeaveSchema,
} from '../validators/staff.validator';

const router = Router();
router.use(authenticateJWT);
router.use(enforceTenantAccess);

const ROLES = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.SOCIETY_EMPLOYEE];
const view = [authorizeRoles(ROLES), requirePermission('STAFF_VIEW', 'READ')];
const manage = [authorizeRoles(ROLES), requirePermission('STAFF_MANAGE', 'FULL')];

/**
 * A staff member's own screen, and the ONLY route in this file with no
 * `STAFF_VIEW` on it.
 *
 * Deliberate. A guard holds no staff permission — that is what the seeded
 * "Security guard" role says — so requiring one here would leave them exactly
 * where they were: on the society-admin dashboard, looking at billing panels
 * that 403 into empty boxes. The service resolves everything from the caller's
 * own `userId`, so there is no id in the URL to tamper with.
 *
 * Declared FIRST, because `/:id` below would otherwise swallow `/me/work`.
 */
router.get('/me/work', authorizeRoles(ROLES), controller.myWork);

router.get('/', ...view, controller.list);
router.get('/alerts', ...view, controller.alerts);
router.get('/coverage', ...view, controller.coverage);
// Declared AFTER the fixed paths, or `/coverage` would be read as an id.
router.get('/:id', ...view, controller.detail);
router.get('/:id/documents', ...view, controller.listDocuments);
// Reading a paper is reading, so these sit behind STAFF_VIEW alongside the
// record they belong to. Each hands back a five-minute signed URL; the S3 key
// itself never leaves the server.
router.get('/:id/documents/:docId/download', ...view, controller.documentDownload);
router.get('/:id/verification/download', ...view, controller.verificationDownload);
router.get('/:id/photo', ...view, controller.photoDownload);

// The plan says how many people a society may keep on the roll. This was one
// of five capabilities defined in the plan editor and enforced nowhere.
router.post('/', ...manage, enforceCapacity('max_staff_count'), validate(createStaffSchema), controller.create);
router.put('/:id', ...manage, validate(updateStaffSchema), controller.update);
router.post('/:id/end', ...manage, validate(endEmploymentSchema), controller.endEmployment);

/**
 * Bringing somebody back counts against the plan's staff cap, exactly like
 * hiring does — they are a person on the roll from that moment, and letting a
 * re-hire slip past `enforceCapacity` would turn "end and reinstate" into a
 * free way over the limit.
 */
router.post('/:id/reinstate', ...manage, enforceCapacity('max_staff_count'),
  validate(reinstateStaffSchema), controller.reinstate);

/**
 * The three login routes.
 *
 * All carry `STAFF_MANAGE` at the door, and all three then refuse anybody
 * without `ACCESS_MANAGE` inside the service. That is not belt-and-braces: a
 * previous phase closed a privilege-escalation path where a `STAFF_MANAGE`
 * holder minted a peer account and read its password out of the response, and
 * revoking or resetting a credential is the same job as creating one. The
 * route-level permission keeps the endpoint off the menu; the service-level
 * check is the one that actually holds.
 */
router.post('/:id/login', ...manage, controller.provisionLogin);
router.post('/:id/login/revoke', ...manage, controller.revokeLogin);
router.post('/:id/login/reset', ...manage, controller.resetPassword);

// Papers. Filing and removing are staff work; reading them is above, with the
// rest of the reads.
router.post('/:id/documents', ...manage, validate(staffDocumentSchema), controller.addDocument);
router.delete('/:id/documents/:docId', ...manage, controller.removeDocument);

// The rota and the leave calendar. Both change who gets sent work, so both are
// STAFF_MANAGE — a shift quietly added is an assignment quietly moved.
router.post('/:id/shifts', ...manage, validate(staffShiftSchema), controller.setShift);
router.delete('/shifts/:shiftId', ...manage, controller.removeShift);
router.post('/:id/leave', ...manage, validate(staffLeaveSchema), controller.addLeave);
router.delete('/leave/:leaveId', ...manage, controller.cancelLeave);

router.post('/assignments', ...manage, validate(assignStaffSchema), controller.assign);
router.delete('/assignments/:id', ...manage, controller.unassign);

export default router;
