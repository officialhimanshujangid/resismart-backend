import { Router } from 'express';
import { BillingController } from '../controllers/billing.controller';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { UserRole } from '../constants/roles';

const router = Router();

const OWNER = [UserRole.SYSTEM_OWNER, UserRole.SYSTEM_EMPLOYEE];

// --- Tenant admin billing (own tenant) ---
router.post('/checkout', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SHOP_ADMIN]), BillingController.checkoutRazorpay);
router.post('/verify-payment', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SHOP_ADMIN]), BillingController.verifyPayment);
router.get('/my-subscription', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SHOP_ADMIN]), BillingController.getMySubscription);
router.post('/cancel', authenticateJWT, enforceTenantAccess, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SHOP_ADMIN]), BillingController.cancelSubscription);

// Invoice history — admins (own tenant) and owners (any / by ?tenantId=)
router.get('/invoices/stats', authenticateJWT, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SHOP_ADMIN, ...OWNER]), BillingController.getInvoiceStats);
router.get('/invoices', authenticateJWT, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SHOP_ADMIN, ...OWNER]), BillingController.getInvoices);
router.get('/invoices/:id/download', authenticateJWT, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SHOP_ADMIN, ...OWNER]), BillingController.getInvoiceDownload);
router.get('/invoices/:id/status', authenticateJWT, authorizeRoles([UserRole.SOCIETY_ADMIN, UserRole.SHOP_ADMIN, ...OWNER]), BillingController.getInvoiceStatus);

// --- Owner only ---
router.post('/upgrade-preview', authenticateJWT, authorizeRoles(OWNER), BillingController.upgradePreview);
router.post('/assign-cash', authenticateJWT, authorizeRoles(OWNER), BillingController.assignCashPlan);
router.get('/subscriptions/stats', authenticateJWT, authorizeRoles(OWNER), BillingController.getSubscriptionStats);
router.get('/subscriptions', authenticateJWT, authorizeRoles(OWNER), BillingController.getSubscriptions);
router.post('/run-maintenance', authenticateJWT, authorizeRoles(OWNER), BillingController.runMaintenance);

export default router;
