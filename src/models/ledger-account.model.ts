import mongoose, { Schema, Document } from 'mongoose';

export type AccountType = 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE' | 'FUND' | 'EQUITY';
export type NormalBalance = 'DEBIT' | 'CREDIT';
export type SubLedgerDimension = 'FLAT' | 'VENDOR';

/** Debit-normal for assets/expenses; credit-normal for everything else. */
export function normalBalanceForType(type: AccountType): NormalBalance {
  return type === 'ASSET' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
}

export interface ILedgerAccount extends Document {
  societyId: mongoose.Types.ObjectId;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  isControlAccount: boolean;
  subLedgerDimension?: SubLedgerDimension;
  fundId?: mongoose.Types.ObjectId;
  parentAccountId?: mongoose.Types.ObjectId;
  isSystem: boolean;
  isActive: boolean;
  openingBalancePaise: number;
  currentBalancePaise: number; // signed in the account's normal direction; recomputed from journal
  createdBy?: mongoose.Types.ObjectId;
  createdByName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const LedgerAccountSchema = new Schema<ILedgerAccount>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  code: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'FUND', 'EQUITY'], required: true },
  normalBalance: { type: String, enum: ['DEBIT', 'CREDIT'], required: true },
  isControlAccount: { type: Boolean, default: false },
  subLedgerDimension: { type: String, enum: ['FLAT', 'VENDOR'] },
  fundId: { type: Schema.Types.ObjectId, ref: 'FinanceFund' },
  parentAccountId: { type: Schema.Types.ObjectId, ref: 'LedgerAccount' },
  isSystem: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  openingBalancePaise: { type: Number, default: 0 },
  currentBalancePaise: { type: Number, default: 0 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdByName: { type: String },
}, { timestamps: true });

LedgerAccountSchema.index({ societyId: 1, code: 1 }, { unique: true });
LedgerAccountSchema.index({ societyId: 1, type: 1 });
LedgerAccountSchema.index({ societyId: 1, fundId: 1 });

export const LedgerAccount = mongoose.model<ILedgerAccount>('LedgerAccount', LedgerAccountSchema);
export default LedgerAccount;
