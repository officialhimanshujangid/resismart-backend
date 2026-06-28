import { Router } from 'express';
import {
  createSociety,
  createFlat,
  updateFlat,
  getFlats,
  getSocieties,
  getSocietyStats,
  getSocietyById,
  registerSocietyPublic,
  registerSocietyAdmin,
  updateSociety,
  approveSociety,
  rejectSociety,
} from '../controllers/society.controller';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { enforceLimit } from '../middlewares/subscription.guard';
import { Flat } from '../models/flat.model';
import mongoose from 'mongoose';
import { UserRole } from '../constants/roles';

const router = Router();

const OWNER = [UserRole.SYSTEM_OWNER, UserRole.SYSTEM_EMPLOYEE];

// --- Public self-registration (landing page) ---
router.post('/register-public', registerSocietyPublic);

// --- Owner society management ---
router.post('/', authenticateJWT, authorizeRoles(OWNER), createSociety);
router.post('/register-admin', authenticateJWT, authorizeRoles(OWNER), registerSocietyAdmin);
router.get('/', authenticateJWT, authorizeRoles(OWNER), getSocieties);
router.get('/stats', authenticateJWT, authorizeRoles(OWNER), getSocietyStats);

// --- Flat endpoints (within the active society tenant) ---
router.post(
  '/flats',
  authenticateJWT,
  enforceTenantAccess,
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  enforceLimit('max_flat_count', (societyId) =>
    Flat.countDocuments({ societyId: new mongoose.Types.ObjectId(societyId) })
  ),
  createFlat
);
router.put(
  '/flats/:flatId',
  authenticateJWT,
  enforceTenantAccess,
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  updateFlat
);
router.get('/flats', authenticateJWT, enforceTenantAccess, getFlats);

// --- Owner: single society + update + approve/reject (kept after /flats to avoid path clash) ---
router.get('/:id', authenticateJWT, authorizeRoles(OWNER), getSocietyById);
router.put('/:id', authenticateJWT, authorizeRoles(OWNER), updateSociety);
router.post('/:id/approve', authenticateJWT, authorizeRoles(OWNER), approveSociety);
router.post('/:id/reject', authenticateJWT, authorizeRoles(OWNER), rejectSociety);

export default router;
