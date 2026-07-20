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
 * `kind` drives grouping and the resident's own mute preferences; `link` is
 * where tapping it lands. Both are plain strings rather than a closed enum
 * because Phases 8-11 will add kinds, and a migration for every new message
 * type is a tax with no benefit — the sender decides, the reader just displays.
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
   * HIGH rings through a muted preference — gate approvals and security, not
   * billing. Kept deliberately small: three levels a human can reason about.
   */
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  readAt?: Date;
  /** Which transports actually accepted it. Written after the attempt, so it is a record, not an intention. */
  deliveredVia: NotificationChannel[];
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
}, { timestamps: { createdAt: true, updatedAt: false } });

// The two queries that exist: "my list, newest first" and "how many unread".
NotificationSchema.index({ societyId: 1, userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, readAt: 1 });

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);
export default Notification;
