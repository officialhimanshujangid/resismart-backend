import { Router } from 'express';
import { SettingsController } from '../controllers/settings.controller';
import { authenticateJWT, authorizeRoles } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

router.get('/', authenticateJWT, authorizeRoles([UserRole.SYSTEM_OWNER]), SettingsController.getSettings);
router.put('/', authenticateJWT, authorizeRoles([UserRole.SYSTEM_OWNER]), SettingsController.updateSettings);

export default router;
