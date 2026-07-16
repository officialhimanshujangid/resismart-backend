import mongoose, { ClientSession } from 'mongoose';
import { FinanceFund, IFinanceFund, FundCategory } from '../models/finance-fund.model';
import { LedgerAccount, ILedgerAccount } from '../models/ledger-account.model';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';
import { accountMovements } from './reporting-period.service';

export interface Actor { userId: string; userName: string }

/**
 * FUND accounts seeded before funds owned their own account. A fund of one of
 * these categories adopts the seeded account — but only if no other fund has
 * claimed it, so a second CORPUS fund gets its own account instead of silently
 * mirroring (and double-counting) the first one's balance.
 */
const SEEDED_CATEGORY_CODE: Partial<Record<FundCategory, string>> = {
  CORPUS: ACCOUNT_CODES.CORPUS_FUND,
  SINKING: ACCOUNT_CODES.SINKING_FUND,
  REPAIR: ACCOUNT_CODES.REPAIR_FUND,
};

// 3100-3120 are the seeded funds; 3900 is Accumulated Surplus. New funds live between.
const FUND_CODE_START = 3130;
const FUND_CODE_END = 3899;

/** Lowest unused FUND account code, reusing gaps. Races are caught by the unique {societyId, code} index. */
async function nextFundAccountCode(societyId: string | mongoose.Types.ObjectId, session?: ClientSession): Promise<string> {
  const existing = await LedgerAccount.find({ societyId }).select('code').session(session ?? null).lean();
  const used = new Set(existing.map((a) => a.code));
  for (let c = FUND_CODE_START; c <= FUND_CODE_END; c++) {
    const code = String(c);
    if (!used.has(code)) return code;
  }
  throw new Error(`No free fund account code left in ${FUND_CODE_START}-${FUND_CODE_END}`);
}

/**
 * Guarantee a fund has its own backing FUND ledger account, creating one if
 * needed. This is what makes a fund collectable: a charge head credits this
 * account, and an expense drawing on the fund debits it.
 *
 * Self-healing — funds created before this existed get linked on first read,
 * so no migration script is needed.
 */
export async function ensureFundAccount(
  societyId: string | mongoose.Types.ObjectId,
  fund: IFinanceFund,
  actor: Actor,
  session?: ClientSession,
): Promise<ILedgerAccount> {
  if (fund.ledgerAccountId) {
    const linked = await LedgerAccount.findOne({ _id: fund.ledgerAccountId, societyId }).session(session ?? null);
    if (linked) return linked;
  }

  // Adopt the legacy seeded account for this category — but only if unclaimed.
  // A compare-and-swap, not read-then-write: two funds of the same category
  // created concurrently would both see `fundId` unset, both adopt the account,
  // and resurrect the double-count this rewrite exists to kill. Whoever loses the
  // swap falls through and mints an account of its own.
  const seededCode = SEEDED_CATEGORY_CODE[fund.category];
  if (seededCode) {
    const seeded = await LedgerAccount.findOneAndUpdate(
      { societyId, code: seededCode, $or: [{ fundId: { $exists: false } }, { fundId: null }, { fundId: fund._id }] },
      { $set: { fundId: fund._id } },
      { new: true, session },
    );
    if (seeded) {
      fund.ledgerAccountId = seeded._id as mongoose.Types.ObjectId;
      await fund.save({ session });
      return seeded;
    }
  }

  // Scan-then-insert can lose a race; the unique {societyId, code} index is the
  // arbiter, so retry on collision instead of surfacing E11000 as a 500.
  for (let attempt = 0; ; attempt++) {
    const code = await nextFundAccountCode(societyId, session);
    try {
      const [account] = await LedgerAccount.create([{
        societyId,
        code,
        name: fund.name,
        type: 'FUND',
        normalBalance: 'CREDIT',
        isControlAccount: false,
        fundId: fund._id,
        isSystem: false,
        isActive: true,
        currentBalancePaise: 0,
        createdBy: actor.userId,
        createdByName: actor.userName,
      }], { session });

      fund.ledgerAccountId = account._id as mongoose.Types.ObjectId;
      await fund.save({ session });
      return account;
    } catch (e: any) {
      // A duplicate key inside a transaction has already aborted it, so only a
      // sessionless caller can usefully retry.
      if (e?.code !== 11000 || session || attempt >= 4) throw e;
    }
  }
}

export interface FundView {
  _id: string;
  name: string;
  category: FundCategory;
  description?: string;
  targetAmountPaise: number;
  isInvested: boolean;
  isActive: boolean;
  ledgerAccountId?: string;
  ledgerAccountCode?: string;
  /** Derived from posted journal entries — never a stored copy. */
  currentBalancePaise: number;
}

/**
 * Funds with balances derived from their ledger accounts.
 *
 * The balance is computed, not read from a stored field, which is why there is
 * no longer a Reconcile button: a card cannot drift from the ledger if it has no
 * separate number of its own.
 */
export async function listFunds(societyId: string, actor: Actor): Promise<FundView[]> {
  const funds = await FinanceFund.find({ societyId });

  // Link any fund that predates per-fund accounts (idempotent, one-time per fund).
  for (const fund of funds) {
    if (!fund.ledgerAccountId) await ensureFundAccount(societyId, fund, actor);
  }

  const movements = await accountMovements(societyId, {}, ['FUND']);
  const byAccountId = new Map(movements.map((m) => [m.accountId, m]));

  return funds
    .map((f) => {
      const m = f.ledgerAccountId ? byAccountId.get(String(f.ledgerAccountId)) : undefined;
      return {
        _id: String(f._id),
        name: f.name,
        category: f.category,
        description: f.description,
        targetAmountPaise: f.targetAmountPaise || 0,
        isInvested: f.isInvested,
        isActive: f.isActive,
        ledgerAccountId: f.ledgerAccountId ? String(f.ledgerAccountId) : undefined,
        ledgerAccountCode: m?.code,
        currentBalancePaise: m?.balancePaise ?? 0,
      };
    })
    .sort((a, b) => b.currentBalancePaise - a.currentBalancePaise);
}

/** Create a fund together with its backing FUND ledger account. */
export async function createFund(
  societyId: string,
  body: { name: string; category: FundCategory; description?: string; targetAmountPaise?: number; isInvested?: boolean },
  actor: Actor,
): Promise<IFinanceFund> {
  const session = await mongoose.startSession();
  try {
    let fund!: IFinanceFund;
    await session.withTransaction(async () => {
      const [created] = await FinanceFund.create([{
        societyId,
        name: body.name,
        category: body.category,
        description: body.description,
        targetAmountPaise: body.targetAmountPaise || 0,
        isInvested: Boolean(body.isInvested),
        createdBy: actor.userId,
        createdByName: actor.userName,
      }], { session });
      await ensureFundAccount(societyId, created, actor, session);
      fund = created;
    });
    return fund;
  } finally {
    session.endSession();
  }
}

/** Resolve a fund's ledger account by fund id — used to wire charge heads and expenses. */
export async function fundAccount(
  societyId: string,
  fundId: string | mongoose.Types.ObjectId,
  actor: Actor,
  session?: ClientSession,
): Promise<ILedgerAccount> {
  const fund = await FinanceFund.findOne({ _id: fundId, societyId }).session(session ?? null);
  if (!fund) throw new Error('Fund not found');
  return ensureFundAccount(societyId, fund, actor, session);
}
