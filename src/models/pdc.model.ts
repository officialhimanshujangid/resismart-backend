import mongoose, { Schema, Document } from 'mongoose';

export type PdcStatus = 'HELD' | 'DEPOSITED' | 'CLEARED' | 'BOUNCED' | 'RETURNED';

/**
 * A post-dated cheque the society is holding for a future date.
 *
 * Deliberately NOT a Receipt. A receipt is money the society has taken in; a PDC
 * is a promise to pay on a date that has not arrived, so nothing is posted to
 * the ledger while it is HELD — booking it would overstate the bank by the value
 * of every cheque in the drawer. The register exists so the committee knows what
 * it is holding and when each one becomes bankable.
 *
 * A real Receipt (and its journal) is created only on deposit, and `receiptId`
 * links to it from then on.
 */
export interface IPostDatedCheque extends Document {
  societyId: mongoose.Types.ObjectId;
  /** Optional: a cheque can be held from a non-member before a flat is linked. */
  flatId?: mongoose.Types.ObjectId;
  blockName?: string;
  flatNumber?: string;
  payerName: string;

  chequeNo: string;
  bankName: string;
  /** The date written on the cheque — before this it cannot be banked. */
  chequeDate: Date;
  amountPaise: number;

  status: PdcStatus;
  /** The receipt raised when this cheque was deposited. Absent while HELD. */
  receiptId?: mongoose.Types.ObjectId;
  notes?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const PostDatedChequeSchema = new Schema<IPostDatedCheque>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat' },
  blockName: { type: String },
  flatNumber: { type: String },
  payerName: { type: String, required: true, trim: true },

  chequeNo: { type: String, required: true, trim: true },
  bankName: { type: String, required: true, trim: true },
  chequeDate: { type: Date, required: true },
  amountPaise: { type: Number, required: true, min: 1 },

  status: { type: String, enum: ['HELD', 'DEPOSITED', 'CLEARED', 'BOUNCED', 'RETURNED'], required: true, default: 'HELD' },
  receiptId: { type: Schema.Types.ObjectId, ref: 'Receipt' },
  notes: { type: String, trim: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
}, { timestamps: true });

// One cheque is one piece of paper. The same number from the same bank for the
// same date is the same cheque — registering it twice would have the society
// banking it twice and chasing a member for money already promised once.
PostDatedChequeSchema.index({ societyId: 1, chequeNo: 1, bankName: 1, chequeDate: 1 }, { unique: true });
// Drives the register and the "due this week" view.
PostDatedChequeSchema.index({ societyId: 1, status: 1, chequeDate: 1 });

export const PostDatedCheque = mongoose.model<IPostDatedCheque>('PostDatedCheque', PostDatedChequeSchema);
export default PostDatedCheque;