import mongoose, { Schema, Document } from 'mongoose';

/**
 * A resident reports a problem; somebody becomes answerable for fixing it.
 *
 * Five decisions here are load-bearing, and each comes from a specific failure
 * in the products that already exist:
 *
 * 1. **`ownerStaffId` and `assigneeStaffId` are different people.** One is
 *    answerable, the other does the work. Products that collapse them into one
 *    field cannot escalate without taking the ticket off the technician.
 *
 * 2. **Staff can reach WORK_DONE but never CLOSED.** MyGate learned this: the
 *    person who did the work is not the person who gets to say it is finished.
 *
 * 3. **`reopenCount` is a counter, not a status rewind.** ADDA reopens by
 *    setting the status back to New, which erases the fact that it was ever
 *    reopened — and reopen rate is the single best measure of whether work is
 *    actually being done.
 *
 * 4. **The SLA clock can pause.** Nobody else does this. Without it, a
 *    technician who cannot get into a locked flat is scored as slow, and the
 *    rational response is to close the ticket and open a new one — which
 *    destroys the history.
 *
 * 5. **`kind: CONDUCT` never routes by trade.** "The housekeeping man was rude"
 *    filed under Housekeeping would be delivered to the housekeeping supervisor
 *    — or to the man himself.
 */

export type ComplaintStatus =
  | 'NEW' | 'ASSIGNED' | 'IN_PROGRESS' | 'ON_HOLD'
  | 'WORK_DONE' | 'RESOLVED' | 'CLOSED' | 'REOPENED' | 'REJECTED';

export type ComplaintKind = 'SERVICE' | 'CONDUCT';
export type ComplaintPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'EMERGENCY';
export type Visibility = 'PERSONAL' | 'COMMUNITY';

/**
 * Why the clock is stopped.
 *
 * A closed list on purpose. Free text would mean every ticket is "on hold" for
 * a reason nobody can aggregate, and the pause would stop meaning anything.
 */
export const PAUSE_REASONS = [
  'AWAITING_ACCESS',      // flat locked, resident not available
  'AWAITING_PARTS',
  'AWAITING_VENDOR',
  'AWAITING_APPROVAL',    // spend above the threshold
] as const;
export type PauseReason = typeof PAUSE_REASONS[number];

export interface IComplaint extends Document {
  societyId: mongoose.Types.ObjectId;
  ticketCode: string;

  kind: ComplaintKind;
  title: string;
  description?: string;
  photoKeys: string[];

  categoryId?: mongoose.Types.ObjectId;
  category: string;
  subCategory?: string;

  visibility: Visibility;
  scope: 'SOCIETY' | 'BLOCK' | 'FLAT';
  blockId?: mongoose.Types.ObjectId;
  blockName?: string;
  flatId?: mongoose.Types.ObjectId;
  flatLabel?: string;
  assetId?: mongoose.Types.ObjectId;
  assetName?: string;

  raisedByUserId?: mongoose.Types.ObjectId;
  raisedByName: string;
  /** APP when the resident filed it; MANAGER/GUARD when somebody typed it for them. */
  viaChannel: 'APP' | 'MANAGER' | 'GUARD';

  /** Answerable. Escalation climbs to this person, not the doer. */
  ownerStaffId?: mongoose.Types.ObjectId;
  ownerName?: string;
  /** Does the work. */
  assigneeStaffId?: mongoose.Types.ObjectId;
  assigneeName?: string;
  /** Or an outside firm, for something under an AMC. */
  assigneeVendorId?: mongoose.Types.ObjectId;
  assigneeVendorName?: string;
  /** How routing landed on them — shown so an odd assignment can be understood. */
  routedVia?: string;

  status: ComplaintStatus;
  priority: ComplaintPriority;

  /** Residents' anger is mostly about silence, so this is tracked separately. */
  firstResponseDueAt?: Date;
  firstRespondedAt?: Date;
  resolutionDueAt?: Date;
  resolvedAt?: Date;
  closedAt?: Date;

  pausedAt?: Date;
  pauseReason?: PauseReason;
  /** Total milliseconds the clock has been stopped. Excluded from every SLA sum. */
  totalPausedMs: number;

  escalationLevel: number;
  lastEscalatedAt?: Date;

  reopenCount: number;
  /** Everyone who asked for this same thing. Nobody else models this. */
  meTooUserIds: mongoose.Types.ObjectId[];
  mergedIntoId?: mongoose.Types.ObjectId;

  rating?: number;
  feedback?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ComplaintSchema = new Schema<IComplaint>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  ticketCode: { type: String, required: true },

  kind: { type: String, enum: ['SERVICE', 'CONDUCT'], default: 'SERVICE' },
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  photoKeys: { type: [String], default: [] },

  categoryId: { type: Schema.Types.ObjectId, ref: 'ComplaintCategory' },
  category: { type: String, required: true },
  subCategory: { type: String },

  visibility: { type: String, enum: ['PERSONAL', 'COMMUNITY'], default: 'PERSONAL' },
  scope: { type: String, enum: ['SOCIETY', 'BLOCK', 'FLAT'], default: 'FLAT' },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },
  blockName: { type: String },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat' },
  flatLabel: { type: String },
  assetId: { type: Schema.Types.ObjectId, ref: 'Asset' },
  assetName: { type: String },

  raisedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  raisedByName: { type: String, required: true },
  viaChannel: { type: String, enum: ['APP', 'MANAGER', 'GUARD'], default: 'APP' },

  ownerStaffId: { type: Schema.Types.ObjectId, ref: 'SocietyStaff' },
  ownerName: { type: String },
  assigneeStaffId: { type: Schema.Types.ObjectId, ref: 'SocietyStaff' },
  assigneeName: { type: String },
  assigneeVendorId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
  assigneeVendorName: { type: String },
  routedVia: { type: String },

  status: {
    type: String,
    enum: ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'WORK_DONE', 'RESOLVED', 'CLOSED', 'REOPENED', 'REJECTED'],
    default: 'NEW',
  },
  priority: { type: String, enum: ['LOW', 'NORMAL', 'HIGH', 'EMERGENCY'], default: 'NORMAL' },

  firstResponseDueAt: { type: Date },
  firstRespondedAt: { type: Date },
  resolutionDueAt: { type: Date },
  resolvedAt: { type: Date },
  closedAt: { type: Date },

  pausedAt: { type: Date },
  pauseReason: { type: String, enum: PAUSE_REASONS },
  totalPausedMs: { type: Number, default: 0 },

  escalationLevel: { type: Number, default: 0 },
  lastEscalatedAt: { type: Date },

  reopenCount: { type: Number, default: 0 },
  meTooUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  mergedIntoId: { type: Schema.Types.ObjectId, ref: 'Complaint' },

  rating: { type: Number, min: 1, max: 5 },
  feedback: { type: String, trim: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

ComplaintSchema.index({ societyId: 1, status: 1, createdAt: -1 });
ComplaintSchema.index({ societyId: 1, flatId: 1, createdAt: -1 });
ComplaintSchema.index({ societyId: 1, assigneeStaffId: 1, status: 1 });
ComplaintSchema.index({ societyId: 1, blockId: 1, createdAt: -1 });
ComplaintSchema.index({ societyId: 1, assetId: 1, createdAt: -1 });
// The escalation sweep: overdue, not yet escalated to the next level.
ComplaintSchema.index({ societyId: 1, status: 1, resolutionDueAt: 1, escalationLevel: 1 });
// Conduct complaints are read through a completely separate door.
ComplaintSchema.index({ societyId: 1, kind: 1, createdAt: -1 });

export const Complaint = mongoose.model<IComplaint>('Complaint', ComplaintSchema);
export default Complaint;
