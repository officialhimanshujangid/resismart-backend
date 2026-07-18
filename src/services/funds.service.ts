import mongoose, { ClientSession } from 'mongoose';
import { FinanceFund, IFinanceFund, FundCategory } from '../models/finance-fund.model';
import { LedgerAccount, ILedgerAccount } from '../models/ledger-account.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';
import { accountMovements } from './reporting-period.service';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

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

  /**
   * Everything ever credited to this fund — what the society has DEMANDED.
   *
   * This, not the balance, is what a target must be judged against. A fund that
   * raised its full ₹1,50,000 and then paid the painter ₹1,40,000 has a balance
   * of ₹10,000; comparing that to the target would tell the society to collect
   * ₹1,40,000 more from members who have already paid in full.
   */
  raisedPaise: number;
  /** Everything ever drawn out — what has been spent from it. */
  spentPaise: number;
  /**
   * How much of what was demanded has actually reached the bank.
   *
   * A fund is credited when the invoice is RAISED, not when it is paid, so
   * `raisedPaise` runs ahead of the cash. Apportioned from each invoice's paid
   * fraction, because FIFO settles whole invoices and never a single line.
   */
  collectedPaise: number;
  /** Still to be demanded before the target is met. Zero once it is. */
  remainingToRaisePaise: number;
  /** Demanded beyond the target. Non-zero means members were over-charged. */
  overRaisedPaise: number;
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
  const collected = await collectedByFund(societyId);

  return funds
    .map((f) => {
      const m = f.ledgerAccountId ? byAccountId.get(String(f.ledgerAccountId)) : undefined;
      const targetAmountPaise = f.targetAmountPaise || 0;
      // Gross in and gross out, not the net. See `raisedPaise` on FundView for
      // why the net would make the system demand money it already has.
      const raisedPaise = m?.creditPaise ?? 0;
      const spentPaise = m?.debitPaise ?? 0;
      return {
        _id: String(f._id),
        name: f.name,
        category: f.category,
        description: f.description,
        targetAmountPaise,
        isInvested: f.isInvested,
        isActive: f.isActive,
        ledgerAccountId: f.ledgerAccountId ? String(f.ledgerAccountId) : undefined,
        ledgerAccountCode: m?.code,
        currentBalancePaise: m?.balancePaise ?? 0,
        raisedPaise,
        spentPaise,
        collectedPaise: collected.get(String(f._id)) || 0,
        remainingToRaisePaise: targetAmountPaise > 0 ? Math.max(0, targetAmountPaise - raisedPaise) : 0,
        overRaisedPaise: targetAmountPaise > 0 ? Math.max(0, raisedPaise - targetAmountPaise) : 0,
      };
    })
    .sort((a, b) => b.currentBalancePaise - a.currentBalancePaise);
}

/**
 * How much cash has actually arrived against each fund.
 *
 * A fund is credited when the bill is raised, so its ledger balance is what was
 * demanded, not what came in. Receipts settle whole invoices — FIFO never
 * allocates to a single line — so the honest figure is each fund line scaled by
 * how much of its invoice has been paid. Approximate by nature, and labelled as
 * such on screen; the guard that actually protects members is raised-vs-target.
 */
async function collectedByFund(societyId: string): Promise<Map<string, number>> {
  const rows = await MaintenanceInvoice.aggregate([
    { $match: { societyId: oid(societyId), 'lineItems.fundId': { $exists: true, $ne: null } } },
    {
      $project: {
        totalPaise: 1,
        outstandingPaise: 1,
        lineItems: {
          $filter: { input: '$lineItems', as: 'li', cond: { $ne: ['$$li.fundId', null] } },
        },
      },
    },
    { $unwind: '$lineItems' },
    {
      $group: {
        _id: '$lineItems.fundId',
        collectedPaise: {
          $sum: {
            $cond: [
              { $gt: ['$totalPaise', 0] },
              {
                $round: [{
                  $multiply: [
                    '$lineItems.lineTotalPaise',
                    { $divide: [{ $subtract: ['$totalPaise', '$outstandingPaise'] }, '$totalPaise'] },
                  ],
                }, 0],
              },
              0,
            ],
          },
        },
      },
    },
  ]);
  return new Map(rows.map((r: any) => [String(r._id), Math.max(0, r.collectedPaise || 0)]));
}

/**
 * Edit a fund's own details.
 *
 * There was no update route at all: a target typed wrongly at creation could
 * never be corrected, which made the whole target-vs-raised guard unusable in
 * practice. Category is deliberately not editable — it decides which seeded
 * ledger account the fund adopted, and changing it after money has moved would
 * strand the balance in the old account.
 */
export async function updateFund(
  societyId: string,
  fundId: string,
  body: { name?: string; description?: string; targetAmountPaise?: number; isInvested?: boolean; isActive?: boolean },
  actor: Actor,
): Promise<IFinanceFund> {
  const fund = await FinanceFund.findOne({ _id: fundId, societyId });
  if (!fund) throw new Error('Fund not found');

  if (body.name !== undefined) {
    if (!body.name.trim()) throw new Error('A fund needs a name');
    fund.name = body.name.trim();
  }
  if (body.description !== undefined) fund.description = body.description;
  if (body.targetAmountPaise !== undefined) fund.targetAmountPaise = Math.max(0, Math.round(body.targetAmountPaise));
  if (body.isInvested !== undefined) fund.isInvested = body.isInvested;
  if (body.isActive !== undefined) fund.isActive = body.isActive;

  fund.updatedBy = new mongoose.Types.ObjectId(actor.userId);
  fund.updatedByName = actor.userName;
  await fund.save();
  return fund;
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
