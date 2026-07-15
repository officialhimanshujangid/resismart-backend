import mongoose, { ClientSession } from 'mongoose';
import { LedgerAccount, ILedgerAccount } from '../models/ledger-account.model';
import { JournalEntry, VoucherType, JournalSourceType } from '../models/journal-entry.model';
import { getFinancialYear, formatDocNumber } from '../utils/financial-year.util';
import { nextSequence } from './finance-sequence.service';

export interface PostLineInput {
  accountId?: string | mongoose.Types.ObjectId;
  accountCode?: string; // alternative to accountId — resolved per society
  debitPaise?: number;
  creditPaise?: number;
  flatId?: mongoose.Types.ObjectId | string;
  vendorId?: mongoose.Types.ObjectId | string;
  fundId?: mongoose.Types.ObjectId | string;
  description?: string;
}

export interface PostJournalInput {
  voucherType: VoucherType;
  entryDate?: Date;
  narration?: string;
  lines: PostLineInput[];
  sourceType?: JournalSourceType;
  sourceId?: mongoose.Types.ObjectId | string;
  reversalOfId?: mongoose.Types.ObjectId | string;
  postedBy: string;
  postedByName: string;
  fyStartMonth?: number; // default 4 (April)
  // When set, the GL voucher reuses this number (so an invoice/receipt journal
  // mirrors its source-document number 1:1) instead of drawing its own sequence.
  voucherNumber?: string;
}

const VOUCHER_PREFIX: Record<VoucherType, string> = {
  INVOICE: 'INV',
  RECEIPT: 'RCPT',
  PAYMENT: 'PV',
  JOURNAL: 'JV',
  CONTRA: 'CV',
  OPENING: 'OB',
  REVERSAL: 'REV',
};

/**
 * Post a balanced double-entry voucher. Enforces: ≥2 lines, each line exactly
 * one of debit/credit, Σdebit === Σcredit. Reserves a gapless voucher number and
 * updates each account's cached balance (signed in its normal direction) — all
 * inside one transaction. Pass `existingSession` to compose within a larger txn.
 */
export async function postJournal(
  societyId: string | mongoose.Types.ObjectId,
  input: PostJournalInput,
  existingSession?: ClientSession,
) {
  const entryDate = input.entryDate || new Date();
  const { fyString } = getFinancialYear(entryDate, input.fyStartMonth ?? 4);

  // Resolve referenced accounts (by id or code) for this society.
  const codes = [...new Set(input.lines.map((l) => l.accountCode).filter(Boolean))] as string[];
  const ids = [...new Set(input.lines.map((l) => l.accountId?.toString()).filter(Boolean))] as string[];
  const orClauses: any[] = [];
  if (codes.length) orClauses.push({ code: { $in: codes } });
  if (ids.length) orClauses.push({ _id: { $in: ids } });
  if (!orClauses.length) throw new Error('Journal lines must reference an account');
  const accounts = await LedgerAccount.find({ societyId, $or: orClauses });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const byId = new Map(accounts.map((a) => [a._id.toString(), a]));

  const resolved = input.lines.map((l) => {
    const acct = l.accountId ? byId.get(l.accountId.toString()) : (l.accountCode ? byCode.get(l.accountCode) : undefined);
    if (!acct) throw new Error(`Ledger account not found: ${l.accountId || l.accountCode}`);
    const debit = Math.round(l.debitPaise || 0);
    const credit = Math.round(l.creditPaise || 0);
    if (debit < 0 || credit < 0) throw new Error('Debit/credit cannot be negative');
    if ((debit > 0) === (credit > 0)) throw new Error('Each journal line must have exactly one of debit or credit');
    return { acct, debit, credit, flatId: l.flatId, vendorId: l.vendorId, fundId: l.fundId, description: l.description };
  });

  if (resolved.length < 2) throw new Error('A journal entry needs at least two lines');
  const totalDebit = resolved.reduce((s, l) => s + l.debit, 0);
  const totalCredit = resolved.reduce((s, l) => s + l.credit, 0);
  if (totalDebit !== totalCredit) throw new Error(`Journal not balanced: Dr ${totalDebit} ≠ Cr ${totalCredit}`);
  if (totalDebit === 0) throw new Error('Journal total cannot be zero');

  const run = async (session: ClientSession) => {
    let voucherNumber = input.voucherNumber;
    if (!voucherNumber) {
      const seq = await nextSequence(societyId, input.voucherType, fyString, session);
      voucherNumber = formatDocNumber({ prefix: VOUCHER_PREFIX[input.voucherType], fyString, seq });
    }

    const [entry] = await JournalEntry.create([{
      societyId,
      voucherNumber,
      voucherType: input.voucherType,
      entryDate,
      financialYear: fyString,
      narration: input.narration,
      lines: resolved.map((l) => ({
        accountId: l.acct._id,
        accountCode: l.acct.code,
        accountName: l.acct.name,
        debitPaise: l.debit,
        creditPaise: l.credit,
        flatId: l.flatId,
        vendorId: l.vendorId,
        fundId: l.fundId,
        description: l.description,
      })),
      totalDebitPaise: totalDebit,
      totalCreditPaise: totalCredit,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      reversalOfId: input.reversalOfId,
      postedBy: input.postedBy,
      postedByName: input.postedByName,
    }], { session });

    // Update cached account balances (signed in each account's normal direction).
    const bulk = resolved.map((l) => {
      const delta = l.acct.normalBalance === 'DEBIT' ? (l.debit - l.credit) : (l.credit - l.debit);
      return { updateOne: { filter: { _id: l.acct._id }, update: { $inc: { currentBalancePaise: delta } } } };
    });
    await LedgerAccount.bulkWrite(bulk, { session });

    return entry;
  };

  if (existingSession) return run(existingSession);
  const session = await mongoose.startSession();
  try {
    let result: any;
    await session.withTransaction(async () => { result = await run(session); });
    return result;
  } finally {
    session.endSession();
  }
}

/**
 * Reverse a posted voucher by posting an equal-and-opposite REVERSAL entry and
 * marking the original REVERSED. Never edits/deletes the original.
 */
export async function reverseJournal(
  societyId: string | mongoose.Types.ObjectId,
  entryId: string | mongoose.Types.ObjectId,
  actor: { postedBy: string; postedByName: string; narration?: string },
  existingSession?: ClientSession,
) {
  const run = async (session: ClientSession) => {
    const orig = await JournalEntry.findOne({ _id: entryId, societyId }).session(session);
    if (!orig) throw new Error('Journal entry not found');
    if (orig.status !== 'POSTED') throw new Error('Only a posted entry can be reversed');

    const reversal = await postJournal(societyId, {
      voucherType: 'REVERSAL',
      entryDate: new Date(),
      narration: `Reversal of ${orig.voucherNumber}${actor.narration ? ` — ${actor.narration}` : ''}`,
      lines: orig.lines.map((l) => ({
        accountId: l.accountId,
        debitPaise: l.creditPaise,
        creditPaise: l.debitPaise,
        flatId: l.flatId,
        vendorId: l.vendorId,
        fundId: l.fundId,
        description: l.description,
      })),
      sourceType: orig.sourceType,
      sourceId: orig.sourceId,
      reversalOfId: orig._id,
      postedBy: actor.postedBy,
      postedByName: actor.postedByName,
    }, session);

    orig.status = 'REVERSED';
    orig.isReversed = true;
    await orig.save({ session });
    return reversal;
  };

  if (existingSession) return run(existingSession);
  const session = await mongoose.startSession();
  try {
    let result: any;
    await session.withTransaction(async () => { result = await run(session); });
    return result;
  } finally {
    session.endSession();
  }
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  debitPaise: number;
  creditPaise: number;
}

/**
 * Trial balance from cached account balances. A DEBIT-normal account with a
 * negative balance correctly appears in the credit column (and vice versa),
 * so the two totals always tie out for a consistent ledger.
 */
export async function getTrialBalance(societyId: string | mongoose.Types.ObjectId) {
  const accounts = await LedgerAccount.find({ societyId }).sort({ code: 1 }).lean<ILedgerAccount[]>();
  const rows: TrialBalanceRow[] = accounts.map((a) => {
    const bal = a.currentBalancePaise;
    const debitPaise = a.normalBalance === 'DEBIT' ? Math.max(bal, 0) : Math.max(-bal, 0);
    const creditPaise = a.normalBalance === 'CREDIT' ? Math.max(bal, 0) : Math.max(-bal, 0);
    return { code: a.code, name: a.name, type: a.type, debitPaise, creditPaise };
  });
  const totalDebitPaise = rows.reduce((s, r) => s + r.debitPaise, 0);
  const totalCreditPaise = rows.reduce((s, r) => s + r.creditPaise, 0);
  return { rows, totalDebitPaise, totalCreditPaise, balanced: totalDebitPaise === totalCreditPaise };
}
