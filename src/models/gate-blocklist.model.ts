import mongoose, { Schema, Document } from 'mongoose';

/**
 * People the society has decided not to let in.
 *
 * **This is the feature MyGate could not ship, and their reason was correct.**
 * Their own FAQ says guard-entered visitor data is *"inaccurate or
 * manipulated"*, which makes a blocklist built on it *"technically
 * unfeasible"*. A list keyed on a hand-typed name is not a blocklist — it is a
 * way to turn away the wrong Ramesh.
 *
 * So the rule here is that **an entry can only be blocked on something that
 * was actually verified**, and the model refuses to store anything else:
 *
 *   - `phone` — verified because a pass was sent to it and redeemed, or an OTP
 *     was confirmed;
 *   - `passUserId` — the resident account that invited them;
 *   - `vehicleNumber` — a plate, which the guard reads off metal rather than
 *     being told.
 *
 * A name is stored ONLY as a label for humans reading the list, and is never
 * matched on. That single decision is what separates this from the feature
 * everybody else abandoned.
 */

export type BlockBasis = 'PHONE' | 'VEHICLE' | 'PASS_ISSUER';

export interface IGateBlocklist extends Document {
  societyId: mongoose.Types.ObjectId;

  basis: BlockBasis;
  /** Normalised: last 10 digits for a phone, stripped and upper-cased for a plate. */
  value: string;

  /** For humans reading the list. NEVER matched on. */
  label?: string;
  reason: string;

  /**
   * Who decided. A blocklist is a serious act against a named person, and one
   * guard having a bad evening is not a society decision — enforced in the
   * service, recorded here.
   */
  approvedByUserIds: mongoose.Types.ObjectId[];
  approvedByNames: string[];

  /** The entry or complaint that prompted it, so the list can be audited later. */
  sourceEntryId?: mongoose.Types.ObjectId;

  isActive: boolean;
  liftedAt?: Date;
  liftedReason?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const GateBlocklistSchema = new Schema<IGateBlocklist>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },

  basis: { type: String, enum: ['PHONE', 'VEHICLE', 'PASS_ISSUER'], required: true },
  value: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },

  label: { type: String, trim: true, maxlength: 120 },
  reason: { type: String, required: true, trim: true, maxlength: 300 },

  approvedByUserIds: { type: [Schema.Types.ObjectId], default: [] },
  approvedByNames: { type: [String], default: [] },
  sourceEntryId: { type: Schema.Types.ObjectId, ref: 'VisitorEntry' },

  isActive: { type: Boolean, default: true },
  liftedAt: { type: Date },
  liftedReason: { type: String, trim: true, maxlength: 300 },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

GateBlocklistSchema.index(
  { societyId: 1, basis: 1, value: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

export const GateBlocklist = mongoose.model<IGateBlocklist>('GateBlocklist', GateBlocklistSchema);
export default GateBlocklist;
