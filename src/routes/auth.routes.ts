import { Router } from 'express';
import { register, login, selectContext, refreshSessionToken } from '../controllers/auth.controller';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/select-context', selectContext);
router.post('/refresh-token', refreshSessionToken);

export default router;
