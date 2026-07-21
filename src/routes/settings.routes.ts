import { Router } from 'express';
import { SettingsController } from '../controllers/settings.controller';
import * as passController from '../controllers/gate-pass.controller';
import { authenticateJWT, authorizeRoles } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

const ownerOnly = [authenticateJWT, authorizeRoles([UserRole.SYSTEM_OWNER])];

router.get('/', ...ownerOnly, SettingsController.getSettings);
router.put('/', ...ownerOnly, SettingsController.updateSettings);

/**
 * The gate-pass signing key. Deliberately here and not in `visitor.routes`.
 *
 * That file is the society's gate: every line on it carries
 * `enforceTenantAccess` and a society-scoped `requirePermission`, and it is
 * mounted under `/visitors` where a request means "this society's gate". This
 * key is neither. ONE install has ONE signing pair, and the society travels as
 * a claim inside the signed blob rather than as a property of the key — so an
 * admin at one society rotating it would re-key every gate at every OTHER
 * society on the platform, and every guard device would have to be told.
 * Nobody at a society can be given that button.
 *
 * `requirePermission` cannot express the rule either, in the opposite
 * direction: it resolves access against the caller's society and a SYSTEM_OWNER
 * has none, so adding it here would 403 the only person entitled to rotate.
 * Owner-level roles alone, exactly like the settings above it — and SYSTEM
 * EMPLOYEE is excluded on purpose, because the blast radius is every gate we
 * run.
 */
router.get('/pass-signing-key', ...ownerOnly, passController.signingKeyStatus);
router.post('/pass-signing-key/rotate', ...ownerOnly, passController.rotateSigningKey);

export default router;
