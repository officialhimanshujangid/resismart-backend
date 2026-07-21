import mongoose, { Schema, Document } from 'mongoose';
import crypto from 'crypto';

/**
 * A lift, a pump, a tank — something that breaks and has a history.
 *
 * The `qrToken` is the cheapest good idea in this whole module and no society
 * app has it. A sticker on Lift 2 that opens a pre-filled complaint removes the
 * single largest source of useless tickets: "the lift isn't working" with no
 * indication of which lift, in which wing.
 *
 * It also gives each machine a history, which turns "replace or repair" and an
 * AMC renewal argument into questions with evidence behind them.
 */
export const ASSET_CATEGORIES = ['LIFT', 'PUMP', 'DG', 'TANK', 'GATE', 'STP', 'CCTV', 'OTHER'] as const;
export type AssetCategory = typeof ASSET_CATEGORIES[number];

export interface IAsset extends Document {
  societyId: mongoose.Types.ObjectId;
  assetCode: string;
  name: string;
  category: AssetCategory;

  blockId?: mongoose.Types.ObjectId;
  blockName?: string;
  location?: string;

  /** Under an AMC, a breakdown is the vendor's cost, not the society's. */
  vendorId?: mongoose.Types.ObjectId;
  vendorName?: string;
  amcExpiresOn?: Date;
  /** The expiry we last warned the committee about, so the daily sweep warns once, not thirty times. */
  amcWarnedForExpiry?: Date;

  /** Printed on the sticker. Random, not derived — a guessable one is a spam vector. */
  qrToken: string;
  isActive: boolean;
  notes?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const AssetSchema = new Schema<IAsset>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  assetCode: { type: String, required: true },
  name: { type: String, required: true, trim: true },
  category: { type: String, required: true },

  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },
  blockName: { type: String },
  location: { type: String, trim: true },

  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
  vendorName: { type: String },
  amcExpiresOn: { type: Date },
  amcWarnedForExpiry: { type: Date },

  qrToken: { type: String, required: true, default: () => crypto.randomBytes(12).toString('hex') },
  isActive: { type: Boolean, default: true },
  notes: { type: String, trim: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

AssetSchema.index({ societyId: 1, assetCode: 1 }, { unique: true });
// Global, not per-society: the scan URL carries only the token, so it has to
// identify the asset AND its society on its own.
AssetSchema.index({ qrToken: 1 }, { unique: true });
AssetSchema.index({ societyId: 1, isActive: 1, category: 1 });

export const Asset = mongoose.model<IAsset>('Asset', AssetSchema);
export default Asset;
