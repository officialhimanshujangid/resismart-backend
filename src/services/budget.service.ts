import mongoose from 'mongoose';
import { Budget, IBudget, IBudgetLine } from '../models/budget.model';
import { LedgerAccount, ILedgerAccount } from '../models/ledger-account.model';
import { accountMovements, resolveFinancialYear } from './reporting-period.service';

export interface Actor { userId: string; userName: string }

/** Thrown for a caller mistake — the controller maps these to 4xx, not 500. */
export class BudgetError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/** Only revenue accounts can be budgeted — a balance-sheet head has no "actual" to compare against. */
const BUDGETABLE_TYPES = ['INCOME', 'EXPENSE'] as const;

/**
 * Resolve the FY, turning a bad year into a 400 rather than a 500.
 *
 * `resolveFinancialYear` throws a plain Error for '26' or 'banana'. Left alone
 * that surfaces as "this report could not be generated" — blaming the server for
 * the caller's typo.
 */
function fyOf(fy: string | undefined, fyStartMonth: number) {
  try {
    return resolveFinancialYear(fy, fyStartMonth);
  } catch (e: any) {
    throw new BudgetError(e.message, 400);
  }
}

/** The society's INCOME/EXPENSE accounts, keyed by code. */
async function budgetableAccounts(societyId: string): Promise<Map<string, ILedgerAccount>> {
  const accounts = await LedgerAccount.find({ societyId: oid(societyId), type: { $in: BUDGETABLE_TYPES } })
    .sort({ code: 1 })
    .lean<ILedgerAccount[]>();
  return new Map(accounts.map(a => [a.code, a]));
}

export interface UpsertBudgetInput {
  fy?: string;
  lines: { accountCode: string; budgetedPaise: number }[];
}

/**
 * Create or replace the budget for a financial year.
 *
 * Replaces the whole line set rather than merging: the committee edits the
 * budget as one table and expects a removed row to be gone. A merge would leave
 * a deleted line budgeted forever with no way to clear it.
 *
 * Editing sends the budget back to DRAFT. Silently keeping APPROVED would leave
 * the record claiming the general body sanctioned figures it never saw — and
 * refusing the edit outright would strand a committee that approved a typo.
 */
export async function upsertBudget(societyId: string, input: UpsertBudgetInput, actor: Actor, fyStartMonth = 4): Promise<IBudget> {
  const fy = fyOf(input.fy, fyStartMonth);
  const accounts = await budgetableAccounts(societyId);

  const seen = new Set<string>();
  const lines: IBudgetLine[] = [];
  for (const l of input.lines || []) {
    const account = accounts.get(l.accountCode);
    // A budget line against a balance-sheet account cannot have an actual to
    // compare with — the variance report reads Income & Expenditure only — so it
    // would sit on the budget forever showing a 100% shortfall.
    if (!account) {
      throw new BudgetError(`'${l.accountCode}' is not an income or expense account, so it cannot be budgeted.`, 400);
    }
    if (seen.has(l.accountCode)) {
      throw new BudgetError(`${account.code} · ${account.name} is listed twice — give it one budget line.`, 400);
    }
    seen.add(l.accountCode);
    if (!Number.isInteger(l.budgetedPaise) || l.budgetedPaise < 0) {
      throw new BudgetError(`The budget for ${account.name} must be a whole amount and cannot be negative.`, 400);
    }
    lines.push({ accountCode: account.code, accountName: account.name, budgetedPaise: l.budgetedPaise });
  }
  lines.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  // Upsert, not find-then-save: two admins saving at once would otherwise race
  // and the unique index would surface as a duplicate-key 500.
  const budget = await Budget.findOneAndUpdate(
    { societyId: oid(societyId), financialYear: fy.fyString },
    {
      $set: { lines, status: 'DRAFT' },
      // $unset, not `$set: undefined` — mongoose strips undefined out of $set, so
      // that would silently leave the old approver and date on a budget it has
      // just sent back to draft.
      $unset: { approvedBy: '', approvedByName: '', approvedAt: '' },
      $setOnInsert: { societyId: oid(societyId), financialYear: fy.fyString, createdBy: oid(actor.userId), createdByName: actor.userName },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return budget!;
}

/** The budget for one financial year, or null if the society hasn't set one. */
export async function getBudget(societyId: string, fy?: string, fyStartMonth = 4): Promise<IBudget | null> {
  const resolved = fyOf(fy, fyStartMonth);
  return Budget.findOne({ societyId: oid(societyId), financialYear: resolved.fyString }).lean<IBudget>();
}

/** Every budget the society has, newest year first — drives the year picker. */
export async function listBudgets(societyId: string) {
  const rows = await Budget.find({ societyId: oid(societyId) })
    .select('financialYear status approvedAt approvedByName lines updatedAt')
    .sort({ financialYear: -1 })
    .lean<IBudget[]>();
  return rows.map(b => ({
    financialYear: b.financialYear,
    status: b.status,
    approvedAt: b.approvedAt,
    approvedByName: b.approvedByName,
    lines: b.lines.length,
    totalBudgetedPaise: b.lines.reduce((s, l) => s + l.budgetedPaise, 0),
    updatedAt: b.updatedAt,
  }));
}

/**
 * Adopt the budget — the general body's sanction for the year's spending.
 *
 * Recorded with who and when because that is the fact the AGM minutes rest on;
 * a budget nobody approved carries no authority to spend against.
 */
export async function approveBudget(societyId: string, fy: string, actor: Actor, fyStartMonth = 4): Promise<IBudget> {
  const resolved = fyOf(fy, fyStartMonth);
  const budget = await Budget.findOne({ societyId: oid(societyId), financialYear: resolved.fyString });
  if (!budget) throw new BudgetError(`There is no budget for ${resolved.fyString} to approve yet.`, 404);
  if (budget.status === 'APPROVED') {
    throw new BudgetError(`The ${resolved.fyString} budget was already approved on ${budget.approvedAt?.toLocaleDateString('en-IN')}.`, 409);
  }
  if (!budget.lines.length) throw new BudgetError('An empty budget cannot be approved — add at least one account.', 400);

  budget.status = 'APPROVED';
  budget.approvedBy = oid(actor.userId);
  budget.approvedByName = actor.userName;
  budget.approvedAt = new Date();
  await budget.save();
  return budget;
}

export interface BudgetVsActualRow {
  code: string;
  name: string;
  type: 'INCOME' | 'EXPENSE';
  budgetedPaise: number;
  actualPaise: number;
  /** actual − budget. Signed the same way on every row, whatever the account. */
  variancePaise: number;
  /** Null where nothing was budgeted: a percentage of zero says nothing. */
  variancePercent: number | null;
  /** Money spent or earned on a head the budget never mentioned. */
  unbudgeted: boolean;
  /**
   * Whether the variance is good news. The same signed number means opposite
   * things by section — ₹1L over on income is a windfall, ₹1L over on repairs is
   * an overrun — so the row must say which rather than leave the reader to
   * infer it from a colour.
   */
  favourable: boolean;
}

export interface BudgetVsActualSection {
  rows: BudgetVsActualRow[];
  budgetedPaise: number;
  actualPaise: number;
  variancePaise: number;
  variancePercent: number | null;
}

/** Two decimals, so a 14.285714% variance doesn't print as a wall of digits. */
const pct = (variance: number, budgeted: number): number | null =>
  (budgeted === 0 ? null : Math.round((variance / budgeted) * 10_000) / 100);

/**
 * Budget vs Actual for a financial year — what the committee said it would do
 * against what it did.
 *
 * Actuals come from `accountMovements` over the FY window, the same source the
 * Income & Expenditure reads, so the two statements cannot disagree. `balancePaise`
 * is taken as the actual because for INCOME and EXPENSE the account's normal side
 * IS the section's side, which is exactly the basis `incomeExpenditure` uses; a
 * different sign convention here would foot to a different total than the
 * statement printed next to it in the AGM pack.
 *
 * Accounts with actuals but no budget are listed too. An unbudgeted spend is the
 * single most useful thing on this report — money that went out on a head the
 * general body never sanctioned — and dropping it would hide exactly what the
 * report exists to surface.
 */
export async function budgetVsActual(societyId: string, opts: { fy?: string; fyStartMonth?: number } = {}) {
  const startMonth = opts.fyStartMonth ?? 4;
  const fy = fyOf(opts.fy, startMonth);

  const [budget, movements] = await Promise.all([
    Budget.findOne({ societyId: oid(societyId), financialYear: fy.fyString }).lean<IBudget>(),
    accountMovements(societyId, { from: fy.fyStart, to: fy.fyEnd }, ['INCOME', 'EXPENSE']),
  ]);

  const budgetByCode = new Map((budget?.lines || []).map(l => [l.accountCode, l]));

  // `accountMovements` returns EVERY income/expense account, moved or not, and
  // `upsertBudget` only accepts lines naming one of them — so iterating the
  // movements alone already covers both budgeted and unbudgeted heads. (A line
  // whose account was deleted outright drops off; the delete is the bug there,
  // and a budget cannot report against an account that no longer exists.)
  const build = (type: 'INCOME' | 'EXPENSE'): BudgetVsActualSection => {
    const rows: BudgetVsActualRow[] = movements.filter(m => m.type === type).map(m => {
      const code = m.code;
      const line = budgetByCode.get(code);
      const budgetedPaise = line?.budgetedPaise ?? 0;
      const actualPaise = m.balancePaise;
      const variancePaise = actualPaise - budgetedPaise;
      return {
        code,
        name: m.name,
        type,
        budgetedPaise,
        actualPaise,
        variancePaise,
        variancePercent: pct(variancePaise, budgetedPaise),
        unbudgeted: !line,
        favourable: type === 'INCOME' ? variancePaise >= 0 : variancePaise <= 0,
      };
    })
      // An account with neither a budget nor a rupee through it is noise: the
      // chart seeds ~25 revenue heads and most societies use a handful.
      .filter(r => r.budgetedPaise !== 0 || r.actualPaise !== 0);

    const budgetedPaise = rows.reduce((s, r) => s + r.budgetedPaise, 0);
    const actualPaise = rows.reduce((s, r) => s + r.actualPaise, 0);
    const variancePaise = actualPaise - budgetedPaise;
    return { rows, budgetedPaise, actualPaise, variancePaise, variancePercent: pct(variancePaise, budgetedPaise) };
  };

  const income = build('INCOME');
  const expenses = build('EXPENSE');

  return {
    period: {
      financialYear: fy.fyString,
      from: fy.fyStart.toISOString(),
      to: fy.fyEnd.toISOString(),
    },
    // The AGM pack skips this statement entirely when it's absent, and the page
    // shows "no budget set" rather than a table of 100% shortfalls.
    hasBudget: !!budget,
    status: budget?.status ?? null,
    approvedAt: budget?.approvedAt ?? null,
    approvedByName: budget?.approvedByName ?? null,
    income,
    expenses,
    budgetedSurplusPaise: income.budgetedPaise - expenses.budgetedPaise,
    actualSurplusPaise: income.actualPaise - expenses.actualPaise,
    unbudgetedSpendPaise: expenses.rows.filter(r => r.unbudgeted).reduce((s, r) => s + r.actualPaise, 0),
  };
}

export type BudgetVsActual = Awaited<ReturnType<typeof budgetVsActual>>;

/**
 * Everything the budget page needs for one year, in one call: the budget itself,
 * the years already on record for the picker, and every account with last year's
 * actual to seed a fresh budget from.
 *
 * One round trip rather than three, because the page is useless until all three
 * have landed — staggering them just shows the treasurer an empty grid that
 * rearranges itself twice.
 */
export async function budgetWorkspace(societyId: string, opts: { fy?: string; fyStartMonth?: number } = {}) {
  const startMonth = opts.fyStartMonth ?? 4;
  const fy = fyOf(opts.fy, startMonth);

  const [budget, budgets, suggestions] = await Promise.all([
    getBudget(societyId, fy.fyString, startMonth),
    listBudgets(societyId),
    budgetSuggestions(societyId, { fy: fy.fyString, fyStartMonth: startMonth }),
  ]);

  return {
    financialYear: fy.fyString,
    budget,
    budgets,
    previousFinancialYear: suggestions.previousFinancialYear,
    accounts: suggestions.accounts,
  };
}

/**
 * Every budgetable account with last year's actual alongside — what the budget
 * page seeds its rows from.
 *
 * Societies budget by looking at what last year cost and adding a bit; starting
 * from an empty grid of 25 account codes is how a treasurer ends up budgeting
 * three heads and missing the electricity bill.
 */
export async function budgetSuggestions(societyId: string, opts: { fy?: string; fyStartMonth?: number } = {}) {
  const startMonth = opts.fyStartMonth ?? 4;
  const fy = fyOf(opts.fy, startMonth);
  const previous = resolveFinancialYear(String(fy.startYear - 1), startMonth);

  const movements = await accountMovements(societyId, { from: previous.fyStart, to: previous.fyEnd }, ['INCOME', 'EXPENSE']);
  return {
    previousFinancialYear: previous.fyString,
    accounts: movements.map(m => ({
      accountCode: m.code,
      accountName: m.name,
      type: m.type,
      previousActualPaise: m.balancePaise,
    })),
  };
}
