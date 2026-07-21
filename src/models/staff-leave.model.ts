import mongoose, { Schema, Document } from 'mongoose';

/**
 * A stretch of days somebody is known to be away.
 *
 * The counterpart to `StaffShift`: the rota says which hours a person normally
 * works, this says which days to skip them entirely. Both exist because
 * complaint routing had no time dimension at all — the primary plumber kept
 * receiving every A-wing ticket while he was at his village for a fortnight,
 * and the backup, who existed precisely for that fortnight, was never tried.
 *
 * Emphatically NOT attendance. Nothing here is a punch-in, nothing is counted
 * against a wage, and there is no "absent without notice" kind — that would be
 * an attendance register wearing a different hat, and attendance is a standing
 * product decision to stay out of. This records what the office already knows
 * in advance, so the software can act on it.
 *
 * Whole days, not hours: a half-day off is a rota question, and pretending to
 * model it here would give two places to look and two answers.
 */

export const LEAVE_KINDS = ['LEAVE', 'SICK', 'WEEKLY_OFF', 'OTHER'] as const;
export type LeaveKind = typeof LEAVE_KINDS[number];

/** What each kind is called on screen. Appendix A rule 2: never show the enum. */
export const LEAVE_KIND_LABEL: Record<LeaveKind, string> = {
  LEAVE: 'On leave',
  SICK: 'Unwell',
  WEEKLY_OFF: 'Weekly off',
  OTHER: 'Away',
};

export interface IStaffLeave extends Document {
  societyId: mongoose.Types.ObjectId;
  staffId: mongoose.Types.ObjectId;
  /** Name at the time of writing, so the list reads without a join. */
  staffName: string;

  /** Both ends INCLUSIVE, normalised to the start and end of their day. */
  from: Date;
  to: Date;
  kind: LeaveKind;
  reason?: string;

  /** Cancelled rather than deleted — an approved absence that vanished is a
   *  row somebody will argue about later. */
  isActive: boolean;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const StaffLeaveSchema = new Schema<IStaffLeave>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  staffId: { type: Schema.Types.ObjectId, ref: 'SocietyStaff', required: true },
  staffName: { type: String, required: true },

  from: { type: Date, required: true },
  to: { type: Date, required: true },
  kind: { type: String, enum: LEAVE_KINDS, default: 'LEAVE' },
  reason: { type: String, trim: true, maxlength: 300 },

  isActive: { type: Boolean, default: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

// "Is this person away right now?" — the query routing runs on every complaint.
StaffLeaveSchema.index({ societyId: 1, staffId: 1, isActive: 1, from: 1, to: 1 });

export const StaffLeave = mongoose.model<IStaffLeave>('StaffLeave', StaffLeaveSchema);
export default StaffLeave;
