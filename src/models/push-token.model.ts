import mongoose, { Schema, Document } from 'mongoose';

/**
 * One device that has agreed to receive notifications.
 *
 * Deliberately per-device and not per-user: a committee member reads on their
 * phone and signs orders on a laptop, and a message that only reached one of
 * them is the message they missed. A user therefore owns as many rows as they
 * have devices, and every one of them is sent to.
 *
 * Two transports live in the same collection because the routing decision is
 * the same question — "where does this person read things?" — and splitting it
 * would mean two lookups and two chances for them to disagree:
 *
 *   WEB     — a browser push subscription (endpoint + p256dh + auth), VAPID
 *   ANDROID / IOS — an FCM registration token from the mobile app
 *
 * `token` is the natural key for both: for FCM it is the registration token,
 * for web it is the subscription endpoint (which is unique per browser
 * install). Unique on (token) alone, NOT on (societyId, token) — one physical
 * device belongs to one person at a time, and letting the same browser be
 * registered under two societies is how you leak a notification across them.
 */
export type PushPlatform = 'WEB' | 'ANDROID' | 'IOS';

export interface IPushToken extends Document {
  societyId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  platform: PushPlatform;
  /** FCM registration token, or the web-push endpoint URL. */
  token: string;
  /** Web push only — the browser's encryption keys. */
  keys?: { p256dh: string; auth: string };
  /** Free text from the browser/app, purely so a user can recognise a device. */
  deviceLabel?: string;
  /** Bumped on every successful send and every re-registration. */
  lastSeenAt: Date;
  /** Consecutive failures. Reset to 0 on success; pruned when the push service says the device is gone. */
  failureCount: number;
  createdBy?: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PushTokenSchema = new Schema<IPushToken>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  platform: { type: String, enum: ['WEB', 'ANDROID', 'IOS'], required: true },
  token: { type: String, required: true },
  keys: {
    type: new Schema({
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    }, { _id: false }),
    // Kept genuinely absent for FCM rows rather than an empty object, so
    // "is this a web subscription?" is one truthy check and never a guess.
    default: undefined,
  },
  deviceLabel: { type: String, trim: true, maxlength: 120 },
  lastSeenAt: { type: Date, default: Date.now },
  failureCount: { type: Number, default: 0 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

PushTokenSchema.index({ token: 1 }, { unique: true });
PushTokenSchema.index({ societyId: 1, userId: 1 });

export const PushToken = mongoose.model<IPushToken>('PushToken', PushTokenSchema);
export default PushToken;
