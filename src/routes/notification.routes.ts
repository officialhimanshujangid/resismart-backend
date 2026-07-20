import { Router } from 'express';
import { authenticateJWT, enforceTenantAccess } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import * as controller from '../controllers/notification.controller';
import {
  registerDeviceSchema, unregisterDeviceSchema, markReadSchema,
} from '../validators/notification.validator';

const router = Router();
router.use(authenticateJWT);
router.use(enforceTenantAccess);

/**
 * No `authorizeRoles` and no `requirePermission` anywhere in this file, and
 * that is deliberate rather than an omission.
 *
 * These are a person's OWN notifications and a person's OWN devices. Every
 * handler scopes to `req.user`, never to anything in the body or query, so
 * there is no wider set to be granted access to — a permission check here
 * could only ever stop somebody reading their own messages.
 */
router.get('/', controller.list);
router.post('/read', validate(markReadSchema), controller.markRead);

router.get('/config', controller.config);
router.post('/devices', validate(registerDeviceSchema), controller.registerDevice);
router.delete('/devices', validate(unregisterDeviceSchema), controller.unregisterDevice);

// Held open. Declared last so it is never mistaken for one of the above.
router.get('/stream', controller.stream);

export default router;
