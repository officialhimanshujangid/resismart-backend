import mongoose, { Schema, Document } from 'mongoose';

export enum FlatStatus {
  VACANT = 'VACANT',
  OWNER_OCCUPIED = 'OWNER_OCCUPIED',
  RENTED = 'RENTED',
}

/**
 * Papers that belong to the FLAT rather than to whoever currently lives in it.
 *
 * A rent agreement or a tenant's ID belongs to a tenure and leaves with them;
 * a sale deed, property card or occupancy certificate stays with the flat
 * through every owner it ever has. Same stored shape as `ITenureDocument` on
 * purpose — one upload route, one presigned-download habit, nothing new to
 * learn or to get wrong.
 */
export type FlatDocumentKind =
  | 'SALE_DEED' | 'PROPERTY_CARD' | 'NOC' | 'OC_CERTIFICATE'
  | 'FLOOR_PLAN' | 'SHARE_CERT_COPY' | 'POSSESSION_LETTER' | 'OTHER';

export interface IFlatDocument {
  _id?: mongoose.Types.ObjectId;
  kind: FlatDocumentKind;
  label: string;
  key: string; // private S3 object key — never public
  url: string;
  uploadedAt: Date;
  uploadedBy?: mongoose.Types.ObjectId;
  uploadedByName: string;
}

export interface IFlat extends Document {
  number: string;
  blockName: string; // "A Block", "Tower 2" - denormalized for speed
  blockId: mongoose.Types.ObjectId;
  societyId: mongoose.Types.ObjectId;
  status: FlatStatus;
  
  plotNumber?: string;
  fullAddress?: string;
  registrationNumber?: string;
  location?: {
    type: 'Point';
    coordinates: number[]; // [longitude, latitude]
  };
  
  size?: mongoose.Types.ObjectId; // Ref to FlatSize

  // No area here: it lives on the flat SIZE, so it is entered once per layout
  // rather than per flat, and a correction fixes every flat at once. Two layouts
  // that genuinely differ are two sizes. See effectiveArea() in invoicing.service.

  /**
   * Free-form per-flat counts for PER_QUANTITY charge heads, e.g.
   * `{ parkingSlots: 2 }` to bill "2 cars × ₹500".
   *
   * A map rather than a column per idea: a society can start billing anything
   * countable — scooter bays, extra water tankers, pet registrations — by
   * agreeing on a key with the charge head, with no schema change per idea. A
   * missing key means zero, so a head can be added before every flat has a
   * count and nobody is billed for something they don't have.
   */
  quantities?: Record<string, number>;

  ownerUserId?: mongoose.Types.ObjectId; // User with UserRole.RESIDENT_OWNER (Head of flat)
  owners: mongoose.Types.ObjectId[]; // Legacy/Backward compat
  residents: mongoose.Types.ObjectId[]; // Refs to Resident model
  
  headOfFamily?: mongoose.Types.ObjectId;
  familyMembers: mongoose.Types.ObjectId[];

  /** Title papers and drawings for this flat. See `IFlatDocument`. */
  documents: IFlatDocument[];

  // Audit columns
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const FlatDocumentSchema = new Schema<IFlatDocument>({
  kind: {
    type: String,
    enum: ['SALE_DEED', 'PROPERTY_CARD', 'NOC', 'OC_CERTIFICATE', 'FLOOR_PLAN', 'SHARE_CERT_COPY', 'POSSESSION_LETTER', 'OTHER'],
    default: 'OTHER',
  },
  label: { type: String, required: true, trim: true },
  key: { type: String, required: true },
  url: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  uploadedByName: { type: String, default: '' },
}, { _id: true });

const FlatSchema = new Schema<IFlat>({
  number: {
    type: String,
    required: true,
    trim: true,
  },
  blockName: {
    type: String,
    required: true,
    trim: true,
  },
  blockId: {
    type: Schema.Types.ObjectId,
    ref: 'Block',
    required: true,
  },
  societyId: {
    type: Schema.Types.ObjectId,
    ref: 'Society',
    required: true,
  },
  status: {
    type: String,
    enum: Object.values(FlatStatus),
    default: FlatStatus.VACANT,
  },
  fullAddress: { type: String, trim: true },
  registrationNumber: { type: String, trim: true },
  location: {
    type: {
      type: String,
      enum: ['Point'],
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
    }
  },
  size: {
    type: Schema.Types.ObjectId,
    ref: 'FlatSize',
  },
  quantities: { type: Map, of: Number, default: undefined },
  ownerUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  owners: [{
    type: Schema.Types.ObjectId,
    ref: 'User',
  }],
  residents: [{
    type: Schema.Types.ObjectId,
    ref: 'Resident',
  }],
  headOfFamily: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  familyMembers: [{
    type: Schema.Types.ObjectId,
    ref: 'User',
  }],
  documents: { type: [FlatDocumentSchema], default: [] },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdByName: {
    type: String,
    required: true,
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  updatedByName: {
    type: String,
    required: true,
  },
}, {
  timestamps: true,
});

// Optimization Indexes
FlatSchema.index({ societyId: 1 });
FlatSchema.index({ blockId: 1 });
FlatSchema.index({ societyId: 1, blockName: 1, number: 1 }, { unique: true }); // Prevent duplicate flat numbers in the same block
FlatSchema.index({ ownerUserId: 1 });
FlatSchema.index({ owners: 1 });
FlatSchema.index({ location: '2dsphere' });

export const Flat = mongoose.model<IFlat>('Flat', FlatSchema);
export default Flat;
