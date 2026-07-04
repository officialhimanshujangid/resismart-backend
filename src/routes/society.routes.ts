import { Router } from 'express';
import {
  createSociety,
  getSocieties,
  getSocietyStats,
  getSocietyById,
  registerSocietyPublic,
  registerSocietyAdmin,
  updateSociety,
  approveSociety,
  rejectSociety,
} from '../controllers/society.controller';
import {
  getBlocks,
  createBlock,
  updateBlock,
  deleteBlock,
} from '../controllers/block.controller';
import {
  createFlat,
  updateFlat,
  getFlats,
  getFlatById,
  deleteFlat,
  downloadBulkUploadTemplate,
  bulkUploadFlats,
} from '../controllers/flat.controller';
import {
  getResidentsByFlat,
  addResident,
  updateResident,
  removeResident,
} from '../controllers/resident.controller';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { enforceLimit } from '../middlewares/subscription.guard';
import { uploadExcel } from '../middlewares/upload.middleware';
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

// --- Block endpoints (within the active society tenant) ---
router.get('/blocks', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), getBlocks);
router.post('/blocks', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN]), createBlock);
router.put('/blocks/:blockId', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN]), updateBlock);
router.delete('/blocks/:blockId', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN]), deleteBlock);

// --- Flat endpoints (within the active society tenant) ---
router.get('/flats/bulk-upload-template', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), downloadBulkUploadTemplate);
router.post(
  '/flats/bulk-upload',
  authenticateJWT,
  enforceTenantAccess,
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]),
  uploadExcel.single('file'),
  bulkUploadFlats
);
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
router.get('/flats/:flatId', authenticateJWT, enforceTenantAccess, getFlatById);
router.delete('/flats/:flatId', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN]), deleteFlat);

// --- Resident endpoints (within the active society tenant) ---
router.get('/flats/:flatId/residents', authenticateJWT, enforceTenantAccess, getResidentsByFlat);
router.post('/flats/:flatId/residents', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER]), addResident);
router.put('/residents/:residentId', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER]), updateResident);
router.delete('/residents/:residentId', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER]), removeResident);

// --- Owner: single society + update + approve/reject (kept after /flats to avoid path clash) ---
router.get('/:id', authenticateJWT, authorizeRoles(OWNER), getSocietyById);
router.put('/:id', authenticateJWT, authorizeRoles(OWNER), updateSociety);
router.post('/:id/approve', authenticateJWT, authorizeRoles(OWNER), approveSociety);
router.post('/:id/reject', authenticateJWT, authorizeRoles(OWNER), rejectSociety);

export default router;
