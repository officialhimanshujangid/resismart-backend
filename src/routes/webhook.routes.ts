import { Router } from 'express';
import { BillingController } from '../controllers/billing.controller';

const router = Router();

// Razorpay posts here. The raw body is preserved in app.ts so the HMAC signature
// can be verified. No JWT — authenticity is established by the signature.
router.post('/razorpay', BillingController.razorpayWebhook);

export default router;
