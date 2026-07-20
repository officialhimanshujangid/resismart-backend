import mongoose, { Schema, Document } from 'mongoose';

/**
 * A vehicle that belongs to a flat.
 *
 * Two jobs, and the second is the one that matters. The obvious job is
 * autocomplete — a guard types "MH12" and the rest appears. The real job is
 * telling a resident's own car apart from a stranger's, because a gate that
 * treats both the same either logs every resident's movements (surveillance,
 * and the loudest complaint against the incumbents) or logs nothing.
 *
 * Registration numbers are stored stripped of spaces and hyphens and
 * upper-cased. "MH 12 AB 1234", "mh12ab1234" and "MH-12-AB-1234" are one car,
 * and a guard in a hurry types all three.
 */

export type VehicleKind = 'CAR' | 'BIKE' | 'CYCLE' | 'OTHER';

export interface IResidentVehicle extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;
  flatLabel?: string;
  blockId?: mongoose.Types.ObjectId;

  /** Normalised: no spaces, no hyphens, upper case. */
  number: string;
  /** What the resident actually typed, for display. */
  displayNumber: string;
  kind: VehicleKind;
  make?: string;
  colour?: string;

  /** Parking slot, where the society allocates them. */
  parkingSlot?: string;

  isActive: boolean;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ResidentVehicleSchema = new Schema<IResidentVehicle>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  flatLabel: { type: String, trim: true },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },

  number: { type: String, required: true, uppercase: true, trim: true, maxlength: 20 },
  displayNumber: { type: String, required: true, trim: true, maxlength: 25 },
  kind: { type: String, enum: ['CAR', 'BIKE', 'CYCLE', 'OTHER'], default: 'CAR' },
  make: { type: String, trim: true, maxlength: 60 },
  colour: { type: String, trim: true, maxlength: 30 },
  parkingSlot: { type: String, trim: true, maxlength: 20 },

  isActive: { type: Boolean, default: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

/**
 * Unique per society among ACTIVE rows only.
 *
 * A car sold to the flat upstairs must be registerable there, and the old row
 * has to survive as history rather than being deleted — the register still
 * refers to it.
 */
ResidentVehicleSchema.index(
  { societyId: 1, number: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);
ResidentVehicleSchema.index({ societyId: 1, flatId: 1 });

export const ResidentVehicle = mongoose.model<IResidentVehicle>('ResidentVehicle', ResidentVehicleSchema);
export default ResidentVehicle;
