import mongoose, { Schema, Document } from 'mongoose';

/**
 * What one person wants to be told about, and when.
 *
 * This model exists because `notification.model.ts` has claimed it since the
 * day it was written — "`kind` drives grouping and the resident's own mute
 * preferences", "HIGH rings through a muted preference" — and there was no
 * preference anywhere in the codebase to mute or to ring through. Every
 * resident got everything, at every hour, on every transport. The declared
 * feature was documentation for behaviour that did not exist, which is worse
 * than no feature: an admin reading the model believed residents could already
 * turn the gate chatter down.
 *
 * (The `quietHours` on `resident-gate-preference.model.ts` is a different
 * thing entirely — it softens the gate's *approval mode* for one flat. It has
 * never silenced a single notification.)
 *
 * Three separate controls, because they answer three separate questions and
 * collapsing them would force a resident to give up more than they wanted:
 *
 *   mutedKinds  — "I do not care about this topic at all."   (subject)
 *   channels    — "Do not use this transport for me."        (route)
 *   quietHours  — "Not at this hour."                        (time)
 *
 * A resident who wants their phone quiet at night should not have to stop
 * receiving gate notices altogether to get it.
 *
 * ONE RULE OVERRIDES ALL THREE: `priority: 'HIGH'`. Somebody is standing at
 * the gate waiting for an answer, or a security event is in progress. A
 * preference may make the product quieter; it may never make the resident
 * unreachable for the one message the whole system exists to carry. That
 * override is enforced in `notification.service`, not here — this model only
 * records the wish.
 */

export interface INotificationPreference extends Document {
  societyId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;

  /**
   * Kinds this person does not want at all — 'GATE_ENTRY', 'COMPLAINT_CLOSED'.
   *
   * A free list of strings rather than an enum for the same reason `kind`
   * itself is a string: new kinds arrive with every module, and a migration
   * per message type is a tax with no benefit. An unknown kind in this list is
   * harmless — it simply matches nothing.
   */
  mutedKinds: string[];

  /**
   * Transports this person will accept.
   *
   * `inApp: false` genuinely stops the row being written. That is deliberate
   * and slightly uncomfortable: the alternative — writing the record anyway
   * and calling the switch "in-app" — is exactly the dead-policy shape this
   * codebase keeps having to dig out (a switch the admin can flip that changes
   * nothing). If a person says they do not want a notification centre entry,
   * the honest implementation is not to make one. HIGH still writes, always.
   */
  channels: {
    inApp: boolean;
    push: boolean;
    email: boolean;
  };

  /**
   * Do not disturb. Minutes past midnight in `timezone`, NOT Date objects — a
   * quiet hour is a wall-clock fact and must not shift when the server moves,
   * when the process TZ is changed, or when a container boots in UTC.
   *
   * `fromMinute` greater than `toMinute` wraps midnight (22:00 → 07:00), which
   * is the normal case and the reason this cannot be a simple range check.
   *
   * Quiet hours HOLD rather than DROP. The record is written immediately (a
   * row in a list wakes nobody) and the noisy transports — push and email —
   * are deferred to the end of the window. Dropping would mean a resident who
   * sleeps eight hours never learns their bill was raised.
   */
  quietHours?: { fromMinute: number; toMinute: number };

  /**
   * IANA zone the quiet window is expressed in. Stored per person rather than
   * read from the process, because `process.env.TZ` is a deployment detail and
   * a resident's night is not.
   */
  timezone: string;

  createdBy?: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationPreferenceSchema = new Schema<INotificationPreference>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

  mutedKinds: { type: [String], default: [] },

  channels: {
    // All three default ON. A person who has never opened this screen must
    // keep receiving everything they received before it existed — a new
    // feature that silently switches somebody's notifications off is a support
    // call about a bill they never saw.
    inApp: { type: Boolean, default: true },
    push: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
  },

  quietHours: {
    type: new Schema({
      fromMinute: { type: Number, required: true, min: 0, max: 1439 },
      toMinute: { type: Number, required: true, min: 0, max: 1439 },
    }, { _id: false }),
    // Genuinely absent rather than a zero-zero range, so "has quiet hours" is
    // one truthy check and never a guess about whether 00:00–00:00 means
    // "always quiet" or "never quiet".
    default: undefined,
  },

  timezone: { type: String, default: 'Asia/Kolkata', trim: true, maxlength: 64 },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// One row per person per society. A managing-committee member who also owns a
// flat in a second society keeps two separate sets of wishes, which is what
// they would expect — the two societies are different amounts of noise.
NotificationPreferenceSchema.index({ societyId: 1, userId: 1 }, { unique: true });

export const NotificationPreference =
  mongoose.model<INotificationPreference>('NotificationPreference', NotificationPreferenceSchema);
export default NotificationPreference;
