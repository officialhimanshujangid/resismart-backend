import mongoose, { Schema, Document } from 'mongoose';

export interface IGlobalSetting extends Document {
  gracePeriodDays: number; // extra days of full access after a paid plan ends, before falling back to free tier
  defaultTrialCapabilities: Map<string, any>; // the perpetual FREE-TIER limits (used when no valid paid plan)
  expiryReminderDays: number[]; // e.g. [3,2,1] => remind 3, 2 and 1 days before expiry
  razorpayWebhookSecret?: string;
  /**
   * Web-push signing keys, generated once on first use when the environment
   * does not pin them. They live here rather than in memory because a
   * regenerated pair invalidates every browser subscription ever handed out —
   * a restart would silently stop notifications for everyone, and nothing
   * would look broken.
   */
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  /**
   * Ed25519, for signing gate passes. Same generate-once-and-keep reasoning as
   * VAPID above, with a sharper consequence: regenerating would invalidate
   * every pass already sitting in somebody's WhatsApp.
   *
   * PEM-encoded. The PUBLIC half is handed to guard devices so they can verify
   * a QR with no network; the private half never leaves the server.
   *
   * **Set PASS_SIGNING_PRIVATE_KEY in the environment for any real install.**
   * Stored here the private half sits in plaintext in one document shared by
   * every society, and the society is a claim inside the signed blob rather
   * than a property of the key — so one leaked row mints passes for every flat
   * on the platform.
   */
  passSigningPublicKey?: string;
  passSigningPrivateKey?: string;
  /**
   * The key that was just retired, and the moment it was.
   *
   * Rotation without these would be a silent outage: every pass already sitting
   * in a guest's WhatsApp was signed by the old key, and every guard device is
   * carrying a CACHED copy of the old public key for exactly the hours it has
   * no network. Signing moves to the new pair immediately; verification accepts
   * BOTH until `passSigningRotatedAt` is older than the maximum offline window.
   * Nothing may delete the old pair before then.
   */
  passSigningPreviousPublicKey?: string;
  passSigningPreviousPrivateKey?: string;
  passSigningRotatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const GlobalSettingSchema = new Schema({
  gracePeriodDays: {
    type: Number,
    required: true,
    default: 7,
  },
  defaultTrialCapabilities: {
    type: Map,
    of: Schema.Types.Mixed,
    default: {
      max_staff_count: 5,
      max_flat_count: 50,
      max_member_count: 100,
      max_visitor_count: 500,
      max_tickets_count: 100,
      max_service_count: 10,
      max_active_listings: 5,
    }
  },
  expiryReminderDays: {
    type: [Number],
    default: [3, 1],
  },
  razorpayWebhookSecret: {
    type: String,
  },
  vapidPublicKey: {
    type: String,
  },
  vapidPrivateKey: {
    type: String,
  },
  passSigningPublicKey: {
    type: String,
  },
  passSigningPrivateKey: {
    type: String,
  },
  passSigningPreviousPublicKey: {
    type: String,
  },
  passSigningPreviousPrivateKey: {
    type: String,
  },
  passSigningRotatedAt: {
    type: Date,
  }
}, {
  timestamps: true,
});

// Create a singleton pattern essentially, we'll just fetch the first document
export const GlobalSetting = mongoose.model<IGlobalSetting>('GlobalSetting', GlobalSettingSchema);
export default GlobalSetting;
