import { Router } from 'express';
import { register, login, loginOtpRequest, loginOtpVerify, refreshSessionToken, forgotPassword, resetPassword } from '../controllers/auth.controller';
import { requestOtpHandler, verifyOtpHandler } from '../controllers/otp.controller';

const router = Router();

router.post('/register', register);
// Password login (platform owner / staff). Tenant identities are passwordless → OTP.
router.post('/login', login);
router.post('/login/otp/request', loginOtpRequest);
router.post('/login/otp/verify', loginOtpVerify);
// NOTE: the old /select-context endpoint was removed — it minted tokens from a
// userId with no credential check. Context switching goes through /refresh-token
// (which requires the refresh token) instead.
router.post('/refresh-token', refreshSessionToken);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// OTP (society/shop/flat registration). Rate-limited by the dedicated /auth/otp limiter.
router.post('/otp/request', requestOtpHandler);
router.post('/otp/verify', verifyOtpHandler);

export default router;
