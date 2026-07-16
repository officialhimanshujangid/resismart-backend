import mongoose from 'mongoose';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Receipt } from '../models/receipt.model';
import { Expense } from '../models/expense.model';
import { ChargeHead } from '../models/charge-head.model';
import { FinanceFund } from '../models/finance-fund.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { JournalEntry } from '../models/journal-entry.model';
import { accountMovements, resolveFinancialYear } from './reporting-period.service';
import { resolveModules } from './finance-modules.service';
import { defaulters } from './reports.service';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const CASH_BANK = [ACCOUNT_CODES.BANK, ACCOUNT_CODES.CASH, ACCOUNT_CODES.UNDEPOSITED_CHEQUES];

export interface StatutoryWarning { severity: 'WARN' | 'INFO'; message: string; href: string }

/**
 * Advisory checks against common co-operative bye-law limits.
 *
 * Deliberately warnings, never blocks: the limits vary by state and by the
 * society's own registered bye-laws, so software that refused to save would be
 * wrong somewhere. Telling a volunteer treasurer that 24% interest is above the
 * usual 21% cap is useful; overruling them is not.
 */
function statutoryWarnings(policy: any, billedThisFyPaise: number): StatutoryWarning[] {
  const out: StatutoryWarning[] = [];
  const lf = policy?.lateFee;
  if (lf?.enabled) {
    const annualised = lf.mode === 'PERCENT_PER_MONTH' ? (lf.ratePercent || 0) * 12 : (lf.ratePercent || 0);
    if (lf.mode !== 'FLAT' && annualised > 21) {
      out.push({
        severity: 'WARN',
        message: `Interest on arrears works out to ${annualised}% a year. Co-operative bye-laws commonly cap this at 21% simple — check yours before the next billing run.`,
        href: '/dashboard/finance/settings',
      });
    }
    if (lf.compounding === 'COMPOUND') {
      out.push({
        severity: 'WARN',
        message: 'Interest is set to compound. Most model bye-laws allow simple interest only.',
        href: '/dashboard/finance/settings',
      });
    }
  }
  const gst = policy?.gst;
  if (gst?.enabled && gst.registrationThresholdPaise > 0 && billedThisFyPaise > 0 && billedThisFyPaise < gst.registrationThresholdPaise) {
    out.push({
      severity: 'INFO',
      message: `You are charging GST, but this year's billing is below the ₹${(gst.registrationThresholdPaise / 100 / 100000).toFixed(0)} lakh registration threshold. A society under the limit generally need not register.`,
      href: '/dashboard/finance/settings',
    });
  }
  if (!gst?.enabled && billedThisFyPaise > (gst?.registrationThresholdPaise || Infinity)) {
    out.push({
      severity: 'WARN',
      message: 'This year\'s billing has passed the GST registration threshold but GST is switched off. Check whether the society now needs to register.',
      href: '/dashboard/finance/settings',
    });
  }
  return out;
}

/**
 * The finance home. Until now the sidebar dropped an admin straight into a list
 * of invoices with no sense of whether the society is actually collecting its
 * money — which is the one question a committee asks every month.
 */
export async function financeDashboard(societyId: string, fyStartMonth = 4) {
  const fy = resolveFinancialYear(undefined, fyStartMonth);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    movements, aged, fyBilled, fyCollected, monthBilled, monthCollected, pendingReceipts, pendingExpenses,
    chargeHeadCount, fundCount, openingCount, invoiceCount, policy,
  ] = await Promise.all([
      accountMovements(societyId),
      defaulters(societyId),
      MaintenanceInvoice.aggregate([
        { $match: { societyId: oid(societyId), invoiceDate: { $gte: fy.fyStart, $lte: fy.fyEnd } } },
        { $group: { _id: null, total: { $sum: '$totalPaise' }, count: { $sum: 1 } } },
      ]),
      Receipt.aggregate([
        { $match: { societyId: oid(societyId), status: 'CLEARED', receiptDate: { $gte: fy.fyStart, $lte: fy.fyEnd } } },
        { $group: { _id: null, total: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
      ]),
      MaintenanceInvoice.aggregate([
        { $match: { societyId: oid(societyId), invoiceDate: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: '$totalPaise' } } },
      ]),
      Receipt.aggregate([
        { $match: { societyId: oid(societyId), status: 'CLEARED', receiptDate: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: '$amountPaise' } } },
      ]),
      Receipt.countDocuments({ societyId: oid(societyId), status: 'PENDING_CONFIRMATION' }),
      Expense.countDocuments({ societyId: oid(societyId), status: 'PENDING_APPROVAL' }),
      ChargeHead.countDocuments({ societyId: oid(societyId), isActive: true }),
      FinanceFund.countDocuments({ societyId: oid(societyId) }),
      JournalEntry.countDocuments({ societyId: oid(societyId), voucherType: 'OPENING' }),
      MaintenanceInvoice.countDocuments({ societyId: oid(societyId) }),
      FinancePolicy.findOne({ societyId: oid(societyId) }).lean(),
    ]);

  const sumOf = (codes: string[]) =>
    movements.filter(m => codes.includes(m.code)).reduce((s, m) => s + m.balancePaise, 0);

  const billedPaise = fyBilled[0]?.total || 0;
  const collectedPaise = fyCollected[0]?.total || 0;

  return {
    financialYear: fy.fyString,
    cashAndBankPaise: sumOf(CASH_BANK),
    fundsPaise: movements.filter(m => m.type === 'FUND').reduce((s, m) => s + m.balancePaise, 0),
    outstandingPaise: aged.totalPaise,
    aging: aged.buckets,
    billedPaise,
    collectedPaise,
    // What share of what we billed this year has actually come in. The single
    // number that tells a committee whether recovery is working.
    collectionEfficiencyPercent: billedPaise > 0 ? Math.round((collectedPaise / billedPaise) * 100) : null,
    thisMonth: {
      billedPaise: monthBilled[0]?.total || 0,
      collectedPaise: monthCollected[0]?.total || 0,
    },
    pending: { receipts: pendingReceipts, expenses: pendingExpenses },
    // A resumable setup state rather than a one-shot wizard: societies onboard in
    // fits and starts, and an admin who abandons a wizard halfway has no way back in.
    //
    // `modules` rides along so the checklist can drop steps the society has
    // switched off. Without it, a society that legitimately keeps no funds and
    // starts fresh would be told it was "4 of 6 done" forever — nagged about work
    // it had correctly decided not to do.
    setup: {
      chargeHeads: chargeHeadCount,
      funds: fundCount,
      openingPosted: openingCount > 0,
      invoicesGenerated: invoiceCount,
      paymentsConfigured: Boolean(policy?.settlement?.upiId) || (policy?.settlement?.mode || 'OFFLINE_ONLY') !== 'OFFLINE_ONLY',
      modules: await resolveModules(societyId),
    },
    warnings: statutoryWarnings(policy, billedPaise),
    topDefaulters: aged.rows.slice(0, 5).map(r => ({
      flat: `${r.blockName} ${r.flatNumber}`.trim(),
      ownerName: r.ownerName,
      outstandingPaise: r.outstandingPaise,
      over90Paise: r.buckets.d90plus,
    })),
  };
}
