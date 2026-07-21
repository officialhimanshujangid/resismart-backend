import mongoose, { Schema, Document } from 'mongoose';

/**
 * One thing a person needs to be told.
 *
 * The record is written FIRST and delivery is attempted afterwards. That order
 * is the whole design: push fails constantly — the phone is off, the browser
 * subscription expired, the token was silently revoked — and a system that
 * treats push as the message loses it. Here push is only a way of hurrying
 * somebody towards a record that already exists and will still be waiting in
 * the notification centre tomorrow.
 *
 * `kind` drives grouping and the resident's own mute preferences — see
 * `notification-preference.model.ts`, which is what actually holds those
 * preferences; `link` is where tapping it lands. Both are plain strings rather
 * than a closed enum because Phases 8-11 will add kinds, and a migration for
 * every new message type is a tax with no benefit — the sender decides, the
 * reader just displays.
 */
export type NotificationChannel = 'IN_APP' | 'PUSH' | 'EMAIL';

export interface INotification extends Document {
  societyId: mongoose.Types.ObjectId;
  /** Who this is for. One row per recipient — never a shared row with a read-by array. */
  userId: mongoose.Types.ObjectId;
  kind: string;
  title: string;
  body: string;
  /** In-app destination, e.g. /dashboard/complaints?id=... */
  link?: string;
  /** What this is about, so a screen can react without parsing the link. */
  entityType?: string;
  entityId?: mongoose.Types.ObjectId;
  /**
   * HIGH rings through a muted kind and through quiet hours — gate approvals
   * and security, not billing. Enforced in `notification.service.notify()`,
   * which is the only place the audience is resolved. Kept deliberately small:
   * three levels a human can reason about.
   */
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  readAt?: Date;
  /** Which transports actually accepted it. Written after the attempt, so it is a record, not an intention. */
  deliveredVia: NotificationChannel[];

  /**
   * The caller's name for the EVENT this row is about — 'complaint:<id>:closed',
   * 'pass:<id>:overuse'. When present, a second `notify()` carrying the same key
   * for the same person is silently discarded.
   *
   * The same marker-field precedent as `Asset.amcWarnedForExpiry` and
   * `VisitorEntry.overstayNotifiedAt`, moved one level down so every caller
   * inherits it instead of each sweep inventing its own flag. It prevents the
   * failure this codebase has had twice already: a retried request, a doubled
   * cron tick or two code paths reacting to one event, and the resident gets the
   * same sentence three times and stops reading any of them.
   *
   * Optional on purpose. A caller with no natural event identity (a broadcast
   * notice, a manual message) must still be able to send the same words twice.
   */
  dedupeKey?: string;

  /**
   * Set when the person's quiet hours were in force at write time. The record
   * exists immediately — a row in a list wakes nobody — but push and email are
   * deferred until this moment, when `releaseHeld()` delivers them.
   *
   * Cleared once released, so "is anything still waiting?" is one indexed
   * query rather than a scan with date arithmetic.
   */
  heldUntil?: Date;

  /**
   * Whether the caller asked for an email fallback, remembered across a hold.
   *
   * Without it, quiet hours would quietly DOWNGRADE a message rather than
   * delay it: the email is skipped at write time, and by the time the window
   * closes nothing left on the row says one was ever wanted. A resident with
   * no phone registered would sleep through their bill entirely, which is the
   * one thing "held, not dropped" was supposed to guarantee.
   */
  emailOnRelease?: boolean;

  /**
   * Push retry bookkeeping.
   *
   * Before these existed a failed push was simply gone: `pushToUsers` bumped a
   * `failureCount` on the DEVICE and the message itself was never tried again.
   * One flaky minute at the push service and the gate approval nobody answered
   * was never re-offered. `pushFailedAt` is the marker the sweep looks for, and
   * `pushAttempts` is what stops it looping forever against a device that is
   * genuinely unreachable.
   */
  pushAttempts: number;
  pushFailedAt?: Date;

  createdAt: Date;
}

const NotificationSchema = new Schema<INotification>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, required: true, trim: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, required: true, trim: true, maxlength: 1000 },
  link: { type: String, trim: true },
  entityType: { type: String, trim: true },
  entityId: { type: Schema.Types.ObjectId },
  priority: { type: String, enum: ['LOW', 'NORMAL', 'HIGH'], default: 'NORMAL' },
  readAt: { type: Date },
  deliveredVia: { type: [String], default: [] },
  dedupeKey: { type: String, trim: true, maxlength: 200 },
  heldUntil: { type: Date },
  emailOnRelease: { type: Boolean },
  pushAttempts: { type: Number, default: 0 },
  pushFailedAt: { type: Date },
}, { timestamps: { createdAt: true, updatedAt: false } });

// The two queries that exist: "my list, newest first" and "how many unread".
NotificationSchema.index({ societyId: 1, userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, readAt: 1 });

/**
 * The dedupe guarantee, in the database rather than in a service.
 *
 * `notify()` reads before it writes, but two processes reacting to the same
 * event will both read "nothing there" and both write. Only a unique index
 * settles that, and it must be PARTIAL — the overwhelming majority of rows
 * carry no dedupeKey at all, and a plain unique index would let exactly one of
 * them exist per person.
 */
NotificationSchema.index(
  { societyId: 1, userId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $exists: true } } },
);

// The two sweeps: "what is waiting for the quiet window to close" and "what
// push failed and is still worth another go".
NotificationSchema.index({ heldUntil: 1 }, { sparse: true });
NotificationSchema.index({ pushFailedAt: 1 }, { sparse: true });

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);
export default Notification;
