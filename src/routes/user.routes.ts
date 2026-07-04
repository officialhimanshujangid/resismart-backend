import { Router } from 'express';
import { authenticateJWT } from '../middlewares/auth.middleware';
import { getMyProfile, updateMyProfile } from '../controllers/user.controller';

const router = Router();

router.use(authenticateJWT);

router.get('/me', getMyProfile);
router.put('/me', updateMyProfile);

export default router;
