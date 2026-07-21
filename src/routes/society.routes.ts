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
import { requirePermissionUnlessResident } from '../middlewares/access.middleware';
import { validate } from '../middlewares/validate.middleware';
import * as flatDocumentController from '../controllers/flat-document.controller';
import { addFlatDocumentSchema } from '../validators/flat-document.validator';
import { addDocumentSchema } from '../validators/household.validator';
import { enforceLimit } from '../middlewares/subscription.guard';
import { enforceCapacity } from '../middlewares/entitlement.middleware';
import { uploadExcel } from '../middlewares/upload.middleware';
import { Flat } from '../models/flat.model';
import mongoose from 'mongoose';
import { UserRole } from '../constants/roles';

const router = Router();

const OWNER = [UserRole.SYSTEM_OWNER, UserRole.SYSTEM_EMPLOYEE];

/**
 * Who may reach a flat's PRIVATE side at all — its people, their documents,
 * its lease, its ownership history.
 *
 * `SOCIETY_EMPLOYEE` is deliberately absent. The gate guard needs flat NUMBERS
 * to log a visitor, and `/gate/flats` gives them exactly that. They have no
 * business with residents' names, phone numbers or ID scans — and every gate
 * product that handed them the directory has leaked it.
 *
 * This is only the outer gate; `flat-access.service` then decides which
 * household within the flat the caller belongs to.
 */
const FLAT_PRIVATE_ROLES = [
  UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE,
  UserRole.RESIDENT_OWNER, UserRole.RESIDENT_TENANT, UserRole.FAMILY_MEMBER,
];

/**
 * ...and of those, which ones need to have been GIVEN the directory.
 *
 * `RESIDENTS_VIEW` is the permission whose own blurb reads "Names and contact
 * details. A gatekeeper does not need this." It had **zero** enforcement sites:
 * setting it to NONE hid the Property menu and nothing else, so any committee
 * member — including one holding a seat with no role assigned at all — could
 * read every resident's name and phone number, download household ID scans,
 * and pull the flat timeline, which carries sale prices and rents.
 *
 * Residents are exempt because `flat-access.service` already clamps them to
 * their own household, which is a tighter limit than any permission.
 *
 * Reads only, on purpose. There is no `RESIDENTS_MANAGE` module yet, and
 * gating writes on a *view* permission would take household management away
 * from every seeded committee role (Chairman and Secretary hold READ, not
 * FULL). Splitting view from manage is the follow-up; leaking the directory
 * was the bug worth stopping first.
 */
const canReadResidents = requirePermissionUnlessResident('RESIDENTS_VIEW', 'READ');

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
router.get('/flats/:flatId/residents', authenticateJWT, enforceTenantAccess, authorizeRoles(FLAT_PRIVATE_ROLES), canReadResidents,getResidentsByFlat);
router.post('/flats/:flatId/residents', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER]), addResident);
router.put('/residents/:residentId', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER]), updateResident);
router.delete('/residents/:residentId', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER]), removeResident);

// --- Household management (owner/admin-managed members, immediate; timeline events) ---
const HOUSEHOLD_ROLES = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER];
// Household and events carry names, contact details and the flat's private
// history. The controller now enforces the household boundary itself; these
// role lists keep the gate guard out of the door entirely.
router.get('/flats/:flatId/household', authenticateJWT, enforceTenantAccess, authorizeRoles(FLAT_PRIVATE_ROLES), canReadResidents,getHousehold);
router.get('/flats/:flatId/events', authenticateJWT, enforceTenantAccess, authorizeRoles(FLAT_PRIVATE_ROLES), canReadResidents,getFlatEvents);
router.post('/flats/:flatId/household', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), enforceCapacity('max_member_count'), addHouseholdMember);
router.put('/household/:residentId', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), updateHouseholdMember);
router.post('/household/:residentId/set-head', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), setHouseholdHead);
// `validate` in front, because the controller parses OUTSIDE its try/catch —
// so a bad body threw an unhandled rejection and took the whole process down
// rather than returning a 400. The shared middleware answers properly.
router.post('/household/:residentId/documents', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), validate(addDocumentSchema), addHouseholdDocument);
router.get('/household/:residentId/documents/:docId/download', authenticateJWT, enforceTenantAccess, authorizeRoles(FLAT_PRIVATE_ROLES), canReadResidents,downloadHouseholdDocument);
router.delete('/household/:residentId', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), removeHouseholdMember);

// --- Flat documents (title papers that outlive whoever lives there) ---
//
// The precise rule lives in `flatDocumentAccess`, because it turns on which
// household a resident belongs to rather than on their role alone: a tenant —
// and a tenant's family — must not see a sale deed, which carries the owner's
// purchase price. These role lists are only the outer gate; owners are let
// through here and then checked properly in the service.
const FLAT_DOC_ROLES = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER, UserRole.FAMILY_MEMBER];
router.get('/flats/:flatId/documents', authenticateJWT, enforceTenantAccess, authorizeRoles(FLAT_DOC_ROLES), canReadResidents,flatDocumentController.list);
router.get('/flats/:flatId/documents/:docId/download', authenticateJWT, enforceTenantAccess, authorizeRoles(FLAT_DOC_ROLES), canReadResidents,flatDocumentController.download);
router.post('/flats/:flatId/documents', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER]), validate(addFlatDocumentSchema), flatDocumentController.add);
router.delete('/flats/:flatId/documents/:docId', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.RESIDENT_OWNER]), flatDocumentController.remove);

// --- Tenancy (current tenant household + tenancy documents) ---
router.get('/flats/:flatId/tenancy', authenticateJWT, enforceTenantAccess, authorizeRoles(FLAT_PRIVATE_ROLES), canReadResidents,getTenancy);
router.post('/flats/:flatId/tenancy/documents', authenticateJWT, enforceTenantAccess, authorizeRoles(HOUSEHOLD_ROLES), validate(addDocumentSchema), addTenancyDocument);
router.get('/flats/:flatId/tenancy/documents/:docId/download', authenticateJWT, enforceTenantAccess, authorizeRoles(FLAT_PRIVATE_ROLES), canReadResidents,downloadTenancyDocument);

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
// The timeline carries sale prices and rents. Same door as the rest of the
// flat's private side.
router.get('/flats/:flatId/timeline', authenticateJWT, enforceTenantAccess, authorizeRoles(FLAT_PRIVATE_ROLES), canReadResidents,getTimeline);
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
