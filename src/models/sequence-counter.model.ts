import mongoose, { Schema, Document } from 'mongoose';

/**
 * Atomic, gapless sequence source for finance document numbers, scoped per
 * society / document-type / financial-year. Incremented via findOneAndUpdate
 * ($inc, upsert) — reserve the number INSIDE the same transaction that creates
 * the document so a rolled-back txn doesn't burn a number.
 */
export interface ISequenceCounter extends Document {
  societyId: mongoose.Types.ObjectId;
  scope: string;          // e.g. 'INVOICE' | 'RECEIPT' | 'PAYMENT' | 'JOURNAL' | 'CONTRA' | 'OPENING' | 'REVERSAL'
  financialYear: string;  // '2026-2027'
  seq: number;
}

const SequenceCounterSchema = new Schema<ISequenceCounter>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  scope: { type: String, required: true },
  financialYear: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 },
});

SequenceCounterSchema.index({ societyId: 1, scope: 1, financialYear: 1 }, { unique: true });

export const SequenceCounter = mongoose.model<ISequenceCounter>('SequenceCounter', SequenceCounterSchema);
export default SequenceCounter;
