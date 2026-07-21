import mongoose, { Schema, Document } from 'mongoose';

/**
 * A physical gate — the door in the wall, not the software.
 *
 * This entity was missing entirely, and its absence made a whole class of
 * question unanswerable. A large society has two, three, four gates; the
 * register could not say which one a visitor came through, could not tell "came
 * in the main gate, left by the service gate" from "came and went by the same
 * one", and could not bind an offline scanner to the door it stands at. Every
 * competitor that takes gates seriously models this; ours pretended there was
 * one implicit gate forever.
 *
 * `kind` matters because gates are not interchangeable: a pedestrian wicket
 * takes no vehicles, a service gate is where deliveries and staff enter, and a
 * society may want approval on the main gate but a plain register at the
 * service one. It is a hint the console uses, not a hard rule.
 */

export const GATE_KINDS = ['MAIN', 'PEDESTRIAN', 'VEHICLE', 'SERVICE'] as const;
export type GateKind = typeof GATE_KINDS[number];

export interface IGate extends Document {
  societyId: mongoose.Types.ObjectId;
  /** Short human code a guard says out loud — "Gate 2", "Service". */
  code: string;
  name: string;
  kind: GateKind;

  /**
   * Which of entry / exit this gate handles. A one-way service gate that only
   * ever lets vehicles out should not offer an entry button. Both true is the
   * ordinary case.
   */
  handlesEntry: boolean;
  handlesExit: boolean;

  /**
   * The wing this gate belongs to, when a society scopes gates to blocks. Left
   * unset for a society-wide main gate. Not an access boundary — just a label
   * for reports and for defaulting the console.
   */
  blockId?: mongoose.Types.ObjectId;
  blockName?: string;

  isActive: boolean;
  notes?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const GateSchema = new Schema<IGate>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  code: { type: String, required: true, trim: true, maxlength: 20 },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  kind: { type: String, enum: GATE_KINDS, default: 'MAIN' },

  handlesEntry: { type: Boolean, default: true },
  handlesExit: { type: Boolean, default: true },

  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },
  blockName: { type: String, trim: true },

  isActive: { type: Boolean, default: true },
  notes: { type: String, trim: true, maxlength: 300 },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

// Codes are unique among ACTIVE gates — a retired "Gate 2" can be reused.
GateSchema.index({ societyId: 1, code: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
GateSchema.index({ societyId: 1, isActive: 1 });

export const Gate = mongoose.model<IGate>('Gate', GateSchema);
export default Gate;
