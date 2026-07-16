import mongoose, { ClientSession } from 'mongoose';
import { Expense, IExpense } from '../models/expense.model';
import { Vendor } from '../models/vendor.model';
import { Block } from '../models/block.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { postJournal, PostLineInput } from './ledger.service';
import { nextDocNumber } from './finance-sequence.service';
import { getOrCreatePolicy } from './finance-policy.service';
import { getFinancialYear } from '../utils/financial-year.util';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';
import { fundAccount } from './funds.service';

const depositForMode = (mode?: string) => mode === 'CASH' ? ACCOUNT_CODES.CASH : mode === 'CHEQUE' ? ACCOUNT_CODES.UNDEPOSITED_CHEQUES : ACCOUNT_CODES.BANK;

interface Actor { userId: string; userName: string; }

/**
 * Debit lines for an expense's line items.
 *
 * A line tagged with a fund draws the money out of that fund's own account
 * instead of an expense head — utilising a reserve is not an expense of the year,
 * and it mirrors the credit side (fund contributions credit the FUND, not
 * income). Until now `fundId` was carried as a tag only, so spending never
 * reduced a fund and the balance could only ever go up.
 */
async function expenseDebitLines(
  societyId: string,
  exp: IExpense,
  actor: Actor,
  session: ClientSession,
  vendorId?: mongoose.Types.ObjectId,
): Promise<PostLineInput[]> {
  const lines: PostLineInput[] = [];
  // Serial, not Promise.all: the driver does not support concurrent operations
  // on one ClientSession inside a transaction.
  for (const l of exp.lineItems) {
    const base: PostLineInput = { debitPaise: l.amountPaise, fundId: l.fundId, blockId: l.blockId, vendorId, description: l.description };
    if (!l.fundId) { lines.push({ ...base, accountCode: l.expenseAccountCode }); continue; }
    const acct = await fundAccount(societyId, String(l.fundId), actor, session);
    lines.push({ ...base, accountId: acct._id as mongoose.Types.ObjectId });
  }
  return lines;
}

/**
 * TDS on one bill, honouring the section's thresholds.
 *
 * Tax is deducted once EITHER the single-bill limit is breached OR the vendor's
 * running total for the financial year crosses the aggregate limit — and when the
 * aggregate trips, it applies to the whole year's payments, not just this bill.
 * Deducting from rupee one (which is what happened before) over-deducts and leaves
 * the society explaining refunds to vendors who were never liable.
 */
/**
 * Is TDS switched on for this society?
 *
 * The switch existed in Settings from the start but nothing read it — deduction
 * ran purely off each vendor's own flag. So on first ask, infer the answer from
 * what the society actually does (any vendor set up for TDS ⇒ it was deducting,
 * so it stays on) and persist it. From then on the switch is authoritative and
 * means what it says.
 */
async function resolveTdsEnabled(societyId: string, policy: any): Promise<boolean> {
  if (policy.tds?.configured) return !!policy.tds.enabled;
  const inUse = await Vendor.countDocuments({ societyId, tdsApplicable: true });
  policy.set('tds.enabled', inUse > 0);
  policy.set('tds.configured', true);
  await policy.save();
  return inUse > 0;
}

async function computeTds(
  societyId: string,
  vendor: { _id: any; tdsRatePercent?: number; tdsThresholdSinglePaise?: number; tdsThresholdAnnualPaise?: number },
  grossPaise: number,
  expenseDate: Date,
  startMonth: number,
): Promise<number> {
  const rate = vendor.tdsRatePercent || 0;
  const single = vendor.tdsThresholdSinglePaise ?? 0;
  const annual = vendor.tdsThresholdAnnualPaise ?? 0;
  const rateOf = (p: number) => Math.round(p * rate / 100);

  if (single <= 0 && annual <= 0) return rateOf(grossPaise); // thresholds switched off

  let priorGross = 0;
  let priorTds = 0;
  if (annual > 0) {
    const { fyStart, fyEnd } = getFinancialYear(expenseDate, startMonth);
    const prior = await Expense.aggregate([
      {
        $match: {
          societyId: new mongoose.Types.ObjectId(societyId),
          vendorId: new mongoose.Types.ObjectId(String(vendor._id)),
          // Everything the society has actually received a bill for, approved or
          // not. Narrowing this to APPROVED/PAID looks tidier and is wrong: TDS
          // is computed once, here at creation, and the normal state of every
          // bill at that moment is PENDING_APPROVAL — so excluding it would
          // hide the year's running total from itself and under-deduct, which
          // is the expensive direction to be wrong in.
          status: { $nin: ['REJECTED', 'CANCELLED'] },
          expenseDate: { $gte: fyStart, $lte: fyEnd },
        },
      },
      { $group: { _id: null, gross: { $sum: '$grossPaise' }, tds: { $sum: '$tdsPaise' } } },
    ]);
    priorGross = prior[0]?.gross || 0;
    priorTds = prior[0]?.tds || 0;
  }

  // The aggregate test comes FIRST and wins. Once the year's total crosses the
  // limit, every payment to the vendor becomes liable — including earlier bills
  // that were under the single-bill limit and had nothing withheld. Deduct on the
  // whole year, less whatever was already taken, so the catch-up lands here.
  // Checking the single-bill limit first (as this used to) returned early and the
  // catch-up never happened, leaving the year under-deducted.
  if (annual > 0 && priorGross + grossPaise >= annual) {
    const due = Math.max(0, rateOf(priorGross + grossPaise) - priorTds);
    // Capped at the bill itself. On the bill that crosses the line the catch-up
    // covers the whole year, which can exceed a small bill outright — ₹99,000
    // then ₹2,000 at 10% wants ₹10,100 out of ₹2,000. You cannot withhold more
    // than you are paying: uncapped, net payable went negative and the model's
    // `min: 0` refused to record the bill at all. The shortfall stays in
    // `priorTds` arithmetic and is recovered from this vendor's next bill.
    return Math.min(due, grossPaise);
  }

  // Otherwise a bill big enough on its own is liable, but only for itself.
  if (single > 0 && grossPaise >= single) return rateOf(grossPaise);

  return 0; // under both limits — nothing to deduct yet
}

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
    // The society-wide switch wins over the per-vendor flag. Without this check,
    // turning "Deduct TDS on vendor payments" off in Settings deducted anyway —
    // a society with no TAN would withhold tax it cannot deposit.
    const tdsOn = await resolveTdsEnabled(societyId, policy);
    if (tdsOn && vendor.tdsApplicable && vendor.tdsRatePercent) {
      tdsPaise = await computeTds(societyId, vendor, grossPaise, expenseDate, startMonth);
    }
  }
  if (typeof body.tdsPaise === 'number') tdsPaise = body.tdsPaise; // manual override
  const netPayablePaise = grossPaise - tdsPaise;

  // Snapshot expense-account names
  const codes = [...new Set(lines.map((l: any) => l.expenseAccountCode))];
  const accts = await LedgerAccount.find({ societyId, code: { $in: codes } }).select('code name').lean();
  const nameByCode = new Map(accts.map(a => [a.code, a.name]));

  // Resolve wing tags. The form sends '' for "Common", which would CastError if
  // spread through untouched — and a blockId from another society would silently
  // file this cost under a wing that isn't ours, so both are checked here.
  const blockIds = [...new Set(lines.map((l: any) => l.blockId).filter((b: any) => !!b))].map(String);
  const blocks = blockIds.length
    ? await Block.find({ _id: { $in: blockIds }, societyId }).select('name').lean()
    : [];
  const blockById = new Map(blocks.map(b => [String(b._id), b.name]));
  for (const id of blockIds) if (!blockById.has(id)) throw new Error('Block not found');

  const { number } = await nextDocNumber(societyId, 'PAYMENT', fyString, { prefix: policy.numbering.voucher.prefix, padding: policy.numbering.voucher.padding, template: policy.numbering.voucher.template });

  return Expense.create({
    societyId, voucherNumber: number, financialYear: fyString, expenseDate,
    vendorId: body.vendorId, vendorName, category: body.category, description: body.description,
    lineItems: lines.map((l: any) => ({
      ...l,
      expenseAccountName: nameByCode.get(l.expenseAccountCode),
      blockId: l.blockId || undefined,
      blockName: l.blockId ? blockById.get(String(l.blockId)) : undefined,
    })),
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
        const lines: PostLineInput[] = await expenseDebitLines(societyId, exp, actor, session, exp.vendorId);
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
        lines = await expenseDebitLines(societyId, exp, actor, session);
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
