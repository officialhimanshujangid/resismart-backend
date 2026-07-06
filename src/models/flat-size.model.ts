import mongoose, { Schema, Document } from 'mongoose';

export interface IFlatSize extends Document {
  name: string; // e.g., "3 BHK"
  details?: string; // e.g., "1220 sq feet"
  societyId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const FlatSizeSchema = new Schema<IFlatSize>({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  details: {
    type: String,
    trim: true,
  },
  societyId: {
    type: Schema.Types.ObjectId,
    ref: 'Society',
    required: true,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, {
  timestamps: true,
});

FlatSizeSchema.index({ societyId: 1 });
FlatSizeSchema.index({ societyId: 1, name: 1 }, { unique: true });

export const FlatSize = mongoose.model<IFlatSize>('FlatSize', FlatSizeSchema);
export default FlatSize;
