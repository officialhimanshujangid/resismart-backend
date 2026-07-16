import mongoose from 'mongoose';
import { LedgerAccount, AccountType, NormalBalance, Taxability, ILedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { getFinancialYear, FinancialYear } from '../utils/financial-year.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * A reporting window. Omit `from` for inception-to-date (the correct basis for
 * Balance Sheet items); supply both for a financial year (Income & Expenditure).
 * `to` is treated as inclusive.
 */
export interface PeriodWindow {
  from?: Date;
  to?: Date;
}

export interface AccountMovement {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  parentAccountId?: string;
  /** INCOME only — drives the mutual vs taxable split for ITR-5. */
  taxability?: Taxability;
  /** Gross debits posted inside the window. */
  debitPaise: number;
  /** Gross credits posted inside the window. */
  creditPaise: number;
  /** Net movement, signed in the account's normal direction. */
  balancePaise: number;
  /** The denormalised `LedgerAccount.currentBalancePaise` (inception-to-date). */
  cachedBalancePaise: number;
}

/** Last millisecond of `d`'s day — so a `to` date includes that whole day. */
export function endOfDay(d: Date): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

/** First millisecond of `d`'s day, local time — the counterpart to `endOfDay`. */
export function startOfDay(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

/**
 * Account balances computed **from the journal**, not from the cached
 * `currentBalancePaise`. This is what makes period-scoped reporting possible:
 * the cache is inception-to-date only and can never answer "what was FY 2025-26".
 *
 * Deliberately does NOT filter on `status`. `reverseJournal` leaves the original
 * entry's lines intact and posts an equal-and-opposite REVERSAL, so both sides
 * must be counted — excluding REVERSED originals would subtract the reversal twice.
 */
export async function accountMovements(
  societyId: string | mongoose.Types.ObjectId,
  window: PeriodWindow = {},
  types?: AccountType[],
): Promise<AccountMovement[]> {
  const accountFilter: any = { societyId: oid(societyId) };
  if (types?.length) accountFilter.type = { $in: types };
  const accounts = await LedgerAccount.find(accountFilter).sort({ code: 1 }).lean<ILedgerAccount[]>();
  if (!accounts.length) return [];

  const match: any = { societyId: oid(societyId) };
  if (window.from || window.to) {
    match.entryDate = {};
    if (window.from) match.entryDate.$gte = window.from;
    if (window.to) match.entryDate.$lte = window.to;
  }

  const agg = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    {
      $group: {
        _id: '$lines.accountId',
        debitPaise: { $sum: '$lines.debitPaise' },
        creditPaise: { $sum: '$lines.creditPaise' },
      },
    },
  ]);
  const moved = new Map<string, { debitPaise: number; creditPaise: number }>(
    agg.map((r: any) => [String(r._id), { debitPaise: r.debitPaise || 0, creditPaise: r.creditPaise || 0 }]),
  );

  return accounts.map((a) => {
    const m = moved.get(String(a._id));
    const debitPaise = m?.debitPaise || 0;
    const creditPaise = m?.creditPaise || 0;
    return {
      accountId: String(a._id),
      code: a.code,
      name: a.name,
      type: a.type,
      normalBalance: a.normalBalance,
      parentAccountId: a.parentAccountId ? String(a.parentAccountId) : undefined,
      taxability: a.taxability,
      debitPaise,
      creditPaise,
      balancePaise: a.normalBalance === 'DEBIT' ? debitPaise - creditPaise : creditPaise - debitPaise,
      cachedBalancePaise: a.currentBalancePaise,
    };
  });
}

/** One wing's movement on one account. `blockId` null = common to the society. */
export interface BlockMovement extends AccountMovement {
  blockId: string | null;
}

/**
 * The same movements as `accountMovements`, but split by wing.
 *
 * One aggregate rather than a scan per wing: with a `blockId` grouping key the
 * database does the split in a single pass, and lines with no wing fall out
 * naturally under the `null` key — which is where they belong, since a shared
 * water bill genuinely isn't any one wing's cost.
 */
export async function accountMovementsByBlock(
  societyId: string | mongoose.Types.ObjectId,
  window: PeriodWindow = {},
  types?: AccountType[],
): Promise<BlockMovement[]> {
  const accountFilter: any = { societyId: oid(societyId) };
  if (types?.length) accountFilter.type = { $in: types };
  const accounts = await LedgerAccount.find(accountFilter).sort({ code: 1 }).lean<ILedgerAccount[]>();
  if (!accounts.length) return [];
  const byId = new Map(accounts.map(a => [String(a._id), a]));

  const match: any = { societyId: oid(societyId) };
  if (window.from || window.to) {
    match.entryDate = {};
    if (window.from) match.entryDate.$gte = window.from;
    if (window.to) match.entryDate.$lte = window.to;
  }

  const agg = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    {
      $group: {
        _id: { accountId: '$lines.accountId', blockId: '$lines.blockId' },
        debitPaise: { $sum: '$lines.debitPaise' },
        creditPaise: { $sum: '$lines.creditPaise' },
      },
    },
  ]);

  const out: BlockMovement[] = [];
  for (const r of agg) {
    const a = byId.get(String(r._id.accountId));
    if (!a) continue; // account filtered out by `types`
    const debitPaise = r.debitPaise || 0;
    const creditPaise = r.creditPaise || 0;
    out.push({
      blockId: r._id.blockId ? String(r._id.blockId) : null,
      accountId: String(a._id),
      code: a.code,
      name: a.name,
      type: a.type,
      normalBalance: a.normalBalance,
      parentAccountId: a.parentAccountId ? String(a.parentAccountId) : undefined,
      taxability: a.taxability,
      debitPaise,
      creditPaise,
      balancePaise: a.normalBalance === 'DEBIT' ? debitPaise - creditPaise : creditPaise - debitPaise,
      cachedBalancePaise: a.currentBalancePaise,
    });
  }
  return out.sort((x, y) => x.code.localeCompare(y.code));
}

export interface DriftRow {
  code: string;
  name: string;
  cachedBalancePaise: number;
  ledgerBalancePaise: number;
  driftPaise: number;
}

/**
 * Accounts whose cached balance no longer matches the journal.
 *
 * A trial balance's Dr/Cr totals ALWAYS tie when every voucher is balanced at
 * post time, so that equality proves nothing. This does: it catches a cache that
 * has drifted from the ledger (a failed bulkWrite, a direct DB write, or a
 * backfill that skipped the GL) — the failure this system can actually have.
 *
 * Pure, over inception-to-date movements the caller already has: comparing a
 * cached inception-to-date balance against a windowed one would report nonsense.
 */
export function driftFrom(inceptionToDate: AccountMovement[]): DriftRow[] {
  return inceptionToDate
    .filter((r) => r.cachedBalancePaise !== r.balancePaise)
    .map((r) => ({
      code: r.code,
      name: r.name,
      cachedBalancePaise: r.cachedBalancePaise,
      ledgerBalancePaise: r.balancePaise,
      driftPaise: r.cachedBalancePaise - r.balancePaise,
    }));
}

/** Resolve a financial year from its start year (e.g. 2026 → FY 2026-2027). */
export function financialYearOf(startYear: number, startMonth = 4): FinancialYear {
  // Mid-FY date guarantees getFinancialYear lands on `startYear` for any startMonth.
  return getFinancialYear(new Date(startYear, startMonth - 1, 15), startMonth);
}

/**
 * Resolve the reporting FY from an optional '2026' / '2026-2027' string, falling
 * back to the FY containing `now`.
 *
 * Rejects rather than guesses: `Number('26')` is a finite 26, and
 * `new Date(26, ...)` maps to 1926 under JS's two-digit-year rule, which would
 * silently answer with an all-zero statement labelled 1926-1927.
 */
export function resolveFinancialYear(fyString: string | undefined, startMonth = 4, now = new Date()): FinancialYear {
  if (fyString) {
    const raw = String(fyString).split('-')[0];
    if (!/^\d{4}$/.test(raw)) throw new Error(`Invalid financial year '${fyString}' — expected e.g. '2026' or '2026-2027'`);
    return financialYearOf(Number(raw), startMonth);
  }
  return getFinancialYear(now, startMonth);
}

/** Parse a user-supplied date, rejecting nonsense instead of yielding Invalid Date. */
export function parseDate(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${field} date '${value}'`);
  return d;
}
