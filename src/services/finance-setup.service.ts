import mongoose from 'mongoose';
import { FinancePolicy } from '../models/finance-policy.model';
import { JournalEntry } from '../models/journal-entry.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Expense } from '../models/expense.model';
import { Vendor } from '../models/vendor.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { postJournal } from './ledger.service';
import { getOrCreatePolicy } from './finance-policy.service';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * The parts of "where do our books start?" a society can answer separately.
 *
 * Split this finely on purpose. A society with no vendors should be able to say
 * so in one click rather than having to pretend it is dealing with a section
 * that does not apply to it — and a single society-wide "we have nothing"
 * button would let somebody skip past four questions they should have read.
 */
export const SETUP_SECTIONS = ['BANK_CASH', 'FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'] as const;
export type SetupSection = typeof SETUP_SECTIONS[number];

const isSection = (s: string): s is SetupSection => (SETUP_SECTIONS as readonly string[]).includes(s);

/**
 * Which account types each section is allowed to touch.
 *
 * Existence is not enough. Without this a bank balance can be entered against
 * `2200 Sundry Creditors`, the entry still balances because 3900 absorbs the
 * difference, and the books are wrong from day one in exactly the way the whole
 * feature exists to prevent — silently, and looking perfectly correct.
 */
const ALLOWED_TYPES: Record<'bankCash' | 'funds' | 'deposits', string[]> = {
  bankCash: ['ASSET'],
  funds: ['EQUITY', 'LIABILITY'],
  deposits: ['LIABILITY'],
};

export interface SetupState {
  complete: boolean;
  completedAt?: Date;
  completedBy?: string;
  completedByName?: string;
  declaredEmpty: SetupSection[];
  openingVoucherId?: string;
  /** Set when the answer was read off existing data rather than given by a person. */
  inferredFrom?: Date;
  /** Whether the admin may still reopen it — see `canReopen` below for the rule. */
  canReopen: boolean;
}

export class SetupError extends Error {}

/**
 * The earliest sign that this society was already keeping books.
 *
 * Invoices are checked separately from journals rather than trusted to imply
 * them: back-filled invoices deliberately post no journal, so a society
 * migrated that way would look untouched if we only counted vouchers.
 */
async function earliestActivity(societyId: string): Promise<Date | undefined> {
  const s = oid(societyId);
  const [journal, invoice, expense] = await Promise.all([
    JournalEntry.findOne({ societyId: s }).sort({ entryDate: 1 }).select('entryDate').lean(),
    MaintenanceInvoice.findOne({ societyId: s }).sort({ createdAt: 1 }).select('createdAt').lean(),
    Expense.findOne({ societyId: s }).sort({ expenseDate: 1 }).select('expenseDate').lean(),
  ]);

  const dates = [journal?.entryDate, invoice?.createdAt, expense?.expenseDate].filter(Boolean) as Date[];
  if (!dates.length) return undefined;
  return dates.reduce((a, b) => (a < b ? a : b));
}

/**
 * May the admin reopen a completed setup?
 *
 * Three cases, and they are different questions wearing the same name:
 *
 * - Nobody completed it; `resolveSetup` inferred it so the society could keep
 *   working. Reopening is always allowed, because the question was never
 *   actually asked. This is the society that has been running ten months and
 *   now wants to state what it really started with.
 *
 * - A person completed it and an OPENING voucher exists. Reopening would orphan
 *   that voucher and a second completion would post another on top of it, so it
 *   is refused until the first has been reversed. Reversal is the module's
 *   standard correction route and leaves both the error and the fix visible —
 *   which is exactly what an auditor wants to see.
 *
 * - A person completed it declaring nothing, so there is no voucher. Then the
 *   only risk is entries posted since; "I clicked confirm too early" is common
 *   and harmless while no money has moved.
 */
async function canReopen(
  societyId: string,
  completedAt: Date,
  inferred: boolean,
  openingVoucherId?: mongoose.Types.ObjectId,
): Promise<boolean> {
  if (inferred) return true;

  if (openingVoucherId) {
    const reversed = await JournalEntry.countDocuments({
      societyId: oid(societyId),
      reversalOfId: openingVoucherId,
    });
    return reversed > 0;
  }

  // No voucher, so the only thing at stake is whatever has been posted since.
  // `completedAt` here is always the moment a person confirmed (never an
  // inferred, possibly back-dated entry date), so this is apples to apples.
  const after = await JournalEntry.countDocuments({
    societyId: oid(societyId),
    createdAt: { $gt: completedAt },
  });
  return after === 0;
}

/**
 * Has this society said where its books start — deciding once from its own data
 * if it never had the chance to say?
 *
 * The inference is the whole point of this function. Without it, shipping the
 * setup gate would lock every society that was already trading out of its own
 * finance module on the day of deploy: they never completed a step that did not
 * exist. `resolveModules` already carries this scar, and the comment there says
 * it plainly — the change would read as data loss even though nothing was lost.
 *
 * Inference is recorded as `inferredFrom` rather than silently backdating
 * `completedAt` alone, so a later reader can tell a stated opening position
 * from an assumed one. Same habit as `isEstimated` elsewhere: a guess is
 * allowed, but it has to admit that it is a guess.
 */
export async function resolveSetup(societyId: string): Promise<SetupState> {
  const policy = await FinancePolicy.findOne({ societyId }).select('setup').lean();
  const setup = policy?.setup;

  if (setup?.completedAt) {
    const inferred = Boolean(setup.inferredFrom);
    return {
      complete: true,
      completedAt: setup.completedAt,
      completedBy: setup.completedBy?.toString(),
      completedByName: setup.completedByName,
      declaredEmpty: (setup.declaredEmpty ?? []).filter(isSection),
      openingVoucherId: setup.openingVoucherId?.toString(),
      inferredFrom: setup.inferredFrom,
      canReopen: await canReopen(societyId, setup.completedAt, inferred, setup.openingVoucherId),
    };
  }

  // Deliberately reopened: do not guess. Without this the society's own opening
  // voucher reads as "was already trading", the inference fires, and reopening
  // becomes a no-op that lets a second opening entry be posted over the first.
  //
  // Note that OPENING vouchers are otherwise left IN the inference below, on
  // purpose: a society that entered its opening balances by hand before this
  // feature existed has one, and excluding them would lock exactly the careful
  // societies out of their own books.
  if (setup?.reopenedAt) {
    return { complete: false, declaredEmpty: [], canReopen: false };
  }

  const firstActivity = await earliestActivity(societyId);
  if (!firstActivity) {
    return { complete: false, declaredEmpty: [], canReopen: false };
  }

  // Best-effort persist: the society gets a usable answer either way, and this
  // write is not worth failing their request over. It no-ops for a society with
  // no policy document yet — harmless, because the answer above is already
  // correct and `completeSetup` creates the policy before it writes anything.
  await FinancePolicy.updateOne(
    { societyId },
    { $set: { 'setup.completedAt': firstActivity, 'setup.inferredFrom': firstActivity } },
  ).catch(() => undefined);

  return {
    complete: true,
    completedAt: firstActivity,
    declaredEmpty: [],
    inferredFrom: firstActivity,
    canReopen: true,
  };
}

/**
 * Cheap gate for the middleware — deliberately NOT `resolveSetup`.
 *
 * This runs on every non-GET finance request. `resolveSetup` computes
 * `canReopen`, which counts journal entries on fields with no supporting index;
 * the middleware then throws that answer away. Reading one field is the whole
 * job here.
 */
export async function isSetupComplete(societyId: string): Promise<boolean> {
  const policy = await FinancePolicy.findOne({ societyId }).select('setup.completedAt setup.reopenedAt').lean();
  if (policy?.setup?.completedAt) return true;
  if (policy?.setup?.reopenedAt) return false;
  return Boolean(await earliestActivity(societyId));
}

export interface OpeningLineInput {
  accountCode: string;
  amountPaise: number;
}
export interface VendorDueInput {
  vendorId: string;
  amountPaise: number;
}

export interface CompleteSetupInput {
  entryDate?: Date;
  /** Bank and cash the society held on day one. Debits — these are assets. */
  bankCash?: OpeningLineInput[];
  /** What the society already owed each vendor. Credits, tagged per vendor. */
  vendorDues?: VendorDueInput[];
  /** Reserves already accumulated. Credits. */
  funds?: OpeningLineInput[];
  /** Deposits held from members. Credits. */
  deposits?: OpeningLineInput[];
  /** Sections the society explicitly said it had nothing for. */
  declaredEmpty?: string[];
}

interface Composed {
  lines: { accountCode: string; debitPaise?: number; creditPaise?: number; vendorId?: string; description?: string }[];
  debitPaise: number;
  creditPaise: number;
}

/**
 * Turn the answers into journal lines, with the balancing figure on 3900.
 *
 * Every opening balance is one half of an entry whose other half is, by
 * definition, the society's accumulated position at the moment it started
 * keeping these books. That is what `3900 Accumulated Surplus / Opening Balance
 * Equity` is for. Asking the user to make Dr equal Cr themselves would be asking
 * them to do bookkeeping to answer a question about bank balances.
 */
export function composeOpening(input: CompleteSetupInput): Composed {
  const lines: Composed['lines'] = [];
  let debitPaise = 0;
  let creditPaise = 0;

  for (const l of input.bankCash ?? []) {
    if (l.amountPaise <= 0) continue;
    lines.push({ accountCode: l.accountCode, debitPaise: l.amountPaise, description: 'Opening balance' });
    debitPaise += l.amountPaise;
  }
  for (const v of input.vendorDues ?? []) {
    if (v.amountPaise <= 0) continue;
    lines.push({
      accountCode: ACCOUNT_CODES.CREDITORS,
      creditPaise: v.amountPaise,
      vendorId: v.vendorId,
      description: 'Opening payable',
    });
    creditPaise += v.amountPaise;
  }
  for (const l of [...(input.funds ?? []), ...(input.deposits ?? [])]) {
    if (l.amountPaise <= 0) continue;
    lines.push({ accountCode: l.accountCode, creditPaise: l.amountPaise, description: 'Opening balance' });
    creditPaise += l.amountPaise;
  }

  if (!lines.length) return { lines, debitPaise, creditPaise };

  // The balancing figure. Whichever side is short gets 3900.
  const diff = debitPaise - creditPaise;
  if (diff > 0) {
    lines.push({ accountCode: ACCOUNT_CODES.SURPLUS, creditPaise: diff, description: 'Opening balance equity' });
    creditPaise += diff;
  } else if (diff < 0) {
    lines.push({ accountCode: ACCOUNT_CODES.SURPLUS, debitPaise: -diff, description: 'Opening balance equity' });
    debitPaise += -diff;
  }

  return { lines, debitPaise, creditPaise };
}

/** Reject a section that both supplies figures and claims to be empty. */
function assertNoContradiction(input: CompleteSetupInput, declaredEmpty: SetupSection[]) {
  const supplied: [SetupSection, boolean][] = [
    ['BANK_CASH', Boolean(input.bankCash?.some(l => l.amountPaise > 0))],
    ['VENDOR_DUES', Boolean(input.vendorDues?.some(l => l.amountPaise > 0))],
    ['FUNDS', Boolean(input.funds?.some(l => l.amountPaise > 0))],
    ['DEPOSITS', Boolean(input.deposits?.some(l => l.amountPaise > 0))],
  ];
  const contradicting = supplied.filter(([s, has]) => has && declaredEmpty.includes(s)).map(([s]) => s);
  if (contradicting.length) {
    throw new SetupError(
      `${contradicting.join(', ')} is marked "nothing here" but has figures. The record would contradict the voucher beside it.`,
    );
  }
}

/**
 * Record the society's starting position and close the question.
 *
 * Posts the OPENING voucher and stamps the policy in one transaction. Doing
 * these as two calls from the browser would leave a society that lost its
 * connection in between with an opening voucher and an unanswered question —
 * and the natural response to that screen is to enter everything again.
 */
export async function completeSetup(
  societyId: string,
  userId: string,
  userName: string,
  input: CompleteSetupInput,
): Promise<{ openingVoucherId?: string; totalPaise: number }> {
  // The policy document is created lazily elsewhere, so a brand new society may
  // not have one at all. Without this every write below silently matches zero
  // documents, the caller is told setup succeeded, and the society is locked out
  // of finance forever by a wizard that reports success on every retry.
  await getOrCreatePolicy(societyId, userId, userName);

  const state = await resolveSetup(societyId);
  if (state.complete && !state.inferredFrom) {
    throw new SetupError('Setup is already complete. Reopen it first if you need to change it.');
  }

  if (input.entryDate && Number.isNaN(input.entryDate.getTime())) {
    throw new SetupError('That opening date could not be read.');
  }

  const declaredEmpty = (input.declaredEmpty ?? []).filter(isSection);
  assertNoContradiction(input, declaredEmpty);
  const composed = composeOpening(input);

  // Every section must be either answered or explicitly declared empty. A
  // half-answered setup is worse than none: it looks finished on the screen.
  const answered = new Set<SetupSection>(declaredEmpty);
  if (input.bankCash?.some(l => l.amountPaise > 0)) answered.add('BANK_CASH');
  if (input.vendorDues?.some(l => l.amountPaise > 0)) answered.add('VENDOR_DUES');
  if (input.funds?.some(l => l.amountPaise > 0)) answered.add('FUNDS');
  if (input.deposits?.some(l => l.amountPaise > 0)) answered.add('DEPOSITS');
  // Flat dues come in through the bulk import, which posts its own opening
  // invoices — so it is answered by having any invoice at all, or by being
  // declared empty here.
  if (!answered.has('FLAT_DUES')) {
    const anyInvoice = await MaintenanceInvoice.countDocuments({ societyId: oid(societyId) });
    if (anyInvoice > 0) answered.add('FLAT_DUES');
  }
  const missing = SETUP_SECTIONS.filter(s => !answered.has(s));
  if (missing.length) {
    throw new SetupError(`Nothing said about: ${missing.join(', ')}. Enter a figure or tick "nothing here".`);
  }

  // Vendors must belong to this society and still be active. An id from
  // somewhere else would post a payable this society does not owe, against a
  // name it cannot see; a deactivated one would create a live balance on a
  // vendor the screens will never show again.
  const vendorIds = [...new Set((input.vendorDues ?? []).filter(v => v.amountPaise > 0).map(v => String(v.vendorId)))];
  if (vendorIds.length) {
    const mine = await Vendor.countDocuments({
      _id: { $in: vendorIds.map(oid) },
      societyId: oid(societyId),
      isActive: true,
    });
    if (mine !== vendorIds.length) throw new SetupError('One or more vendors are unknown to this society or inactive.');
  }

  // Accounts must exist, be active, and be the RIGHT KIND. A typo'd code should
  // fail loudly rather than post to nothing; a liability sitting in the bank
  // column should fail loudly rather than balance perfectly and lie.
  await assertAccountTypes(societyId, input);

  const session = await mongoose.startSession();
  let openingVoucherId: string | undefined;
  try {
    await session.withTransaction(async () => {
      // Re-read inside the transaction and make the stamp itself the lock.
      // Two clicks on "Finish" would otherwise both pass the check above, both
      // post, and double the society's opening balances.
      const claim = await FinancePolicy.updateOne(
        {
          societyId,
          $or: [
            { 'setup.completedAt': { $exists: false } },
            { 'setup.inferredFrom': { $exists: true } },
          ],
        },
        {
          $set: {
            'setup.completedAt': new Date(),
            'setup.completedBy': oid(userId),
            'setup.completedByName': userName,
            'setup.declaredEmpty': declaredEmpty,
          },
          $unset: { 'setup.inferredFrom': '', 'setup.reopenedAt': '', 'setup.openingVoucherId': '' },
        },
        { session },
      );
      if (claim.modifiedCount === 0) {
        throw new SetupError('Setup was completed by someone else a moment ago.');
      }

      if (composed.lines.length) {
        const entry = await postJournal(
          societyId,
          {
            voucherType: 'OPENING',
            entryDate: input.entryDate,
            narration: 'Opening balances',
            sourceType: 'OPENING',
            lines: composed.lines,
            postedBy: userId,
            postedByName: userName,
          },
          session,
        );
        openingVoucherId = (entry as any)?._id?.toString();
        await FinancePolicy.updateOne(
          { societyId },
          { $set: { 'setup.openingVoucherId': oid(openingVoucherId) } },
          { session },
        );
      }
    });
  } finally {
    await session.endSession();
  }

  return { openingVoucherId, totalPaise: composed.debitPaise };
}

/**
 * Accounts must exist, be active, and sit on the side of the balance sheet the
 * section claims. Checked in one query rather than three round trips.
 */
async function assertAccountTypes(societyId: string, input: CompleteSetupInput) {
  const wanted: { code: string; section: keyof typeof ALLOWED_TYPES }[] = [
    ...(input.bankCash ?? []).filter(l => l.amountPaise > 0).map(l => ({ code: l.accountCode, section: 'bankCash' as const })),
    ...(input.funds ?? []).filter(l => l.amountPaise > 0).map(l => ({ code: l.accountCode, section: 'funds' as const })),
    ...(input.deposits ?? []).filter(l => l.amountPaise > 0).map(l => ({ code: l.accountCode, section: 'deposits' as const })),
  ];
  if (!wanted.length) return;

  const codes = [...new Set(wanted.map(w => w.code))];
  const rows = await LedgerAccount.find({ societyId: oid(societyId), code: { $in: codes }, isActive: true })
    .select('code type')
    .lean();
  const byCode = new Map(rows.map(r => [r.code, r.type]));

  const unknown = codes.filter(c => !byCode.has(c));
  if (unknown.length) {
    throw new SetupError(`Unknown or inactive account code: ${unknown.join(', ')}.`);
  }

  for (const w of wanted) {
    const type = byCode.get(w.code)!;
    if (!ALLOWED_TYPES[w.section].includes(type)) {
      throw new SetupError(
        `Account ${w.code} is ${type} — it cannot hold a ${w.section === 'bankCash' ? 'bank or cash' : w.section} opening balance.`,
      );
    }
  }
}

/**
 * Let the admin answer the question again.
 *
 * Deliberately does not touch the opening voucher already posted. If one exists
 * it stays, and a second `completeSetup` would add another — which is why
 * `canReopen` refuses until the first has been reversed. Reversing it goes
 * through the normal reversal route, the same as any other correction here.
 */
export async function reopenSetup(societyId: string, userId: string, userName: string): Promise<void> {
  const state = await resolveSetup(societyId);
  if (!state.complete) return;
  if (!state.canReopen) {
    throw new SetupError('Entries have been posted since setup was completed. Correct them with a journal instead.');
  }

  await getOrCreatePolicy(societyId, userId, userName);
  await FinancePolicy.updateOne(
    { societyId },
    {
      $set: { 'setup.reopenedAt': new Date() },
      // openingVoucherId must go too. Left behind, it points at a voucher from
      // the previous cycle whose old reversal then satisfies `canReopen`
      // forever — waving through every future reopen, including ones with live
      // entries sitting on top.
      $unset: {
        'setup.completedAt': '', 'setup.completedBy': '', 'setup.completedByName': '',
        'setup.inferredFrom': '', 'setup.openingVoucherId': '', 'setup.declaredEmpty': '',
      },
    },
  );
  logger.info(`Society ${societyId}: finance setup reopened by ${userName} (${userId})`);
}
