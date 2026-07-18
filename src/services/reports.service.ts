import mongoose from 'mongoose';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Receipt } from '../models/receipt.model';
import { Expense } from '../models/expense.model';
import { Vendor } from '../models/vendor.model';
import { Block } from '../models/block.model';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';
import {
  accountMovements, accountMovementsByBlock, driftFrom, resolveFinancialYear, endOfDay, startOfDay, parseDate,
  AccountMovement, BlockMovement, DriftRow,
} from './reporting-period.service';
import { fyShort } from '../utils/financial-year.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const CASH_BANK = ['1100', '1110', '1120', '1300'];

/**
 * Inclusive day window in local time.
 *
 * Both ends must use the same time base. `new Date('2026-04-01')` parses as UTC
 * midnight per spec, while `endOfDay` works in local time — so pairing them made
 * the window asymmetric and dropped entries posted in the first hours of `from`
 * (05:30 worth of them, for a server in IST).
 */
const dayWindow = (from?: string, to?: string) => {
  const m: { $gte?: Date; $lte?: Date } = {};
  if (from) m.$gte = startOfDay(parseDate(from, 'from'));
  if (to) m.$lte = endOfDay(parseDate(to, 'to'));
  return Object.keys(m).length ? m : undefined;
};

export interface ReportLine {
  code: string;
  name: string;
  amountPaise: number;
  previousAmountPaise?: number;
  /** Accounts grouped under this heading (e.g. Fixed Assets). */
  children?: ReportLine[];
}
export interface PeriodMeta { financialYear: string; from: string; to: string; previousFinancialYear: string }

const sum = (rows: { amountPaise: number }[]) => rows.reduce((s, r) => s + r.amountPaise, 0);
const sumPrevious = (rows: ReportLine[]) => rows.reduce((s, r) => s + (r.previousAmountPaise || 0), 0);

/**
 * What an account contributes to its own section of the Balance Sheet.
 *
 * Signed by the section's natural side, NOT by the account's own normalBalance —
 * that difference is the whole point. Accumulated Depreciation is an ASSET that
 * carries a CREDIT balance, so its `balancePaise` (signed the account's way) is
 * positive; summing assets that way would ADD the depreciation instead of netting
 * it off, overstating assets and tipping the sheet out of balance by twice the
 * amount, since the matching expense pulls the funding side the other way.
 */
const sectionAmount = (r: AccountMovement) =>
  (r.type === 'ASSET' || r.type === 'EXPENSE') ? r.debitPaise - r.creditPaise : r.creditPaise - r.debitPaise;

/**
 * One Balance Sheet section, grouped into schedules.
 *
 * An account with a `parentAccountId` is folded under that heading and the
 * heading reports the net of its children — so Fixed Assets shows cost less
 * depreciation, which is the figure a reader actually wants.
 */
function sectionSchedule(type: string, now: AccountMovement[], prev: AccountMovement[]): ReportLine[] {
  const current = now.filter(r => r.type === type);
  const prevById = new Map(prev.filter(r => r.type === type).map(p => [p.accountId, p]));
  const line = (r: AccountMovement): ReportLine => {
    const p = prevById.get(r.accountId);
    return {
      code: r.code,
      name: r.name,
      amountPaise: sectionAmount(r),
      previousAmountPaise: p ? sectionAmount(p) : 0,
    };
  };

  const byId = new Map(current.map(r => [r.accountId, r]));
  const kidsOf = new Map<string, AccountMovement[]>();
  const top: AccountMovement[] = [];
  for (const r of current) {
    // Only nest under a parent in the same section; a dangling parent id would
    // otherwise silently drop the account off the statement entirely.
    if (r.parentAccountId && byId.has(r.parentAccountId)) {
      kidsOf.set(r.parentAccountId, [...(kidsOf.get(r.parentAccountId) || []), r]);
    } else {
      top.push(r);
    }
  }

  const out: ReportLine[] = [];
  for (const r of top) {
    const children = (kidsOf.get(r.accountId) || [])
      .map(line)
      .filter(k => k.amountPaise !== 0 || k.previousAmountPaise !== 0)
      .sort((a, b) => a.code.localeCompare(b.code));
    const self = line(r);
    if (children.length) {
      // A heading carries no postings of its own — its figure is its children's net.
      out.push({
        ...self,
        amountPaise: self.amountPaise + sum(children),
        previousAmountPaise: (self.previousAmountPaise || 0) + sumPrevious(children),
        children,
      });
    } else if (self.amountPaise !== 0 || self.previousAmountPaise !== 0) {
      out.push(self);
    }
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Merge current and previous movements into comparative rows.
 *
 * Unions the two code sets. Filtering on the current period first would drop an
 * account that had activity last year but none this year — taking its comparative
 * with it, so the previous-year column would not add up to the same total that
 * running last year's report directly reports.
 */
function withComparative(current: AccountMovement[], previous: AccountMovement[]): ReportLine[] {
  const cur = new Map(current.map(c => [c.code, c]));
  const prev = new Map(previous.map(p => [p.code, p]));
  return [...new Set([...cur.keys(), ...prev.keys()])]
    .sort()
    .map(code => {
      const c = cur.get(code);
      const p = prev.get(code);
      return {
        code,
        name: c?.name || p?.name || code,
        amountPaise: c?.balancePaise || 0,
        previousAmountPaise: p?.balancePaise || 0,
      };
    })
    .filter(r => r.amountPaise !== 0 || r.previousAmountPaise !== 0);
}

/**
 * Trial Balance as at a date, derived from the journal.
 *
 * `balanced` is retained for display convention but is near-tautological: every
 * voucher is balanced at post time, so the columns always tie. The meaningful
 * integrity signal is `drift` — accounts whose cached balance no longer matches
 * the journal. That is the failure mode this system can actually have.
 */
export async function trialBalance(societyId: string, opts: { asOf?: string } = {}) {
  const to = opts.asOf ? endOfDay(parseDate(opts.asOf, 'asOf')) : undefined;
  const all = await accountMovements(societyId, { to });
  const rows = all
    // Balances only. A wash account (equal debits and credits) nets to zero and
    // would otherwise print as a meaningless 0/0 row. Deliberately not keyed off
    // `cachedBalancePaise`, which is inception-to-today and would leak accounts
    // with no activity yet at `asOf` into a historical trial balance.
    .filter(r => r.balancePaise !== 0)
    .map(r => ({
      code: r.code,
      name: r.name,
      type: r.type,
      debitPaise: r.balancePaise > 0 && r.normalBalance === 'DEBIT' ? r.balancePaise
        : r.balancePaise < 0 && r.normalBalance === 'CREDIT' ? -r.balancePaise : 0,
      creditPaise: r.balancePaise > 0 && r.normalBalance === 'CREDIT' ? r.balancePaise
        : r.balancePaise < 0 && r.normalBalance === 'DEBIT' ? -r.balancePaise : 0,
    }));
  const totalDebitPaise = rows.reduce((s, r) => s + r.debitPaise, 0);
  const totalCreditPaise = rows.reduce((s, r) => s + r.creditPaise, 0);
  // Drift compares a cached inception-to-date balance, so it only means anything
  // on a full-history run — and `all` already holds exactly those movements.
  const drift: DriftRow[] = opts.asOf ? [] : driftFrom(all);
  return {
    rows,
    totalDebitPaise,
    totalCreditPaise,
    balanced: totalDebitPaise === totalCreditPaise,
    drift,
    driftTotalPaise: drift.reduce((s, d) => s + Math.abs(d.driftPaise), 0),
  };
}

/**
 * Income & Expenditure for a financial year (accrual).
 *
 * Scoped to the FY window — reading cached balances here would silently sum every
 * year the society has ever run, which is what it used to do.
 */
export async function incomeExpenditure(societyId: string, opts: { fy?: string; fyStartMonth?: number } = {}) {
  const startMonth = opts.fyStartMonth ?? 4;
  const fy = resolveFinancialYear(opts.fy, startMonth);
  const prev = resolveFinancialYear(String(fy.startYear - 1), startMonth);

  const [rows, prevRows] = await Promise.all([
    accountMovements(societyId, { from: fy.fyStart, to: fy.fyEnd }, ['INCOME', 'EXPENSE']),
    accountMovements(societyId, { from: prev.fyStart, to: prev.fyEnd }, ['INCOME', 'EXPENSE']),
  ]);
  const byType = (t: string) => withComparative(rows.filter(r => r.type === t), prevRows.filter(r => r.type === t));
  const income = byType('INCOME');
  const expenses = byType('EXPENSE');
  const totalIncomePaise = sum(income);
  const totalExpensePaise = sum(expenses);

  // Mutuality split. What members contribute to their own society isn't taxable
  // income (the principle of mutuality); what the society earns from outside it —
  // bank/FD interest, tower rent — is. Without this split nobody can work out the
  // society's taxable income for its ITR-5.
  const taxableCodes = new Set(rows.filter(r => r.taxability === 'TAXABLE').map(r => r.code));
  const taxableIncomePaise = income.filter(r => taxableCodes.has(r.code)).reduce((s, r) => s + r.amountPaise, 0);

  return {
    period: {
      financialYear: fy.fyString,
      from: fy.fyStart.toISOString(),
      to: fy.fyEnd.toISOString(),
      previousFinancialYear: prev.fyString,
    } as PeriodMeta,
    income,
    expenses,
    totalIncomePaise,
    totalExpensePaise,
    surplusPaise: totalIncomePaise - totalExpensePaise,
    previousTotalIncomePaise: sumPrevious(income),
    previousTotalExpensePaise: sumPrevious(expenses),
    mutuality: {
      taxableIncomePaise,
      mutualIncomePaise: totalIncomePaise - taxableIncomePaise,
      taxableHeads: income.filter(r => taxableCodes.has(r.code)).map(r => r.name),
    },
  };
}

/**
 * Wing-wise Income & Expenditure — the cost-centre view.
 *
 * Answers the question a multi-wing committee actually argues about: what did
 * Tower A collect and spend against Tower B. Income comes free (every bill knows
 * its flat's wing); expenses only land on a wing if somebody tagged them.
 *
 * Deliberately does NOT apportion common costs across wings. Splitting a shared
 * security bill needs a rule the society must choose — by flats, by area, by
 * share — and inventing one here would produce numbers that look official and
 * aren't. Common sits in its own column, visible and unallocated, and the totals
 * still tie back to the society I&E. That last property is the point: a wing
 * report that doesn't reconcile to the statutory one is worse than none.
 */
export async function wingWiseIncomeExpenditure(societyId: string, opts: { fy?: string; fyStartMonth?: number } = {}) {
  const startMonth = opts.fyStartMonth ?? 4;
  const fy = resolveFinancialYear(opts.fy, startMonth);

  const [rows, blocks] = await Promise.all([
    accountMovementsByBlock(societyId, { from: fy.fyStart, to: fy.fyEnd }, ['INCOME', 'EXPENSE']),
    Block.find({ societyId }).select('name').sort({ name: 1 }).lean(),
  ]);

  const nameById = new Map(blocks.map((b: any) => [String(b._id), b.name as string]));
  const byBlock = new Map<string, BlockMovement[]>();
  for (const r of rows) {
    const key = r.blockId ?? '__common__';
    const list = byBlock.get(key);
    if (list) list.push(r); else byBlock.set(key, [r]);
  }

  const columnFor = (key: string, label: string) => {
    const rs = byBlock.get(key) || [];
    const lines = (t: string) => rs
      .filter(r => r.type === t)
      .map(r => ({ code: r.code, name: r.name, amountPaise: sectionAmount(r), previousAmountPaise: 0 }))
      .filter(l => l.amountPaise !== 0);
    const income = lines('INCOME');
    const expenses = lines('EXPENSE');
    const totalIncomePaise = income.reduce((s, l) => s + l.amountPaise, 0);
    const totalExpensePaise = expenses.reduce((s, l) => s + l.amountPaise, 0);
    return {
      blockId: key === '__common__' ? null : key,
      label,
      income,
      expenses,
      totalIncomePaise,
      totalExpensePaise,
      surplusPaise: totalIncomePaise - totalExpensePaise,
    };
  };

  // Every wing gets a column even with no activity — an absent wing reads as an
  // oversight, a zero column reads as a fact.
  const wings = blocks.map((b: any) => columnFor(String(b._id), b.name));

  // A wing on a line whose block was since deleted would otherwise vanish
  // silently, quietly breaking the tie-back to the society I&E.
  for (const key of byBlock.keys()) {
    if (key === '__common__' || nameById.has(key)) continue;
    wings.push(columnFor(key, 'Unknown wing'));
  }

  const common = columnFor('__common__', 'Common (not wing-specific)');
  const all = [...wings, common];

  return {
    period: {
      financialYear: fy.fyString,
      from: fy.fyStart.toISOString(),
      to: fy.fyEnd.toISOString(),
      previousFinancialYear: resolveFinancialYear(String(fy.startYear - 1), startMonth).fyString,
    } as PeriodMeta,
    wings,
    common,
    totals: {
      totalIncomePaise: all.reduce((s, c) => s + c.totalIncomePaise, 0),
      totalExpensePaise: all.reduce((s, c) => s + c.totalExpensePaise, 0),
      surplusPaise: all.reduce((s, c) => s + c.surplusPaise, 0),
    },
  };
}

/**
 * Balance Sheet as at a date (defaults to the current FY end).
 *
 * Balance-sheet items are inception-to-date; the surplus is split into
 * accumulated (everything before this FY started) and current-year — the format
 * an Indian society's auditor expects, and impossible to produce from a cache.
 */
export async function balanceSheet(societyId: string, opts: { fy?: string; asOf?: string; fyStartMonth?: number } = {}) {
  const startMonth = opts.fyStartMonth ?? 4;
  // An explicit as-of date wins; otherwise report as at the chosen FY's end (for
  // the current FY that date is in the future, which is harmless — no entries
  // exist beyond today, so the balances are today's).
  const fy = opts.asOf
    ? resolveFinancialYear(undefined, startMonth, endOfDay(parseDate(opts.asOf, 'asOf')))
    : resolveFinancialYear(opts.fy, startMonth);
  const asOf = opts.asOf ? endOfDay(parseDate(opts.asOf, 'asOf')) : fy.fyEnd;
  const prevEnd = new Date(fy.fyStart.getTime() - 1);

  // Two scans, not four: every figure below comes out of these. Each call unwinds
  // the whole journal, so the surpluses are derived arithmetically rather than by
  // re-querying — current-year surplus is just (inception→asOf) − (inception→prevEnd).
  const [allNow, allPrev] = await Promise.all([
    accountMovements(societyId, { to: asOf }),
    accountMovements(societyId, { to: prevEnd }),
  ]);
  const surplusOf = (rows: AccountMovement[]) =>
    rows.filter(r => r.type === 'INCOME').reduce((s, r) => s + sectionAmount(r), 0)
    - rows.filter(r => r.type === 'EXPENSE').reduce((s, r) => s + sectionAmount(r), 0);

  const accumulatedSurplusPaise = surplusOf(allPrev);
  const currentSurplusPaise = surplusOf(allNow) - accumulatedSurplusPaise;

  const pick = (t: string) => sectionSchedule(t, allNow, allPrev);
  const assets = pick('ASSET');
  const liabilities = pick('LIABILITY');
  const funds = pick('FUND');
  const equity = pick('EQUITY');

  const assetsTotalPaise = sum(assets);
  const fundingTotalPaise = sum(liabilities) + sum(funds) + sum(equity) + accumulatedSurplusPaise + currentSurplusPaise;

  return {
    asOf: asOf.toISOString(),
    financialYear: fy.fyString,
    assets, liabilities, funds, equity,
    accumulatedSurplusPaise,
    currentSurplusPaise,
    assetsTotalPaise,
    liabilitiesPlusFundsPlusEquityPaise: fundingTotalPaise,
    balanced: assetsTotalPaise === fundingTotalPaise,
    differencePaise: assetsTotalPaise - fundingTotalPaise,
    // The prior year as its own balanced statement. `surplusPaise` is that year's
    // CLOSING total surplus — which is exactly this year's accumulated surplus,
    // but naming it "accumulated" here too would mean two different things under
    // one key in the same payload.
    previous: {
      financialYear: `${fy.startYear - 1}-${fy.startYear}`,
      assetsTotalPaise: sumPrevious(assets),
      liabilitiesPlusFundsPlusEquityPaise:
        sumPrevious(liabilities) + sumPrevious(funds) + sumPrevious(equity) + accumulatedSurplusPaise,
      surplusPaise: accumulatedSurplusPaise,
    },
  };
}

/** Receipts & Payments (cash basis) for a period, head-wise by counter account. */
export async function receiptsAndPayments(societyId: string, from?: string, to?: string) {
  const period = dayWindow(from, to);
  const match: any = { societyId: oid(societyId) };
  if (period) match.entryDate = period;

  const sideAgg = (cashCond: 'debit' | 'credit') => JournalEntry.aggregate([
    { $match: match },
    { $match: { 'lines.accountCode': { $in: CASH_BANK } } },
    { $addFields: { cashMove: { $sum: { $map: { input: { $filter: { input: '$lines', as: 'l', cond: { $and: [{ $in: ['$$l.accountCode', CASH_BANK] }, { $gt: [cashCond === 'debit' ? '$$l.debitPaise' : '$$l.creditPaise', 0] }] } } }, as: 'l', in: cashCond === 'debit' ? '$$l.debitPaise' : '$$l.creditPaise' } } } } },
    { $match: { cashMove: { $gt: 0 } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountCode': { $nin: CASH_BANK } } },
    { $group: { _id: '$lines.accountCode', name: { $first: '$lines.accountName' }, amountPaise: { $sum: cashCond === 'debit' ? '$lines.creditPaise' : '$lines.debitPaise' } } },
    { $project: { _id: 0, code: '$_id', name: 1, amountPaise: 1 } },
    { $sort: { code: 1 } },
  ]);

  const [receipts, payments] = await Promise.all([sideAgg('debit'), sideAgg('credit')]);
  const totalReceipts = receipts.reduce((s: number, r: any) => s + r.amountPaise, 0);
  const totalPayments = payments.reduce((s: number, r: any) => s + r.amountPaise, 0);

  // Opening cash+bank before `from`
  let openingPaise = 0;
  if (from) {
    const opening = await JournalEntry.aggregate([
      // Must be the exact complement of dayWindow's `$gte`, or entries between the
      // two bases would be counted twice (or lost) across opening and receipts.
      { $match: { societyId: oid(societyId), entryDate: { $lt: startOfDay(parseDate(from, 'from')) } } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': { $in: CASH_BANK } } },
      { $group: { _id: null, net: { $sum: { $subtract: ['$lines.debitPaise', '$lines.creditPaise'] } } } },
    ]);
    openingPaise = opening[0]?.net || 0;
  }
  return { openingPaise, receipts, payments, totalReceiptsPaise: totalReceipts, totalPaymentsPaise: totalPayments, closingPaise: openingPaise + totalReceipts - totalPayments };
}

export interface AgingBuckets { current: number; d31_60: number; d61_90: number; d90plus: number }
const emptyBuckets = (): AgingBuckets => ({ current: 0, d31_60: 0, d61_90: 0, d90plus: 0 });

/** Which aging bucket an invoice falls in, by days since its due date. */
function bucketFor(dueDate: Date, asOf: Date): keyof AgingBuckets {
  const days = Math.floor((asOf.getTime() - new Date(dueDate).getTime()) / 86_400_000);
  if (days <= 30) return 'current';   // includes not-yet-due (negative days)
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90plus';
}

/**
 * Defaulter register with aging.
 *
 * Aging is the point of this report — "₹40,000 outstanding" means something very
 * different when it's this month's bill versus two years stale, and a committee
 * chasing recovery needs to see which. Buckets are by days past the due date.
 */
export async function defaulters(societyId: string, opts: { asOf?: string } = {}) {
  const asOf = opts.asOf ? endOfDay(parseDate(opts.asOf, 'asOf')) : new Date();
  const invoices = await MaintenanceInvoice.find({ societyId: oid(societyId), outstandingPaise: { $gt: 0 } })
    .select('flatId flatNumber blockName primaryOwnerName outstandingPaise dueDate invoiceNumber')
    .lean();

  const byFlat = new Map<string, {
    flatId: string; flatNumber: string; blockName: string; ownerName?: string;
    invoices: number; outstandingPaise: number; oldestDue: Date; buckets: AgingBuckets;
  }>();

  for (const inv of invoices) {
    const key = String(inv.flatId);
    const row = byFlat.get(key) || {
      flatId: key, flatNumber: inv.flatNumber, blockName: inv.blockName, ownerName: inv.primaryOwnerName,
      invoices: 0, outstandingPaise: 0, oldestDue: inv.dueDate, buckets: emptyBuckets(),
    };
    row.invoices += 1;
    row.outstandingPaise += inv.outstandingPaise;
    if (new Date(inv.dueDate) < new Date(row.oldestDue)) row.oldestDue = inv.dueDate;
    row.buckets[bucketFor(inv.dueDate, asOf)] += inv.outstandingPaise;
    byFlat.set(key, row);
  }

  const rows = [...byFlat.values()].sort((a, b) => b.outstandingPaise - a.outstandingPaise);
  const totals = rows.reduce((acc, r) => {
    (Object.keys(acc.buckets) as (keyof AgingBuckets)[]).forEach(k => { acc.buckets[k] += r.buckets[k]; });
    acc.totalPaise += r.outstandingPaise;
    return acc;
  }, { totalPaise: 0, buckets: emptyBuckets() });

  return { asOf: asOf.toISOString(), rows, totalPaise: totals.totalPaise, buckets: totals.buckets };
}

/** Collection register: cleared receipts for a period. */
export async function collectionRegister(societyId: string, from?: string, to?: string) {
  const q: any = { societyId: oid(societyId), status: 'CLEARED' };
  const period = dayWindow(from, to);
  if (period) q.receiptDate = period;
  const rows = await Receipt.find(q).sort({ receiptDate: 1 }).select('receiptNumber flatNumber blockName mode amountPaise receiptDate advanceCreatedPaise').lean();
  const totalPaise = rows.reduce((s, r) => s + r.amountPaise, 0);
  return { rows, totalPaise };
}

/**
 * Fund statement: FUND-type balances, derived from the journal.
 *
 * Deliberately journal-derived rather than reading the cached balance: the Funds
 * page derives too, and if this read the cache the same fund could print two
 * different numbers on two screens whenever the cache drifted.
 */
export async function fundStatement(societyId: string, opts: { asOf?: string } = {}) {
  const to = opts.asOf ? endOfDay(parseDate(opts.asOf, 'asOf')) : undefined;
  const rows = (await accountMovements(societyId, { to }, ['FUND']))
    .map(r => ({ code: r.code, name: r.name, balancePaise: r.balancePaise }));
  return { rows, totalPaise: rows.reduce((s, r) => s + r.balancePaise, 0) };
}

/**
 * GST output register — invoice-wise, bucketed by month.
 *
 * Built from the invoices themselves, not the GST-Output journal credits: a
 * return needs invoice number, date, taxable value, rate and the CGST/SGST split
 * per document, and a journal credit carries none of that. Monthly because GST
 * is filed monthly — grouping by financial year (as this used to) produced one
 * row per year, which no one can file.
 */
export async function gstRegister(societyId: string, from?: string, to?: string) {
  const q: any = { societyId: oid(societyId), gstPaise: { $gt: 0 } };
  const period = dayWindow(from, to);
  if (period) q.invoiceDate = period;
  const invoices = await MaintenanceInvoice.find(q)
    .select('invoiceNumber invoiceDate billingPeriod blockName flatNumber lineItems gstPaise')
    .sort({ invoiceDate: 1 })
    .lean();

  const rows = invoices.map(inv => {
    const taxable = (inv.lineItems || []).filter(l => l.gstApplicable).reduce((s, l) => s + l.baseAmountPaise, 0);
    const cgst = (inv.lineItems || []).reduce((s, l) => s + (l.cgstPaise || 0), 0);
    const sgst = (inv.lineItems || []).reduce((s, l) => s + (l.sgstPaise || 0), 0);
    const rated = (inv.lineItems || []).find(l => l.gstApplicable);
    return {
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      month: new Date(inv.invoiceDate).toISOString().slice(0, 7),
      flat: `${inv.blockName} ${inv.flatNumber}`.trim(),
      taxableValuePaise: taxable,
      ratePercent: rated?.gstRatePercent,
      sacCode: rated?.sacCode,
      cgstPaise: cgst,
      sgstPaise: sgst,
      gstPaise: inv.gstPaise,
    };
  });

  const monthMap = new Map<string, { month: string; invoices: number; taxableValuePaise: number; cgstPaise: number; sgstPaise: number; gstPaise: number }>();
  for (const r of rows) {
    const m = monthMap.get(r.month) || { month: r.month, invoices: 0, taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, gstPaise: 0 };
    m.invoices += 1; m.taxableValuePaise += r.taxableValuePaise;
    m.cgstPaise += r.cgstPaise; m.sgstPaise += r.sgstPaise; m.gstPaise += r.gstPaise;
    monthMap.set(r.month, m);
  }

  return {
    months: [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month)),
    rows,
    totalTaxableValuePaise: rows.reduce((s, r) => s + r.taxableValuePaise, 0),
    totalGstPaise: rows.reduce((s, r) => s + r.gstPaise, 0),
  };
}

/**
 * Every voucher behind one account, with a running balance — the drill-down for
 * a figure on a statement. Without this each report number is a dead end.
 */
export async function accountLedger(societyId: string, opts: { code: string; from?: string; to?: string }) {
  const account = await LedgerAccount.findOne({ societyId: oid(societyId), code: opts.code }).lean();
  if (!account) throw new Error(`Invalid account code '${opts.code}'`);

  const match: any = { societyId: oid(societyId) };
  const period = dayWindow(opts.from, opts.to);
  if (period) match.entryDate = period;

  // Opening: everything on this account before the window starts.
  let openingPaise = 0;
  if (period?.$gte) {
    const opening = await JournalEntry.aggregate([
      { $match: { societyId: oid(societyId), entryDate: { $lt: period.$gte } } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountId': account._id } },
      { $group: { _id: null, dr: { $sum: '$lines.debitPaise' }, cr: { $sum: '$lines.creditPaise' } } },
    ]);
    const dr = opening[0]?.dr || 0, cr = opening[0]?.cr || 0;
    openingPaise = account.normalBalance === 'DEBIT' ? dr - cr : cr - dr;
  }

  const entries = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': account._id } },
    { $sort: { entryDate: 1, voucherNumber: 1 } },
    {
      $project: {
        _id: 0,
        entryId: '$_id',
        voucherNumber: 1, voucherType: 1, entryDate: 1, narration: 1,
        debitPaise: '$lines.debitPaise',
        creditPaise: '$lines.creditPaise',
        description: '$lines.description',
        flatId: '$lines.flatId',
      },
    },
  ]);

  let running = openingPaise;
  const rows = entries.map((e: any) => {
    running += account.normalBalance === 'DEBIT' ? e.debitPaise - e.creditPaise : e.creditPaise - e.debitPaise;
    return { ...e, balancePaise: running };
  });

  return {
    account: { code: account.code, name: account.name, type: account.type, normalBalance: account.normalBalance },
    openingPaise,
    rows,
    closingPaise: running,
    totalDebitPaise: rows.reduce((s, r) => s + r.debitPaise, 0),
    totalCreditPaise: rows.reduce((s, r) => s + r.creditPaise, 0),
  };
}

/**
 * Financial years that actually have entries, newest first — drives the FY picker.
 *
 * Each entry carries its real date range, because only the server knows the
 * society's FY start month; the client would otherwise have to guess April to
 * turn "FY 2026-2027" into a from/to for the range-based registers.
 */
export async function availableFinancialYears(societyId: string, fyStartMonth = 4) {
  const years: string[] = await JournalEntry.distinct('financialYear', { societyId: oid(societyId) });
  const current = resolveFinancialYear(undefined, fyStartMonth).fyString;
  const financialYears = [...new Set([current, ...years])]
    .sort()
    .reverse()
    .map(fy => {
      const r = resolveFinancialYear(fy, fyStartMonth);
      return {
        fy: r.fyString,
        label: fyShort(r.fyString),
        from: r.fyStart.toISOString(),
        to: r.fyEnd.toISOString(),
      };
    });
  return { financialYears, current, fyStartMonth };
}

/** Indian TDS returns are quarterly: Q1 = Apr-Jun, regardless of the society's FY start. */
const tdsQuarter = (d: Date): string => {
  const m = new Date(d).getMonth() + 1; // 1-12
  const q = m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 && m <= 12 ? 'Q3' : 'Q4';
  const year = m >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  return `${q} ${year}-${String(year + 1).slice(-2)}`;
};

/**
 * TDS register — deductee-wise, which is what Form 26Q actually needs.
 *
 * Built from expenses joined to vendors so each row carries the deductee's PAN,
 * section and rate. This used to `$group: {_id: null}` the TDS-Payable credits
 * into a single scalar — a number you cannot file, attribute, or issue a Form
 * 16A from. Only APPROVED/PAID expenses appear: TDS is deducted when the expense
 * is accrued or paid, so a draft has deducted nothing.
 */
/**
 * Every vendor: what was billed in the period, what was withheld, what was paid,
 * and what the society still owes.
 *
 * Outstanding is taken from the LEDGER — the `2200 Sundry Creditors` lines
 * tagged with each vendor — not from the expense documents, because the ledger
 * is what the Balance Sheet reports. The total therefore reconciles to the
 * Creditors control account, and the suite asserts exactly that. Only the
 * Creditors leg is counted: an expense also debits 5xxx with the same vendor
 * tag, and counting both would double every bill.
 */
export async function vendorRegister(societyId: string, from?: string, to?: string) {
  const sid = oid(societyId);
  const period = dayWindow(from, to);

  const expenseMatch: any = { societyId: sid, status: { $nin: ['REJECTED', 'CANCELLED'] }, vendorId: { $ne: null } };
  if (period) expenseMatch.expenseDate = period;

  const [vendors, billed, ledger] = await Promise.all([
    Vendor.find({ societyId: sid }).select('name pan gstin tdsApplicable tdsSection tdsRatePercent isActive').sort({ name: 1 }).lean(),
    Expense.aggregate([
      { $match: expenseMatch },
      {
        $group: {
          _id: '$vendorId',
          billedPaise: { $sum: '$grossPaise' },
          tdsPaise: { $sum: '$tdsPaise' },
          bills: { $sum: 1 },
        },
      },
    ]),
    // Outstanding is a position, not a period figure, so it is never date-filtered:
    // a bill raised last year and still unpaid is money owed today.
    JournalEntry.aggregate([
      // $elemMatch, NOT `'lines.vendorId': { $ne: null }`.
      //
      // On an array, `$ne: null` means "NO element is null" — so a voucher was
      // excluded outright the moment any one of its lines lacked a vendor, which
      // is every payment (the bank leg) and every accrual carrying TDS. The
      // vendor's payments vanished while its accruals stayed, and the totals
      // still tied because the two excluded halves netted to zero.
      { $match: { societyId: sid, lines: { $elemMatch: { vendorId: { $exists: true, $ne: null } } } } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': ACCOUNT_CODES.CREDITORS, 'lines.vendorId': { $ne: null } } },
      {
        $group: {
          _id: '$lines.vendorId',
          creditPaise: { $sum: '$lines.creditPaise' },
          debitPaise: { $sum: '$lines.debitPaise' },
        },
      },
    ]),
  ]);

  const billedBy = new Map(billed.map((b: any) => [String(b._id), b]));
  const ledgerBy = new Map(ledger.map((l: any) => [String(l._id), l]));

  const rows = vendors.map(v => {
    const b: any = billedBy.get(String(v._id)) || {};
    const l: any = ledgerBy.get(String(v._id)) || {};
    const paidPaise = l.debitPaise || 0;
    return {
      vendorId: String(v._id),
      name: v.name,
      pan: v.pan,
      gstin: v.gstin,
      tds: v.tdsApplicable ? `${v.tdsSection || '—'} @ ${v.tdsRatePercent ?? 0}%` : null,
      /** Blocks Form 26Q — the same flag the TDS register raises. */
      missingPan: !!v.tdsApplicable && !v.pan,
      isActive: v.isActive !== false,
      bills: b.bills || 0,
      billedPaise: b.billedPaise || 0,
      tdsPaise: b.tdsPaise || 0,
      paidPaise,
      outstandingPaise: (l.creditPaise || 0) - paidPaise,
    };
  })
    // A vendor with no activity in the window and nothing owed is just noise.
    .filter(r => r.bills > 0 || r.outstandingPaise !== 0)
    .sort((a, b) => b.outstandingPaise - a.outstandingPaise || b.billedPaise - a.billedPaise);

  return {
    rows,
    totals: {
      billedPaise: rows.reduce((s, r) => s + r.billedPaise, 0),
      tdsPaise: rows.reduce((s, r) => s + r.tdsPaise, 0),
      paidPaise: rows.reduce((s, r) => s + r.paidPaise, 0),
      outstandingPaise: rows.reduce((s, r) => s + r.outstandingPaise, 0),
    },
    missingPanCount: rows.filter(r => r.missingPan).length,
  };
}

export async function tdsRegister(societyId: string, from?: string, to?: string) {
  const q: any = { societyId: oid(societyId), tdsPaise: { $gt: 0 }, status: { $in: ['APPROVED', 'PAID'] } };
  const period = dayWindow(from, to);
  if (period) q.expenseDate = period;

  const expenses = await Expense.find(q)
    .select('voucherNumber expenseDate vendorId vendorName grossPaise tdsPaise status')
    .sort({ expenseDate: 1 })
    .lean();

  const vendorIds = [...new Set(expenses.map(e => e.vendorId).filter(Boolean).map(String))];
  const vendors = vendorIds.length
    ? await Vendor.find({ _id: { $in: vendorIds }, societyId: oid(societyId) }).select('name pan tdsSection tdsRatePercent').lean()
    : [];
  const vendorById = new Map(vendors.map(v => [String(v._id), v]));

  const rows = expenses.map(e => {
    const v = e.vendorId ? vendorById.get(String(e.vendorId)) : undefined;
    return {
      voucherNumber: e.voucherNumber,
      expenseDate: e.expenseDate,
      quarter: tdsQuarter(e.expenseDate),
      vendorId: e.vendorId ? String(e.vendorId) : undefined,
      vendorName: v?.name || e.vendorName || '(no vendor)',
      pan: v?.pan,
      section: v?.tdsSection,
      ratePercent: v?.tdsRatePercent,
      grossPaise: e.grossPaise,
      tdsPaise: e.tdsPaise,
    };
  });

  // Per deductee — one line per vendor+section, the shape a 26Q annexure takes.
  const byDeductee = new Map<string, { vendorName: string; pan?: string; section?: string; deductions: number; grossPaise: number; tdsPaise: number }>();
  for (const r of rows) {
    const key = `${r.vendorId || r.vendorName}|${r.section || ''}`;
    const d = byDeductee.get(key) || { vendorName: r.vendorName, pan: r.pan, section: r.section, deductions: 0, grossPaise: 0, tdsPaise: 0 };
    d.deductions += 1; d.grossPaise += r.grossPaise; d.tdsPaise += r.tdsPaise;
    byDeductee.set(key, d);
  }

  const byQuarter = new Map<string, { quarter: string; deductions: number; tdsPaise: number }>();
  for (const r of rows) {
    const qq = byQuarter.get(r.quarter) || { quarter: r.quarter, deductions: 0, tdsPaise: 0 };
    qq.deductions += 1; qq.tdsPaise += r.tdsPaise;
    byQuarter.set(r.quarter, qq);
  }

  const missingPan = [...byDeductee.values()].filter(d => !d.pan).map(d => d.vendorName);

  return {
    rows,
    deductees: [...byDeductee.values()].sort((a, b) => b.tdsPaise - a.tdsPaise),
    quarters: [...byQuarter.values()].sort((a, b) => a.quarter.localeCompare(b.quarter)),
    totalGrossPaise: rows.reduce((s, r) => s + r.grossPaise, 0),
    totalTdsPaise: rows.reduce((s, r) => s + r.tdsPaise, 0),
    deductions: rows.length,
    // A deductee without a PAN attracts a higher rate and blocks the return —
    // worth surfacing rather than leaving the admin to find it at filing time.
    missingPan,
  };
}
