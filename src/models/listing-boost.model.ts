import mongoose, { Schema, Document } from 'mongoose';

export type BoostStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'FAILED' | 'REFUNDED';

/**
 * One boost purchase = one row = the platform revenue ledger. The package terms are
 * SNAPSHOTTED at purchase so later edits to AdSetting never rewrite history or pricing.
 * A boost widens its listing's visibility radius and pins it to the top for `durationDays`.
 */
export interface IListingBoost extends Document {
  listingId: mongoose.Types.ObjectId;
  societyId: mongoose.Types.ObjectId;
  packageId?: string;
  packageSnapshot: { label: string; pricePaise: number; durationDays: number; radiusKm: number; topPlacement: boolean };

  amountPaise: number;
  currency: string;
  status: BoostStatus;

  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  invoiceId?: mongoose.Types.ObjectId;

  startAt?: Date;
  endAt?: Date;

  purchasedByUserId: mongoose.Types.ObjectId;
  purchasedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ListingBoostSchema = new Schema<IListingBoost>({
  listingId: { type: Schema.Types.ObjectId, ref: 'PropertyListing', required: true },
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  packageId: { type: String },
  packageSnapshot: {
    label: { type: String, required: true },
    pricePaise: { type: Number, required: true, min: 0 },
    durationDays: { type: Number, required: true, min: 1 },
    radiusKm: { type: Number, required: true, min: 0 },
    topPlacement: { type: Boolean, default: true },
  },
  amountPaise: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['PENDING', 'ACTIVE', 'EXPIRED', 'FAILED', 'REFUNDED'], default: 'PENDING' },

  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },

  startAt: { type: Date },
  endAt: { type: Date },

  purchasedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  purchasedByName: { type: String, required: true },
}, { timestamps: true });

ListingBoostSchema.index({ listingId: 1 });
ListingBoostSchema.index({ societyId: 1 });
ListingBoostSchema.index({ status: 1, endAt: 1 }); // expiry sweep
ListingBoostSchema.index({ razorpayOrderId: 1 });
ListingBoostSchema.index({ razorpayPaymentId: 1 }, { unique: true, sparse: true }); // idempotency
ListingBoostSchema.index({ createdAt: -1 });

export const ListingBoost = mongoose.model<IListingBoost>('ListingBoost', ListingBoostSchema);
export default ListingBoost;
