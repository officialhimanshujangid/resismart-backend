import { Router } from 'express';
import {
  getCommittee, getDesignations, getEligibleMembers, getHistory,
  startCommittee, dissolveCommittee, createDesignation, updateDesignation,
  addMember, updateMember, removeMember,
} from '../controllers/committee.controller';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/access.middleware';
import { UserRole } from '../constants/roles';

/**
 * Roster mutations stay SOCIETY_ADMIN-only, deliberately.
 *
 * The seeded Chairman and Secretary roles carry `COMMITTEE_MANAGE: FULL` and
 * the sidebar shows them the Committee link because of it — yet every mutation
 * below refuses them. That mismatch is real and worth fixing, but the fix is a
 * product decision ("committee = admin-lite" was chosen deliberately), not a
 * bug to be quietly reversed. Left as-is; the honest options are to drop
 * COMMITTEE_MANAGE from those seeded roles or to let it work here.
 */

const router = Router();

// Committee roster control is Society-Admin only (decision: admin-lite committee).
const ADMIN = [UserRole.SOCIETY_ADMIN];
// Viewing is open to any society member (admins, committee, residents).
const view = [authenticateJWT, enforceTenantAccess];
const manage = [authenticateJWT, enforceTenantAccess, authorizeRoles(ADMIN)];

// Reads. Who the office bearers are is properly open to the whole society —
// in a real society it is painted on a board in the lobby.
router.get('/', ...view, getCommittee);
router.get('/designations', ...view, getDesignations);
router.get('/history', ...view, getHistory);

// ...but this one is not the committee, it is a list of every active resident,
// which is a directory by another name. It was open to any signed-in member,
// residents included. Same permission as the directory itself.
router.get('/eligible-members',
  authenticateJWT, enforceTenantAccess,
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  requirePermission('RESIDENTS_VIEW', 'READ'),
  getEligibleMembers);

// Term management
router.post('/', ...manage, startCommittee);
router.post('/:id/dissolve', ...manage, dissolveCommittee);

// Designations
router.post('/designations', ...manage, createDesignation);
router.put('/designations/:id', ...manage, updateDesignation);

// Members
router.post('/:id/members', ...manage, addMember);
router.put('/members/:memberId', ...manage, updateMember);
router.delete('/members/:memberId', ...manage, removeMember);

export default router;
