import mongoose from 'mongoose';
import { FinancePolicy } from '../models/finance-policy.model';
import { Expense } from '../models/expense.model';
import { FixedAsset } from '../models/fixed-asset.model';
import { Investment } from '../models/investment.model';
import { FinanceFund } from '../models/finance-fund.model';
import { ShareCertificate } from '../models/share-certificate.model';
import { Budget } from '../models/budget.model';
import { BankStatementLine } from '../models/bank-statement-line.model';
import { PostDatedCheque } from '../models/pdc.model';
import { DefaulterNotice } from '../models/defaulter-notice.model';
import { Refund } from '../models/refund.model';
import { JournalEntry } from '../models/journal-entry.model';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * The optional parts of the finance module.
 *
 * A twenty-flat society bills maintenance, takes payments and wants to be left
 * alone. It should not have to look at share registers, fixed deposits and bank
 * reconciliation to find the two screens it uses. These names let a society say
 * what it actually does.
 *
 * Deliberately NOT the same thing as `moduleKey` in the sidebar, which drives
 * system-employee permissions — reusing that would make finance vanish for an
 * employee who lacks a permission, which is a different question entirely.
 */
export const FINANCE_MODULES = [
  'EXPENSES', 'FUNDS', 'REFUNDS', 'SHARES', 'ASSETS', 'INVESTMENTS',
  'BUDGET', 'BANKING', 'PDC', 'NOTICES', 'ACCOUNTING', 'IMPORT',
] as const;
export type FinanceModule = typeof FINANCE_MODULES[number];

/**
 * What a society gets before it says otherwise. Nearly every Indian society
 * spends money and holds a sinking or corpus fund; almost none of them, on day
 * one, are reconciling bank statements or running a share register.
 */
export const DEFAULT_MODULES: FinanceModule[] = ['EXPENSES', 'FUNDS'];

export interface ModuleInfo {
  key: FinanceModule;
  label: string;
  blurb: string;
  /** Screens this switch shows or hides — so the setting can say what it does. */
  pages: string[];
}

export const MODULE_CATALOG: ModuleInfo[] = [
  { key: 'EXPENSES', label: 'Expenses & vendors', blurb: 'Record what the society spends and who it pays.', pages: ['Expenses'] },
  { key: 'FUNDS', label: 'Funds & reserves', blurb: 'Corpus, sinking and repair funds.', pages: ['Funds'] },
  { key: 'REFUNDS', label: 'Refunds', blurb: 'Give back advance credit a member has paid ahead.', pages: ['Refunds'] },
  { key: 'SHARES', label: 'Members & shares', blurb: 'The statutory share register. Required by co-operative law, but many societies keep it on paper.', pages: ['Members & Shares'] },
  { key: 'ASSETS', label: 'Fixed assets & depreciation', blurb: 'Lifts, pumps and furniture, and writing down their value each year.', pages: ['Fixed Assets'] },
  { key: 'INVESTMENTS', label: 'Fixed deposits', blurb: 'FDs and the interest they earn.', pages: ['Fixed Deposits'] },
  { key: 'BUDGET', label: 'Budgeting', blurb: 'Plan the year and track spending against it.', pages: ['Budget'] },
  { key: 'BANKING', label: 'Bank reconciliation', blurb: 'Tick your books off against the bank statement.', pages: ['Bank Reconciliation'] },
  { key: 'PDC', label: 'Post-dated cheques', blurb: 'Cheques held for a future date.', pages: ['Post-dated Cheques'] },
  { key: 'NOTICES', label: 'Defaulter notices & recovery', blurb: 'Formal notices and recovery filings for members who do not pay.', pages: ['Defaulter Notices'] },
  { key: 'ACCOUNTING', label: 'Full accounting tools', blurb: 'The chart of accounts, manual vouchers and opening balances. For a treasurer who knows double-entry.', pages: ['Chart of Accounts', 'Vouchers & Journal', 'Opening Balances'] },
  { key: 'IMPORT', label: 'Bulk import', blurb: 'Load flats, members or opening dues from a spreadsheet. Mostly useful once, at setup.', pages: ['Bulk Import'] },
];

const isValid = (m: string): m is FinanceModule => (FINANCE_MODULES as readonly string[]).includes(m);

/**
 * Work out which modules a society is already using, from its data.
 *
 * Only ever runs once, for a society that has never chosen. Without it, turning
 * this feature on would hide screens from societies already using them — the
 * change would read as data loss even though nothing was lost.
 */
async function inferFromData(societyId: string): Promise<FinanceModule[]> {
  const s = oid(societyId);
  const [expenses, assets, investments, funds, shares, budgets, bankLines, pdcs, notices, refunds, manualVouchers] =
    await Promise.all([
      Expense.countDocuments({ societyId: s }),
      FixedAsset.countDocuments({ societyId: s }),
      Investment.countDocuments({ societyId: s }),
      FinanceFund.countDocuments({ societyId: s }),
      ShareCertificate.countDocuments({ societyId: s }),
      Budget.countDocuments({ societyId: s }),
      BankStatementLine.countDocuments({ societyId: s }),
      PostDatedCheque.countDocuments({ societyId: s }),
      DefaulterNotice.countDocuments({ societyId: s }),
      Refund.countDocuments({ societyId: s }),
      JournalEntry.countDocuments({ societyId: s, voucherType: { $in: ['JOURNAL', 'OPENING', 'CONTRA'] } }),
    ]);

  const on = new Set<FinanceModule>(DEFAULT_MODULES);
  if (expenses > 0) on.add('EXPENSES');
  if (assets > 0) on.add('ASSETS');
  if (investments > 0) on.add('INVESTMENTS');
  if (funds > 0) on.add('FUNDS');
  if (shares > 0) on.add('SHARES');
  if (budgets > 0) on.add('BUDGET');
  if (bankLines > 0) on.add('BANKING');
  if (pdcs > 0) on.add('PDC');
  if (notices > 0) on.add('NOTICES');
  if (refunds > 0) on.add('REFUNDS');
  // A manual voucher means somebody is doing real bookkeeping here — leave them
  // their tools. Automatic invoice/receipt vouchers don't count.
  if (manualVouchers > 0) on.add('ACCOUNTING');
  return [...on];
}

/**
 * The modules a society has switched on, deciding once from its data if it has
 * never said. Persisted so the answer is stable and cheap to read.
 */
export async function resolveModules(societyId: string): Promise<FinanceModule[]> {
  const policy = await FinancePolicy.findOne({ societyId }).select('modules').lean();
  if (policy?.modules?.length) return policy.modules.filter(isValid);

  const inferred = await inferFromData(societyId);
  // Best-effort: a society with no policy yet still gets a sensible answer,
  // and the write is not worth failing the request over.
  await FinancePolicy.updateOne({ societyId }, { $set: { modules: inferred } }).catch(() => undefined);
  return inferred;
}

/** Is one module on? Used by callers that need to gate a single screen. */
export async function hasModule(societyId: string, module: FinanceModule): Promise<boolean> {
  return (await resolveModules(societyId)).includes(module);
}
