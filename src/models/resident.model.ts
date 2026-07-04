import mongoose, { Schema, Document } from 'mongoose';

export interface IResident extends Document {
  flatId: mongoose.Types.ObjectId;
  societyId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  relationship: string; // 'OWNER', 'SPOUSE', 'CHILD', 'PARENT', 'TENANT', 'OTHER'
  isOwner: boolean;
  isActive: boolean;
  
  // Audit columns
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ResidentSchema = new Schema<IResident>({
  flatId: {
    type: Schema.Types.ObjectId,
    ref: 'Flat',
    required: true,
  },
  societyId: {
    type: Schema.Types.ObjectId,
    ref: 'Society',
    required: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  relationship: {
    type: String,
    enum: ['OWNER', 'SPOUSE', 'CHILD', 'PARENT', 'TENANT', 'OTHER'],
    required: true,
  },
  isOwner: {
    type: Boolean,
    default: false,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
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
ResidentSchema.index({ flatId: 1 });
ResidentSchema.index({ societyId: 1 });
ResidentSchema.index({ userId: 1 });
ResidentSchema.index({ flatId: 1, userId: 1 }, { unique: true }); // A user can only be added to a flat once

export const Resident = mongoose.model<IResident>('Resident', ResidentSchema);
export default Resident;
