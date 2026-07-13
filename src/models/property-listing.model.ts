import mongoose, { Schema, Document } from 'mongoose';

export type ListingKind = 'SALE' | 'RENT';
export type ListingScope = 'FLAT' | 'SOCIETY';
export type ListingStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'SOLD' | 'RENTED' | 'EXPIRED' | 'TAKEN_DOWN';
export type VerificationStatus = 'UNVERIFIED' | 'PENDING' | 'PENDING_OWNER' | 'VERIFIED' | 'REJECTED';

export interface IListingPhoto {
  url: string;
  isCover: boolean;
  blurhash?: string; // reserved for the Phase 7 media pipeline
}

/**
 * A rent/sale advertisement. Visible for free within an owner-configured base radius
 * (`effectiveRadiusMeters`); a paid boost (Phase 4) widens the radius and pins it to the
 * top. `location` is copied from the flat/society at create time so geo-radius search
 * (Phase 4) can run a single-collection `$geoNear`.
 */
export interface IPropertyListing extends Document {
  kind: ListingKind;
  scope: ListingScope;
  flatId?: mongoose.Types.ObjectId;
  societyId: mongoose.Types.ObjectId;

  title: string;
  description?: string;
  pricePaise: number;
  priceType: 'TOTAL' | 'PER_MONTH';
  bedrooms?: number;
  sizeLabel?: string;
  furnishing?: 'UNFURNISHED' | 'SEMI_FURNISHED' | 'FURNISHED';
  amenities: string[];
  photos: IListingPhoto[];

  location?: { type: 'Point'; coordinates: number[] };
  city?: string;
  pincode?: string;
  addressLine?: string;

  status: ListingStatus;
  contact: { name?: string; phone?: string; revealPhone: boolean };
  verification: { status: VerificationStatus; method?: string; verifiedAt?: Date; verifiedBy?: mongoose.Types.ObjectId };
  boost: {
    active: boolean;
    listingBoostId?: mongoose.Types.ObjectId;
    packageLabel?: string;
    radiusKm?: number;
    topPlacement: boolean;
    startAt?: Date;
    endAt?: Date;
  };
  effectiveRadiusMeters: number;

  slug: string;
  viewsCount: number;
  leadsCount: number;
  favoritesCount: number;
  publishedAt?: Date;
  lastBumpedAt?: Date;
  expiresAt?: Date;

  createdByUserId: mongoose.Types.ObjectId;
  createdByRole: string;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const PhotoSchema = new Schema<IListingPhoto>({
  url: { type: String, required: true },
  isCover: { type: Boolean, default: false },
  blurhash: { type: String },
}, { _id: false });

const PropertyListingSchema = new Schema<IPropertyListing>({
  kind: { type: String, enum: ['SALE', 'RENT'], required: true },
  scope: { type: String, enum: ['FLAT', 'SOCIETY'], required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat' },
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },

  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  pricePaise: { type: Number, required: true, min: 0 },
  priceType: { type: String, enum: ['TOTAL', 'PER_MONTH'], required: true },
  bedrooms: { type: Number, min: 0 },
  sizeLabel: { type: String, trim: true },
  furnishing: { type: String, enum: ['UNFURNISHED', 'SEMI_FURNISHED', 'FURNISHED'] },
  amenities: { type: [String], default: [] },
  photos: { type: [PhotoSchema], default: [] },

  location: {
    type: { type: String, enum: ['Point'] },
    coordinates: { type: [Number] },
  },
  city: { type: String, trim: true },
  pincode: { type: String, trim: true },
  addressLine: { type: String, trim: true },

  status: { type: String, enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'SOLD', 'RENTED', 'EXPIRED', 'TAKEN_DOWN'], default: 'DRAFT' },
  contact: {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    revealPhone: { type: Boolean, default: false },
  },
  verification: {
    status: { type: String, enum: ['UNVERIFIED', 'PENDING', 'PENDING_OWNER', 'VERIFIED', 'REJECTED'], default: 'UNVERIFIED' },
    method: { type: String },
    verifiedAt: { type: Date },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  boost: {
    active: { type: Boolean, default: false },
    listingBoostId: { type: Schema.Types.ObjectId, ref: 'ListingBoost' },
    packageLabel: { type: String },
    radiusKm: { type: Number },
    topPlacement: { type: Boolean, default: false },
    startAt: { type: Date },
    endAt: { type: Date },
  },
  effectiveRadiusMeters: { type: Number, default: 0 },

  slug: { type: String, required: true },
  viewsCount: { type: Number, default: 0 },
  leadsCount: { type: Number, default: 0 },
  favoritesCount: { type: Number, default: 0 },
  publishedAt: { type: Date },
  lastBumpedAt: { type: Date },
  expiresAt: { type: Date },

  createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByRole: { type: String, required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, {
  timestamps: true,
});

PropertyListingSchema.index({ location: '2dsphere' });
PropertyListingSchema.index({ status: 1, 'boost.topPlacement': -1, 'boost.startAt': -1, publishedAt: -1 });
PropertyListingSchema.index({ societyId: 1 });
PropertyListingSchema.index({ flatId: 1 });
PropertyListingSchema.index({ createdByUserId: 1 });
PropertyListingSchema.index({ city: 1, kind: 1, status: 1, pricePaise: 1 });
PropertyListingSchema.index({ slug: 1 }, { unique: true });
PropertyListingSchema.index({ 'verification.status': 1 });
PropertyListingSchema.index({ status: 1, 'boost.endAt': 1 }); // boost-expiry sweep

export const PropertyListing = mongoose.model<IPropertyListing>('PropertyListing', PropertyListingSchema);
export default PropertyListing;
