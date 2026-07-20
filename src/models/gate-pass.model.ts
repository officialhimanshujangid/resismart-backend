import mongoose, { Schema, Document } from 'mongoose';

/**
 * An invitation, made before the visitor arrives.
 *
 * Two ways to present it, because a gate has to work for both a guest with a
 * smartphone and a grandmother with a feature phone:
 *
 *   - a **QR code**, signed so a guard's device can verify it with no network;
 *   - a **six-digit code**, typed in.
 *
 * Both burn the same pass. The pass is the fact; the QR and the code are two
 * doors into it, and a pass that could be used once by QR and once again by
 * code would be worse than having neither.
 *
 * The signature is Ed25519 and NOT an HMAC, deliberately. Offline verification
 * means the guard's device holds the verifying key — with an HMAC that same key
 * signs, so any guard phone could mint passes for the whole society. A public
 * key can only check.
 */

export type GatePassStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'REVOKED';

export interface IGatePass extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;
  flatLabel?: string;
  blockId?: mongoose.Types.ObjectId;

  visitorName: string;
  visitorPhone?: string;
  category: string;
  purpose?: string;

  /** Six digits. Unique among ACTIVE passes in a society — see the partial index. */
  code: string;
  /** The signed blob a QR encodes. Stored so a revoked pass can still be recognised on sync. */
  qrPayload: string;

  validFrom: Date;
  validTo: Date;

  /**
   * How many people the pass covers. A family of five arriving in one car is
   * one invitation, not five — and a guard forced to make five passes will
   * make one and wave the rest through.
   */
  maxUses: number;
  usedCount: number;

  status: GatePassStatus;
  usedAt?: Date;
  usedEntryIds: mongoose.Types.ObjectId[];

  revokedAt?: Date;
  revokedReason?: string;

  /**
   * Set when a pass was accepted more than it should have been — almost always
   * because two guard devices were offline at once.
   *
   * Recorded and shown, NOT blocked. The visitor is already inside by the time
   * the sync happens; pretending otherwise would only mean the second entry
   * never gets recorded at all, which is strictly worse for the register.
   */
  overUsedAt?: Date;
  overUseNote?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const GatePassSchema = new Schema<IGatePass>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  flatLabel: { type: String, trim: true },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },

  visitorName: { type: String, required: true, trim: true, maxlength: 120 },
  visitorPhone: { type: String, trim: true, maxlength: 20 },
  category: { type: String, required: true },
  purpose: { type: String, trim: true, maxlength: 200 },

  code: { type: String, required: true },
  qrPayload: { type: String, required: true },

  validFrom: { type: Date, required: true },
  validTo: { type: Date, required: true },

  maxUses: { type: Number, default: 1, min: 1, max: 20 },
  usedCount: { type: Number, default: 0 },

  status: { type: String, enum: ['ACTIVE', 'USED', 'EXPIRED', 'REVOKED'], default: 'ACTIVE' },
  usedAt: { type: Date },
  usedEntryIds: { type: [Schema.Types.ObjectId], default: [] },

  revokedAt: { type: Date },
  revokedReason: { type: String, trim: true, maxlength: 200 },
  overUsedAt: { type: Date },
  overUseNote: { type: String, trim: true, maxlength: 200 },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

/**
 * Six digits are only 900,000 possibilities, so they are reused over time — a
 * society running for years would otherwise exhaust them. The uniqueness that
 * matters is among passes that can still be USED, which is what this partial
 * index enforces: two ACTIVE passes may never share a code, but yesterday's
 * spent 481920 can be issued again tomorrow.
 */
GatePassSchema.index(
  { societyId: 1, code: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);
GatePassSchema.index({ societyId: 1, flatId: 1, createdAt: -1 });
GatePassSchema.index({ status: 1, validTo: 1 });

export const GatePass = mongoose.model<IGatePass>('GatePass', GatePassSchema);
export default GatePass;
