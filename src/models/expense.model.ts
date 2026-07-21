import mongoose, { Schema, Document } from 'mongoose';

export type ExpenseStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'PAID' | 'REJECTED' | 'CANCELLED';

export interface IExpenseLine {
  expenseAccountCode: string;
  expenseAccountName?: string;
  description?: string;
  amountPaise: number;
  fundId?: mongoose.Types.ObjectId;
  /**
   * Wing this cost belongs to. Left unset for anything shared — and most costs
   * genuinely are shared, so this stays optional rather than getting a default.
   */
  blockId?: mongoose.Types.ObjectId;
  blockName?: string;
  /**
   * Which staff member this line paid.
   *
   * The third optional dimension, alongside fund and wing — deliberately held
   * back until the staff model existed, because a field pointing at nothing is
   * the exact declared-but-never-read shape that has bitten this module a dozen
   * times. Answers "how much did we pay Gangaram this year" straight from the
   * expense lines, so the figure is the ledger's own and cannot drift from it.
   */
  staffId?: mongoose.Types.ObjectId;
  staffName?: string;

  /**
   * What this line was spent ON, in operations terms.
   *
   * The two questions a committee asks that nothing could answer: "what did
   * that lift cost us this year" and "how much did fixing that complaint come
   * to". Both were unanswerable because money and maintenance lived in two
   * modules with no thread between them — the ledger knew ₹18,000 went to a
   * vendor, the complaint knew a pump was repaired, and nothing joined them.
   *
   * Optional and purely descriptive: nothing in the posting logic reads these,
   * so tagging a line wrongly costs a report its accuracy and never the books
   * their balance.
   */
  complaintId?: mongoose.Types.ObjectId;
  complaintCode?: string;
  assetId?: mongoose.Types.ObjectId;
  assetName?: string;
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
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },
  blockName: { type: String, trim: true },
  staffId: { type: Schema.Types.ObjectId, ref: 'SocietyStaff' },
  staffName: { type: String, trim: true },
  complaintId: { type: Schema.Types.ObjectId, ref: 'Complaint' },
  complaintCode: { type: String, trim: true },
  assetId: { type: Schema.Types.ObjectId, ref: 'Asset' },
  assetName: { type: String, trim: true },
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
