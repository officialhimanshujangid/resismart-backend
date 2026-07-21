import { Router } from 'express';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { requirePermission, attachAccess } from '../middlewares/access.middleware';
import { requireModule, requireResidentFeature, enforceCapacity } from '../middlewares/entitlement.middleware';
import { validate } from '../middlewares/validate.middleware';
import { uploadDocument } from '../middlewares/upload.middleware';
import { UserRole } from '../constants/roles';
import * as controller from '../controllers/complaint.controller';
import {
  raiseComplaintSchema, assignComplaintSchema, respondSchema, pauseSchema,
  workDoneSchema, reopenSchema, rateSchema, createAssetSchema, updateAssetSchema,
  listComplaintsQuerySchema, rejectSchema, duplicateSchema, commentSchema,
  internalNoteSchema,
} from '../validators/complaint.validator';

const router = Router();
router.use(authenticateJWT);
router.use(enforceTenantAccess);

/**
 * Gates 1 and 2 for the whole desk: a society whose plan excludes complaints,
 * or which has switched the module off, gets 404 here rather than a menu item
 * that leads somewhere it cannot use.
 */
router.use(requireModule('COMPLAINTS'));

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
// `validate(..., 'query')` is not decoration. `status` and `category` went
// from the query string into the Mongo filter untouched, and Express's `qs`
// parser turns `?status[$ne]=CLOSED` into an object — one URL, and a resident
// reads every complaint in the society. The schema refuses anything that is not
// a plain string before the service ever sees it.
router.get('/', authorizeRoles(EVERYONE), attachAccess, validate(listComplaintsQuerySchema, 'query'), controller.list);
router.get('/options', authorizeRoles(EVERYONE), attachAccess, controller.options);
router.get('/escalations', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'READ'), controller.escalations);

/**
 * The six numbers, without the rest of the form.
 *
 * The screen used to re-fetch `/options` — categories, assets, the staff
 * directory, and a full collection scan for the statistics — after every single
 * button press, because that was the only place the numbers lived (H-17). Same
 * permission as the copy inside `/options`: these are the committee's figures
 * about everybody's complaints, not a resident's own.
 */
router.get('/stats', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'READ'), controller.stats);

/**
 * Photographs. Declared before /:id so "photos" is never read as an id.
 *
 * `uploadDocument` rather than the image-only `upload`: a resident photographs
 * a leak, but a manager attaches the plumber's quotation, and a form that
 * refuses the PDF sends them back to the office door. 10MB, PDF or image, held
 * in memory and streamed to a private prefix — the same middleware the flat
 * documents use, because a second upload path is a second thing to get wrong.
 */
router.post('/photos', authorizeRoles(EVERYONE), uploadDocument.single('file'), controller.uploadPhoto);

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
// The gallery. Every key is signed for five minutes and only after the caller
// has been through `detail`'s scoping — so a resident of another flat asking
// for these gets the same 404 they get for the complaint itself.
router.get('/:id/photos', authorizeRoles(EVERYONE), attachAccess, controller.photos);

// Raising is open to everyone; a manager or guard may file on somebody's behalf.
//
// `attachAccess` on all five: without it `req.access` is undefined, `canManage`
// comes out false for an ADMIN, and `actable` then 404s them off their own
// society's complaint — "That complaint could not be found", to the person who
// owns the society. It is also what tells `resolve` whether the caller is the
// technician who did the work or a manager acting for the flat.
router.post('/', authorizeRoles(EVERYONE), requireResidentFeature('complaintRaise'), enforceCapacity('max_tickets_count'), attachAccess, validate(raiseComplaintSchema), controller.raise);
router.post('/:id/me-too', authorizeRoles(EVERYONE), attachAccess, controller.meToo);
router.post('/:id/rate', authorizeRoles(EVERYONE), attachAccess, validate(rateSchema), controller.rate);
router.post('/:id/reopen', authorizeRoles(EVERYONE), attachAccess, validate(reopenSchema), controller.reopen);
// The resident confirms it is fixed. Deliberately open to them: the whole point
// is that the person who did the work does not get to declare it finished —
// and `resolve` now refuses the assignee outright, which is where that promise
// is actually kept.
router.post('/:id/resolve', authorizeRoles(EVERYONE), attachAccess, controller.resolve);

/**
 * The resident's own message box — the thing that was missing.
 *
 * `respond` below is STAFF_SIDE behind `COMPLAINTS_OWN`, and the screen showed
 * its box and its Reply button to everybody, so a resident asking "when is the
 * plumber coming?" got a 403 and their only remaining move was to file a second
 * complaint. EVERYONE here, and `comment` then holds them to their own ticket
 * through `actable` — a neighbour cannot write on a complaint they can only
 * read.
 */
router.post('/:id/comment', authorizeRoles(EVERYONE), attachAccess, validate(commentSchema), controller.comment);

// Doing the work. COMPLAINTS_OWN is enough — a technician needs to reply, pause
// and report done on their own queue without seeing everyone else's.
router.post('/:id/respond', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_OWN', 'FULL'), validate(respondSchema), controller.respond);
router.post('/:id/pause', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_OWN', 'FULL'), validate(pauseSchema), controller.pause);
router.post('/:id/resume', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_OWN', 'FULL'), controller.resume);
router.post('/:id/work-done', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_OWN', 'FULL'), validate(workDoneSchema), controller.workDone);
// Staff talking to staff. `isInternal` has been on the event model since the
// beginning and `detail` has always hidden internal events from residents —
// this is the first thing that can actually write one by hand. STAFF_SIDE is
// the guarantee: there is no door onto this channel from a resident's session.
router.post('/:id/note', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_OWN', 'FULL'), validate(internalNoteSchema), controller.internalNote);

// Managing it. Assigning and closing need the wider permission.
router.post('/:id/assign', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), validate(assignComplaintSchema), controller.assign);
router.post('/:id/close', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), controller.close);
router.post('/:id/escalate', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), controller.escalate);

// Throwing one out, and merging one into another. Both reach REJECTED, which
// until now no code path could set — so the only way to dispose of junk was to
// walk it through "the work is done" and "yes, it is fixed", permanently
// corrupting `resolvedAt` and the median-resolution figure on the way.
router.post('/:id/reject', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), validate(rejectSchema), controller.reject);
router.post('/:id/duplicate', authorizeRoles(STAFF_SIDE), requirePermission('COMPLAINTS_MANAGE', 'FULL'), validate(duplicateSchema), controller.markDuplicate);

export default router;
