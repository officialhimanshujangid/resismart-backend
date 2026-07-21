import mongoose, { Schema, Document } from 'mongoose';

/**
 * "Whoever is responsible this week", with a name on it.
 *
 * The vacant-flat ladder has always had a `DUTY_ROSTER` rung and it has always
 * been a no-op, because there was nothing in the database that could answer the
 * question. A society that picked it silently got the next rung down, which in
 * practice meant the whole committee — the exact blanket notification the
 * ladder exists to avoid.
 *
 * The unit is a SEAT, not a shift log: one row says "on Tuesday nights, A Wing
 * is R. Nair's problem". Nothing here records what happened; it records who is
 * accountable when something does. That is why a retired row is deactivated
 * rather than kept as history — a rota nobody is on any more is not evidence of
 * anything, and a stale name in it would be worse than an empty roster, because
 * an empty roster falls through to somebody who can actually act.
 *
 * `blockId` absent means society-wide, and that is the common case: a small
 * society has one duty officer, not one per wing. A wing-scoped row wins over a
 * society-wide one for a flat in that wing, so a society can start simple and
 * split later without deleting anything.
 */

/** 0 = Sunday, matching `Date.prototype.getDay()` so no translation is needed. */
export const DUTY_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type DutyWeekday = typeof DUTY_WEEKDAYS[number];

/**
 * Three values, not a start/end time pair.
 *
 * A committee rota is not a shift roster: nobody is going to fill in
 * "18:00–06:00" for seven days for four wings. `ALL_DAY` is the default and
 * covers the society that simply wants one name per day; DAY and NIGHT exist
 * because "who do I ring at 2am" is a genuinely different answer in most
 * societies.
 */
export const DUTY_SHIFTS = ['ALL_DAY', 'DAY', 'NIGHT'] as const;
export type DutyShift = typeof DUTY_SHIFTS[number];

/** Where DAY stops and NIGHT starts, in hours. Kept here so the resolver and any future screen cannot disagree. */
export const DAY_SHIFT_FROM_HOUR = 6;
export const DAY_SHIFT_TO_HOUR = 18;

export interface IOpsDutyRoster extends Document {
  societyId: mongoose.Types.ObjectId;

  /** Unset means the whole society. A wing-scoped row wins over this one. */
  blockId?: mongoose.Types.ObjectId;
  blockName?: string;

  /**
   * The person, as a login. This is what the gate actually notifies, so it is
   * required — a rota entry naming somebody who cannot be reached is the
   * silently-broken setting this model was built to remove.
   */
  userId: mongoose.Types.ObjectId;
  /** Denormalised so a roster screen and an audit line can name them without a join. */
  memberName: string;

  /**
   * Their committee seat, when they hold one. Optional on purpose: a society
   * may well put the manager or a former secretary on the rota, and refusing
   * that would push them back to "tell the whole committee".
   */
  committeeMemberId?: mongoose.Types.ObjectId;
  designationLabel?: string;

  weekday: DutyWeekday;
  shift: DutyShift;

  notes?: string;
  isActive: boolean;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const OpsDutyRosterSchema = new Schema<IOpsDutyRoster>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },

  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },
  blockName: { type: String, trim: true, maxlength: 80 },

  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  memberName: { type: String, required: true, trim: true, maxlength: 120 },

  committeeMemberId: { type: Schema.Types.ObjectId, ref: 'CommitteeMember' },
  designationLabel: { type: String, trim: true, maxlength: 80 },

  weekday: { type: Number, required: true, min: 0, max: 6 },
  shift: { type: String, enum: DUTY_SHIFTS, default: 'ALL_DAY' },

  notes: { type: String, trim: true, maxlength: 300 },
  isActive: { type: Boolean, default: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

/**
 * One PERSON per slot, not one person per society-weekday-shift.
 *
 * Two names on Tuesday night is a real arrangement — a pair on call, or a
 * handover week — and forbidding it would push societies back to naming nobody.
 * What must never happen is the same person listed twice on the same slot: the
 * roster would then notify them twice for one visitor, which is how people
 * learn to mute the app.
 *
 * Partial on `isActive` so a seat that was retired can be filled again by the
 * same person later; without that, taking somebody off Tuesdays would bar them
 * from Tuesdays for ever.
 */
OpsDutyRosterSchema.index(
  { societyId: 1, blockId: 1, weekday: 1, shift: 1, userId: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);
/** The read the gate makes on every visitor to an empty flat. */
OpsDutyRosterSchema.index({ societyId: 1, isActive: 1, weekday: 1 });

export const OpsDutyRoster = mongoose.model<IOpsDutyRoster>('OpsDutyRoster', OpsDutyRosterSchema);
export default OpsDutyRoster;
