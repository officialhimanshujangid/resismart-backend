import mongoose, { Schema, Document } from 'mongoose';

export interface ISociety extends Document {
  name: string;
  address: string;
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

export const Society = mongoose.model<ISociety>('Society', SocietySchema);
export default Society;
