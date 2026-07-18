import mongoose, { Schema, Document } from 'mongoose';

export interface IFlatSize extends Document {
  name: string; // e.g., "2 BHK — 1600 sqft"
  details?: string; // free-text notes
  /**
   * The area every flat of this size has.
   *
   * Held here rather than on each flat because a society has a handful of size
   * definitions and hundreds of flats — typing the area 200 times is 200 chances
   * to mistype it, and PER_SQFT billing multiplies whatever it finds. A society
   * with two different 1BHK layouts simply defines two sizes ("1BHK 1200",
   * "1BHK 1500"), which is how a committee already thinks about them.
   *
   * A flat may still carry its own area as an override for a genuine oddity —
   * the corner unit with a terrace — and that wins when set.
   */
  carpetAreaSqft?: number;
  builtUpAreaSqft?: number;
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
  carpetAreaSqft: { type: Number, min: 0 },
  builtUpAreaSqft: { type: Number, min: 0 },
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
