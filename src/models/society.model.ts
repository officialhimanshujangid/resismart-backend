import mongoose, { Schema, Document } from 'mongoose';

export interface ISociety extends Document {
  name: string;
  address: string;
  status: 'PENDING' | 'ACTIVE' | 'REJECTED';
  location?: {
    type: 'Point';
    coordinates: number[]; // [longitude, latitude]
  };
  // Primary admin contact (captured on self-registration, before a User exists)
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  adminUserId?: mongoose.Types.ObjectId; // SOCIETY_ADMIN user, created on approval
  rejectionReason?: string;
  // Extended details
  city?: string;
  state?: string;
  pincode?: string;
  registrationNumber?: string;
  totalBlocks?: number;
  totalFlats?: number;
  website?: string;
  // Audit metadata columns
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const SocietySchema = new Schema<ISociety>({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  address: {
    type: String,
    required: true,
    trim: true,
  },
  status: {
    type: String,
    enum: ['PENDING', 'ACTIVE', 'REJECTED'],
    default: 'PENDING',
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
    }
  },
  contactName: { type: String, trim: true },
  contactEmail: { type: String, trim: true, lowercase: true },
  contactPhone: { type: String, trim: true },
  adminUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  rejectionReason: { type: String, trim: true },
  city: { type: String, trim: true },
  state: { type: String, trim: true },
  pincode: { type: String, trim: true },
  registrationNumber: { type: String, trim: true },
  totalBlocks: { type: Number, min: 0 },
  totalFlats: { type: Number, min: 0 },
  website: { type: String, trim: true },
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

// Indexes for fast querying
SocietySchema.index({ createdBy: 1 });
SocietySchema.index({ name: 1 });
SocietySchema.index({ status: 1 });
SocietySchema.index({ location: '2dsphere' });

export const Society = mongoose.model<ISociety>('Society', SocietySchema);
export default Society;
