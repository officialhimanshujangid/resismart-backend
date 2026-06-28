import mongoose, { Schema, Document } from 'mongoose';

export interface IInvoice extends Document {
  tenantId: mongoose.Types.ObjectId;
  tenantType: 'SOCIETY' | 'SHOP';
  subscriptionId?: mongoose.Types.ObjectId; // linked once payment succeeds
  planId?: mongoose.Types.ObjectId;
  tenure?: string;
  invoiceType: 'ONLINE_RAZORPAY' | 'OFFLINE_CASH';
  
  // For Razorpay
  razorpayInvoiceId?: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySubscriptionId?: string;
  razorpayPaymentLinkId?: string;
  razorpayPaymentLinkUrl?: string;
  razorpayInvoiceUrl?: string; // Link to download Razorpay generated invoice
  
  // For Offline/Custom
  customInvoiceNumber?: string;
  customPdfUrl?: string; // S3 link to our generated PDF

  // Cash/manual accountability
  collectedById?: mongoose.Types.ObjectId; // who physically took the payment
  collectedByName?: string;
  recordedById?: mongoose.Types.ObjectId; // who created this entry (logged-in user)
  recordedByName?: string;
  creditApplied?: number; // paise credited from the previous plan on an upgrade

  amount: number; // In paise
  currency: string;
  status: 'PAID' | 'PENDING' | 'FAILED' | 'REFUNDED';
  
  paidAt?: Date;
  
  createdAt: Date;
  updatedAt: Date;
}

const InvoiceSchema = new Schema<IInvoice>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  tenantType: { type: String, enum: ['SOCIETY', 'SHOP'], required: true },
  subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription' },
  planId: { type: Schema.Types.ObjectId, ref: 'Plan' },
  tenure: { type: String },
  invoiceType: { type: String, enum: ['ONLINE_RAZORPAY', 'OFFLINE_CASH'], required: true },
  
  razorpayInvoiceId: { type: String },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  razorpaySubscriptionId: { type: String },
  razorpayPaymentLinkId: { type: String },
  razorpayPaymentLinkUrl: { type: String },
  razorpayInvoiceUrl: { type: String },
  
  customInvoiceNumber: { type: String },
  customPdfUrl: { type: String },

  collectedById: { type: Schema.Types.ObjectId, ref: 'User' },
  collectedByName: { type: String },
  recordedById: { type: Schema.Types.ObjectId, ref: 'User' },
  recordedByName: { type: String },
  creditApplied: { type: Number, default: 0 },

  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  
  status: { type: String, enum: ['PAID', 'PENDING', 'FAILED', 'REFUNDED'], required: true },
  
  paidAt: { type: Date }
}, {
  timestamps: true,
});

InvoiceSchema.index({ tenantId: 1, tenantType: 1 });
InvoiceSchema.index({ subscriptionId: 1 });
InvoiceSchema.index({ razorpayOrderId: 1 });
InvoiceSchema.index({ razorpaySubscriptionId: 1 });
InvoiceSchema.index({ razorpayPaymentLinkId: 1 });
// Dedup real payments; sparse so the many null (cash/pending) invoices don't collide.
InvoiceSchema.index({ razorpayPaymentId: 1 }, { unique: true, sparse: true });

export const Invoice = mongoose.model<IInvoice>('Invoice', InvoiceSchema);
export default Invoice;
