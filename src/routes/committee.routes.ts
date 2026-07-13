import { Router } from 'express';
import {
  getCommittee, getDesignations, getEligibleMembers, getHistory,
  startCommittee, dissolveCommittee, createDesignation, updateDesignation,
  addMember, updateMember, removeMember,
} from '../controllers/committee.controller';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

// Committee roster control is Society-Admin only (decision: admin-lite committee).
const ADMIN = [UserRole.SOCIETY_ADMIN];
// Viewing is open to any society member (admins, committee, residents).
const view = [authenticateJWT, enforceTenantAccess];
const manage = [authenticateJWT, enforceTenantAccess, authorizeRoles(ADMIN)];

// Reads
router.get('/', ...view, getCommittee);
router.get('/designations', ...view, getDesignations);
router.get('/eligible-members', ...view, getEligibleMembers);
router.get('/history', ...view, getHistory);

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
