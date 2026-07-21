import mongoose, { Schema, Document } from 'mongoose';

/**
 * A level, a basement or an open compound — the thing you draw a map of.
 *
 * Zones exist so slots have somewhere to live that a resident can point at.
 * "B1-14" means nothing on its own; "Basement 1, second row" is how the
 * watchman gives directions, and a map with no zones is one enormous grid that
 * matches no real floor plan.
 *
 * `layout.rows/cols` bounds the grid rather than describing it. Real basements
 * have aisles, ramps and pillars, so most cells are EMPTY — the map is drawn
 * from the slots that exist, and this only says how big the sheet of paper is.
 * Without it a society with one slot at row 40 renders forty rows of nothing.
 */

export const PARKING_ZONE_KINDS = ['BASEMENT', 'STILT', 'OPEN', 'COVERED', 'MLCP'] as const;
export type ParkingZoneKind = typeof PARKING_ZONE_KINDS[number];

export interface IParkingZone extends Document {
  societyId: mongoose.Types.ObjectId;
  name: string;
  /** Set when a wing owns the parking under it. Absent means society-wide. */
  blockId?: mongoose.Types.ObjectId;
  blockName?: string;
  kind: ParkingZoneKind;
  /** 0 for ground, -1 for the first basement. Sorts the way a lift does. */
  levelIndex: number;
  layout: { rows: number; cols: number };
  sortOrder: number;
  isActive: boolean;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ParkingZoneSchema = new Schema<IParkingZone>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },
  blockName: { type: String, trim: true },
  kind: { type: String, enum: PARKING_ZONE_KINDS, default: 'BASEMENT' },
  levelIndex: { type: Number, default: 0 },
  // Capped, and the cap is not arbitrary: the map is a CSS grid the browser has
  // to lay out, and a fat-fingered "1000 × 1000" wizard run would ask it to
  // render a million cells. A society that genuinely needs more has two zones.
  layout: {
    rows: { type: Number, default: 10, min: 1, max: 200 },
    cols: { type: Number, default: 10, min: 1, max: 200 },
  },
  sortOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

/**
 * Unique among LIVE zones only.
 *
 * A society that retires "Basement 2" and later rebuilds it must be able to use
 * the name again, and the old zone has to survive rather than be deleted — its
 * allocations are the history of who parked where, and history that names a
 * zone nobody can look up is not history.
 */
ParkingZoneSchema.index(
  { societyId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);
ParkingZoneSchema.index({ societyId: 1, sortOrder: 1, levelIndex: 1 });

export const ParkingZone = mongoose.model<IParkingZone>('ParkingZone', ParkingZoneSchema);
export default ParkingZone;
