import mongoose, { Schema, Document } from 'mongoose';

export interface IGlobalSetting extends Document {
  gracePeriodDays: number; // extra days of full access after a paid plan ends, before falling back to free tier
  defaultTrialCapabilities: Map<string, any>; // the perpetual FREE-TIER limits (used when no valid paid plan)
  expiryReminderDays: number[]; // e.g. [3,2,1] => remind 3, 2 and 1 days before expiry
  razorpayWebhookSecret?: string;
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
    }
  },
  expiryReminderDays: {
    type: [Number],
    default: [3, 1],
  },
  razorpayWebhookSecret: {
    type: String,
  }
}, {
  timestamps: true,
});

// Create a singleton pattern essentially, we'll just fetch the first document
export const GlobalSetting = mongoose.model<IGlobalSetting>('GlobalSetting', GlobalSettingSchema);
export default GlobalSetting;
