import { Router } from 'express';
import {
  getSocieties,
  getSocietyStats,
  getSocietyById,
  registerSocietyPublic,
  registerSocietyAdmin,
  updateSociety,
  approveSociety,
  rejectSociety,
  getMySociety,
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
  getFlatFormLookup,
} from '../controllers/flat.controller';
import {
  getResidentsByFlat,
  addResident,
  updateResident,
  removeResident,
} from '../controllers/resident.controller';
import {
  createRegistrationRequest,
  listRegistrationRequests,
  approveRegistrationRequest,
  rejectRegistrationRequest,
  cancelRegistrationRequest,
} from '../controllers/membership-request.controller';
import {
  rentOutFlat,
  sellFlat,
  endTenancy,
  moveIn,
  setVacant,
  getTimeline,
  addHistoricalTenure,
  updateTenure,
  deleteTenure,
} from '../controllers/flat-lifecycle.controller';
import {
  getHousehold,
  getFlatEvents,
  addHouseholdMember,
  updateHouseholdMember,
  setHouseholdHead,
  removeHouseholdMember,
  addHouseholdDocument,
  downloadHouseholdDocument,
  getTenancy,
  addTenancyDocument,
  downloadTenancyDocument,
} from '../controllers/household.controller';
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
router.post('/register-admin', authenticateJWT, authorizeRoles(OWNER), registerSocietyAdmin);
router.get('/', authenticateJWT, authorizeRoles(OWNER), getSocieties);
router.get('/stats', authenticateJWT, authorizeRoles(OWNER), getSocietyStats);

// --- Block endpoints (within the active society tenant) ---
router.get('/me', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), getMySociety);

router.get('/blocks', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), getBlocks);
router.post('/blocks', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN]), createBlock);
router.put('/blocks/:blockId', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN]), updateBlock);
router.delete('/blocks/:blockId', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN]), deleteBlock);

// --- Flat endpoints (within the active society tenant) ---
router.get('/flats/form-lookup', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), getFlatFormLookup);
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

// --- Household management (owner/admin-managed members, immediate; timeline events) ---
const HOUSEHOLD_ROLES = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER];
router.get('/flats/:flatId/household', authenticateJWT, enforceTenantAccess, getHousehold);
router.get('/flats/:flatId/events', authenticateJWT, enforceTenantAccess, getFlatEvents);
router.post('/flats/:flatId/household', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), addHouseholdMember);
router.put('/household/:residentId', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), updateHouseholdMember);
router.post('/household/:residentId/set-head', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), setHouseholdHead);
router.post('/household/:residentId/documents', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), addHouseholdDocument);
router.get('/household/:residentId/documents/:docId/download', authenticateJWT, enforceTenantAccess, downloadHouseholdDocument);
router.delete('/household/:residentId', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), removeHouseholdMember);

// --- Tenancy (current tenant household + tenancy documents) ---
router.get('/flats/:flatId/tenancy', authenticateJWT, enforceTenantAccess, getTenancy);
router.post('/flats/:flatId/tenancy/documents', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), addTenancyDocument);
router.get('/flats/:flatId/tenancy/documents/:docId/download', authenticateJWT, enforceTenantAccess, downloadTenancyDocument);

// --- Resident registration requests (two-way approval) ---
router.post(
  '/flats/:flatId/registration-requests',
  authenticateJWT,
  enforceTenantAccess,
  authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER, UserRole.RESIDENT_TENANT]),
  createRegistrationRequest
);
router.get('/registration-requests', authenticateJWT, enforceTenantAccess, listRegistrationRequests);
router.post('/registration-requests/:requestId/approve', authenticateJWT, enforceTenantAccess, approveRegistrationRequest);
router.post('/registration-requests/:requestId/reject', authenticateJWT, enforceTenantAccess, rejectRegistrationRequest);
router.post('/registration-requests/:requestId/cancel', authenticateJWT, enforceTenantAccess, cancelRegistrationRequest);

// --- Flat lifecycle & timeline (rent / sell / occupancy) ---
const LIFECYCLE_ROLES = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER];
router.get('/flats/:flatId/timeline', authenticateJWT, enforceTenantAccess, getTimeline);
router.post('/flats/:flatId/rent-out', authenticateJWT, enforceTenantAccess, authorizeRoles(LIFECYCLE_ROLES), rentOutFlat);
router.post('/flats/:flatId/sell', authenticateJWT, enforceTenantAccess, authorizeRoles(LIFECYCLE_ROLES), sellFlat);
router.post('/flats/:flatId/end-tenancy', authenticateJWT, enforceTenantAccess, authorizeRoles(LIFECYCLE_ROLES), endTenancy);
router.post('/flats/:flatId/move-in', authenticateJWT, enforceTenantAccess, authorizeRoles(LIFECYCLE_ROLES), moveIn);
router.post('/flats/:flatId/set-vacant', authenticateJWT, enforceTenantAccess, authorizeRoles(LIFECYCLE_ROLES), setVacant);
router.post('/flats/:flatId/tenures', authenticateJWT, enforceTenantAccess, authorizeRoles(LIFECYCLE_ROLES), addHistoricalTenure);
router.put('/tenures/:tenureId', authenticateJWT, enforceTenantAccess, authorizeRoles(LIFECYCLE_ROLES), updateTenure);
router.delete('/tenures/:tenureId', authenticateJWT, enforceTenantAccess, authorizeRoles(LIFECYCLE_ROLES), deleteTenure);

// --- Owner: single society + update + approve/reject (kept after /flats to avoid path clash) ---
router.get('/:id', authenticateJWT, authorizeRoles(OWNER), getSocietyById);
router.put('/:id', authenticateJWT, authorizeRoles(OWNER), updateSociety);
router.post('/:id/approve', authenticateJWT, authorizeRoles(OWNER), approveSociety);
router.post('/:id/reject', authenticateJWT, authorizeRoles(OWNER), rejectSociety);

export default router;
