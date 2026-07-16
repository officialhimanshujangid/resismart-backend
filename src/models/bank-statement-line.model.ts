import mongoose, { Schema, Document } from 'mongoose';

/**
 * UNMATCHED — on the statement, no journal entry claimed yet (a reconciling item).
 * MATCHED    — tied to exactly one JournalEntry.
 * IGNORED    — the row should never have been imported (a repeated header, a
 *              running-balance line, a duplicate the bank's own export emitted).
 *              It is excluded from the statement balance entirely, which is what
 *              separates it from UNMATCHED: an UNMATCHED line really happened at
 *              the bank and must still be explained.
 */
export type BankStatementLineStatus = 'UNMATCHED' | 'MATCHED' | 'IGNORED';

export interface IBankStatementLine extends Document {
  societyId: mongoose.Types.ObjectId;
  /** Which bank ledger account this statement belongs to, e.g. '1100'. */
  accountCode: string;
  /** Normalised to the start of the day — see the unique index note below. */
  txnDate: Date;
  description: string;
  /** UTR / cheque no. / bank reference. Normalised to '' when the bank gives none. */
  refNo?: string;
  /** Money OUT of the bank per the bank. In the books this is a CREDIT to the bank account. */
  debitPaise: number;
  /** Money INTO the bank per the bank. In the books this is a DEBIT to the bank account. */
  creditPaise: number;

  importBatchId: mongoose.Types.ObjectId;
  /**
   * Ordinal of this row among rows sharing its natural key *within the imported
   * batch*. Purely a de-duplication discriminator — see the unique index note.
   */
  dedupeSeq: number;

  matchedJournalEntryId?: mongoose.Types.ObjectId;
  status: BankStatementLineStatus;
  matchedBy?: string;
  matchedByName?: string;
  matchedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const BankStatementLineSchema = new Schema<IBankStatementLine>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  accountCode: { type: String, required: true, trim: true },
  txnDate: { type: Date, required: true },
  description: { type: String, required: true, trim: true, default: '' },
  // Default '' rather than leaving it unset: in a unique index, missing / null /
  // '' are three different keys, so a bank that omits the reference on some rows
  // would defeat de-duplication on exactly those rows.
  refNo: { type: String, trim: true, default: '' },
  debitPaise: { type: Number, required: true, min: 0, default: 0 },
  creditPaise: { type: Number, required: true, min: 0, default: 0 },

  importBatchId: { type: Schema.Types.ObjectId, required: true },
  dedupeSeq: { type: Number, required: true, default: 0 },

  matchedJournalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  status: { type: String, enum: ['UNMATCHED', 'MATCHED', 'IGNORED'], required: true, default: 'UNMATCHED' },
  matchedBy: { type: String },
  matchedByName: { type: String },
  matchedAt: { type: Date },
}, { timestamps: true });

// The working index: every read is "this society's lines for this bank account,
// in date order".
BankStatementLineSchema.index({ societyId: 1, accountCode: 1, txnDate: 1 });
// Auto-match and the two reconciling-item columns both filter on status.
BankStatementLineSchema.index({ societyId: 1, accountCode: 1, status: 1 });
// A journal entry may be claimed by at most one statement line. Enforced by the
// database, not just by the service: `autoMatch` and a hand match can race, and a
// double-claimed entry would be counted twice in the reconciliation.
//
// `partialFilterExpression`, NOT `sparse`. A compound sparse index indexes a
// document when ANY of its keyed fields is present — and `societyId` is always
// present — so every unmatched line would be indexed under a null
// matchedJournalEntryId, collide with the previous one, and make it impossible to
// import a second unmatched row at all. A partial index skips them properly.
BankStatementLineSchema.index(
  { societyId: 1, matchedJournalEntryId: 1 },
  { unique: true, partialFilterExpression: { matchedJournalEntryId: { $exists: true } } },
);

/**
 * Idempotent re-import.
 *
 * A bank statement has no per-row primary key, so the key has to be synthesised
 * from what every export actually contains:
 *
 *  - `societyId`  — tenant isolation.
 *  - `accountCode` — the same amount on the same day in the current account and
 *    the savings account are two different transactions, and one file could be
 *    imported against either.
 *  - `txnDate` (normalised to start-of-day at import) — banks stamp times
 *    inconsistently between exports of the same period; keeping the time would
 *    make a re-import look brand new.
 *  - `debitPaise` + `creditPaise` as two fields, not one signed amount — ₹500 out
 *    and ₹500 in are different rows.
 *  - `refNo` — the UTR/cheque number, the closest thing a bank gives to an id.
 *
 * `description` is deliberately NOT in the key. Banks re-render narration between
 * exports (whitespace, truncation, added channel suffixes), so including it would
 * let a second import of the same file insert everything again — the precise
 * failure this index exists to prevent.
 *
 * `dedupeSeq` is what makes the key safe. None of the fields above is unique:
 * two ₹500 cash deposits on the same day with no reference are two real
 * transactions, and a unique index without a discriminator would silently drop
 * the second one — quietly losing money from the reconciliation, which is worse
 * than a duplicate. `dedupeSeq` is the row's ordinal among identical rows within
 * the imported batch, so re-importing the same file recomputes the same ordinals
 * and collides (idempotent), while a genuinely repeated transaction still gets a
 * row of its own.
 */
BankStatementLineSchema.index(
  { societyId: 1, accountCode: 1, txnDate: 1, refNo: 1, debitPaise: 1, creditPaise: 1, dedupeSeq: 1 },
  { unique: true },
);

export const BankStatementLine = mongoose.model<IBankStatementLine>('BankStatementLine', BankStatementLineSchema);
export default BankStatementLine;
