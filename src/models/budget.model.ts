import mongoose, { Schema, Document } from 'mongoose';

export type BudgetStatus = 'DRAFT' | 'APPROVED';

export interface IBudgetLine {
  accountCode: string;
  /**
   * Denormalised from the ledger at save time. An account can be renamed, and a
   * budget the general body approved must keep reading the way it read when they
   * approved it — resolving the name live would silently rewrite last year's
   * minutes.
   */
  accountName: string;
  budgetedPaise: number;
}

/**
 * A society's budget for one financial year, account by account.
 *
 * Indian co-operative societies put a budget to the general body before the year
 * starts and report against it at the AGM; without one there is nothing to hold
 * the committee's spending to. One document per society per FY — the whole
 * budget is approved as a single resolution, so the lines have no independent
 * life and are stored inline rather than as their own collection.
 */
export interface IBudget extends Document {
  societyId: mongoose.Types.ObjectId;
  /** '2026-2027', matching JournalEntry.financialYear. */
  financialYear: string;
  lines: IBudgetLine[];

  status: BudgetStatus;
  approvedBy?: mongoose.Types.ObjectId;
  approvedByName?: string;
  approvedAt?: Date;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const BudgetLineSchema = new Schema<IBudgetLine>({
  accountCode: { type: String, required: true },
  accountName: { type: String, required: true },
  budgetedPaise: { type: Number, required: true, min: 0 },
}, { _id: false });

const BudgetSchema = new Schema<IBudget>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  financialYear: { type: String, required: true },
  lines: { type: [BudgetLineSchema], default: [] },

  status: { type: String, enum: ['DRAFT', 'APPROVED'], default: 'DRAFT' },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedByName: { type: String },
  approvedAt: { type: Date },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
}, { timestamps: true });

// One budget per society per year. The upsert relies on this to be idempotent —
// without it a double-submit would leave two budgets and the variance report
// would silently report against whichever it read first.
BudgetSchema.index({ societyId: 1, financialYear: 1 }, { unique: true });

export const Budget = mongoose.model<IBudget>('Budget', BudgetSchema);
export default Budget;
