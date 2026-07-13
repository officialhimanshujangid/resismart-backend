import { Router } from 'express';
import { authenticateJWT } from '../middlewares/auth.middleware';
import { getMyContexts, getUnitSummary, getMyFlat } from '../controllers/me.controller';

const router = Router();

router.use(authenticateJWT);

router.get('/contexts', getMyContexts);
router.get('/unit-summary', getUnitSummary);
router.get('/flat', getMyFlat);

export default router;
