import mongoose, { Schema, Document } from 'mongoose';

export interface IFinanceLedgerEntry extends Document {
  societyId: mongoose.Types.ObjectId;
  billId?: mongoose.Types.ObjectId;
  paymentId?: mongoose.Types.ObjectId;
  
  entryType: 'BILL_RAISED' | 'PAYMENT_RECEIVED' | 'LATE_FEE_APPLIED' | 'WAIVER' | 'REFUND' | 'ADJUSTMENT' | 'REVERSAL';
  description: string;
  
  debitPaise: number; // Amount owed to society (bill raised, late fee)
  creditPaise: number; // Amount received by society (payment, refund reversal)
  
  flatId?: mongoose.Types.ObjectId;
  flatNumber?: string;
  billingPeriod?: string;
  
  performedBy: string; // userId or 'SYSTEM'
  performedByName: string;
  
  metadata?: Record<string, any>;
  
  createdAt: Date;
  // Intentionally omitting updatedAt because ledger entries must be immutable
}

const FinanceLedgerEntrySchema = new Schema<IFinanceLedgerEntry>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  billId: { type: Schema.Types.ObjectId, ref: 'SocietyBill' },
  paymentId: { type: Schema.Types.ObjectId, ref: 'BillPayment' },
  
  entryType: { 
    type: String, 
    enum: ['BILL_RAISED', 'PAYMENT_RECEIVED', 'LATE_FEE_APPLIED', 'WAIVER', 'REFUND', 'ADJUSTMENT', 'REVERSAL'], 
    required: true 
  },
  description: { type: String, required: true, trim: true },
  
  debitPaise: { type: Number, required: true, min: 0, default: 0 },
  creditPaise: { type: Number, required: true, min: 0, default: 0 },
  
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat' },
  flatNumber: { type: String },
  billingPeriod: { type: String },
  
  performedBy: { type: String, required: true },
  performedByName: { type: String, required: true },
  
  metadata: { type: Schema.Types.Mixed },
  
  createdAt: { type: Date, default: Date.now },
}, { 
  // Disable timestamps option because we only want createdAt, not updatedAt
  timestamps: false 
});

// Indexes
FinanceLedgerEntrySchema.index({ societyId: 1, createdAt: -1 });
FinanceLedgerEntrySchema.index({ billId: 1 });
FinanceLedgerEntrySchema.index({ societyId: 1, entryType: 1, createdAt: -1 });

export const FinanceLedgerEntry = mongoose.model<IFinanceLedgerEntry>('FinanceLedgerEntry', FinanceLedgerEntrySchema);
export default FinanceLedgerEntry;
