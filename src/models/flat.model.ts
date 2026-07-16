import mongoose, { Schema, Document } from 'mongoose';

export enum FlatStatus {
  VACANT = 'VACANT',
  OWNER_OCCUPIED = 'OWNER_OCCUPIED',
  RENTED = 'RENTED',
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

  // Area for per-sq-ft billing (finance). Optional; only needed for PER_SQFT charge heads.
  carpetAreaSqft?: number;
  builtUpAreaSqft?: number;

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
  
  // Audit columns
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

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
  carpetAreaSqft: { type: Number, min: 0 },
  builtUpAreaSqft: { type: Number, min: 0 },
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
