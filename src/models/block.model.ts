import mongoose, { Schema, Document } from 'mongoose';

export interface IBlock extends Document {
  name: string;
  societyId: mongoose.Types.ObjectId;
  totalFloors?: number;
  blockType?: string; // e.g. TOWER, WING, PHASE, BLOCK
  
  // Audit columns
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const BlockSchema = new Schema<IBlock>({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  societyId: {
    type: Schema.Types.ObjectId,
    ref: 'Society',
    required: true,
  },
  totalFloors: {
    type: Number,
    min: 0,
  },
  blockType: {
    type: String,
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

// Optimization Indexes
BlockSchema.index({ societyId: 1 });
BlockSchema.index({ societyId: 1, name: 1 }, { unique: true }); // Prevent duplicate block names in the same society

export const Block = mongoose.model<IBlock>('Block', BlockSchema);
export default Block;
