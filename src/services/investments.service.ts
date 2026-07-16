import mongoose from 'mongoose';
import { Investment, IInvestment, InterestPayout, InvestmentStatus } from '../models/investment.model';
import { FinanceFund } from '../models/finance-fund.model';
import { postJournal, PostLineInput } from './ledger.service';
import { getOrCreatePolicy } from './finance-policy.service';
import { fundAccount } from './funds.service';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';

interface Actor { userId: string; userName: string }

/** Thrown for a caller mistake — the controller maps these to 4xx, not 500. */
export class InvestmentError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const DAY_MS = 86_400_000;

/**
 * Whole days between two dates.
 *
 * Rounded, not floored: the process runs in Asia/Kolkata (see `config/timezone`)
 * where there is no DST, but dates arriving from the client can carry a stray
 * time component, and a floor would silently drop a day from every span.
 */
const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);

export interface InterestAccrualRow {
  investmentId: string;
  bankName: string;
  principalPaise: number;
  ratePercent: number;
  /** Set when the deposit holds a fund's money — decides where the interest lands. */
  linkedFundId?: string;
  /** Filled in by the preview/run wrapper, for display only. */
  creditToLabel?: string;
  /** Accrued *before* this run. */
  accruedInterestPaise: number;
  /** Start of the un-accrued span — the day after the last run, or the deposit's start. */
  fromDate: Date;
  /** End of the span actually accrued. Capped at maturity for a deposit that does not renew. */
  toDate: Date;
  days: number;
  /** What this run would earn. Whole paise. */
  interestPaise: number;
  /** Accrued after this run. */
  closingAccruedInterestPaise: number;
  /** Why nothing is accrued, when nothing is accrued — the preview shows this verbatim. */
  skipReason?: string;
}

/**
 * What one deposit would earn for the span ending `upTo`.
 *
 * The span starts at `lastAccrualUpTo` (not at the deposit's start) — accruing
 * from the start every time is exactly the double-count this register has to
 * avoid. Pure: computes, never writes. `runInterestAccrual` and
 * `interestAccrualPreview` share it, so the number a user previews is the number
 * that posts.
 */
function computeAccrual(inv: IInvestment, upTo: Date): InterestAccrualRow {
  const from = inv.lastAccrualUpTo ? new Date(inv.lastAccrualUpTo) : new Date(inv.startDate);
  const base: InterestAccrualRow = {
    investmentId: String(inv._id),
    bankName: inv.bankName,
    principalPaise: inv.principalPaise,
    ratePercent: inv.ratePercent,
    linkedFundId: inv.linkedFundId ? String(inv.linkedFundId) : undefined,
    accruedInterestPaise: inv.accruedInterestPaise,
    fromDate: from,
    toDate: upTo,
    days: 0,
    interestPaise: 0,
    closingAccruedInterestPaise: inv.accruedInterestPaise,
  };

  if (inv.status === 'CLOSED') return { ...base, skipReason: 'Closed' };

  // A deposit stops earning the day it matures. Only an auto-renewing one keeps
  // running past that date — otherwise the money is sitting in the bank waiting
  // to be collected, and inventing interest on it would overstate the reserve.
  const maturity = new Date(inv.maturityDate);
  const to = !inv.autoRenew && upTo > maturity ? maturity : upTo;

  const days = daysBetween(from, to);
  if (days <= 0) {
    return {
      ...base,
      toDate: to,
      days: Math.max(0, days),
      skipReason: !inv.autoRenew && from >= maturity
        ? 'Matured — interest already accrued to maturity'
        : 'Already accrued up to this date',
    };
  }

  // Simple interest, the way a society's FD advice states it. Money is integer
  // paise: round once, here, so the preview and the voucher cannot disagree.
  const raw = inv.principalPaise * (inv.ratePercent / 100) * (days / 365);
  const interestPaise = Math.max(0, Math.round(raw));

  return {
    ...base,
    toDate: to,
    days,
    interestPaise,
    closingAccruedInterestPaise: inv.accruedInterestPaise + interestPaise,
  };
}

function parseUpTo(upToDate?: string | Date): Date {
  const d = upToDate ? new Date(upToDate) : new Date();
  if (Number.isNaN(d.getTime())) throw new InvestmentError('upToDate is not a valid date');
  return d;
}

/** Fund names for the rows that credit a fund, so the preview says where the money goes. */
async function labelRows(societyId: string, rows: InterestAccrualRow[]): Promise<InterestAccrualRow[]> {
  const fundIds = [...new Set(rows.map((r) => r.linkedFundId).filter(Boolean))] as string[];
  const funds = fundIds.length ? await FinanceFund.find({ societyId, _id: { $in: fundIds } }).select('name').lean() : [];
  const nameById = new Map(funds.map((f) => [String(f._id), f.name]));
  return rows.map((r) => ({
    ...r,
    creditToLabel: r.linkedFundId ? (nameById.get(r.linkedFundId) || 'Linked fund') : 'Interest Income (Bank/FD)',
  }));
}

export interface InterestAccrualPreview {
  upToDate: Date;
  rows: InterestAccrualRow[];
  /** Deposits this run would actually accrue. */
  accruable: number;
  /** Deposits with nothing to accrue — each row carries its own `skipReason`. */
  skipped: number;
  totalPaise: number;
  /** Of the total, what belongs to funds rather than to general income. */
  toFundsPaise: number;
  toIncomePaise: number;
}

/**
 * What an interest accrual run *would* post, without posting it.
 *
 * Accrual is an entry nobody asked for and no document backs — the bank has not
 * paid anything yet — so it has to be inspectable before it hits the ledger.
 * Same contract as the depreciation dry-run: preview and post share one code
 * path, so the preview cannot drift from what actually posts.
 */
export async function interestAccrualPreview(
  societyId: string,
  opts: { upToDate?: string | Date } = {},
): Promise<InterestAccrualPreview> {
  const upTo = parseUpTo(opts.upToDate);
  const investments = await Investment.find({ societyId }).sort({ startDate: 1 });
  const rows = await labelRows(societyId, investments.map((i) => computeAccrual(i, upTo)));
  return {
    upToDate: upTo,
    rows,
    accruable: rows.filter((r) => r.interestPaise > 0).length,
    skipped: rows.filter((r) => r.interestPaise === 0).length,
    totalPaise: rows.reduce((s, r) => s + r.interestPaise, 0),
    toFundsPaise: rows.filter((r) => r.linkedFundId).reduce((s, r) => s + r.interestPaise, 0),
    toIncomePaise: rows.filter((r) => !r.linkedFundId).reduce((s, r) => s + r.interestPaise, 0),
  };
}

export interface InterestAccrualRunResult {
  upToDate: Date;
  posted: boolean;
  journalEntryId?: string;
  voucherNumber?: string;
  investmentsAccrued: number;
  totalPaise: number;
  rows: InterestAccrualRow[];
}

/**
 * Accrue interest up to a date and post it to the ledger.
 *
 * ONE voucher for the whole run, not one per deposit — that is how it appears in
 * a society's books, and the per-deposit detail lives on the deposits
 * themselves. The interest is debited to 1300 either way: it has been earned but
 * not paid out, so it swells the deposit rather than the bank balance.
 *
 * Where it is CREDITED is the whole point of the linked fund:
 *
 *   Dr  1300 Fixed Deposits / Investments      (interest earned)
 *       Cr  the fund's own FUND account        — for a fund-linked deposit
 *       Cr  4200 Interest Income (Bank/FD)     — for an unlinked one
 *
 * Interest earned on money that belongs to the sinking fund belongs to the
 * sinking fund. Routing it to general income silently drains a reserve the
 * members are owed, and the fund statement would never show why.
 *
 * Idempotent per period: each deposit only accrues the span after its own
 * `lastAccrualUpTo`, so a second run for the same date accrues nothing and posts
 * nothing. The date is advanced only for deposits that actually accrued, and
 * only as far as the span really covered (maturity may cut it short) — advancing
 * it past that would silently swallow a span.
 */
export async function runInterestAccrual(
  societyId: string,
  opts: { upToDate?: string | Date } = {},
  actor: Actor = { userId: '', userName: '' },
): Promise<InterestAccrualRunResult> {
  const upTo = parseUpTo(opts.upToDate);
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;

  const session = await mongoose.startSession();
  try {
    let out!: InterestAccrualRunResult;
    await session.withTransaction(async () => {
      const investments = await Investment.find({ societyId }).sort({ startDate: 1 }).session(session);
      const rows = investments.map((i) => computeAccrual(i, upTo));
      const accrued = rows.filter((r) => r.interestPaise > 0);
      const totalPaise = accrued.reduce((s, r) => s + r.interestPaise, 0);

      // Nothing to accrue — most often a re-run of a period already booked.
      // Return quietly rather than throw: postJournal rejects a zero voucher, and
      // "you already ran this" is not an error the caller needs to handle.
      if (totalPaise === 0) {
        out = {
          upToDate: upTo,
          posted: false,
          investmentsAccrued: 0,
          totalPaise: 0,
          rows: await labelRows(societyId, rows),
        };
        return;
      }

      // Group the credits by destination account — one line per fund, one for
      // ordinary income — rather than one per deposit, so the voucher reads the
      // way the money actually moved.
      const byId = new Map(investments.map((i) => [String(i._id), i]));
      const creditByAccount = new Map<string, { accountId?: mongoose.Types.ObjectId; accountCode?: string; label: string; paise: number }>();
      for (const r of accrued) {
        const inv = byId.get(r.investmentId)!;
        let key: string;
        let entry: { accountId?: mongoose.Types.ObjectId; accountCode?: string; label: string; paise: number };
        if (inv.linkedFundId) {
          // Resolve inside the transaction: a fund's account may be minted on
          // demand here, and a sessionless read would not see it.
          const acct = await fundAccount(societyId, inv.linkedFundId, actor, session);
          key = `id:${String(acct._id)}`;
          entry = creditByAccount.get(key) || { accountId: acct._id as mongoose.Types.ObjectId, label: acct.name, paise: 0 };
        } else {
          key = `code:${ACCOUNT_CODES.INTEREST_INCOME}`;
          entry = creditByAccount.get(key) || { accountCode: ACCOUNT_CODES.INTEREST_INCOME, label: 'Interest income', paise: 0 };
        }
        entry.paise += r.interestPaise;
        creditByAccount.set(key, entry);
      }

      const lines: PostLineInput[] = [
        {
          accountCode: ACCOUNT_CODES.INVESTMENTS,
          debitPaise: totalPaise,
          description: `Interest accrued on ${accrued.length} deposit(s)`,
        },
        ...[...creditByAccount.values()].map((c) => ({
          accountId: c.accountId,
          accountCode: c.accountCode,
          creditPaise: c.paise,
          description: `Interest earned — ${c.label}`,
        })),
      ];

      const je = await postJournal(societyId, {
        voucherType: 'JOURNAL',
        entryDate: upTo,
        narration: `FD interest accrued up to ${upTo.toLocaleDateString('en-IN')}`,
        lines,
        postedBy: actor.userId,
        postedByName: actor.userName,
        fyStartMonth: startMonth,
      }, session);

      for (const r of accrued) {
        const inv = byId.get(r.investmentId)!;
        inv.accruedInterestPaise += r.interestPaise;
        // r.toDate, not upTo: maturity may have cut the span short, and claiming
        // to have accrued past it would swallow nothing but would be a lie the
        // next run reads back.
        inv.lastAccrualUpTo = r.toDate;
        // Accrued through to maturity and not renewing — the deposit is done
        // earning, and the register should say so without waiting for a human.
        if (inv.status === 'ACTIVE' && !inv.autoRenew && r.toDate >= new Date(inv.maturityDate)) {
          inv.status = 'MATURED';
        }
        await inv.save({ session });
      }

      out = {
        upToDate: upTo,
        posted: true,
        journalEntryId: String(je._id),
        voucherNumber: je.voucherNumber,
        investmentsAccrued: accrued.length,
        totalPaise,
        rows: await labelRows(societyId, rows),
      };
    });
    return out;
  } finally {
    session.endSession();
  }
}

export interface InvestmentView {
  _id: string;
  bankName: string;
  accountNumberLast4?: string;
  principalPaise: number;
  ratePercent: number;
  startDate: Date;
  maturityDate: Date;
  interestPayout: InterestPayout;
  linkedFundId?: string;
  linkedFundName?: string;
  autoRenew: boolean;
  accruedInterestPaise: number;
  /** Derived, never stored: principal + accrued. Two fields cannot disagree if only one exists. */
  currentValuePaise: number;
  lastAccrualUpTo?: Date;
  status: InvestmentStatus;
  closedOn?: Date;
  /** Whole days until maturity; negative once it is past. Undefined for a closed deposit. */
  daysToMaturity?: number;
}

const toView = (i: IInvestment, fundName?: string): InvestmentView => ({
  _id: String(i._id),
  bankName: i.bankName,
  accountNumberLast4: i.accountNumberLast4,
  principalPaise: i.principalPaise,
  ratePercent: i.ratePercent,
  startDate: i.startDate,
  maturityDate: i.maturityDate,
  interestPayout: i.interestPayout,
  linkedFundId: i.linkedFundId ? String(i.linkedFundId) : undefined,
  linkedFundName: fundName,
  autoRenew: i.autoRenew,
  accruedInterestPaise: i.accruedInterestPaise,
  currentValuePaise: i.principalPaise + i.accruedInterestPaise,
  lastAccrualUpTo: i.lastAccrualUpTo,
  status: i.status,
  closedOn: i.closedOn,
  daysToMaturity: i.status === 'CLOSED' ? undefined : daysBetween(new Date(), new Date(i.maturityDate)),
});

export interface InvestmentListResult {
  investments: InvestmentView[];
  totals: {
    principalPaise: number;
    accruedInterestPaise: number;
    currentValuePaise: number;
    count: number;
    /** Live deposits maturing within the next 30 days — what a treasurer has to act on. */
    maturingSoon: number;
  };
}

/** The register: every deposit, what it earns, and what it is worth today. */
export async function listInvestments(societyId: string, opts: { includeClosed?: boolean } = {}): Promise<InvestmentListResult> {
  const query: any = { societyId };
  if (!opts.includeClosed) query.status = { $ne: 'CLOSED' };
  const investments = await Investment.find(query).sort({ maturityDate: 1 });

  const fundIds = [...new Set(investments.map((i) => i.linkedFundId?.toString()).filter(Boolean))] as string[];
  const funds = fundIds.length ? await FinanceFund.find({ societyId, _id: { $in: fundIds } }).select('name').lean() : [];
  const nameById = new Map(funds.map((f) => [String(f._id), f.name]));

  const views = investments.map((i) => toView(i, i.linkedFundId ? nameById.get(String(i.linkedFundId)) : undefined));
  return {
    investments: views,
    totals: {
      principalPaise: views.reduce((s, i) => s + i.principalPaise, 0),
      accruedInterestPaise: views.reduce((s, i) => s + i.accruedInterestPaise, 0),
      currentValuePaise: views.reduce((s, i) => s + i.currentValuePaise, 0),
      count: views.length,
      maturingSoon: views.filter((i) => i.status !== 'CLOSED' && (i.daysToMaturity ?? 0) <= 30).length,
    },
  };
}

/**
 * A deposit that matures before it starts is a typo, not a plan — and it would
 * make every accrual span negative, so nothing would ever be earned.
 */
function assertTerm(startDate: Date, maturityDate: Date) {
  if (maturityDate <= startDate) throw new InvestmentError('Maturity date must be after the start date');
}

/**
 * Put money into a fixed deposit and record it.
 *
 *   Dr  1300 Fixed Deposits / Investments
 *       Cr  1100 Bank
 *
 * A deposit is NOT an expense: the society has exactly as much money as before,
 * it has just moved somewhere it earns more. Booking it as spending would
 * understate the society's assets by the whole principal and show a surplus that
 * collapsed for no reason.
 */
export async function createInvestment(societyId: string, body: any, actor: Actor): Promise<InvestmentView> {
  const principalPaise = Math.round(body.principalPaise);
  const startDate = body.startDate ? new Date(body.startDate) : new Date();
  const maturityDate = new Date(body.maturityDate);
  if (Number.isNaN(maturityDate.getTime())) throw new InvestmentError('Maturity date is not a valid date');
  assertTerm(startDate, maturityDate);

  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;

  // Fail before any money moves if the fund does not exist.
  let fundName: string | undefined;
  if (body.linkedFundId) {
    const fund = await FinanceFund.findOne({ _id: body.linkedFundId, societyId }).select('name').lean();
    if (!fund) throw new InvestmentError('Linked fund not found', 404);
    fundName = fund.name;
  }

  const session = await mongoose.startSession();
  try {
    let out!: InvestmentView;
    await session.withTransaction(async () => {
      const [inv] = await Investment.create([{
        societyId,
        bankName: body.bankName,
        accountNumberLast4: body.accountNumberLast4,
        principalPaise,
        ratePercent: body.ratePercent,
        startDate,
        maturityDate,
        interestPayout: body.interestPayout || 'CUMULATIVE',
        linkedFundId: body.linkedFundId || undefined,
        autoRenew: Boolean(body.autoRenew),
        accruedInterestPaise: 0,
        status: 'ACTIVE',
        createdBy: actor.userId,
        createdByName: actor.userName,
      }], { session });

      await postJournal(societyId, {
        voucherType: 'JOURNAL',
        entryDate: startDate,
        narration: `Fixed deposit placed — ${inv.bankName}${inv.accountNumberLast4 ? ` ••${inv.accountNumberLast4}` : ''}`,
        lines: [
          { accountCode: ACCOUNT_CODES.INVESTMENTS, debitPaise: principalPaise, fundId: inv.linkedFundId, description: `FD — ${inv.bankName}` },
          { accountCode: ACCOUNT_CODES.BANK, creditPaise: principalPaise, description: `Placed in FD — ${inv.bankName}` },
        ],
        postedBy: actor.userId,
        postedByName: actor.userName,
        fyStartMonth: startMonth,
      }, session);

      out = toView(inv, fundName);
    });
    return out;
  } finally {
    session.endSession();
  }
}

/**
 * Edit a deposit's descriptive and policy fields.
 *
 * `principalPaise` and `accruedInterestPaise` are deliberately not editable
 * here — both are consequences of posted vouchers, and letting them be typed
 * over would put the register and the ledger's 1300 balance at odds with no
 * trace of why. Correct a wrong principal by closing the deposit and re-entering
 * it, so the ledger carries the correction too.
 */
export async function updateInvestment(societyId: string, id: string, body: any): Promise<InvestmentView> {
  const inv = await Investment.findOne({ _id: id, societyId });
  if (!inv) throw new InvestmentError('Investment not found', 404);
  if (inv.status === 'CLOSED') throw new InvestmentError('A closed deposit can no longer be edited');

  if (body.linkedFundId !== undefined) {
    if (body.linkedFundId) {
      const fund = await FinanceFund.findOne({ _id: body.linkedFundId, societyId }).select('name').lean();
      if (!fund) throw new InvestmentError('Linked fund not found', 404);
      inv.linkedFundId = new mongoose.Types.ObjectId(String(body.linkedFundId));
    } else {
      // '' means unlink, which must become undefined rather than reaching
      // Mongoose as an empty ObjectId cast.
      inv.linkedFundId = undefined;
    }
  }

  for (const f of ['bankName', 'accountNumberLast4', 'ratePercent', 'interestPayout', 'autoRenew'] as const) {
    if (body[f] !== undefined) (inv as any)[f] = body[f];
  }
  const startDate = body.startDate !== undefined ? new Date(body.startDate) : inv.startDate;
  const maturityDate = body.maturityDate !== undefined ? new Date(body.maturityDate) : inv.maturityDate;
  assertTerm(startDate, maturityDate);
  inv.startDate = startDate;
  inv.maturityDate = maturityDate;

  await inv.save();
  const fund = inv.linkedFundId ? await FinanceFund.findById(inv.linkedFundId).select('name').lean() : null;
  return toView(inv, fund?.name);
}

export interface CloseInvestmentInput {
  closedOn?: string | Date;
  /** What the bank actually paid out. */
  proceedsPaise?: number;
}

/**
 * Close a deposit and take the money back.
 *
 *   Dr  1100 Bank                              (what the bank paid)
 *   Dr  4200 Interest Income                   (if it paid LESS than the books say)
 *       Cr  1300 Fixed Deposits / Investments  (principal + everything accrued)
 *       Cr  4200 Interest Income               (if it paid MORE)
 *
 * The deposit leaves the books at its carrying value — principal plus every
 * paisa of interest accrued against it — because that is what 1300 is holding.
 * Any gap is the accrual estimate meeting reality: a premature-withdrawal
 * penalty debits the interest back out, a final quarter nobody accrued credits
 * it in. Leaving the gap unbooked would strand the difference in 1300 forever.
 */
export async function closeInvestment(
  societyId: string,
  id: string,
  input: CloseInvestmentInput,
  actor: Actor,
): Promise<InvestmentView> {
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const closedOn = input.closedOn ? new Date(input.closedOn) : new Date();
  if (Number.isNaN(closedOn.getTime())) throw new InvestmentError('closedOn is not a valid date');
  const proceedsPaise = Math.max(0, Math.round(input.proceedsPaise || 0));

  const session = await mongoose.startSession();
  try {
    let out!: InvestmentView;
    await session.withTransaction(async () => {
      const inv = await Investment.findOne({ _id: id, societyId }).session(session);
      if (!inv) throw new InvestmentError('Investment not found', 404);
      if (inv.status === 'CLOSED') {
        throw new InvestmentError(
          `This deposit with ${inv.bankName} was already closed on ${inv.closedOn?.toLocaleDateString('en-IN')}`,
        );
      }
      if (closedOn < inv.startDate) throw new InvestmentError('A deposit cannot be closed before it was placed');

      const carryingPaise = inv.principalPaise + inv.accruedInterestPaise;
      const gain = proceedsPaise - carryingPaise;

      const lines: PostLineInput[] = [];
      if (proceedsPaise > 0) lines.push({ accountCode: ACCOUNT_CODES.BANK, debitPaise: proceedsPaise, description: `FD proceeds — ${inv.bankName}` });
      if (gain < 0) lines.push({ accountCode: ACCOUNT_CODES.INTEREST_INCOME, debitPaise: -gain, description: `Interest shortfall on closure — ${inv.bankName}` });
      lines.push({ accountCode: ACCOUNT_CODES.INVESTMENTS, creditPaise: carryingPaise, fundId: inv.linkedFundId, description: `Deposit closed — ${inv.bankName}` });
      if (gain > 0) lines.push({ accountCode: ACCOUNT_CODES.INTEREST_INCOME, creditPaise: gain, description: `Extra interest on closure — ${inv.bankName}` });

      await postJournal(societyId, {
        voucherType: 'JOURNAL',
        entryDate: closedOn,
        narration: `Fixed deposit closed — ${inv.bankName}${inv.accountNumberLast4 ? ` ••${inv.accountNumberLast4}` : ''}`,
        lines,
        postedBy: actor.userId,
        postedByName: actor.userName,
        fyStartMonth: startMonth,
      }, session);

      inv.status = 'CLOSED';
      inv.closedOn = closedOn;
      await inv.save({ session });

      const fund = inv.linkedFundId
        ? await FinanceFund.findOne({ _id: inv.linkedFundId, societyId }).select('name').session(session).lean()
        : null;
      out = toView(inv, fund?.name);
    });
    return out;
  } finally {
    session.endSession();
  }
}