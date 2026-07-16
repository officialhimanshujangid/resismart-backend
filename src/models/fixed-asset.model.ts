import mongoose, { Schema, Document } from 'mongoose';

/**
 * Straight-line charges the same amount every year off (cost − salvage);
 * written-down-value charges a fixed rate on the *remaining* book value, so the
 * charge tapers. Indian societies use both — the Model Bye-laws let the general
 * body pick, and lifts/DG sets are commonly WDV while buildings run SLM.
 */
export type DepreciationMethod = 'SLM' | 'WDV';

export interface IFixedAsset extends Document {
  societyId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  /** One of the 15xx fixed-asset heads — where the asset's cost sits in the GL. */
  assetAccountCode: string;
  assetAccountName?: string;
  purchaseDate: Date;
  costPaise: number;
  salvageValuePaise: number;

  method: DepreciationMethod;
  /** Annual rate, e.g. 10 for 10% p.a. */
  ratePercent: number;
  usefulLifeYears?: number;

  /** Running total charged to date. Never exceeds costPaise − salvageValuePaise. */
  accumulatedDepreciationPaise: number;
  /**
   * The through-date of the last posted depreciation run. This is what makes a
   * run idempotent: the next run only charges the span *after* this date, so
   * re-running the same period charges nothing rather than double-charging.
   */
  lastDepreciationUpTo?: Date;

  disposedOn?: Date;
  disposalProceedsPaise?: number;
  isActive: boolean;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;

  createdAt: Date;
  updatedAt: Date;
}

const FixedAssetSchema = new Schema<IFixedAsset>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  assetAccountCode: { type: String, required: true },
  assetAccountName: { type: String },
  purchaseDate: { type: Date, required: true },
  costPaise: { type: Number, required: true, min: 0 },
  salvageValuePaise: { type: Number, default: 0, min: 0 },

  method: { type: String, enum: ['SLM', 'WDV'], required: true },
  ratePercent: { type: Number, required: true, min: 0, max: 100 },
  usefulLifeYears: { type: Number, min: 0 },

  accumulatedDepreciationPaise: { type: Number, default: 0, min: 0 },
  lastDepreciationUpTo: { type: Date },

  disposedOn: { type: Date },
  disposalProceedsPaise: { type: Number, min: 0 },
  isActive: { type: Boolean, default: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
}, { timestamps: true });

FixedAssetSchema.index({ societyId: 1, isActive: 1, purchaseDate: -1 });
FixedAssetSchema.index({ societyId: 1, assetAccountCode: 1 });

export const FixedAsset = mongoose.model<IFixedAsset>('FixedAsset', FixedAssetSchema);
export default FixedAsset;
