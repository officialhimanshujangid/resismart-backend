import { Router } from 'express';
import { authenticateJWT } from '../middlewares/auth.middleware';
import { getMyContexts, getUnitSummary, getMyFlat, getMyEntitlements } from '../controllers/me.controller';

const router = Router();

router.use(authenticateJWT);

router.get('/contexts', getMyContexts);
router.get('/unit-summary', getUnitSummary);
router.get('/flat', getMyFlat);
// The four gates in one answer — see the controller for why it is one call.
router.get('/entitlements', getMyEntitlements);

export default router;
