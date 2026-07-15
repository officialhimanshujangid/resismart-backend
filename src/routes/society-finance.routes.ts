import { Router } from 'express';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import { UserRole } from '../constants/roles';
import * as societyFinanceController from '../controllers/society-finance.controller';
import * as ledgerController from '../controllers/ledger.controller';
import * as chargeHeadController from '../controllers/charge-head.controller';
import * as financePolicyController from '../controllers/finance-policy.controller';
import * as invoiceController from '../controllers/maintenance-invoice.controller';
import * as collectionsController from '../controllers/collections.controller';
import * as expensesController from '../controllers/expenses.controller';
import * as settlementController from '../controllers/settlement.controller';
import * as reportsController from '../controllers/reports.controller';
import {
  updateFinanceSettingsSchema,
  setupBankDetailsSchema,
  generateBillsSchema,
  rejectOfflinePaymentSchema,
  createFundSchema,
  postJournalSchema,
  createChargeHeadSchema,
  updateChargeHeadSchema,
  updateFinancePolicySchema,
  generateInvoicesSchema,
  recordPaymentSchema,
  bounceReceiptSchema,
  createVendorSchema,
  updateVendorSchema,
  createExpenseSchema,
  payExpenseSchema,
  updateSettlementSchema,
} from '../validators/society-finance.validator';

const router = Router();

// Apply auth and tenant access to all routes
router.use(authenticateJWT);
router.use(enforceTenantAccess);

// Society Admin & Committee Roles
const ADMIN_ROLES = [UserRole.SOCIETY_ADMIN];
const ADMIN_AND_COMMITTEE = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE];

// Settings
router.get('/settings', authorizeRoles(ADMIN_ROLES), societyFinanceController.getSettings);
router.put('/settings', authorizeRoles(ADMIN_ROLES), validate(updateFinanceSettingsSchema), societyFinanceController.updateSettings);
router.post('/settings/bank-details', authorizeRoles(ADMIN_ROLES), validate(setupBankDetailsSchema), societyFinanceController.setupBankDetails);

// Bills
router.post('/bills/generate', authorizeRoles(ADMIN_ROLES), validate(generateBillsSchema), societyFinanceController.generateBills);
router.get('/bills', authorizeRoles(ADMIN_AND_COMMITTEE), societyFinanceController.listBills);
router.get('/bills/summary', authorizeRoles(ADMIN_AND_COMMITTEE), societyFinanceController.getBillSummary);

// Payments & Confirmations
router.get('/payments/pending-confirmation', authorizeRoles(ADMIN_AND_COMMITTEE), societyFinanceController.listPendingConfirmations);
router.post('/payments/:paymentId/confirm', authorizeRoles(ADMIN_AND_COMMITTEE), societyFinanceController.confirmOfflinePayment);
router.post('/payments/:paymentId/reject', authorizeRoles(ADMIN_AND_COMMITTEE), validate(rejectOfflinePaymentSchema), societyFinanceController.rejectOfflinePayment);

// Funds Management
router.get('/funds', authorizeRoles(ADMIN_AND_COMMITTEE), societyFinanceController.getFunds);
router.post('/funds', authorizeRoles(ADMIN_ROLES), validate(createFundSchema), societyFinanceController.createFund);
router.post('/funds/reconcile', authorizeRoles(ADMIN_AND_COMMITTEE), societyFinanceController.reconcileFundsController);

// Finance Policy (Phase 2 config)
router.get('/policy', authorizeRoles(ADMIN_AND_COMMITTEE), financePolicyController.getPolicy);
router.put('/policy', authorizeRoles(ADMIN_ROLES), validate(updateFinancePolicySchema), financePolicyController.updatePolicy);

// Charge Heads (Phase 2)
router.get('/charge-heads', authorizeRoles(ADMIN_AND_COMMITTEE), chargeHeadController.listChargeHeads);
router.post('/charge-heads', authorizeRoles(ADMIN_ROLES), validate(createChargeHeadSchema), chargeHeadController.createChargeHeadController);
router.put('/charge-heads/:id', authorizeRoles(ADMIN_ROLES), validate(updateChargeHeadSchema), chargeHeadController.updateChargeHeadController);
router.delete('/charge-heads/:id', authorizeRoles(ADMIN_ROLES), chargeHeadController.deleteChargeHeadController);

// Reports (Phase 6/7) — read-only, admin + committee
router.get('/reports/trial-balance', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.trialBalance);
router.get('/reports/income-expenditure', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.incomeExpenditure);
router.get('/reports/balance-sheet', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.balanceSheet);
router.get('/reports/receipts-payments', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.receiptsAndPayments);
router.get('/reports/defaulters', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.defaulters);
router.get('/reports/collection-register', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.collectionRegister);
router.get('/reports/fund-statement', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.fundStatement);
router.get('/reports/gst-register', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.gstRegister);
router.get('/reports/tds-register', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.tdsRegister);

// Settlement (Phase 5)
router.get('/settlement', authorizeRoles(ADMIN_ROLES), settlementController.getSettlement);
router.put('/settlement', authorizeRoles(ADMIN_ROLES), validate(updateSettlementSchema), settlementController.updateSettlement);

// Vendors & Expenses (Phase 4)
router.get('/vendors', authorizeRoles(ADMIN_AND_COMMITTEE), expensesController.listVendors);
router.post('/vendors', authorizeRoles(ADMIN_ROLES), validate(createVendorSchema), expensesController.createVendor);
router.put('/vendors/:id', authorizeRoles(ADMIN_ROLES), validate(updateVendorSchema), expensesController.updateVendor);
router.get('/expenses', authorizeRoles(ADMIN_AND_COMMITTEE), expensesController.listExpenses);
router.get('/expenses/summary', authorizeRoles(ADMIN_AND_COMMITTEE), expensesController.getExpenseSummary);
router.post('/expenses', authorizeRoles(ADMIN_AND_COMMITTEE), validate(createExpenseSchema), expensesController.createExpenseController);
router.post('/expenses/:id/approve', authorizeRoles(ADMIN_ROLES), expensesController.approveExpenseController);
router.post('/expenses/:id/pay', authorizeRoles(ADMIN_ROLES), validate(payExpenseSchema), expensesController.payExpenseController);
router.post('/expenses/:id/reject', authorizeRoles(ADMIN_ROLES), validate(rejectOfflinePaymentSchema), expensesController.rejectExpenseController);

// Collections & Receipts (Phase 3)
router.get('/collections/receipts', authorizeRoles(ADMIN_AND_COMMITTEE), collectionsController.listReceipts);
router.get('/collections/pending', authorizeRoles(ADMIN_AND_COMMITTEE), collectionsController.listPendingReceipts);
router.get('/collections/flat/:flatId/outstanding', authorizeRoles(ADMIN_AND_COMMITTEE), collectionsController.getFlatOutstanding);
router.post('/collections/record', authorizeRoles(ADMIN_AND_COMMITTEE), validate(recordPaymentSchema), collectionsController.recordPayment);
router.post('/collections/receipts/:id/confirm', authorizeRoles(ADMIN_AND_COMMITTEE), collectionsController.confirmReceiptController);
router.post('/collections/receipts/:id/reject', authorizeRoles(ADMIN_AND_COMMITTEE), validate(rejectOfflinePaymentSchema), collectionsController.rejectReceiptController);
router.post('/collections/receipts/:id/bounce', authorizeRoles(ADMIN_ROLES), validate(bounceReceiptSchema), collectionsController.bounceReceiptController);
router.post('/collections/receipts/:id/deposit', authorizeRoles(ADMIN_AND_COMMITTEE), collectionsController.depositChequeController);
router.get('/collections/receipts/:id/pdf', authorizeRoles(ADMIN_AND_COMMITTEE), collectionsController.downloadReceiptPdf);

// Maintenance Invoices (Phase 2 consolidated invoicing)
router.post('/invoices/generate', authorizeRoles(ADMIN_ROLES), validate(generateInvoicesSchema), invoiceController.generateInvoices);
router.get('/invoices', authorizeRoles(ADMIN_AND_COMMITTEE), invoiceController.listInvoices);
router.get('/invoices/summary', authorizeRoles(ADMIN_AND_COMMITTEE), invoiceController.getInvoiceSummary);
router.get('/invoices/:id', authorizeRoles(ADMIN_AND_COMMITTEE), invoiceController.getInvoiceDetail);
router.get('/invoices/:id/pdf', authorizeRoles(ADMIN_AND_COMMITTEE), invoiceController.downloadInvoicePdf);

// Ledger / General Accounting (Phase 1 GL core)
router.get('/ledger/accounts', authorizeRoles(ADMIN_AND_COMMITTEE), ledgerController.listAccounts);
router.post('/ledger/accounts/seed', authorizeRoles(ADMIN_ROLES), ledgerController.seedAccounts);
router.get('/ledger/journal', authorizeRoles(ADMIN_AND_COMMITTEE), ledgerController.listJournal);
router.post('/ledger/journal', authorizeRoles(ADMIN_ROLES), validate(postJournalSchema), ledgerController.postManualJournal);
router.get('/ledger/trial-balance', authorizeRoles(ADMIN_AND_COMMITTEE), ledgerController.getTrialBalanceController);

export default router;
