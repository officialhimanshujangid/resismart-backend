import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { requirePermission, attachAccess } from '../middlewares/access.middleware';
import { requireOpsSetup } from '../middlewares/ops-setup.middleware';
import { validate } from '../middlewares/validate.middleware';
import { UserRole } from '../constants/roles';
import * as controller from '../controllers/visitor.controller';
import * as approvalController from '../controllers/gate-approval.controller';
import * as passController from '../controllers/gate-pass.controller';
import * as depthController from '../controllers/gate-depth.controller';
import * as gateController from '../controllers/gate-crud.controller';
import {
  recordEntrySchema, recordExitSchema, updateOpsPolicySchema, askApprovalSchema,
  decideApprovalSchema, overrideApprovalSchema, gatePreferenceSchema,
  issuePassSchema, revokePassSchema, redeemPassSchema, syncPassesSchema,
  addVehicleSchema, blockSchema, unblockSchema,
} from '../validators/visitor.validator';

const router = Router();
router.use(authenticateJWT);
router.use(enforceTenantAccess);

/**
 * The gate device makes far more requests than a person browsing.
 *
 * A busy gate logs an entry every minute or two and polls "who is inside"
 * constantly; the app-wide 300-per-15-minutes limiter would cut it off mid
 * shift, at which point the guard falls back to paper and the whole record for
 * that evening is lost. Its own tier, sized for a device rather than a human.
 */
const gateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many gate requests. Slow down.' },
});

const GUARD_ROLES = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.SOCIETY_EMPLOYEE];
const SOCIETY_ROLES = [
  UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.SOCIETY_EMPLOYEE,
  UserRole.RESIDENT_OWNER, UserRole.RESIDENT_TENANT, UserRole.FAMILY_MEMBER,
];

// ------------------------------------------------------------- gate console
router.post('/entries', gateLimiter, authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'FULL'), requireOpsSetup, validate(recordEntrySchema), controller.recordEntry);
router.post('/entries/:id/exit', gateLimiter, authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'FULL'), validate(recordExitSchema), controller.recordExit);
router.get('/inside', gateLimiter, authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'READ'), attachAccess, controller.inside);
router.get('/flats', gateLimiter, authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'READ'), controller.flatOptions);

// --------------------------------------------------------------------- log
//
// Residents are allowed here on purpose, and the controller clamps them to
// their own flats. Sending them somewhere else would mean a second endpoint
// with a second copy of the same privacy rule to keep in step.
router.get('/entries', authorizeRoles(SOCIETY_ROLES), attachAccess, controller.list);
// `attachAccess` was missing here, so a committee member scoped to A wing could
// pull C wing's visitor face photographs — the exact failure the wing scope was
// written to prevent, on the one endpoint that serves biometric-adjacent data.
router.get('/entries/:id/photo', authorizeRoles(SOCIETY_ROLES), attachAccess, controller.photo);

router.get('/reconciliation', authorizeRoles(GUARD_ROLES), requirePermission('GATE_LOGS', 'READ'), controller.reconciliation);

// ------------------------------------------------------------- approvals
//
// Note who is allowed where. Asking and overriding are the GUARD's job and
// carry GATE_CONSOLE. Answering is not gated on any permission at all — the
// authority to answer comes from having been asked, which the service checks
// against the snapshot taken when the request was made. A permission check
// here could only ever stop a resident answering their own door.
router.post('/approvals', gateLimiter, authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'FULL'), validate(askApprovalSchema), approvalController.ask);
router.get('/approvals/pending', gateLimiter, authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'READ'), approvalController.pending);
router.post('/approvals/:id/override', gateLimiter, authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'FULL'), validate(overrideApprovalSchema), approvalController.override);
router.get('/approvals/report', authorizeRoles(GUARD_ROLES), requirePermission('GATE_LOGS', 'READ'), approvalController.report);

router.get('/approvals/mine', authorizeRoles(SOCIETY_ROLES), approvalController.mine);
router.post('/approvals/:id/decide', authorizeRoles(SOCIETY_ROLES), validate(decideApprovalSchema), approvalController.decide);

router.get('/preferences', authorizeRoles(SOCIETY_ROLES), approvalController.myPreferences);
router.put('/preferences', authorizeRoles(SOCIETY_ROLES), validate(gatePreferenceSchema), approvalController.savePreferences);
router.get('/effective-rule', authorizeRoles(SOCIETY_ROLES), approvalController.effective);

// ---------------------------------------------------------------- passes
//
// Issuing is a RESIDENT's act, not a guard's — the service checks they live in
// the flat they are inviting to. Redeeming is the guard's, and carries
// GATE_CONSOLE like every other thing that opens the gate.
router.get('/passes', authorizeRoles(SOCIETY_ROLES), passController.list);
router.post('/passes', authorizeRoles(SOCIETY_ROLES), validate(issuePassSchema), passController.issue);
router.post('/passes/:id/revoke', authorizeRoles(SOCIETY_ROLES), validate(revokePassSchema), passController.revoke);

router.get('/passes/scanner-config', gateLimiter, authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'READ'), passController.scannerConfig);
// A live scan burns the pass AND writes the entry, joined — that is what
// `controller.scanEntry` does. The old `passController.redeem` only burned the
// pass, leaving a scanned visitor nowhere in the register; it is kept below
// only for the OFFLINE sync, where the device already admitted them and this
// is reconciliation, not admission.
router.post('/passes/redeem', gateLimiter, authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'FULL'), validate(redeemPassSchema), controller.scanEntry);
router.post('/passes/sync', gateLimiter, authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'FULL'), validate(syncPassesSchema), passController.sync);

// -------------------------------------------------------- vehicles & depth
router.get('/vehicles', authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'READ'), depthController.listVehicles);
router.get('/vehicles/suggest', gateLimiter, authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'READ'), depthController.suggestVehicles);
router.get('/vehicles/mine', authorizeRoles(SOCIETY_ROLES), depthController.myVehicles);
router.post('/vehicles', authorizeRoles(SOCIETY_ROLES), validate(addVehicleSchema), depthController.addVehicle);
router.delete('/vehicles/:id', authorizeRoles(SOCIETY_ROLES), depthController.removeVehicle);

// The blocklist. Reading it is gate work; adding to it is a committee act, and
// the service requires two serving members regardless of what this line allows.
router.get('/blocklist', authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'READ'), depthController.listBlocked);
router.post('/blocklist', authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), validate(blockSchema), depthController.block);
router.post('/blocklist/:id/lift', authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), validate(unblockSchema), depthController.unblock);

router.get('/report', authorizeRoles(GUARD_ROLES), requirePermission('GATE_LOGS', 'READ'), depthController.report);

// -------------------------------------------------------------------- gates
// The physical gates a society has. Reading is gate work; managing them is a
// settings-level act, so it carries OPS_SETTINGS.
router.get('/gates', authorizeRoles(GUARD_ROLES), requirePermission('GATE_CONSOLE', 'READ'), gateController.list);
router.post('/gates', authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), requirePermission('OPS_SETTINGS', 'FULL'), gateController.create);
router.put('/gates/:id', authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), requirePermission('OPS_SETTINGS', 'FULL'), gateController.update);
router.post('/gates/:id/retire', authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), requirePermission('OPS_SETTINGS', 'FULL'), gateController.retire);

// ------------------------------------------------------------------ settings
// Which modules the society uses. Open to every member: it drives the sidebar,
// and a resident being unable to read it is why the Complaints link would
// otherwise appear in a society that has complaints switched off.
router.get('/modules', authorizeRoles(SOCIETY_ROLES), controller.getModules);

// The setup checklist. Open to any society member who can reach operations —
// the guard needs to see why the console refused them, not just that it did.
router.get('/setup', authorizeRoles(GUARD_ROLES), controller.setup);

router.get('/policy', authorizeRoles(GUARD_ROLES), requirePermission('OPS_SETTINGS', 'READ'), controller.getPolicy);
router.put('/policy', authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE]), requirePermission('OPS_SETTINGS', 'FULL'), validate(updateOpsPolicySchema), controller.updatePolicy);

export default router;
