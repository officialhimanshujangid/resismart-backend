import mongoose, { Schema, Document } from 'mongoose';

export type ChargeCategory =
  | 'MAINTENANCE' | 'SINKING_FUND' | 'REPAIR_FUND' | 'CORPUS'
  | 'WATER' | 'PARKING' | 'FESTIVAL' | 'NON_OCCUPANCY'
  | 'UTILITY' | 'ADHOC' | 'OTHER';

export type PricingMode = 'UNIFORM' | 'PER_FLAT_SIZE' | 'PER_SQFT' | 'METERED' | 'PERCENTAGE' | 'FLAT_ADHOC';
export type Occupancy = 'ALL' | 'OWNER_OCCUPIED' | 'RENTED' | 'VACANT';
export type BillTo = 'OWNER' | 'OCCUPANT';

export interface IChargeHead extends Document {
  societyId: mongoose.Types.ObjectId;
  code: string;
  name: string;
  description?: string;
  category: ChargeCategory;

  pricingMode: PricingMode;
  uniformAmountPaise?: number;
  perSizeAmounts?: { flatSizeId: mongoose.Types.ObjectId; label: string; amountPaise: number }[];
  ratePerSqftPaise?: number;              // PER_SQFT (uses Flat.carpetAreaSqft)
  areaBasis?: 'CARPET' | 'BUILTUP';
  perUnitRatePaise?: number;              // METERED
  meterType?: string;
  percentOf?: 'MAINTENANCE' | 'BASE';     // PERCENTAGE — of the maintenance line or of the running base
  percentValue?: number;

  applicability: {
    occupancy: Occupancy[];
    blockIds?: mongoose.Types.ObjectId[];
    flatIds?: mongoose.Types.ObjectId[];
    exemptFlatIds?: mongoose.Types.ObjectId[];
  };
  billTo: BillTo;

  // GL wiring
  incomeAccountId: mongoose.Types.ObjectId;   // LedgerAccount to credit (income or fund account)
  incomeAccountCode: string;                  // snapshot
  fundId?: mongoose.Types.ObjectId;           // when this head feeds a fund

  gstApplicable: boolean;
  gstRatePercent?: number;
  sacCode?: string;

  isRecurring: boolean;
  isActive: boolean;
  sortOrder: number;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ChargeHeadSchema = new Schema<IChargeHead>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  code: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  category: {
    type: String,
    enum: ['MAINTENANCE', 'SINKING_FUND', 'REPAIR_FUND', 'CORPUS', 'WATER', 'PARKING', 'FESTIVAL', 'NON_OCCUPANCY', 'UTILITY', 'ADHOC', 'OTHER'],
    required: true,
  },

  pricingMode: { type: String, enum: ['UNIFORM', 'PER_FLAT_SIZE', 'PER_SQFT', 'METERED', 'PERCENTAGE', 'FLAT_ADHOC'], required: true },
  uniformAmountPaise: { type: Number, min: 0 },
  perSizeAmounts: [{
    flatSizeId: { type: Schema.Types.ObjectId, ref: 'FlatSize', required: true },
    label: { type: String, required: true },
    amountPaise: { type: Number, required: true, min: 0 },
  }],
  ratePerSqftPaise: { type: Number, min: 0 },
  areaBasis: { type: String, enum: ['CARPET', 'BUILTUP'], default: 'CARPET' },
  perUnitRatePaise: { type: Number, min: 0 },
  meterType: { type: String },
  percentOf: { type: String, enum: ['MAINTENANCE', 'BASE'] },
  percentValue: { type: Number, min: 0 },

  applicability: {
    occupancy: { type: [String], enum: ['ALL', 'OWNER_OCCUPIED', 'RENTED', 'VACANT'], default: ['ALL'] },
    blockIds: [{ type: Schema.Types.ObjectId, ref: 'Block' }],
    flatIds: [{ type: Schema.Types.ObjectId, ref: 'Flat' }],
    exemptFlatIds: [{ type: Schema.Types.ObjectId, ref: 'Flat' }],
  },
  billTo: { type: String, enum: ['OWNER', 'OCCUPANT'], default: 'OWNER' },

  incomeAccountId: { type: Schema.Types.ObjectId, ref: 'LedgerAccount', required: true },
  incomeAccountCode: { type: String, required: true },
  fundId: { type: Schema.Types.ObjectId, ref: 'FinanceFund' },

  gstApplicable: { type: Boolean, default: false },
  gstRatePercent: { type: Number, min: 0 },
  sacCode: { type: String },

  isRecurring: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 100 },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
}, { timestamps: true });

ChargeHeadSchema.index({ societyId: 1, code: 1 }, { unique: true });
ChargeHeadSchema.index({ societyId: 1, isActive: 1, sortOrder: 1 });

export const ChargeHead = mongoose.model<IChargeHead>('ChargeHead', ChargeHeadSchema);
export default ChargeHead;
