import { Router } from 'express';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import { UserRole } from '../constants/roles';
import * as residentFinanceController from '../controllers/resident-finance.controller';
import { reportOfflineReceiptSchema, payOnlineSchema } from '../validators/society-finance.validator';

const router = Router();

router.use(authenticateJWT);
router.use(enforceTenantAccess);

const RESIDENT_ROLES = [UserRole.RESIDENT_OWNER, UserRole.RESIDENT_TENANT, UserRole.FAMILY_MEMBER];

// Invoices & dues
router.get('/invoices', authorizeRoles(RESIDENT_ROLES), residentFinanceController.listMyInvoices);
router.get('/outstanding', authorizeRoles(RESIDENT_ROLES), residentFinanceController.getMyOutstanding);
router.get('/receipts', authorizeRoles(RESIDENT_ROLES), residentFinanceController.listMyReceipts);
router.get('/statement', authorizeRoles(RESIDENT_ROLES), residentFinanceController.getMyStatement);

// Pay
router.post('/pay-online', authorizeRoles(RESIDENT_ROLES), validate(payOnlineSchema), residentFinanceController.payOnline);
router.post('/report-offline', authorizeRoles(RESIDENT_ROLES), validate(reportOfflineReceiptSchema), residentFinanceController.reportOffline);

// PDFs
router.get('/invoices/:id/pdf', authorizeRoles(RESIDENT_ROLES), residentFinanceController.downloadMyInvoicePdf);
router.get('/receipts/:id/pdf', authorizeRoles(RESIDENT_ROLES), residentFinanceController.downloadMyReceiptPdf);

export default router;
