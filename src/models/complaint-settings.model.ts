import mongoose, { Schema, Document } from 'mongoose';

/**
 * When this society is actually open for work — the calendar every complaint
 * clock is measured against.
 *
 * The defect this exists to end: all SLA arithmetic was raw UTC epoch maths.
 * `firstResponseDueAt = now + firstResponseMinutes * 60_000`, and nothing else.
 * So a category promising a 15-minute first reply, filed at 02:00, was breached
 * at 02:15 — and the sweep then escalated it to the committee, by push, in the
 * middle of the night, for a leaking tap nobody was ever going to attend before
 * nine. The promise was never keepable, so the breach was never a fault; it was
 * a false accusation the software made against its own staff every night.
 *
 * **Why this is not on `SocietyOpsPolicy`.** That document is the natural home
 * — it already holds "everything a society decides about its gate, its
 * complaints and its staff" — and IV-3 names it. It is owned by another module,
 * and a schema change there is that module's migration, its settings screen and
 * its verify script, not this one's. The calendar has exactly one reader (the
 * complaint clocks) and exactly one writer (the complaints desk), so it lives
 * with its reader. If the two documents are ever merged, the shape below is
 * deliberately flat and portable enough to lift across whole.
 *
 * One lazily-created row per society, the same pattern as `FinancePolicy`: a
 * society that has never opened the settings screen still gets a working,
 * opinionated calendar rather than a null that every caller has to remember to
 * handle.
 */
export interface IComplaintSettings extends Document {
  societyId: mongoose.Types.ObjectId;

  /**
   * A society that genuinely staffs the desk day and night sets this, and the
   * clocks go back to plain elapsed time. Off by default, because the ones that
   * do not are the ones being woken up.
   */
  roundTheClock: boolean;

  /** 0 = Sunday … 6 = Saturday. Indian societies work Saturdays; Sunday is off. */
  workingDays: number[];
  /** Minutes past local midnight. 540 = 09:00, 1080 = 18:00. */
  dayStartMinute: number;
  dayEndMinute: number;

  /**
   * `YYYY-MM-DD`, in local time, not `Date`.
   *
   * A holiday is a DAY, not an instant. Stored as a `Date` it becomes midnight
   * in whatever zone wrote it, and 15 August then either starts at 05:30 or
   * ends at 18:30 depending on which host produced it — the same class of bug
   * `config/timezone` exists to stop in the finance layer.
   */
  holidays: string[];

  /**
   * Whether an emergency category keeps its round-the-clock clock.
   *
   * Someone stuck in a lift at 02:00 is a five-minute promise at 02:00, and
   * measuring that in working hours would make it due at 09:05 the next
   * morning, which is grotesque. So emergencies opt out by default. A society
   * whose "emergency" list has drifted into meaning "important" turns this off
   * and gets business hours for everything.
   */
  emergencyRoundTheClock: boolean;

  updatedBy?: mongoose.Types.ObjectId;
  updatedByName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ComplaintSettingsSchema = new Schema<IComplaintSettings>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true, unique: true },

  roundTheClock: { type: Boolean, default: false },
  workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
  dayStartMinute: { type: Number, default: 9 * 60, min: 0, max: 24 * 60 },
  dayEndMinute: { type: Number, default: 18 * 60, min: 0, max: 24 * 60 },
  holidays: { type: [String], default: [] },
  emergencyRoundTheClock: { type: Boolean, default: true },

  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedByName: { type: String },
}, { timestamps: true });

export const ComplaintSettings = mongoose.model<IComplaintSettings>('ComplaintSettings', ComplaintSettingsSchema);
export default ComplaintSettings;
