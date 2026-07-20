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
   */
  passSigningPublicKey?: string;
  passSigningPrivateKey?: string;
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
  }
}, {
  timestamps: true,
});

// Create a singleton pattern essentially, we'll just fetch the first document
export const GlobalSetting = mongoose.model<IGlobalSetting>('GlobalSetting', GlobalSettingSchema);
export default GlobalSetting;
