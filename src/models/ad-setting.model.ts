import mongoose, { Schema, Document } from 'mongoose';

/**
 * A purchasable boost package. Priced/duration/radius are set by the SYSTEM_OWNER.
 * Buying a package expands a listing's visibility radius and (optionally) pins it to
 * the top of search results for `durationDays`. The subdocument `_id` is the stable
 * package identifier referenced at boost checkout, so pricing is always server-authoritative.
 */
export interface IBoostPackage {
  _id?: mongoose.Types.ObjectId;
  label: string;
  pricePaise: number;   // amount charged, in paise (INR)
  durationDays: number; // how long the boost stays active
  radiusKm: number;     // boosted visibility radius (must be <= maxRadiusKm)
  topPlacement: boolean;// pin to top of results while active
  isActive: boolean;    // false = hidden from buyers (kept for history)
}

/**
 * Singleton marketplace configuration, owned by the SYSTEM_OWNER. Controls the free
 * base visibility radius, the hard radius cap, the catalog of paid boost packages, and
 * listing auto-expiry. Fetched-or-created on first access (same pattern as GlobalSetting).
 */
export interface IAdSetting extends Document {
  listingsEnabled: boolean;   // master switch for the whole marketplace
  baseRadiusKm: number;       // free visibility radius for every ACTIVE listing
  maxRadiusKm: number;        // hard cap for any boosted radius
  currency: string;           // 'INR'
  listingExpiryDays: number;  // auto-expire ACTIVE listings after this many idle days
  boostPackages: IBoostPackage[];
  createdAt: Date;
  updatedAt: Date;
}

const BoostPackageSchema = new Schema<IBoostPackage>({
  label: { type: String, required: true, trim: true },
  pricePaise: { type: Number, required: true, min: 0 },
  durationDays: { type: Number, required: true, min: 1 },
  radiusKm: { type: Number, required: true, min: 0 },
  topPlacement: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
}, { _id: true }); // subdocument _id is the stable package identifier used at checkout

const AdSettingSchema = new Schema<IAdSetting>({
  listingsEnabled: { type: Boolean, default: true },
  baseRadiusKm: { type: Number, default: 5, min: 0 },
  maxRadiusKm: { type: Number, default: 50, min: 0 },
  currency: { type: String, default: 'INR' },
  listingExpiryDays: { type: Number, default: 60, min: 1 },
  boostPackages: {
    type: [BoostPackageSchema],
    default: () => ([
      { label: '10-Day Spotlight', pricePaise: 2000, durationDays: 10, radiusKm: 25, topPlacement: true, isActive: true },
      { label: '30-Day Reach+', pricePaise: 5000, durationDays: 30, radiusKm: 40, topPlacement: true, isActive: true },
    ]),
  },
}, {
  timestamps: true,
});

export const AdSetting = mongoose.model<IAdSetting>('AdSetting', AdSettingSchema);
export default AdSetting;
