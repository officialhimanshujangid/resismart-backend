import mongoose, { Schema, Document } from 'mongoose';

/**
 * A posted depreciation run.
 *
 * Exists so a run can be undone. Reversing the voucher alone would leave every
 * asset's `accumulatedDepreciationPaise` and `lastDepreciationUpTo` where the run
 * put them — the register would insist the depreciation had been charged while
 * the ledger said otherwise, and the next run would refuse to re-charge the span.
 * So each line records what that asset was charged and where its through-date
 * stood beforehand, which is exactly what rolling back needs.
 */
export interface IDepreciationRunLine {
  assetId: mongoose.Types.ObjectId;
  assetName: string;
  depreciationPaise: number;
  /** The asset's `lastDepreciationUpTo` before this run — restored on reversal. */
  previousLastDepreciationUpTo?: Date;
}

export interface IDepreciationRun extends Document {
  societyId: mongoose.Types.ObjectId;
  upToDate: Date;
  totalPaise: number;
  lines: IDepreciationRunLine[];

  journalEntryId: mongoose.Types.ObjectId;
  voucherNumber: string;

  status: 'POSTED' | 'REVERSED';
  reversalJournalEntryId?: mongoose.Types.ObjectId;
  reversedOn?: Date;
  reversedByName?: string;
  reversalReason?: string;

  postedBy: string;
  postedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const DepreciationRunLineSchema = new Schema<IDepreciationRunLine>({
  assetId: { type: Schema.Types.ObjectId, ref: 'FixedAsset', required: true },
  assetName: { type: String, required: true },
  depreciationPaise: { type: Number, required: true, min: 0 },
  previousLastDepreciationUpTo: { type: Date },
}, { _id: false });

const DepreciationRunSchema = new Schema<IDepreciationRun>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  upToDate: { type: Date, required: true },
  totalPaise: { type: Number, required: true, min: 0 },
  lines: { type: [DepreciationRunLineSchema], required: true },

  journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry', required: true },
  voucherNumber: { type: String, required: true },

  status: { type: String, enum: ['POSTED', 'REVERSED'], default: 'POSTED' },
  reversalJournalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  reversedOn: { type: Date },
  reversedByName: { type: String },
  reversalReason: { type: String, trim: true },

  postedBy: { type: String, required: true },
  postedByName: { type: String, required: true },
}, { timestamps: true });

DepreciationRunSchema.index({ societyId: 1, upToDate: -1 });

export const DepreciationRun = mongoose.model<IDepreciationRun>('DepreciationRun', DepreciationRunSchema);
export default DepreciationRun;
