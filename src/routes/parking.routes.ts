import { Router } from 'express';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { requirePermission, requirePermissionUnlessResident, attachAccess } from '../middlewares/access.middleware';
import { requireModule, requireResidentFeature } from '../middlewares/entitlement.middleware';
import { validate } from '../middlewares/validate.middleware';
import { UserRole } from '../constants/roles';
import * as controller from '../controllers/parking.controller';
import {
  configureParkingSchema,
  createZoneSchema, updateZoneSchema, bulkSlotsSchema, updateSlotSchema,
  allocateSchema, releaseSchema, transferSchema, raiseRequestSchema, decideRequestSchema,
} from '../validators/parking.validator';

const router = Router();
router.use(authenticateJWT);
router.use(enforceTenantAccess);

/**
 * Gate 1 + gate 2 for the module.
 *
 * A society that does not manage parking gets 404 from every route below, and
 * 404 rather than 403 because a module the society never switched on should not
 * appear to exist; "this is here and you may not have it" invites a support call
 * about a feature nobody sold them.
 *
 * Applied per line rather than with `router.use`, and the exception is the whole
 * reason: the two SETTINGS routes have to stay reachable while parking is off,
 * or the wizard that switches it on 404s and the module can never be reached at
 * all. Exactly the arrangement `visitor.routes.ts` uses for `/policy`. Anything
 * added below must carry `parkingModule` explicitly — the cost of the exception
 * is that it can no longer be forgotten silently in one place.
 */
const parkingModule = requireModule('PARKING');

const OFFICE_ROLES = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.SOCIETY_EMPLOYEE];
const SOCIETY_ROLES = [
  UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.SOCIETY_EMPLOYEE,
  UserRole.RESIDENT_OWNER, UserRole.RESIDENT_TENANT, UserRole.FAMILY_MEMBER,
];

// ----------------------------------------------------------------- settings
//
// OPS_SETTINGS, not PARKING_MANAGE, and that is deliberate. PARKING_MANAGE is
// only offered by the role editor to a society that already HAS parking
// (`offeredPermissionsFor`), so gating the switch-on behind it would be a lock
// whose key is inside the room. This is a society-settings act — the same
// permission that answers "do we record people leaving?" answers "do we manage
// parking?".
router.get('/settings', authorizeRoles(OFFICE_ROLES), requirePermission('OPS_SETTINGS', 'READ'), controller.settings);
router.put('/settings', authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), requirePermission('OPS_SETTINGS', 'FULL'), validate(configureParkingSchema), controller.configure);

// -------------------------------------------------------------------- zones
//
// Reading the areas is view work. Creating one changes the inventory the whole
// module counts from, so it carries PARKING_MANAGE.
// Residents may LIST zones, and that is not an oversight being widened.
//
// `/map/:zoneId` deliberately admits residents and clamps what they see —
// occupied vs free, never who. But a resident had no way to obtain a zoneId to
// ask about, because this route was office-only. The clamped view was therefore
// unreachable: careful privacy work that no resident could ever trigger.
//
// A zone is a basement with a name and a grid size. It is the least sensitive
// thing in the module, and every resident can see it by walking downstairs.
router.get('/zones', parkingModule, requireResidentFeature('parkingViewOwn'), authorizeRoles(SOCIETY_ROLES), requirePermissionUnlessResident('PARKING_VIEW', 'READ'), controller.listZones);
router.post('/zones', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_MANAGE', 'FULL'), validate(createZoneSchema), controller.createZone);
router.put('/zones/:id', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_MANAGE', 'FULL'), validate(updateZoneSchema), controller.updateZone);

// -------------------------------------------------------------------- slots
router.get('/slots', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_VIEW', 'READ'), controller.listSlots);
router.post('/slots/bulk', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_MANAGE', 'FULL'), validate(bulkSlotsSchema), controller.bulkCreateSlots);
router.patch('/slots/:id', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_MANAGE', 'FULL'), validate(updateSlotSchema), controller.updateSlot);

// ---------------------------------------------------------------------- map
//
// Residents belong here — "is anything free in Basement 2?" is the question the
// map exists to answer, and sending them to a second endpoint would mean a
// second copy of the privacy rule to keep in step. They are exempt from
// PARKING_VIEW because the SERVICE clamps them instead: without that permission
// the map returns colours, plus their own flat's slot in full. Names and plates
// need the permission, because the popover is otherwise a directory of who owns
// which car, assembled from a screen that claims to answer "is B1-14 free?".
router.get('/map/:zoneId', parkingModule, requireResidentFeature('parkingViewOwn'), authorizeRoles(SOCIETY_ROLES), requirePermissionUnlessResident('PARKING_VIEW', 'READ'), controller.map);

// -------------------------------------------------------------- allocations
router.get('/allocations', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_VIEW', 'READ'), controller.listAllocations);
router.post('/allocations', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_MANAGE', 'FULL'), validate(allocateSchema), controller.allocate);
router.post('/allocations/:id/release', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_MANAGE', 'FULL'), validate(releaseSchema), controller.release);
router.post('/allocations/:id/transfer', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_MANAGE', 'FULL'), validate(transferSchema), controller.transfer);

// A resident's own slots, and only ever their own — the service reads the
// caller's residencies rather than anything on the request.
router.get('/mine', parkingModule, requireResidentFeature('parkingViewOwn'), authorizeRoles(SOCIETY_ROLES), controller.mine);

// ----------------------------------------------------------------- requests
//
// Asking is a RESIDENT's act and is gated on `parkingRequest`, which ships OFF:
// most societies want that conversation in person before it becomes a queue.
// Deciding is the committee's, and carries PARKING_MANAGE because approving
// allots a slot and starts a bill.
router.get('/requests', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_VIEW', 'READ'), controller.listRequests);
router.post('/requests', parkingModule, requireResidentFeature('parkingRequest'), authorizeRoles(SOCIETY_ROLES), attachAccess, validate(raiseRequestSchema), controller.raiseRequest);
router.post('/requests/:id/decide', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_MANAGE', 'FULL'), validate(decideRequestSchema), controller.decideRequest);
// `attachAccess` so the service can tell the office cancelling a request from a
// resident cancelling their neighbour's.
router.post('/requests/:id/withdraw', parkingModule, authorizeRoles(SOCIETY_ROLES), attachAccess, controller.withdrawRequest);

// ------------------------------------------------------------------ reports
router.get('/reports/occupancy', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_VIEW', 'READ'), controller.occupancy);
// The one that finds money. Kept on PARKING_VIEW rather than MANAGE so a
// treasurer who cannot allot slots can still read why the parking income moved.
router.get('/reports/reconciliation', parkingModule, authorizeRoles(OFFICE_ROLES), requirePermission('PARKING_VIEW', 'READ'), controller.reconciliation);

export default router;
