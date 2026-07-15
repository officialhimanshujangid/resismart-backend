import mongoose, { Schema, Document } from 'mongoose';

export type FundCategory =
  | 'CORPUS'
  | 'SINKING'
  | 'REPAIR'
  | 'SPECIAL'
  | 'GENERAL'
  | 'RESERVE'
  | 'MAINTENANCE_POOL'
  | 'OPENING_BALANCE';

export interface IFinanceFund extends Document {
  societyId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  category: FundCategory;
  currentBalancePaise: number;
  targetAmountPaise: number;
  isInvested: boolean;
  isActive: boolean;
  // Reserved for Phase 6 (ledger-backed funds): 1:1 link to a FUND LedgerAccount.
  ledgerAccountId?: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const FinanceFundSchema = new Schema<IFinanceFund>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  category: {
    type: String,
    enum: ['CORPUS', 'SINKING', 'REPAIR', 'SPECIAL', 'GENERAL', 'RESERVE', 'MAINTENANCE_POOL', 'OPENING_BALANCE'],
    required: true,
    default: 'GENERAL',
  },
  currentBalancePaise: { type: Number, required: true, default: 0 },
  targetAmountPaise: { type: Number, default: 0, min: 0 },
  isInvested: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  ledgerAccountId: { type: Schema.Types.ObjectId, ref: 'LedgerAccount' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
}, { timestamps: true });

FinanceFundSchema.index({ societyId: 1, name: 1 }, { unique: true });

export const FinanceFund = mongoose.model<IFinanceFund>('FinanceFund', FinanceFundSchema);
export default FinanceFund;
