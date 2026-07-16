import mongoose from 'mongoose';
import { BankStatementLine, IBankStatementLine, BankStatementLineStatus } from '../models/bank-statement-line.model';
import { JournalEntry } from '../models/journal-entry.model';
import { LedgerAccount, ILedgerAccount } from '../models/ledger-account.model';
import { accountMovements, startOfDay, endOfDay, parseDate } from './reporting-period.service';

export interface Actor { userId: string; userName: string }

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * How far apart a statement line and a journal entry may be dated and still be
 * the same transaction. Three days covers the usual causes — a cheque banked on
 * Friday and credited on Monday, a NEFT posted on the value date, a receipt
 * entered the morning after it was taken.
 */
const DATE_TOLERANCE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The one asymmetry in this whole file, and the one that gets reconciliation wrong.
 *
 * A bank statement is written from the BANK's point of view: it "debits" your
 * account when money leaves it. The society's books are written from the
 * SOCIETY's point of view, where the bank account is an asset — money arriving
 * DEBITS it. So the two sides are mirrored:
 *
 *   statement.creditPaise (money in)  ⇔  journal debit on the bank account
 *   statement.debitPaise  (money out) ⇔  journal credit on the bank account
 *
 * Everything below is expressed in the society's direction — `inPaise` /
 * `outPaise` — so the flip happens exactly once, here at the boundary.
 */
const statementIn = (l: { creditPaise: number }) => l.creditPaise;
const statementOut = (l: { debitPaise: number }) => l.debitPaise;

export class BankReconciliationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Resolve a bank ledger account for this society, rejecting anything that isn't one. */
async function bankAccount(societyId: string, accountCode: string): Promise<ILedgerAccount> {
  const account = await LedgerAccount.findOne({ societyId, code: accountCode });
  if (!account) throw new BankReconciliationError(`Ledger account '${accountCode}' not found`, 404);
  // A reconciliation against an income or fund account is meaningless — the arithmetic
  // would still "tie" while describing nothing a bank could confirm.
  if (account.type !== 'ASSET') {
    throw new BankReconciliationError(`'${accountCode} — ${account.name}' is not a bank or cash account`);
  }
  return account;
}

export interface BankAccountOption {
  code: string;
  name: string;
  accountId: string;
}

/**
 * The accounts a statement can be imported against — the Cash & Bank asset
 * accounts. Drives the picker rather than making the page guess which of the
 * chart's ~50 accounts is a bank.
 */
export async function bankAccounts(societyId: string): Promise<BankAccountOption[]> {
  const group = await LedgerAccount.findOne({ societyId, code: '1000' }).select('_id').lean();
  const accounts = await LedgerAccount.find({
    societyId,
    type: 'ASSET',
    isActive: true,
    ...(group ? { parentAccountId: group._id } : { code: { $in: ['1100', '1105', '1110', '1120'] } }),
  }).sort({ code: 1 }).lean<ILedgerAccount[]>();

  return accounts.map((a) => ({ code: a.code, name: a.name, accountId: String(a._id) }));
}

// ---------------------------------------------------------------- import

export interface ImportLineInput {
  txnDate: string | Date;
  description?: string;
  refNo?: string;
  debitPaise?: number;
  creditPaise?: number;
}

export interface ImportStatementInput {
  accountCode: string;
  lines: ImportLineInput[];
}

export interface ImportResult {
  importBatchId: string;
  imported: number;
  duplicates: number;
}

/** The fields the unique index is built from, as a string — see the model's index note. */
const naturalKey = (accountCode: string, txnDate: Date, refNo: string, debitPaise: number, creditPaise: number) =>
  [accountCode, txnDate.getTime(), refNo, debitPaise, creditPaise].join('|');

/**
 * Import a parsed bank statement.
 *
 * Idempotent by construction: rows are de-duplicated by the model's unique index,
 * not by a read-then-write check here, so importing the same file twice — or two
 * admins importing it at the same moment — inserts each row exactly once.
 * Duplicates are counted and reported rather than thrown, because "you already
 * imported this" is a normal answer, not an error.
 */
export async function importStatement(
  societyId: string,
  body: ImportStatementInput,
  actor: Actor,
): Promise<ImportResult> {
  const account = await bankAccount(societyId, body.accountCode);
  if (!body.lines?.length) throw new BankReconciliationError('The statement has no rows to import');

  const importBatchId = new mongoose.Types.ObjectId();

  // `dedupeSeq` counts identical rows *within this batch*, so the same file always
  // produces the same ordinals and therefore the same keys. Counting against rows
  // already in the database instead would hand the second import fresh ordinals and
  // insert the whole file again.
  const seen = new Map<string, number>();

  const docs = body.lines.map((l, i) => {
    const txnDate = startOfDay(l.txnDate instanceof Date ? l.txnDate : parseDate(String(l.txnDate), `row ${i + 1} txnDate`));
    const debitPaise = Math.round(l.debitPaise || 0);
    const creditPaise = Math.round(l.creditPaise || 0);

    if (debitPaise < 0 || creditPaise < 0) {
      throw new BankReconciliationError(`Row ${i + 1}: an amount cannot be negative`);
    }
    // A row that is neither money in nor money out is a running-balance or header
    // row the parser mistook for a transaction. Letting it through would create an
    // unmatchable ₹0 reconciling item nobody can ever clear.
    if (debitPaise === 0 && creditPaise === 0) {
      throw new BankReconciliationError(`Row ${i + 1}: must have either money in or money out`);
    }
    if (debitPaise > 0 && creditPaise > 0) {
      throw new BankReconciliationError(`Row ${i + 1}: a transaction is either money in or money out, not both`);
    }

    const refNo = (l.refNo || '').trim();
    const key = naturalKey(account.code, txnDate, refNo, debitPaise, creditPaise);
    const dedupeSeq = seen.get(key) ?? 0;
    seen.set(key, dedupeSeq + 1);

    return {
      societyId: oid(societyId),
      accountCode: account.code,
      txnDate,
      description: (l.description || '').trim(),
      refNo,
      debitPaise,
      creditPaise,
      importBatchId,
      dedupeSeq,
      status: 'UNMATCHED' as BankStatementLineStatus,
    };
  });

  try {
    // `ordered: false` so one duplicate does not abandon the rest of the file.
    const inserted = await BankStatementLine.insertMany(docs, { ordered: false });
    return { importBatchId: String(importBatchId), imported: inserted.length, duplicates: 0 };
  } catch (e: any) {
    // A partially-successful unordered insertMany reports as an error carrying the
    // per-row outcome. Every write error must be a duplicate key (11000) — anything
    // else is a real failure and is rethrown.
    const writeErrors: any[] = e?.writeErrors || (e?.code === 11000 ? [e] : []);
    if (!writeErrors.length) throw e;
    const nonDuplicate = writeErrors.find((w) => (w.err?.code ?? w.code) !== 11000);
    if (nonDuplicate) throw e;

    const duplicates = writeErrors.length;
    return { importBatchId: String(importBatchId), imported: docs.length - duplicates, duplicates };
  }
}

// ---------------------------------------------------------------- book side

/**
 * One voucher's net effect on the bank account, in the society's direction.
 *
 * Aggregated per JournalEntry, not per line: a voucher is one bank transaction
 * even when it touches the account twice, and `matchedJournalEntryId` can only
 * name an entry anyway. Deliberately does NOT filter on `status`, for the same
 * reason `accountMovements` does not — a reversal is its own equal-and-opposite
 * entry and both sides must be counted, or the book balance here would not agree
 * with the one the reports show.
 */
export interface BookMovement {
  journalEntryId: string;
  voucherNumber: string;
  voucherType: string;
  entryDate: Date;
  narration?: string;
  inPaise: number;
  outPaise: number;
  /** Signed effect on the bank balance: positive is money in. */
  netPaise: number;
}

async function bookMovements(societyId: string, account: ILedgerAccount): Promise<BookMovement[]> {
  const entries = await JournalEntry.find({ societyId, 'lines.accountId': account._id })
    .sort({ entryDate: 1, createdAt: 1 })
    .lean();

  return entries.map((je: any) => {
    let inPaise = 0;
    let outPaise = 0;
    for (const line of je.lines) {
      if (String(line.accountId) !== String(account._id)) continue;
      inPaise += line.debitPaise || 0;   // debit to a bank asset = money in
      outPaise += line.creditPaise || 0; // credit to a bank asset = money out
    }
    return {
      journalEntryId: String(je._id),
      voucherNumber: je.voucherNumber,
      voucherType: je.voucherType,
      entryDate: je.entryDate,
      narration: je.narration,
      inPaise,
      outPaise,
      netPaise: inPaise - outPaise,
    };
  });
}

// ---------------------------------------------------------------- auto-match

export interface AutoMatchResult {
  matched: number;
  unmatchedLines: number;
  unmatchedBookEntries: number;
}

/**
 * Pair unmatched statement lines with unclaimed journal entries on amount, a
 * ±3-day window, and the reference when both sides carry one.
 *
 * Amount equality is required, never approximated. A near-match is a different
 * transaction, and pairing on "close enough" would produce a reconciliation that
 * ties on paper while hiding a real difference — the one thing this feature
 * exists to surface.
 *
 * Greedy and deterministic: statement lines are walked oldest-first and each
 * takes its best remaining candidate (exact reference first, then the nearest
 * date). An entry consumed by one line is removed from the pool, so it can never
 * be claimed twice — which is also enforced by a unique index, because this
 * function and a hand match can run at the same time.
 */
export async function autoMatch(societyId: string, accountCode: string, actor: Actor): Promise<AutoMatchResult> {
  const account = await bankAccount(societyId, accountCode);

  const [lines, movements, claimed] = await Promise.all([
    BankStatementLine.find({ societyId, accountCode: account.code, status: 'UNMATCHED' }).sort({ txnDate: 1, _id: 1 }),
    bookMovements(societyId, account),
    BankStatementLine.find({ societyId, accountCode: account.code, status: 'MATCHED' }).select('matchedJournalEntryId').lean(),
  ]);

  const used = new Set(claimed.map((c: any) => String(c.matchedJournalEntryId)));
  const pool = movements.filter((m) => !used.has(m.journalEntryId));

  let matched = 0;
  for (const line of lines) {
    const inPaise = statementIn(line);
    const outPaise = statementOut(line);
    const lineRef = (line.refNo || '').trim().toLowerCase();

    const candidates = pool
      .filter((m) => !used.has(m.journalEntryId))
      .filter((m) => m.inPaise === inPaise && m.outPaise === outPaise)
      .map((m) => ({
        m,
        deltaDays: Math.abs(m.entryDate.getTime() - line.txnDate.getTime()) / DAY_MS,
        // The reference only ever breaks a tie. Requiring it would match almost
        // nothing: a society's own vouchers rarely carry the bank's UTR.
        refHit: !!lineRef && `${m.voucherNumber} ${m.narration || ''}`.toLowerCase().includes(lineRef),
      }))
      .filter((c) => c.deltaDays <= DATE_TOLERANCE_DAYS)
      .sort((a, b) =>
        (Number(b.refHit) - Number(a.refHit))
        || (a.deltaDays - b.deltaDays)
        || a.m.entryDate.getTime() - b.m.entryDate.getTime()
        || a.m.journalEntryId.localeCompare(b.m.journalEntryId));

    const best = candidates[0];
    if (!best) continue;

    line.status = 'MATCHED';
    line.matchedJournalEntryId = oid(best.m.journalEntryId);
    line.matchedBy = actor.userId;
    line.matchedByName = actor.userName;
    line.matchedAt = new Date();
    try {
      await line.save();
    } catch (e: any) {
      // The unique index refused: a concurrent match took this entry first. Leave
      // the line unmatched and move on rather than fail the whole run.
      if (e?.code !== 11000) throw e;
      used.add(best.m.journalEntryId);
      continue;
    }
    used.add(best.m.journalEntryId);
    matched++;
  }

  return {
    matched,
    unmatchedLines: await BankStatementLine.countDocuments({ societyId, accountCode: account.code, status: 'UNMATCHED' }),
    unmatchedBookEntries: movements.filter((m) => !used.has(m.journalEntryId)).length,
  };
}

// ---------------------------------------------------------------- manual override

/** Load a line and fail with a 404 the controller can pass straight through. */
async function findLine(societyId: string, lineId: string): Promise<IBankStatementLine> {
  const line = await BankStatementLine.findOne({ _id: lineId, societyId });
  if (!line) throw new BankReconciliationError('Statement line not found', 404);
  return line;
}

/**
 * Tie a statement line to a journal entry by hand, for what auto-match could not
 * see (a receipt entered a fortnight late, a lump-sum bank credit).
 *
 * Amount equality is enforced here too, even though this is the manual override.
 * The reconciliation's arithmetic only ties because every matched pair cancels
 * exactly; allowing a "close enough" hand match would let an operator silently
 * break the statement that proves the books.
 */
export async function matchLine(
  societyId: string,
  lineId: string,
  journalEntryId: string,
  actor: Actor,
): Promise<IBankStatementLine> {
  const line = await findLine(societyId, lineId);
  if (line.status === 'MATCHED') throw new BankReconciliationError('This line is already matched — unmatch it first');

  const account = await bankAccount(societyId, line.accountCode);
  const entry = await JournalEntry.findOne({ _id: journalEntryId, societyId }).lean();
  if (!entry) throw new BankReconciliationError('Voucher not found', 404);

  const movement = (await bookMovements(societyId, account)).find((m) => m.journalEntryId === String(entry._id));
  if (!movement) throw new BankReconciliationError(`Voucher ${entry.voucherNumber} does not touch ${account.code} — ${account.name}`);

  if (movement.inPaise !== statementIn(line) || movement.outPaise !== statementOut(line)) {
    throw new BankReconciliationError(
      `Amounts differ: the statement line is ${rupees(statementIn(line) - statementOut(line))} `
      + `but voucher ${entry.voucherNumber} moves ${rupees(movement.netPaise)}. `
      + 'Post a correcting voucher rather than matching two different amounts.',
    );
  }

  line.status = 'MATCHED';
  line.matchedJournalEntryId = entry._id as mongoose.Types.ObjectId;
  line.matchedBy = actor.userId;
  line.matchedByName = actor.userName;
  line.matchedAt = new Date();
  try {
    await line.save();
  } catch (e: any) {
    if (e?.code === 11000) throw new BankReconciliationError(`Voucher ${entry.voucherNumber} is already matched to another statement line`, 409);
    throw e;
  }
  return line;
}

/** Undo a match — auto or manual — putting the line back on the reconciling list. */
export async function unmatchLine(societyId: string, lineId: string, actor: Actor): Promise<IBankStatementLine> {
  const line = await findLine(societyId, lineId);
  if (line.status !== 'MATCHED') throw new BankReconciliationError('This line is not matched');

  // `$unset`, not `= null`: the unique index on matchedJournalEntryId is partial
  // on `$exists`, so a null would still be indexed — a second unmatched line would
  // then collide on null and be impossible to save.
  await BankStatementLine.updateOne(
    { _id: line._id, societyId },
    {
      $set: { status: 'UNMATCHED', matchedBy: actor.userId, matchedByName: actor.userName, matchedAt: new Date() },
      $unset: { matchedJournalEntryId: '' },
    },
  );
  return (await findLine(societyId, lineId));
}

/**
 * Drop a row that should never have been imported. Excluded from the statement
 * balance, so it must genuinely be a non-transaction — a repeated header, an
 * export artefact. A real bank charge is UNMATCHED, not IGNORED: it needs a
 * voucher, not a hiding place.
 */
export async function ignoreLine(societyId: string, lineId: string, actor: Actor): Promise<IBankStatementLine> {
  const line = await findLine(societyId, lineId);
  if (line.status === 'MATCHED') throw new BankReconciliationError('Unmatch this line before ignoring it');

  line.status = 'IGNORED';
  line.matchedBy = actor.userId;
  line.matchedByName = actor.userName;
  line.matchedAt = new Date();
  await line.save();
  return line;
}

// ---------------------------------------------------------------- the BRS

export interface ReconcilingBookItem {
  journalEntryId: string;
  voucherNumber: string;
  voucherType: string;
  entryDate: Date;
  narration?: string;
  inPaise: number;
  outPaise: number;
  netPaise: number;
}

export interface ReconcilingStatementItem {
  _id: string;
  txnDate: Date;
  description: string;
  refNo?: string;
  debitPaise: number;
  creditPaise: number;
  netPaise: number;
}

export interface Reconciliation {
  accountCode: string;
  accountName: string;
  asOf: Date;
  /** Per the books, from the journal — the same figure the Balance Sheet shows. */
  bookBalancePaise: number;
  /** Per the bank, derived from the imported lines. */
  statementBalancePaise: number;
  /** In the ledger, not (yet) on the statement. */
  unmatchedInBooks: ReconcilingBookItem[];
  /** On the statement, not (yet) in the ledger. */
  unmatchedOnStatement: ReconcilingStatementItem[];
  booksOnlyNetPaise: number;
  statementOnlyNetPaise: number;
  /** Zero when the statement is fully explained. */
  differencePaise: number;
  reconciled: boolean;
  counts: { statementLines: number; matched: number; unmatched: number; ignored: number; bookEntries: number };
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * The bank reconciliation statement itself.
 *
 *   book balance − (in the books, not on the statement) + (on the statement, not in the books)
 *     = statement balance
 *
 * That identity is not decoration; it is the proof. It holds because every matched
 * pair moves the same money on both sides and therefore cancels, leaving only the
 * reconciling items — which is exactly why `matchLine` refuses to pair unequal
 * amounts.
 *
 * "Unmatched" here means *unmatched as at the cut-off*, not merely `status !==
 * 'MATCHED'`. A cheque written on the 30th and cleared on the 2nd is matched in
 * the database, yet at a 31st cut-off it is still a reconciling item — it is in
 * the books and not yet on the statement. Treating the pair as settled would put
 * the statement out by its amount. So a pair counts as settled only when BOTH
 * sides fall on or before `asOf`.
 *
 * `statementBalancePaise` is derived from the imported lines rather than read from
 * a bank-supplied closing balance, which means it is the bank's true closing
 * balance only if the imported history reaches back to the account's inception.
 * Import from the start, or read the difference as "unexplained since import".
 */
export async function reconciliation(
  societyId: string,
  query: { accountCode: string; asOf?: string },
): Promise<Reconciliation> {
  const account = await bankAccount(societyId, query.accountCode);
  const asOf = endOfDay(query.asOf ? parseDate(query.asOf, 'asOf') : new Date());

  const [movements, allLines, movementRows] = await Promise.all([
    bookMovements(societyId, account),
    BankStatementLine.find({ societyId, accountCode: account.code }).sort({ txnDate: 1, _id: 1 }).lean<IBankStatementLine[]>(),
    // The book balance comes from `accountMovements` — the same source the Trial
    // Balance and Balance Sheet read, so the BRS can never quietly disagree with
    // the statements it is meant to support.
    accountMovements(societyId, { to: asOf }, [account.type]),
  ]);

  const bookBalancePaise = movementRows.find((m) => m.accountId === String(account._id))?.balancePaise ?? 0;

  // A line the operator has ignored never happened as far as this statement is
  // concerned — see the model's status note.
  const live = allLines.filter((l) => l.status !== 'IGNORED');
  const within = live.filter((l) => l.txnDate <= asOf);

  const statementBalancePaise = within.reduce((s, l) => s + statementIn(l) - statementOut(l), 0);

  const movementById = new Map(movements.map((m) => [m.journalEntryId, m]));
  const lineByJournalId = new Map(
    live.filter((l) => l.status === 'MATCHED' && l.matchedJournalEntryId)
      .map((l) => [String(l.matchedJournalEntryId), l] as const),
  );

  const unmatchedInBooks: ReconcilingBookItem[] = movements
    .filter((m) => m.entryDate <= asOf)
    .filter((m) => {
      const counterpart = lineByJournalId.get(m.journalEntryId);
      // Unmatched, or matched to a line the bank only shows after the cut-off.
      return !counterpart || counterpart.txnDate > asOf;
    })
    .map((m) => ({
      journalEntryId: m.journalEntryId,
      voucherNumber: m.voucherNumber,
      voucherType: m.voucherType,
      entryDate: m.entryDate,
      narration: m.narration,
      inPaise: m.inPaise,
      outPaise: m.outPaise,
      netPaise: m.netPaise,
    }));

  const unmatchedOnStatement: ReconcilingStatementItem[] = within
    .filter((l) => {
      if (l.status !== 'MATCHED' || !l.matchedJournalEntryId) return true;
      const counterpart = movementById.get(String(l.matchedJournalEntryId));
      // Matched to a voucher the books only carry after the cut-off.
      return !counterpart || counterpart.entryDate > asOf;
    })
    .map((l) => ({
      _id: String(l._id),
      txnDate: l.txnDate,
      description: l.description,
      refNo: l.refNo,
      debitPaise: l.debitPaise,
      creditPaise: l.creditPaise,
      netPaise: statementIn(l) - statementOut(l),
    }));

  const booksOnlyNetPaise = unmatchedInBooks.reduce((s, r) => s + r.netPaise, 0);
  const statementOnlyNetPaise = unmatchedOnStatement.reduce((s, r) => s + r.netPaise, 0);

  const differencePaise = (bookBalancePaise - booksOnlyNetPaise + statementOnlyNetPaise) - statementBalancePaise;

  return {
    accountCode: account.code,
    accountName: account.name,
    asOf,
    bookBalancePaise,
    statementBalancePaise,
    unmatchedInBooks,
    unmatchedOnStatement,
    booksOnlyNetPaise,
    statementOnlyNetPaise,
    differencePaise,
    reconciled: differencePaise === 0,
    counts: {
      statementLines: allLines.length,
      matched: allLines.filter((l) => l.status === 'MATCHED').length,
      unmatched: allLines.filter((l) => l.status === 'UNMATCHED').length,
      ignored: allLines.filter((l) => l.status === 'IGNORED').length,
      bookEntries: movements.length,
    },
  };
}
