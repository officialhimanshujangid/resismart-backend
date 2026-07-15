import mongoose, { Schema, Document } from 'mongoose';

export interface IBillPayment extends Document {
  societyId: mongoose.Types.ObjectId;
  billId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;

  paymentMethod: 'RAZORPAY' | 'UPI' | 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'OTHER';
  amountPaise: number;
  status: 'INITIATED' | 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'FAILED' | 'REJECTED' | 'REFUNDED';

  // Razorpay (online path)
  razorpayPaymentLinkId?: string;
  razorpayPaymentLinkUrl?: string;
  razorpayPaymentId?: string;
  razorpaySignatureVerified?: boolean;
  razorpayWebhookEventId?: string;
  razorpayWebhookAt?: Date;

  // Offline evidence (UPI/Cash/Bank)
  referenceNote?: string;
  proofImageKey?: string;
  proofImageUrl?: string;
  paymentDate?: Date;

  // Dual control confirmation
  confirmedBy?: mongoose.Types.ObjectId;
  confirmedByName?: string;
  confirmedAt?: Date;
  rejectedBy?: mongoose.Types.ObjectId;
  rejectedByName?: string;
  rejectedAt?: Date;
  rejectionReason?: string;

  // Who submitted this payment
  paidBy: mongoose.Types.ObjectId;
  paidByName: string;
  paidByRole: string;

  createdAt: Date;
  updatedAt: Date;
}

const BillPaymentSchema = new Schema<IBillPayment>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  billId: { type: Schema.Types.ObjectId, ref: 'SocietyBill', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },

  paymentMethod: { 
    type: String, 
    enum: ['RAZORPAY', 'UPI', 'CASH', 'BANK_TRANSFER', 'CHEQUE', 'OTHER'], 
    required: true 
  },
  amountPaise: { type: Number, required: true, min: 1 },
  status: { 
    type: String, 
    enum: ['INITIATED', 'PENDING_CONFIRMATION', 'CONFIRMED', 'FAILED', 'REJECTED', 'REFUNDED'], 
    required: true 
  },

  razorpayPaymentLinkId: { type: String },
  razorpayPaymentLinkUrl: { type: String },
  razorpayPaymentId: { type: String },
  razorpaySignatureVerified: { type: Boolean },
  razorpayWebhookEventId: { type: String },
  razorpayWebhookAt: { type: Date },

  referenceNote: { type: String, trim: true },
  proofImageKey: { type: String },
  proofImageUrl: { type: String },
  paymentDate: { type: Date },

  confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  confirmedByName: { type: String },
  confirmedAt: { type: Date },
  rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  rejectedByName: { type: String },
  rejectedAt: { type: Date },
  rejectionReason: { type: String },

  paidBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  paidByName: { type: String, required: true },
  paidByRole: { type: String, required: true },

}, { timestamps: true });

// Indexes
BillPaymentSchema.index({ razorpayPaymentLinkId: 1 }, { unique: true, sparse: true });
BillPaymentSchema.index({ razorpayWebhookEventId: 1 }, { unique: true, sparse: true });
BillPaymentSchema.index({ billId: 1, status: 1 });
BillPaymentSchema.index({ societyId: 1, status: 1, createdAt: -1 });

export const BillPayment = mongoose.model<IBillPayment>('BillPayment', BillPaymentSchema);
export default BillPayment;
