import mongoose, { Schema, Document } from 'mongoose';
import { SlotVehicleKind } from './parking-slot.model';

/**
 * The waiting list.
 *
 * Every society with fewer slots than cars already has one — written in a
 * register, or in the secretary's memory, which is the version that causes
 * fights. The only thing that makes a queue acceptable is that its ORDER is
 * visible and dated, so `queuedAt` is stamped once and never touched again:
 * approving, rejecting or withdrawing a request cannot silently reorder the
 * people behind it.
 *
 * Decisions are recorded, not applied by deletion. "We asked in March and were
 * told no" is the sentence a resident brings to the AGM, and a rejected row
 * that vanished leaves the committee with nothing to answer it with.
 */

export const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type ParkingRequestStatus = typeof REQUEST_STATUSES[number];

export interface IParkingRequest extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;
  flatLabel?: string;
  blockId?: mongoose.Types.ObjectId;

  requestedByUserId: mongoose.Types.ObjectId;
  requestedByName: string;
  vehicleKind: SlotVehicleKind;
  note?: string;

  status: ParkingRequestStatus;
  /** Set once, at creation. The queue's only honest ordering. */
  queuedAt: Date;

  decidedBy?: mongoose.Types.ObjectId;
  decidedByName?: string;
  decidedAt?: Date;
  decisionNote?: string;
  /** What the approval actually produced, so the two can be read together. */
  allocationId?: mongoose.Types.ObjectId;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ParkingRequestSchema = new Schema<IParkingRequest>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  flatLabel: { type: String, trim: true },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },

  requestedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  requestedByName: { type: String, required: true },
  vehicleKind: { type: String, enum: ['CAR', 'BIKE', 'EV', 'ANY'], default: 'CAR' },
  note: { type: String, trim: true, maxlength: 500 },

  status: { type: String, enum: REQUEST_STATUSES, default: 'PENDING' },
  queuedAt: { type: Date, required: true, default: Date.now },

  decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  decidedByName: { type: String, trim: true },
  decidedAt: { type: Date },
  decisionNote: { type: String, trim: true, maxlength: 500 },
  allocationId: { type: Schema.Types.ObjectId, ref: 'ParkingAllocation' },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

// Sorted by the queue, because that is the only order anybody ever wants to
// read it in — and a list that comes back newest-first invites a committee to
// serve the loudest rather than the earliest.
ParkingRequestSchema.index({ societyId: 1, status: 1, queuedAt: 1 });
ParkingRequestSchema.index({ societyId: 1, flatId: 1, queuedAt: -1 });

export const ParkingRequest = mongoose.model<IParkingRequest>('ParkingRequest', ParkingRequestSchema);
export default ParkingRequest;
