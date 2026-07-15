import { Router } from 'express';
import { BillingController } from '../controllers/billing.controller';
import { societyRazorpayWebhook } from '../controllers/settlement.controller';

const router = Router();

// Razorpay posts here. The raw body is preserved in app.ts so the HMAC signature
// can be verified. No JWT — authenticity is established by the signature.
router.post('/razorpay', BillingController.razorpayWebhook);

// Per-society webhook for OWN_KEYS settlement (verified with the society's own secret).
router.post('/razorpay/society/:societyId', societyRazorpayWebhook);

export default router;
