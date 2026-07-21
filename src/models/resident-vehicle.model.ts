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

/**
 * Whose vehicle this is.
 *
 * Not everything at the gate belongs to a flat. A contractor's van and a
 * housekeeper's scooter both need to be recognised, and lumping them in as
 * resident vehicles is how a whitelist ends up full of people who stopped
 * working here two years ago — which is why `validTill` exists and is
 * mandatory for anything that is not a resident's own car.
 */
export type VehicleOwnerKind = 'RESIDENT' | 'STAFF' | 'VENDOR' | 'VISITOR';

/** Who put it on the register. Answers "who let this van in?" months later. */
export type VehicleRegisteredVia = 'SELF' | 'ADMIN' | 'COMMITTEE' | 'GATE';

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

  /**
   * The real slot, once the society runs the parking module.
   *
   * `parkingSlot` below stays as a DISPLAY label and nothing more. Every screen
   * and every guard console already reads that string; removing it would have
   * meant editing all of them in the same change that introduces slots, and a
   * society that never switches parking on would lose the one thing it had.
   * When both are set, `slotId` is the fact and `parkingSlot` is its caption.
   */
  slotId?: mongoose.Types.ObjectId;

  /** Denormalised display label. See `slotId`. Free text, and may be stale. */
  parkingSlot?: string;

  ownerKind: VehicleOwnerKind;
  /** The staff post this belongs to, when `ownerKind` is STAFF. */
  staffId?: mongoose.Types.ObjectId;
  /**
   * When the whitelist entry stops meaning anything.
   *
   * A worker's vehicle that never expires is a permanent hole in the gate: the
   * contractor finishes the job, the van keeps being waved through, and nobody
   * can say who authorised it. Optional on the model because a resident's own
   * car has no end date; the service insists on it for STAFF and VENDOR.
   */
  validTill?: Date;
  registeredVia: VehicleRegisteredVia;

  /** Papers. Keys into the upload store, never the documents themselves. */
  rcKey?: string;
  insuranceExpiry?: Date;
  pucExpiry?: Date;
  photoKey?: string;

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
  slotId: { type: Schema.Types.ObjectId, ref: 'ParkingSlot' },
  parkingSlot: { type: String, trim: true, maxlength: 20 },

  // Defaults to RESIDENT so every row written before this field existed keeps
  // meaning exactly what it meant — they were all residents' cars.
  ownerKind: { type: String, enum: ['RESIDENT', 'STAFF', 'VENDOR', 'VISITOR'], default: 'RESIDENT' },
  staffId: { type: Schema.Types.ObjectId, ref: 'SocietyStaff' },
  validTill: { type: Date },
  registeredVia: { type: String, enum: ['SELF', 'ADMIN', 'COMMITTEE', 'GATE'], default: 'ADMIN' },

  rcKey: { type: String, trim: true, maxlength: 300 },
  insuranceExpiry: { type: Date },
  pucExpiry: { type: Date },
  photoKey: { type: String, trim: true, maxlength: 300 },

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
