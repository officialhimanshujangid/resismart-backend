import mongoose, { Schema, Document } from 'mongoose';

/**
 * Handing over the keys to a society.
 *
 * This exists because the incumbents genuinely do not have it. MyGate's answer
 * to "our secretary has moved out" is *create a new admin, then delete the old
 * one* — two separate destructive acts with nothing linking them, and no record
 * afterwards of who handed what to whom. A society that loses its admin's phone
 * mid-way through is left with two admins or none, and no way to tell which.
 *
 * So a transfer is a THING, with a lifecycle:
 *
 *   INITIATED → the outgoing admin has named a successor. Nothing has changed.
 *   ACCEPTED  → the successor proved they hold the contact and took the role.
 *   DECLINED / CANCELLED / EXPIRED → nothing happened, and it is on the record
 *               that nothing happened.
 *
 * The load-bearing rule is that **INITIATED changes nothing at all**. Until
 * somebody accepts, the outgoing admin is still the admin — because the most
 * likely failure is that the successor never responds, and a society locked out
 * by its own succession plan is far worse than a slow handover.
 */

export type TransferStatus = 'INITIATED' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';

/**
 * How the successor was chosen. Recorded because the three cases carry
 * genuinely different risk, and a committee reviewing history should not have
 * to infer which one happened.
 */
export type SuccessorKind =
  | 'EXISTING_MEMBER'   // already a resident here
  | 'COMMITTEE'         // a serving committee member
  | 'EXTERNAL';         // a paid manager, tied to no flat — ApnaComplex's shape

export interface IAdminTransfer extends Document {
  societyId: mongoose.Types.ObjectId;

  fromUserId: mongoose.Types.ObjectId;
  fromName: string;
  /**
   * What the outgoing admin becomes. Chosen explicitly at initiation and never
   * defaulted — an admin who silently vanishes from the society is how a
   * founding secretary loses access to their own flat's records.
   */
  fromBecomes: string;

  toUserId: mongoose.Types.ObjectId;
  toName: string;
  toContact: string;
  toChannel: 'EMAIL' | 'PHONE';
  successorKind: SuccessorKind;

  status: TransferStatus;
  reason?: string;

  /** An unanswered invitation must not stay live forever. */
  expiresAt: Date;
  acceptedAt?: Date;
  closedAt?: Date;
  closedReason?: string;

  /**
   * Break-glass: taking the role rather than being given it.
   *
   * Modelled on bye-law 139, which lets a Chairman use committee powers in an
   * emergency **provided the reason is recorded and the next meeting ratifies
   * it**. That is exactly the shape a break-glass needs, and it is legally
   * grounded rather than invented — so the software can be strict about it
   * without being arbitrary.
   */
  isBreakGlass: boolean;
  /** Committee members who signed off. Chairman plus two, checked in the service. */
  approvedByUserIds: mongoose.Types.ObjectId[];
  approvedByNames: string[];
  /** The displaced admin's window to object before it is settled. */
  objectionDeadline?: Date;
  objectedAt?: Date;
  objectionNote?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const AdminTransferSchema = new Schema<IAdminTransfer>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },

  fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  fromName: { type: String, required: true },
  fromBecomes: { type: String, required: true },

  toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  toName: { type: String, required: true },
  toContact: { type: String, required: true },
  toChannel: { type: String, enum: ['EMAIL', 'PHONE'], required: true },
  successorKind: { type: String, enum: ['EXISTING_MEMBER', 'COMMITTEE', 'EXTERNAL'], required: true },

  status: { type: String, enum: ['INITIATED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'], default: 'INITIATED' },
  reason: { type: String, trim: true, maxlength: 300 },

  expiresAt: { type: Date, required: true },
  acceptedAt: { type: Date },
  closedAt: { type: Date },
  closedReason: { type: String, trim: true, maxlength: 300 },

  isBreakGlass: { type: Boolean, default: false },
  approvedByUserIds: { type: [Schema.Types.ObjectId], default: [] },
  approvedByNames: { type: [String], default: [] },
  objectionDeadline: { type: Date },
  objectedAt: { type: Date },
  objectionNote: { type: String, trim: true, maxlength: 300 },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

/**
 * At most one live handover per society.
 *
 * Two competing transfers is not a race worth resolving cleverly — whichever
 * accepted last would win, and the other party would have no idea their
 * handover had been undone.
 */
AdminTransferSchema.index(
  { societyId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'INITIATED' } },
);
AdminTransferSchema.index({ societyId: 1, createdAt: -1 });
AdminTransferSchema.index({ status: 1, expiresAt: 1 });

export const AdminTransfer = mongoose.model<IAdminTransfer>('AdminTransfer', AdminTransferSchema);
export default AdminTransfer;
