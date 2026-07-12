import mongoose, { Schema, Document } from 'mongoose';

export type OtpChannel = 'PHONE' | 'EMAIL';
export type OtpPurpose = 'SOCIETY_REGISTRATION' | 'SHOP_REGISTRATION' | 'FLAT_REGISTRATION' | 'LOGIN' | 'GENERIC';

export interface IOtp extends Document {
  channel: OtpChannel;
  target: string;          // normalized phone (E.164-ish) or lowercased email
  purpose: OtpPurpose;
  codeHash: string;        // sha256 of the 6-digit code — never store plaintext
  expiresAt: Date;         // TTL: extended to the verify-token window once verified
  attempts: number;        // wrong-code attempts, capped
  verified: boolean;
  lastSentAt: Date;        // for send cooldown
  sendCount: number;       // sends within the current rolling window (abuse cap)
  windowStart: Date;       // start of the current send-count window
  createdAt: Date;
  updatedAt: Date;
}

const OtpSchema = new Schema<IOtp>({
  channel: { type: String, enum: ['PHONE', 'EMAIL'], required: true },
  target: { type: String, required: true, trim: true },
  purpose: {
    type: String,
    enum: ['SOCIETY_REGISTRATION', 'SHOP_REGISTRATION', 'FLAT_REGISTRATION', 'LOGIN', 'GENERIC'],
    required: true,
  },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  verified: { type: Boolean, default: false },
  lastSentAt: { type: Date },
  sendCount: { type: Number, default: 0 },
  windowStart: { type: Date },
}, { timestamps: true });

// One active OTP per (channel, target, purpose) — request upserts/replaces it.
OtpSchema.index({ channel: 1, target: 1, purpose: 1 }, { unique: true });
// TTL: Mongo purges the doc shortly after it expires.
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Otp = mongoose.model<IOtp>('Otp', OtpSchema);
export default Otp;
