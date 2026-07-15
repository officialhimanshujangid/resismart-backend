import mongoose from 'mongoose';
import { Expense, IExpense } from '../models/expense.model';
import { Vendor } from '../models/vendor.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { postJournal, PostLineInput } from './ledger.service';
import { nextDocNumber } from './finance-sequence.service';
import { getOrCreatePolicy } from './finance-policy.service';
import { getFinancialYear } from '../utils/financial-year.util';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';

const depositForMode = (mode?: string) => mode === 'CASH' ? ACCOUNT_CODES.CASH : mode === 'CHEQUE' ? ACCOUNT_CODES.UNDEPOSITED_CHEQUES : ACCOUNT_CODES.BANK;

interface Actor { userId: string; userName: string; }

export async function createExpense(societyId: string, body: any, actor: Actor): Promise<IExpense> {
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const expenseDate = body.expenseDate ? new Date(body.expenseDate) : new Date();
  const { fyString } = getFinancialYear(expenseDate, startMonth);

  const lines = body.lineItems || [];
  const grossPaise = lines.reduce((s: number, l: any) => s + (l.amountPaise || 0), 0);

  let vendorName: string | undefined;
  let tdsPaise = 0;
  if (body.vendorId) {
    const vendor = await Vendor.findOne({ _id: body.vendorId, societyId });
    if (!vendor) throw new Error('Vendor not found');
    vendorName = vendor.name;
    if (vendor.tdsApplicable && vendor.tdsRatePercent) tdsPaise = Math.round(grossPaise * vendor.tdsRatePercent / 100);
  }
  if (typeof body.tdsPaise === 'number') tdsPaise = body.tdsPaise; // manual override
  const netPayablePaise = grossPaise - tdsPaise;

  // Snapshot expense-account names
  const codes = [...new Set(lines.map((l: any) => l.expenseAccountCode))];
  const accts = await LedgerAccount.find({ societyId, code: { $in: codes } }).select('code name').lean();
  const nameByCode = new Map(accts.map(a => [a.code, a.name]));

  const { number } = await nextDocNumber(societyId, 'PAYMENT', fyString, { prefix: policy.numbering.voucher.prefix, padding: policy.numbering.voucher.padding, template: policy.numbering.voucher.template });

  return Expense.create({
    societyId, voucherNumber: number, financialYear: fyString, expenseDate,
    vendorId: body.vendorId, vendorName, category: body.category, description: body.description,
    lineItems: lines.map((l: any) => ({ ...l, expenseAccountName: nameByCode.get(l.expenseAccountCode) })),
    grossPaise, tdsPaise, netPayablePaise,
    paymentMode: body.paymentMode,
    status: 'PENDING_APPROVAL',
    createdBy: actor.userId, createdByName: actor.userName,
  });
}

export async function approveExpense(societyId: string, id: string, actor: Actor): Promise<IExpense> {
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const threshold = policy.approvals?.expenseThresholdPaise ?? 0;
  const session = await mongoose.startSession();
  try {
    let out: IExpense;
    await session.withTransaction(async () => {
      const exp = await Expense.findOne({ _id: id, societyId }).session(session);
      if (!exp) throw new Error('Expense not found');
      if (exp.status !== 'PENDING_APPROVAL') throw new Error('Expense is not pending approval');
      if (threshold > 0 && exp.grossPaise >= threshold && exp.createdBy.toString() === actor.userId) {
        throw new Error('This expense exceeds the approval threshold and needs a different approver');
      }

      // Vendor expenses accrue to Creditors on approval; direct expenses post on payment.
      if (exp.vendorId) {
        const lines: PostLineInput[] = exp.lineItems.map(l => ({ accountCode: l.expenseAccountCode, debitPaise: l.amountPaise, vendorId: exp.vendorId, fundId: l.fundId, description: l.description }));
        if (exp.tdsPaise > 0) lines.push({ accountCode: ACCOUNT_CODES.TDS_PAYABLE, creditPaise: exp.tdsPaise, description: 'TDS withheld' });
        lines.push({ accountCode: ACCOUNT_CODES.CREDITORS, creditPaise: exp.netPayablePaise, vendorId: exp.vendorId, description: `Payable to ${exp.vendorName}` });
        const je = await postJournal(societyId, { voucherType: 'PAYMENT', voucherNumber: `${exp.voucherNumber}-ACC`, entryDate: exp.expenseDate, narration: `Expense ${exp.voucherNumber} accrual`, lines, sourceType: 'EXPENSE', sourceId: exp._id, postedBy: actor.userId, postedByName: actor.userName, fyStartMonth: startMonth }, session);
        exp.accrualJournalEntryId = je._id;
      }
      exp.status = 'APPROVED';
      exp.approvedBy = new mongoose.Types.ObjectId(actor.userId);
      exp.approvedByName = actor.userName;
      exp.approvedAt = new Date();
      await exp.save({ session });
      out = exp;
    });
    return out!;
  } finally { session.endSession(); }
}

export async function payExpense(societyId: string, id: string, actor: Actor, paymentMode?: string): Promise<IExpense> {
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const session = await mongoose.startSession();
  try {
    let out: IExpense;
    await session.withTransaction(async () => {
      const exp = await Expense.findOne({ _id: id, societyId }).session(session);
      if (!exp) throw new Error('Expense not found');
      if (exp.status !== 'APPROVED') throw new Error('Only an approved expense can be paid');
      const mode = paymentMode || exp.paymentMode || 'BANK';
      const deposit = depositForMode(mode);

      let lines: PostLineInput[];
      if (exp.vendorId) {
        // Settle the creditor.
        lines = [
          { accountCode: ACCOUNT_CODES.CREDITORS, debitPaise: exp.netPayablePaise, vendorId: exp.vendorId, description: `Paid ${exp.vendorName}` },
          { accountCode: deposit, creditPaise: exp.netPayablePaise, description: `Payment ${exp.voucherNumber}` },
        ];
      } else {
        // Direct expense: book expense + TDS + cash/bank in one voucher.
        lines = exp.lineItems.map(l => ({ accountCode: l.expenseAccountCode, debitPaise: l.amountPaise, fundId: l.fundId, description: l.description }));
        if (exp.tdsPaise > 0) lines.push({ accountCode: ACCOUNT_CODES.TDS_PAYABLE, creditPaise: exp.tdsPaise, description: 'TDS withheld' });
        lines.push({ accountCode: deposit, creditPaise: exp.netPayablePaise, description: `Payment ${exp.voucherNumber}` });
      }
      const je = await postJournal(societyId, { voucherType: 'PAYMENT', voucherNumber: exp.voucherNumber, entryDate: new Date(), narration: `Expense ${exp.voucherNumber} paid`, lines, sourceType: 'EXPENSE', sourceId: exp._id, postedBy: actor.userId, postedByName: actor.userName, fyStartMonth: startMonth }, session);
      exp.paymentJournalEntryId = je._id;
      exp.paymentMode = mode as any;
      exp.status = 'PAID';
      exp.paidAt = new Date();
      await exp.save({ session });
      out = exp;
    });
    return out!;
  } finally { session.endSession(); }
}

export async function rejectExpense(societyId: string, id: string, reason: string, actor: Actor): Promise<IExpense> {
  const exp = await Expense.findOne({ _id: id, societyId });
  if (!exp) throw new Error('Expense not found');
  if (!['PENDING_APPROVAL', 'DRAFT'].includes(exp.status)) throw new Error('Only a pending expense can be rejected');
  exp.status = 'REJECTED';
  exp.rejectionReason = reason;
  await exp.save();
  return exp;
}
