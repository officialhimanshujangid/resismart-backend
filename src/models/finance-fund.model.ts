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

/**
 * A fund master: the name, purpose and target of a reserve. It deliberately holds
 * NO balance — the money lives in the 1:1 `ledgerAccountId` FUND account and is
 * derived from posted journals (see `funds.service.listFunds`). A stored copy
 * here is what previously let two same-category cards mirror one account and
 * double-count the society's reserves.
 */
export interface IFinanceFund extends Document {
  societyId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  category: FundCategory;
  targetAmountPaise: number;
  isInvested: boolean;
  isActive: boolean;
  /** 1:1 backing FUND LedgerAccount. Created with the fund; the money is here. */
  ledgerAccountId?: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy?: mongoose.Types.ObjectId;
  updatedByName?: string;
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
  targetAmountPaise: { type: Number, default: 0, min: 0 },
  isInvested: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  ledgerAccountId: { type: Schema.Types.ObjectId, ref: 'LedgerAccount' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedByName: { type: String },
}, { timestamps: true });

FinanceFundSchema.index({ societyId: 1, name: 1 }, { unique: true });

export const FinanceFund = mongoose.model<IFinanceFund>('FinanceFund', FinanceFundSchema);
export default FinanceFund;
