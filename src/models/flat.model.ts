import mongoose, { Schema, Document } from 'mongoose';

export enum FlatStatus {
  VACANT = 'VACANT',
  OWNER_OCCUPIED = 'OWNER_OCCUPIED',
  RENTED = 'RENTED',
}

export interface IFlat extends Document {
  number: string;
  blockName: string; // "A Block", "Tower 2" - denormalized for speed
  societyId: mongoose.Types.ObjectId;
  status: FlatStatus;
  owners: mongoose.Types.ObjectId[]; // Users with UserRole.RESIDENT_OWNER
  
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
  owners: [{
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
FlatSchema.index({ societyId: 1, blockName: 1, number: 1 }, { unique: true }); // Prevent duplicate flat numbers in the same block
FlatSchema.index({ owners: 1 });

export const Flat = mongoose.model<IFlat>('Flat', FlatSchema);
export default Flat;
