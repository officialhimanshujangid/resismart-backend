import { Router } from 'express';
import { z } from 'zod';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import { UserRole } from '../constants/roles';
import * as controller from '../controllers/admin-transfer.controller';

const router = Router();
router.use(authenticateJWT);
router.use(enforceTenantAccess);

const objectId = /^[0-9a-fA-F]{24}$/;

const initiateSchema = z.object({
  toUserId: z.string().regex(objectId),
  successorKind: z.enum(['EXISTING_MEMBER', 'COMMITTEE', 'EXTERNAL']),
  // Required, with no default anywhere in the stack. An outgoing admin's next
  // role is a decision somebody has to make out loud.
  fromBecomes: z.enum(['SOCIETY_COMMITTEE', 'RESIDENT_OWNER', 'RESIDENT_TENANT', 'NONE']),
  reason: z.string().max(300).optional(),
});

const acceptSchema = z.object({
  code: z.string().regex(/^[0-9]{4,8}$/, 'That does not look like the code'),
});

const breakGlassSchema = z.object({
  toUserId: z.string().regex(objectId),
  reason: z.string().min(10, 'Please say what the emergency is — this is kept permanently').max(300),
  approverUserIds: z.array(z.string().regex(objectId)).min(2, 'At least two other committee members must agree').max(10),
});

const objectSchema = z.object({
  note: z.string().max(300).optional(),
});

const SOCIETY_SIDE = [
  UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE,
  UserRole.RESIDENT_OWNER, UserRole.RESIDENT_TENANT,
];

/**
 * Every route here checks authority in the SERVICE, not in a role guard, and
 * that is deliberate rather than sloppy.
 *
 * The question is never "what role do you hold" — it is "are you the current
 * admin", "were you the one offered this", "are you three serving committee
 * members including the Chairman". A role guard cannot answer any of those,
 * and having one here would give the false impression that it had.
 *
 * The roles below are only a coarse outer fence: a shop owner has no business
 * on any of these endpoints at all.
 */
router.get('/', authorizeRoles(SOCIETY_SIDE), controller.status);
router.post('/', authorizeRoles(SOCIETY_SIDE), validate(initiateSchema), controller.initiate);
router.post('/cancel', authorizeRoles(SOCIETY_SIDE), controller.cancel);

router.post('/send-code', authorizeRoles(SOCIETY_SIDE), controller.sendCode);
router.post('/accept', authorizeRoles(SOCIETY_SIDE), validate(acceptSchema), controller.accept);
router.post('/decline', authorizeRoles(SOCIETY_SIDE), controller.decline);

router.post('/break-glass', authorizeRoles(SOCIETY_SIDE), validate(breakGlassSchema), controller.breakGlass);
router.post('/:id/object', authorizeRoles(SOCIETY_SIDE), validate(objectSchema), controller.object);

export default router;
