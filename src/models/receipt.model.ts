import mongoose, { Schema, Document } from 'mongoose';

export type ReceiptMode = 'CASH' | 'CHEQUE' | 'UPI' | 'BANK_TRANSFER' | 'RAZORPAY' | 'OTHER';
export type ReceiptStatus = 'INITIATED' | 'PENDING_CONFIRMATION' | 'CLEARED' | 'BOUNCED' | 'REVERSED' | 'REJECTED';
export type ReceiptSource = 'RESIDENT' | 'ADMIN_WALKIN' | 'GATEWAY';

export interface IReceiptAllocation {
  invoiceId: mongoose.Types.ObjectId;
  invoiceNumber: string;
  billingPeriod: string;
  appliedPaise: number;
}

export interface IReceipt extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;
  blockName: string;
  flatNumber: string;

  receiptNumber: string;
  financialYear: string;
  receiptDate: Date;

  mode: ReceiptMode;
  amountPaise: number;
  allocations: IReceiptAllocation[];
  advanceCreatedPaise: number;
  depositAccountCode: string; // asset account money landed in (1110/1120/1100)

  instrument?: { chequeNo?: string; bankName?: string; chequeDate?: Date };
  referenceNote?: string;
  proofImageKey?: string;
  proofImageUrl?: string;

  // online
  razorpayPaymentLinkId?: string;
  razorpayPaymentLinkUrl?: string;
  razorpayPaymentId?: string;
  razorpayWebhookEventId?: string;
  gatewayFeePaise?: number;

  status: ReceiptStatus;
  source: ReceiptSource;

  journalEntryId?: mongoose.Types.ObjectId;
  reversalJournalEntryId?: mongoose.Types.ObjectId;
  clearanceJournalEntryId?: mongoose.Types.ObjectId;

  recordedBy: mongoose.Types.ObjectId;
  recordedByName: string;
  recordedByRole: string;
  confirmedBy?: mongoose.Types.ObjectId;
  confirmedByName?: string;
  confirmedAt?: Date;
  rejectedBy?: mongoose.Types.ObjectId;
  rejectedByName?: string;
  rejectedAt?: Date;
  rejectionReason?: string;

  pdfKey?: string;
  pdfUrl?: string;

  createdAt: Date;
  updatedAt: Date;
}

const AllocationSchema = new Schema<IReceiptAllocation>({
  invoiceId: { type: Schema.Types.ObjectId, ref: 'MaintenanceInvoice', required: true },
  invoiceNumber: { type: String, required: true },
  billingPeriod: { type: String, required: true },
  appliedPaise: { type: Number, required: true, min: 0 },
}, { _id: false });

const ReceiptSchema = new Schema<IReceipt>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  blockName: { type: String, required: true },
  flatNumber: { type: String, required: true },

  receiptNumber: { type: String, required: true },
  financialYear: { type: String, required: true },
  receiptDate: { type: Date, required: true },

  mode: { type: String, enum: ['CASH', 'CHEQUE', 'UPI', 'BANK_TRANSFER', 'RAZORPAY', 'OTHER'], required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  allocations: { type: [AllocationSchema], default: [] },
  advanceCreatedPaise: { type: Number, default: 0 },
  depositAccountCode: { type: String, required: true },

  instrument: {
    chequeNo: { type: String },
    bankName: { type: String },
    chequeDate: { type: Date },
  },
  referenceNote: { type: String, trim: true },
  proofImageKey: { type: String },
  proofImageUrl: { type: String },

  razorpayPaymentLinkId: { type: String },
  razorpayPaymentLinkUrl: { type: String },
  razorpayPaymentId: { type: String },
  razorpayWebhookEventId: { type: String },
  gatewayFeePaise: { type: Number },

  status: { type: String, enum: ['INITIATED', 'PENDING_CONFIRMATION', 'CLEARED', 'BOUNCED', 'REVERSED', 'REJECTED'], required: true },
  source: { type: String, enum: ['RESIDENT', 'ADMIN_WALKIN', 'GATEWAY'], required: true },

  journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  reversalJournalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  clearanceJournalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },

  recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  recordedByName: { type: String, required: true },
  recordedByRole: { type: String, required: true },
  confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  confirmedByName: { type: String },
  confirmedAt: { type: Date },
  rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  rejectedByName: { type: String },
  rejectedAt: { type: Date },
  rejectionReason: { type: String },

  pdfKey: { type: String },
  pdfUrl: { type: String },
}, { timestamps: true });

ReceiptSchema.index({ societyId: 1, receiptNumber: 1 }, { unique: true });
ReceiptSchema.index({ societyId: 1, status: 1, createdAt: -1 });
ReceiptSchema.index({ flatId: 1, createdAt: -1 });
ReceiptSchema.index({ razorpayPaymentLinkId: 1 }, { unique: true, sparse: true });
ReceiptSchema.index({ razorpayWebhookEventId: 1 }, { unique: true, sparse: true });

export const Receipt = mongoose.model<IReceipt>('Receipt', ReceiptSchema);
export default Receipt;
