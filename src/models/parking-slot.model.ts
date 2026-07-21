import mongoose, { Schema, Document } from 'mongoose';

/**
 * One bay. The thing a car actually stands in.
 *
 * This is the inventory that never existed: before it, "B-14" was a twenty
 * character free-text string on a vehicle row, two flats could both claim it,
 * and nothing anywhere in the product noticed. A slot is now a row in a
 * collection with a unique code, which is the whole reason a conflict can be
 * detected at all.
 *
 * `row`/`col` are what makes the map possible. They are grid coordinates, NOT
 * geometry — cells with no slot are aisles, so a floor plan with a ramp up the
 * middle draws correctly without anybody modelling a ramp.
 *
 * `status` is deliberately wider than free/taken. A society needs to say "this
 * one is the fire tender's" (RESERVED) and "this one has a pillar in it"
 * (OUT_OF_SERVICE) without inventing a fake allocation to hide it, which is
 * exactly what happens when the only two states are AVAILABLE and ALLOCATED.
 */

export const SLOT_VEHICLE_KINDS = ['CAR', 'BIKE', 'EV', 'ANY'] as const;
export type SlotVehicleKind = typeof SLOT_VEHICLE_KINDS[number];

export const SLOT_SIZES = ['COMPACT', 'STANDARD', 'LARGE'] as const;
export type SlotSize = typeof SLOT_SIZES[number];

export const SLOT_STATUSES = [
  'AVAILABLE', 'ALLOCATED', 'RESERVED', 'VISITOR', 'BLOCKED', 'OUT_OF_SERVICE',
] as const;
export type SlotStatus = typeof SLOT_STATUSES[number];

export interface IParkingSlot extends Document {
  societyId: mongoose.Types.ObjectId;
  zoneId: mongoose.Types.ObjectId;
  zoneName?: string;
  /** What is painted on the floor. "B1-14". */
  code: string;
  row: number;
  col: number;

  vehicleKind: SlotVehicleKind;
  size: SlotSize;
  isAccessible: boolean;
  hasEvCharger: boolean;

  status: SlotStatus;
  /**
   * The live allocation, denormalised so the map is one query.
   *
   * A cache, and treated as one: `ParkingAllocation`'s partial unique index is
   * the truth about what may hold a slot. If the two ever disagree the index
   * wins, because it is the thing the database enforces and this is the thing
   * an application bug can leave behind.
   */
  currentAllocationId?: mongoose.Types.ObjectId;
  isActive: boolean;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ParkingSlotSchema = new Schema<IParkingSlot>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  zoneId: { type: Schema.Types.ObjectId, ref: 'ParkingZone', required: true },
  zoneName: { type: String, trim: true },
  code: { type: String, required: true, uppercase: true, trim: true, maxlength: 20 },
  row: { type: Number, required: true, min: 1 },
  col: { type: Number, required: true, min: 1 },

  vehicleKind: { type: String, enum: SLOT_VEHICLE_KINDS, default: 'CAR' },
  size: { type: String, enum: SLOT_SIZES, default: 'STANDARD' },
  isAccessible: { type: Boolean, default: false },
  hasEvCharger: { type: Boolean, default: false },

  status: { type: String, enum: SLOT_STATUSES, default: 'AVAILABLE' },
  currentAllocationId: { type: Schema.Types.ObjectId, ref: 'ParkingAllocation' },
  isActive: { type: Boolean, default: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

/**
 * Both uniqueness rules are partial on `isActive`, for the same reason as
 * `ResidentVehicle.number`: slots are retired, never deleted, because the
 * allocations that refer to them are the record of who parked where. A
 * plain unique index would mean a basement re-numbered after a re-tender could
 * never reuse its own codes, and the only way out would be destroying history.
 */
ParkingSlotSchema.index(
  { societyId: 1, code: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);
ParkingSlotSchema.index(
  { zoneId: 1, row: 1, col: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);
ParkingSlotSchema.index({ societyId: 1, zoneId: 1, status: 1 });

export const ParkingSlot = mongoose.model<IParkingSlot>('ParkingSlot', ParkingSlotSchema);
export default ParkingSlot;
