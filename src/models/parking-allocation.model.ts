import mongoose, { Schema, Document } from 'mongoose';
import { SlotVehicleKind } from './parking-slot.model';

/**
 * Who holds a slot, and who held it before them.
 *
 * **Append-only.** Ending an allocation stamps `endedAt` and flips the status;
 * nothing is ever removed. Parking is the second most argued-about thing in an
 * Indian society after money, and "B1-14 was ours until the Sharmas took it in
 * 2023" is a claim the software has to be able to settle. A row deleted on
 * release makes every such argument unanswerable, and the allocation history is
 * also the only evidence for why a flat was billed what it was billed.
 *
 * The one-live-allocation-per-slot rule is enforced by the PARTIAL UNIQUE INDEX
 * below and NOT by application code, deliberately. A read-then-write check in
 * the service is a race: two committee members allotting the same slot from two
 * browsers at the same second both read "free" and both write. The database is
 * the only place that can refuse the second one, and it refuses it with an
 * 11000 the service turns into a sentence a human can act on.
 */

export const ALLOCATION_KINDS = ['PERMANENT', 'TEMPORARY', 'VISITOR', 'STAFF'] as const;
export type AllocationKind = typeof ALLOCATION_KINDS[number];

export type AllocationStatus = 'ACTIVE' | 'ENDED';

export interface IParkingAllocation extends Document {
  societyId: mongoose.Types.ObjectId;
  slotId: mongoose.Types.ObjectId;
  /** Denormalised so history still reads after a slot is retired. */
  slotCode: string;
  zoneId: mongoose.Types.ObjectId;
  /**
   * The slot's vehicle kind, copied at allocation time.
   *
   * This is what decides whether the flat is billed a car rate or a bike rate,
   * so the billing recompute is one query against this collection instead of a
   * join. Copying it is safe only because `updateSlot` refuses to change a
   * slot's kind while an allocation is live — without that rule this field
   * would drift and a flat would be billed for a car it does not have.
   */
  slotKind: SlotVehicleKind;

  flatId: mongoose.Types.ObjectId;
  flatLabel?: string;
  blockId?: mongoose.Types.ObjectId;
  /** The specific car, when the society tracks that far. Optional by design. */
  vehicleId?: mongoose.Types.ObjectId;

  kind: AllocationKind;
  startDate: Date;
  endDate?: Date;
  status: AllocationStatus;
  endReason?: string;

  /**
   * Whether this slot counts towards the flat's bill.
   *
   * Per-allocation rather than per-society, because the exceptions are real: a
   * committee often allots one free slot per flat and charges for the second,
   * and a slot given to the society's own watchman is never billed to anybody.
   * A society-wide switch would force those into a spreadsheet, which is where
   * they were before.
   */
  chargeable: boolean;

  allocatedBy: mongoose.Types.ObjectId;
  allocatedByName: string;
  endedBy?: mongoose.Types.ObjectId;
  endedByName?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ParkingAllocationSchema = new Schema<IParkingAllocation>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  slotId: { type: Schema.Types.ObjectId, ref: 'ParkingSlot', required: true },
  slotCode: { type: String, required: true, trim: true, maxlength: 20 },
  zoneId: { type: Schema.Types.ObjectId, ref: 'ParkingZone', required: true },
  slotKind: { type: String, enum: ['CAR', 'BIKE', 'EV', 'ANY'], default: 'CAR' },

  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  flatLabel: { type: String, trim: true },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },
  vehicleId: { type: Schema.Types.ObjectId, ref: 'ResidentVehicle' },

  kind: { type: String, enum: ALLOCATION_KINDS, default: 'PERMANENT' },
  startDate: { type: Date, required: true, default: Date.now },
  endDate: { type: Date },
  status: { type: String, enum: ['ACTIVE', 'ENDED'], default: 'ACTIVE' },
  endReason: { type: String, trim: true, maxlength: 200 },

  chargeable: { type: Boolean, default: true },

  allocatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  allocatedByName: { type: String, required: true },
  endedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  endedByName: { type: String, trim: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

/**
 * One live allocation per slot, enforced by the database.
 *
 * On `slotId` alone rather than `{ societyId, slotId }` — a slot already
 * belongs to exactly one society, so adding the society to the key would only
 * make the index wider without making it stricter, and a wider key is a key
 * somebody can later be tempted to query on partially.
 *
 * The partial filter is what lets the same slot be allotted again next year:
 * ENDED rows are ignored by the index, so the history piles up freely and only
 * the single ACTIVE row is constrained.
 */
ParkingAllocationSchema.index(
  { slotId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);
ParkingAllocationSchema.index({ societyId: 1, flatId: 1, status: 1 });
ParkingAllocationSchema.index({ societyId: 1, status: 1, startDate: -1 });

export const ParkingAllocation = mongoose.model<IParkingAllocation>('ParkingAllocation', ParkingAllocationSchema);
export default ParkingAllocation;
