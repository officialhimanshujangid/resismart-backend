import mongoose, { Schema, Document } from 'mongoose';

/**
 * What one resident wants their gate to do.
 *
 * This exists because the society-wide policy is the wrong grain for half the
 * real decisions. One flat orders food four times a week and wants deliveries
 * waved through; the flat above works nights and wants nothing after ten. A
 * single society-level rule forces both of them to live with the other's
 * choice, and the one who loses starts ignoring every notification — which
 * costs the society the one message that mattered.
 *
 * **These preferences can only ever RELAX toward less interruption, never
 * expand authority.** A resident may say "stop asking me about deliveries";
 * they may not say "let anyone in without asking" when the society requires
 * approval. `effectivePolicy` in ops-policy.service is where that ceiling is
 * enforced, and it is the only place these are read.
 */

export interface IResidentGatePreference extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;

  /**
   * Per category: leave it at the gate, or stop asking and just tell me.
   *
   * Only ever a step DOWN from the society rule. Absent means "whatever the
   * society says", which is different from an explicit choice — hence a Map
   * with no default rather than a filled-in object.
   */
  categoryMode: Map<string, 'ASK' | 'NOTIFY_ONLY' | 'LEAVE_AT_GATE'>;

  /**
   * Do not wake me. Stored as minutes past midnight in society-local time,
   * NOT as Date objects — a quiet hour is a wall-clock fact and must not shift
   * when the server's timezone or the clock changes.
   *
   * `from` greater than `to` means it wraps midnight (22:00 → 07:00), which is
   * the normal case and the reason this is not a simple range comparison.
   */
  quietHours?: { fromMinute: number; toMinute: number };

  /**
   * People this flat expects. A name+phone match skips the asking entirely and
   * notifies instead — the maid, the milkman, the physiotherapist on Tuesdays.
   */
  expectedVisitors: {
    name: string;
    phone?: string;
    note?: string;
    addedAt: Date;
  }[];

  createdBy?: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ResidentGatePreferenceSchema = new Schema<IResidentGatePreference>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

  categoryMode: {
    type: Map,
    of: { type: String, enum: ['ASK', 'NOTIFY_ONLY', 'LEAVE_AT_GATE'] },
    default: undefined,
  },
  quietHours: {
    type: new Schema({
      fromMinute: { type: Number, required: true, min: 0, max: 1439 },
      toMinute: { type: Number, required: true, min: 0, max: 1439 },
    }, { _id: false }),
    default: undefined,
  },
  expectedVisitors: {
    type: [new Schema({
      name: { type: String, required: true, trim: true, maxlength: 120 },
      phone: { type: String, trim: true, maxlength: 20 },
      note: { type: String, trim: true, maxlength: 200 },
      addedAt: { type: Date, default: Date.now },
    }, { _id: false })],
    default: [],
  },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// One row per person per flat: a resident who owns two flats keeps separate
// preferences for each, which is what they would expect.
ResidentGatePreferenceSchema.index({ societyId: 1, flatId: 1, userId: 1 }, { unique: true });

export const ResidentGatePreference =
  mongoose.model<IResidentGatePreference>('ResidentGatePreference', ResidentGatePreferenceSchema);
export default ResidentGatePreference;
