import mongoose, { Schema, Document } from 'mongoose';

export type VoucherType = 'INVOICE' | 'RECEIPT' | 'PAYMENT' | 'JOURNAL' | 'CONTRA' | 'OPENING' | 'REVERSAL';
export type JournalStatus = 'POSTED' | 'REVERSED';
export type JournalSourceType = 'INVOICE' | 'RECEIPT' | 'EXPENSE' | 'ADJUSTMENT' | 'OPENING';

export interface IJournalLine {
  accountId: mongoose.Types.ObjectId;
  accountCode: string;
  accountName: string;
  debitPaise: number;
  creditPaise: number;
  flatId?: mongoose.Types.ObjectId;
  vendorId?: mongoose.Types.ObjectId;
  fundId?: mongoose.Types.ObjectId;
  /**
   * Which wing this belongs to — the cost-centre dimension.
   *
   * Denormalised rather than joined through the flat: a shared expense has no
   * flat at all, and a report that had to reach through one could never see the
   * lift bill for Tower B. A line with no `blockId` is common to the society.
   */
  blockId?: mongoose.Types.ObjectId;
  description?: string;
}

export interface IJournalEntry extends Document {
  societyId: mongoose.Types.ObjectId;
  voucherNumber: string;
  voucherType: VoucherType;
  entryDate: Date;
  financialYear: string; // '2026-2027'
  narration?: string;

  lines: IJournalLine[];
  totalDebitPaise: number;
  totalCreditPaise: number;

  sourceType?: JournalSourceType;
  sourceId?: mongoose.Types.ObjectId;

  reversalOfId?: mongoose.Types.ObjectId;
  isReversed: boolean;
  status: JournalStatus;

  postedBy: string; // userId or 'SYSTEM'
  postedByName: string;
  createdAt: Date;
}

const JournalLineSchema = new Schema<IJournalLine>({
  accountId: { type: Schema.Types.ObjectId, ref: 'LedgerAccount', required: true },
  accountCode: { type: String, required: true },
  accountName: { type: String, required: true },
  debitPaise: { type: Number, required: true, min: 0, default: 0 },
  creditPaise: { type: Number, required: true, min: 0, default: 0 },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat' },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
  fundId: { type: Schema.Types.ObjectId, ref: 'FinanceFund' },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },
  description: { type: String },
}, { _id: false });

const JournalEntrySchema = new Schema<IJournalEntry>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  voucherNumber: { type: String, required: true },
  voucherType: { type: String, enum: ['INVOICE', 'RECEIPT', 'PAYMENT', 'JOURNAL', 'CONTRA', 'OPENING', 'REVERSAL'], required: true },
  entryDate: { type: Date, required: true },
  financialYear: { type: String, required: true },
  narration: { type: String, trim: true },

  lines: { type: [JournalLineSchema], required: true },
  totalDebitPaise: { type: Number, required: true, min: 0 },
  totalCreditPaise: { type: Number, required: true, min: 0 },

  sourceType: { type: String, enum: ['INVOICE', 'RECEIPT', 'EXPENSE', 'ADJUSTMENT', 'OPENING'] },
  sourceId: { type: Schema.Types.ObjectId },

  reversalOfId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  isReversed: { type: Boolean, default: false },
  status: { type: String, enum: ['POSTED', 'REVERSED'], default: 'POSTED' },

  postedBy: { type: String, required: true },
  postedByName: { type: String, required: true },
}, {
  // Immutable ledger: only createdAt, never updatedAt.
  timestamps: { createdAt: true, updatedAt: false },
});

JournalEntrySchema.index({ societyId: 1, voucherNumber: 1 }, { unique: true });
JournalEntrySchema.index({ societyId: 1, entryDate: -1 });
JournalEntrySchema.index({ societyId: 1, voucherType: 1, financialYear: 1 });
JournalEntrySchema.index({ sourceType: 1, sourceId: 1 });
// The vendor sub-ledger. `2200 Sundry Creditors` is declared VENDOR-dimensioned
// and every expense line carries a vendorId, but nothing could query it without
// unwinding the whole journal.
JournalEntrySchema.index({ societyId: 1, 'lines.vendorId': 1, entryDate: -1 });

export const JournalEntry = mongoose.model<IJournalEntry>('JournalEntry', JournalEntrySchema);
export default JournalEntry;
