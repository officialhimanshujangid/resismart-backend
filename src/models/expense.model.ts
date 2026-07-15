import mongoose, { Schema, Document } from 'mongoose';

export type ExpenseStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'PAID' | 'REJECTED' | 'CANCELLED';

export interface IExpenseLine {
  expenseAccountCode: string;
  expenseAccountName?: string;
  description?: string;
  amountPaise: number;
  fundId?: mongoose.Types.ObjectId;
}

export interface IExpense extends Document {
  societyId: mongoose.Types.ObjectId;
  voucherNumber: string;
  financialYear: string;
  expenseDate: Date;

  vendorId?: mongoose.Types.ObjectId;
  vendorName?: string;
  category?: string;
  description?: string;

  lineItems: IExpenseLine[];
  grossPaise: number;
  tdsPaise: number;
  netPayablePaise: number;

  paymentMode?: 'BANK' | 'CASH' | 'CHEQUE' | 'UPI';
  attachments: { key: string; url: string; uploadedAt: Date }[];

  status: ExpenseStatus;
  accrualJournalEntryId?: mongoose.Types.ObjectId;
  paymentJournalEntryId?: mongoose.Types.ObjectId;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  approvedBy?: mongoose.Types.ObjectId;
  approvedByName?: string;
  approvedAt?: Date;
  rejectionReason?: string;
  paidAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const ExpenseLineSchema = new Schema<IExpenseLine>({
  expenseAccountCode: { type: String, required: true },
  expenseAccountName: { type: String },
  description: { type: String },
  amountPaise: { type: Number, required: true, min: 0 },
  fundId: { type: Schema.Types.ObjectId, ref: 'FinanceFund' },
}, { _id: false });

const ExpenseSchema = new Schema<IExpense>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  voucherNumber: { type: String, required: true },
  financialYear: { type: String, required: true },
  expenseDate: { type: Date, required: true },

  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
  vendorName: { type: String },
  category: { type: String },
  description: { type: String, trim: true },

  lineItems: { type: [ExpenseLineSchema], default: [] },
  grossPaise: { type: Number, required: true, min: 0 },
  tdsPaise: { type: Number, default: 0, min: 0 },
  netPayablePaise: { type: Number, required: true, min: 0 },

  paymentMode: { type: String, enum: ['BANK', 'CASH', 'CHEQUE', 'UPI'] },
  attachments: [{ key: String, url: String, uploadedAt: Date }],

  status: { type: String, enum: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED'], default: 'PENDING_APPROVAL' },
  accrualJournalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  paymentJournalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedByName: { type: String },
  approvedAt: { type: Date },
  rejectionReason: { type: String },
  paidAt: { type: Date },
}, { timestamps: true });

ExpenseSchema.index({ societyId: 1, voucherNumber: 1 }, { unique: true });
ExpenseSchema.index({ societyId: 1, status: 1, createdAt: -1 });
ExpenseSchema.index({ vendorId: 1 });

export const Expense = mongoose.model<IExpense>('Expense', ExpenseSchema);
export default Expense;
