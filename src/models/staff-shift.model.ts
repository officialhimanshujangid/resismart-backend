import mongoose, { Schema, Document } from 'mongoose';

/**
 * When somebody is *expected* to be on duty.
 *
 * This is a ROTA, not a register. It answers "who is meant to be here on a
 * Tuesday evening", which is what routing needs; it does NOT answer "who
 * actually turned up", which is attendance. Attendance stays out of this
 * product — a standing decision, for the same reason payroll is out: a
 * biometric roll nobody reconciles is worse than no roll, and the societies
 * that need one already run one at the gate.
 *
 * Why it exists at all: `StaffAssignment` is (staff × wing × trade × rank) with
 * no time dimension whatsoever, so `findAssignee` handed the night guard the
 * 11am lift complaint and the day plumber the 2am burst pipe. The backup rank
 * was only ever consulted when NO primary row existed — never when the primary
 * was simply not here.
 *
 * A staff member with NO shift rows is treated as always available. That is
 * deliberate: most societies will never build a rota, and a missing rota must
 * not quietly send every complaint to the unassigned queue.
 */

/** 0 = Sunday … 6 = Saturday, matching `Date.getDay()` so no mapping is needed. */
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Zero-padded 24-hour clock. Sorts correctly as plain text, which keeps the
 *  comparisons in `findAssignee` free of date arithmetic. */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface IStaffShift extends Document {
  societyId: mongoose.Types.ObjectId;
  staffId: mongoose.Types.ObjectId;
  /** Name at the time of writing, so the rota screen reads without a join. */
  staffName: string;

  weekday: number;
  /** "22:00" */
  from: string;
  /**
   * "06:00".
   *
   * When `to` is less than or equal to `from` the shift runs PAST MIDNIGHT and
   * ends on the following day. A 22:00–06:00 guard shift is the ordinary case
   * in an Indian society, and the naive test `from <= now && now < to` reports
   * that guard as off duty for every single hour of it.
   */
  to: string;

  isActive: boolean;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const StaffShiftSchema = new Schema<IStaffShift>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  staffId: { type: Schema.Types.ObjectId, ref: 'SocietyStaff', required: true },
  staffName: { type: String, required: true },

  weekday: { type: Number, required: true, min: 0, max: 6 },
  from: { type: String, required: true, match: HHMM },
  to: { type: String, required: true, match: HHMM },

  isActive: { type: Boolean, default: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

// The routing lookup runs per society and per person: "is this one on duty
// right now?" — so the compound index is society + staff + live.
StaffShiftSchema.index({ societyId: 1, staffId: 1, isActive: 1 });
StaffShiftSchema.index({ societyId: 1, isActive: 1, weekday: 1 });

export const StaffShift = mongoose.model<IStaffShift>('StaffShift', StaffShiftSchema);
export default StaffShift;
