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
import * as fixedAssetsController from '../controllers/fixed-assets.controller';
import * as investmentsController from '../controllers/investments.controller';
import * as settlementController from '../controllers/settlement.controller';
import * as reportsController from '../controllers/reports.controller';
import * as shareCapitalController from '../controllers/share-capital.controller';
import * as budgetController from '../controllers/budget.controller';
import * as defaulterNoticeController from '../controllers/defaulter-notice.controller';
import * as pdcController from '../controllers/pdc.controller';
import * as adjustmentsController from '../controllers/adjustments.controller';
import * as bankReconciliationController from '../controllers/bank-reconciliation.controller';
import * as bulkImportController from '../controllers/bulk-import.controller';
import { uploadSpreadsheet } from '../middlewares/upload.middleware';
import {
  updateFinanceSettingsSchema,
  setupBankDetailsSchema,
  generateBillsSchema,
  rejectOfflinePaymentSchema,
  createFundSchema,
  postJournalSchema,
  createAccountSchema,
  updateAccountSchema,
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
  createAssetSchema,
  updateAssetSchema,
  runDepreciationSchema,
  disposeAssetSchema,
  reverseDepreciationSchema,
  createInvestmentSchema,
  updateInvestmentSchema,
  runInterestAccrualSchema,
  closeInvestmentSchema,
  updateSettlementSchema,
  importBankStatementSchema,
  autoMatchBankSchema,
  matchBankLineSchema,
  issueSharesSchema,
  transferSharesSchema,
  issueNoticeSchema,
  resolveNoticeSchema,
  registerPdcSchema,
  depositPdcSchema,
  pdcStatusSchema,
  adjustInvoiceSchema,
  requestRefundSchema,
  bulkImportSchema,
  upsertBudgetSchema,
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
// No /funds/reconcile: fund balances are derived from their ledger accounts on
// read, so there is nothing left to reconcile.

// Bank Reconciliation (Phase C) — the statement that proves the bank balance.
router.get('/bank/accounts', authorizeRoles(ADMIN_AND_COMMITTEE), bankReconciliationController.listBankAccounts);
router.get('/bank/reconciliation', authorizeRoles(ADMIN_AND_COMMITTEE), bankReconciliationController.getReconciliation);
router.post('/bank/import', authorizeRoles(ADMIN_ROLES), validate(importBankStatementSchema), bankReconciliationController.importStatement);
router.post('/bank/auto-match', authorizeRoles(ADMIN_ROLES), validate(autoMatchBankSchema), bankReconciliationController.autoMatch);
router.post('/bank/lines/:id/match', authorizeRoles(ADMIN_ROLES), validate(matchBankLineSchema), bankReconciliationController.matchLine);
router.post('/bank/lines/:id/unmatch', authorizeRoles(ADMIN_ROLES), bankReconciliationController.unmatchLine);
router.post('/bank/lines/:id/ignore', authorizeRoles(ADMIN_ROLES), bankReconciliationController.ignoreLine);

// Members & Shares (Phase C) — the statutory register of members.
router.get('/shares', authorizeRoles(ADMIN_AND_COMMITTEE), shareCapitalController.register);
router.post('/shares', authorizeRoles(ADMIN_ROLES), validate(issueSharesSchema), shareCapitalController.issue);
router.post('/shares/:id/transfer', authorizeRoles(ADMIN_ROLES), validate(transferSharesSchema), shareCapitalController.transfer);

// Budget (Phase D) — what the general body sanctioned, and how the year ran
// against it. Setting and approving a budget is the committee's own act, so
// writes are admin-only; the variance is a report and reads like one.
router.get('/budget', authorizeRoles(ADMIN_AND_COMMITTEE), budgetController.current);
router.put('/budget', authorizeRoles(ADMIN_ROLES), validate(upsertBudgetSchema), budgetController.upsert);
router.post('/budget/:fy/approve', authorizeRoles(ADMIN_ROLES), budgetController.approve);
router.get('/reports/budget-vs-actual', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.budgetVsActual);

// Defaulter Notices & Recovery (Phase D) — the written trail recovery depends on.
router.get('/notices', authorizeRoles(ADMIN_AND_COMMITTEE), defaulterNoticeController.list);
router.post('/notices', authorizeRoles(ADMIN_ROLES), validate(issueNoticeSchema), defaulterNoticeController.issue);
router.post('/notices/:id/resolve', authorizeRoles(ADMIN_ROLES), validate(resolveNoticeSchema), defaulterNoticeController.resolve);
router.get('/notices/:id/pdf', authorizeRoles(ADMIN_AND_COMMITTEE), defaulterNoticeController.pdf);

// Post-dated Cheques (Phase D) — held, not banked. Nothing posts until deposit.
router.get('/pdc', authorizeRoles(ADMIN_AND_COMMITTEE), pdcController.list);
router.post('/pdc', authorizeRoles(ADMIN_ROLES), validate(registerPdcSchema), pdcController.register);
router.post('/pdc/:id/deposit', authorizeRoles(ADMIN_ROLES), validate(depositPdcSchema), pdcController.deposit);
router.post('/pdc/:id/status', authorizeRoles(ADMIN_ROLES), validate(pdcStatusSchema), pdcController.status);

// Bulk Import (Phase C) — onboard a whole society from a spreadsheet.
// Every write goes through `preview` first: the treasurer sees each row's
// verdict before anything is committed. `uploadExcel` is a no-op unless the
// request is multipart, so the same route takes a pasted CSV or a file.
router.get('/import/:kind/template', authorizeRoles(ADMIN_ROLES), bulkImportController.template);
router.post('/import/:kind/preview', authorizeRoles(ADMIN_ROLES), uploadSpreadsheet.single('file'), validate(bulkImportSchema), bulkImportController.preview);
router.post('/import/:kind/commit', authorizeRoles(ADMIN_ROLES), uploadSpreadsheet.single('file'), validate(bulkImportSchema), bulkImportController.commit);

// Adjustments & Refunds (Phase D) — money the society gives back or gives up.
router.get('/invoices/:id/rebate', authorizeRoles(ADMIN_AND_COMMITTEE), adjustmentsController.rebateSuggestion);
router.post('/invoices/:id/adjust', authorizeRoles(ADMIN_ROLES), validate(adjustInvoiceSchema), adjustmentsController.adjustInvoice);
router.get('/refunds', authorizeRoles(ADMIN_AND_COMMITTEE), adjustmentsController.listRefunds);
router.post('/refunds', authorizeRoles(ADMIN_AND_COMMITTEE), validate(requestRefundSchema), adjustmentsController.requestRefund);
router.post('/refunds/:id/pay', authorizeRoles(ADMIN_ROLES), adjustmentsController.payRefund);
router.post('/refunds/:id/reject', authorizeRoles(ADMIN_ROLES), validate(rejectOfflinePaymentSchema), adjustmentsController.rejectRefund);

// Finance Policy (Phase 2 config)
// Modules drive the sidebar, so committee members need it too.
router.get('/modules', authorizeRoles(ADMIN_AND_COMMITTEE), financePolicyController.getModules);
router.get('/policy', authorizeRoles(ADMIN_AND_COMMITTEE), financePolicyController.getPolicy);
router.put('/policy', authorizeRoles(ADMIN_ROLES), validate(updateFinancePolicySchema), financePolicyController.updatePolicy);

// Charge Heads (Phase 2)
router.get('/charge-heads', authorizeRoles(ADMIN_AND_COMMITTEE), chargeHeadController.listChargeHeads);
router.post('/charge-heads', authorizeRoles(ADMIN_ROLES), validate(createChargeHeadSchema), chargeHeadController.createChargeHeadController);
router.put('/charge-heads/:id', authorizeRoles(ADMIN_ROLES), validate(updateChargeHeadSchema), chargeHeadController.updateChargeHeadController);
router.delete('/charge-heads/:id', authorizeRoles(ADMIN_ROLES), chargeHeadController.deleteChargeHeadController);

// Reports (Phase 6/7) — read-only, admin + committee
router.get('/dashboard', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.dashboard);
router.get('/reports/financial-years', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.financialYears);
router.get('/reports/ledger/:code', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.accountLedger);
router.get('/reports/trial-balance', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.trialBalance);
router.get('/reports/income-expenditure', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.incomeExpenditure);
router.get('/reports/wing-wise', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.wingWise);
router.get('/reports/balance-sheet', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.balanceSheet);
router.get('/reports/receipts-payments', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.receiptsAndPayments);
router.get('/reports/defaulters', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.defaulters);
router.get('/reports/collection-register', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.collectionRegister);
router.get('/reports/fund-statement', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.fundStatement);
router.get('/reports/gst-register', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.gstRegister);
router.get('/reports/tds-register', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.tdsRegister);
// Must stay above ':key/export' — that route is a catch-all and would capture
// 'agm-pack' as a report key, then reject it as an unknown report.
router.get('/reports/agm-pack/export', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.exportAgmPack);
// Keep last: ':key' would otherwise swallow the named report routes above.
router.get('/reports/:key/export', authorizeRoles(ADMIN_AND_COMMITTEE), reportsController.exportReport);

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

// Fixed Assets & Depreciation (Phase C)
router.get('/assets', authorizeRoles(ADMIN_AND_COMMITTEE), fixedAssetsController.listAssetsController);
// Keep 'depreciation' above ':id' — a literal segment must not be captured as an id.
router.get('/assets/depreciation/preview', authorizeRoles(ADMIN_AND_COMMITTEE), fixedAssetsController.previewDepreciationController);
router.get('/assets/depreciation/runs', authorizeRoles(ADMIN_AND_COMMITTEE), fixedAssetsController.listDepreciationRunsController);
router.post('/assets/depreciation/run', authorizeRoles(ADMIN_ROLES), validate(runDepreciationSchema), fixedAssetsController.runDepreciationController);
router.post('/assets/depreciation/runs/:id/reverse', authorizeRoles(ADMIN_ROLES), validate(reverseDepreciationSchema), fixedAssetsController.reverseDepreciationRunController);
router.post('/assets', authorizeRoles(ADMIN_ROLES), validate(createAssetSchema), fixedAssetsController.createAssetController);
router.put('/assets/:id', authorizeRoles(ADMIN_ROLES), validate(updateAssetSchema), fixedAssetsController.updateAssetController);
router.post('/assets/:id/dispose', authorizeRoles(ADMIN_ROLES), validate(disposeAssetSchema), fixedAssetsController.disposeAssetController);

// Fixed Deposits & Investments (Phase D) — where a society's reserves actually sit.
router.get('/investments', authorizeRoles(ADMIN_AND_COMMITTEE), investmentsController.listInvestmentsController);
// Keep 'accrual' above ':id' — a literal segment must not be captured as an id.
router.get('/investments/accrual/preview', authorizeRoles(ADMIN_AND_COMMITTEE), investmentsController.previewInterestAccrualController);
router.post('/investments/accrual/run', authorizeRoles(ADMIN_ROLES), validate(runInterestAccrualSchema), investmentsController.runInterestAccrualController);
router.post('/investments', authorizeRoles(ADMIN_ROLES), validate(createInvestmentSchema), investmentsController.createInvestmentController);
router.put('/investments/:id', authorizeRoles(ADMIN_ROLES), validate(updateInvestmentSchema), investmentsController.updateInvestmentController);
router.post('/investments/:id/close', authorizeRoles(ADMIN_ROLES), validate(closeInvestmentSchema), investmentsController.closeInvestmentController);

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
// Keep 'seed' above ':id' — a literal segment must not be captured as an id.
router.post('/ledger/accounts/seed', authorizeRoles(ADMIN_ROLES), ledgerController.seedAccounts);
router.post('/ledger/accounts', authorizeRoles(ADMIN_ROLES), validate(createAccountSchema), ledgerController.createAccount);
router.put('/ledger/accounts/:id', authorizeRoles(ADMIN_ROLES), validate(updateAccountSchema), ledgerController.updateAccount);
router.delete('/ledger/accounts/:id', authorizeRoles(ADMIN_ROLES), ledgerController.deleteAccount);
router.get('/ledger/journal', authorizeRoles(ADMIN_AND_COMMITTEE), ledgerController.listJournal);
router.post('/ledger/journal', authorizeRoles(ADMIN_ROLES), validate(postJournalSchema), ledgerController.postManualJournal);
router.get('/ledger/trial-balance', authorizeRoles(ADMIN_AND_COMMITTEE), ledgerController.getTrialBalanceController);

export default router;
