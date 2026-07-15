import mongoose from 'mongoose';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Receipt } from '../models/receipt.model';
import { getTrialBalance } from './ledger.service';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const CASH_BANK = ['1100', '1110', '1120', '1300'];
const dateMatch = (from?: string, to?: string) => {
  const m: any = {};
  if (from) m.$gte = new Date(from);
  if (to) { const e = new Date(to); e.setHours(23, 59, 59, 999); m.$lte = e; }
  return Object.keys(m).length ? m : undefined;
};

export { getTrialBalance };

/** Income & Expenditure (accrual): income vs expense account balances → surplus/deficit. */
export async function incomeExpenditure(societyId: string) {
  const accts = await LedgerAccount.find({ societyId, type: { $in: ['INCOME', 'EXPENSE'] } }).sort({ code: 1 }).lean();
  const income = accts.filter(a => a.type === 'INCOME').map(a => ({ code: a.code, name: a.name, amountPaise: a.currentBalancePaise }));
  const expenses = accts.filter(a => a.type === 'EXPENSE').map(a => ({ code: a.code, name: a.name, amountPaise: a.currentBalancePaise }));
  const totalIncome = income.reduce((s, r) => s + r.amountPaise, 0);
  const totalExpense = expenses.reduce((s, r) => s + r.amountPaise, 0);
  return { income, expenses, totalIncomePaise: totalIncome, totalExpensePaise: totalExpense, surplusPaise: totalIncome - totalExpense };
}

/** Balance Sheet (as-of): assets vs liabilities + funds + equity (incl. current surplus). */
export async function balanceSheet(societyId: string) {
  const accts = await LedgerAccount.find({ societyId }).sort({ code: 1 }).lean();
  const pick = (t: string) => accts.filter(a => a.type === t).map(a => ({ code: a.code, name: a.name, amountPaise: a.currentBalancePaise }));
  const assets = pick('ASSET'); const liabilities = pick('LIABILITY'); const funds = pick('FUND'); const equity = pick('EQUITY');
  const totalIncome = accts.filter(a => a.type === 'INCOME').reduce((s, a) => s + a.currentBalancePaise, 0);
  const totalExpense = accts.filter(a => a.type === 'EXPENSE').reduce((s, a) => s + a.currentBalancePaise, 0);
  const surplusPaise = totalIncome - totalExpense;
  const assetsTotal = assets.reduce((s, r) => s + r.amountPaise, 0);
  const liabTotal = liabilities.reduce((s, r) => s + r.amountPaise, 0);
  const fundsTotal = funds.reduce((s, r) => s + r.amountPaise, 0);
  const equityTotal = equity.reduce((s, r) => s + r.amountPaise, 0);
  return {
    assets, liabilities, funds, equity,
    assetsTotalPaise: assetsTotal,
    liabilitiesPlusFundsPlusEquityPaise: liabTotal + fundsTotal + equityTotal + surplusPaise,
    currentSurplusPaise: surplusPaise,
    balanced: assetsTotal === liabTotal + fundsTotal + equityTotal + surplusPaise,
  };
}

/** Receipts & Payments (cash basis) for a period, head-wise by counter account. */
export async function receiptsAndPayments(societyId: string, from?: string, to?: string) {
  const period = dateMatch(from, to);
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
      { $match: { societyId: oid(societyId), entryDate: { $lt: new Date(from) } } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': { $in: CASH_BANK } } },
      { $group: { _id: null, net: { $sum: { $subtract: ['$lines.debitPaise', '$lines.creditPaise'] } } } },
    ]);
    openingPaise = opening[0]?.net || 0;
  }
  return { openingPaise, receipts, payments, totalReceiptsPaise: totalReceipts, totalPaymentsPaise: totalPayments, closingPaise: openingPaise + totalReceipts - totalPayments };
}

/** Defaulter register: flats with outstanding dues. */
export async function defaulters(societyId: string) {
  const rows = await MaintenanceInvoice.aggregate([
    { $match: { societyId: oid(societyId), outstandingPaise: { $gt: 0 } } },
    { $group: { _id: '$flatId', flatNumber: { $first: '$flatNumber' }, blockName: { $first: '$blockName' }, ownerName: { $first: '$primaryOwnerName' }, invoices: { $sum: 1 }, outstandingPaise: { $sum: '$outstandingPaise' }, oldestDue: { $min: '$dueDate' } } },
    { $sort: { outstandingPaise: -1 } },
  ]);
  const totalPaise = rows.reduce((s: number, r: any) => s + r.outstandingPaise, 0);
  return { rows, totalPaise };
}

/** Collection register: cleared receipts for a period. */
export async function collectionRegister(societyId: string, from?: string, to?: string) {
  const q: any = { societyId: oid(societyId), status: 'CLEARED' };
  const period = dateMatch(from, to);
  if (period) q.receiptDate = period;
  const rows = await Receipt.find(q).sort({ receiptDate: 1 }).select('receiptNumber flatNumber blockName mode amountPaise receiptDate advanceCreatedPaise').lean();
  const totalPaise = rows.reduce((s, r) => s + r.amountPaise, 0);
  return { rows, totalPaise };
}

/** Fund statement: FUND-type ledger account balances. */
export async function fundStatement(societyId: string) {
  const rows = await LedgerAccount.find({ societyId, type: 'FUND' }).sort({ code: 1 }).lean();
  return { rows: rows.map(r => ({ code: r.code, name: r.name, balancePaise: r.currentBalancePaise })), totalPaise: rows.reduce((s, r) => s + r.currentBalancePaise, 0) };
}

/** GST output register (Phase 7): GST charged on invoices, from journal GST-Output credits. */
export async function gstRegister(societyId: string, from?: string, to?: string) {
  const match: any = { societyId: oid(societyId), voucherType: 'INVOICE' };
  const period = dateMatch(from, to);
  if (period) match.entryDate = period;
  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.accountCode': '2300' } },
    { $group: { _id: '$financialYear', gstPaise: { $sum: '$lines.creditPaise' }, invoices: { $sum: 1 } } },
    { $project: { _id: 0, financialYear: '$_id', gstPaise: 1, invoices: 1 } },
  ]);
  const totalGstPaise = rows.reduce((s: number, r: any) => s + r.gstPaise, 0);
  return { rows, totalGstPaise };
}

/** TDS register (Phase 7): TDS withheld on vendor expenses, from journal TDS-Payable credits. */
export async function tdsRegister(societyId: string, from?: string, to?: string) {
  const match: any = { societyId: oid(societyId) };
  const period = dateMatch(from, to);
  if (period) match.entryDate = period;
  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.accountCode': '2310', 'lines.creditPaise': { $gt: 0 } } },
    { $group: { _id: null, tdsPaise: { $sum: '$lines.creditPaise' }, count: { $sum: 1 } } },
  ]);
  return { totalTdsPaise: rows[0]?.tdsPaise || 0, deductions: rows[0]?.count || 0 };
}
