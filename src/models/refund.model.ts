import mongoose, { Schema, Document } from 'mongoose';

export type RefundStatus = 'PENDING_APPROVAL' | 'PAID' | 'REJECTED';

/**
 * Money going back to a member — an advance they no longer want held, or an
 * overpayment.
 *
 * Kept as its own record rather than a negative receipt: a refund is a decision
 * somebody makes and somebody else signs off, and `approvals.refundRequiresApproval`
 * has been sitting in the policy unenforced since it was written. A negative
 * receipt would carry no requester, no approver and no reason.
 */
export interface IRefund extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;
  blockName: string;
  flatNumber: string;
  memberName?: string;

  amountPaise: number;
  mode: 'BANK' | 'CASH';
  reason: string;

  status: RefundStatus;
  requestedBy: mongoose.Types.ObjectId;
  requestedByName: string;
  approvedBy?: mongoose.Types.ObjectId;
  approvedByName?: string;
  approvedAt?: Date;
  rejectionReason?: string;

  journalEntryId?: mongoose.Types.ObjectId;
  paidOn?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const RefundSchema = new Schema<IRefund>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  blockName: { type: String, required: true },
  flatNumber: { type: String, required: true },
  memberName: { type: String },

  amountPaise: { type: Number, required: true, min: 1 },
  mode: { type: String, enum: ['BANK', 'CASH'], default: 'BANK' },
  reason: { type: String, required: true, trim: true },

  status: { type: String, enum: ['PENDING_APPROVAL', 'PAID', 'REJECTED'], default: 'PENDING_APPROVAL' },
  requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  requestedByName: { type: String, required: true },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedByName: { type: String },
  approvedAt: { type: Date },
  rejectionReason: { type: String, trim: true },

  journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  paidOn: { type: Date },
}, { timestamps: true });

RefundSchema.index({ societyId: 1, status: 1, createdAt: -1 });
RefundSchema.index({ societyId: 1, flatId: 1 });

export const Refund = mongoose.model<IRefund>('Refund', RefundSchema);
export default Refund;
