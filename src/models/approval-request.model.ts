import mongoose, { Schema, Document } from 'mongoose';
import { HostKind } from './visitor-entry.model';

/**
 * "There is someone at the gate for you."
 *
 * Separate from `VisitorEntry` on purpose. The entry is a fact — this person
 * came in at 6:42pm. The request is a decision, and decisions have a shape the
 * fact does not: who was asked, who answered first, who was too late, whether
 * the guard overrode it and why. Folding them together would either bloat
 * every register row or lose the trail the moment a resident says "I never
 * approved that".
 *
 * The request is created BEFORE the entry, and the entry is only written once
 * a decision exists. That ordering is what makes "was this person actually let
 * in, and on whose word?" answerable.
 */

export type ApprovalOutcome =
  | 'PENDING'
  | 'APPROVED'
  | 'DENIED'
  | 'LEFT_AT_GATE'      // the delivery was accepted, the person did not come in
  | 'TIMED_OUT'         // nobody answered, and the policy said HOLD
  | 'GUARD_OVERRIDE'    // the guard decided, with a reason on the record
  | 'AUTO_DENIED'
  | 'CANCELLED';        // the visitor left before anyone answered

export type ApprovalDecidedBy = 'RESIDENT' | 'GUARD' | 'SYSTEM';

export interface IApprovalRequest extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId?: mongoose.Types.ObjectId;
  flatLabel?: string;
  blockId?: mongoose.Types.ObjectId;

  /**
   * Who the visit is FOR — the same polymorphic host the entry carries.
   *
   * Mirrored here rather than read through `visitorEntryId` because the request
   * is created BEFORE the entry, and the notification that asks somebody to
   * allow a visitor has to be able to name the host at that moment. See
   * `HostKind` in visitor-entry.model for why a flat id was never enough.
   */
  hostKind: HostKind;
  hostUserId?: mongoose.Types.ObjectId;
  hostStaffId?: mongoose.Types.ObjectId;
  hostLabel: string;

  visitorName: string;
  visitorPhone?: string;
  category: string;
  photoKey?: string;
  vehicleNumber?: string;
  notes?: string;

  /**
   * Everybody who was asked, captured at the moment of asking.
   *
   * A snapshot, not a live lookup: a tenancy that ends next week must not
   * rewrite who was asked last Tuesday. This is the field that answers "why
   * was I not asked?" months later.
   */
  askedUserIds: mongoose.Types.ObjectId[];
  /** Why those people and not others — RENTED_TENANT_ONLY, OWNER_OCCUPIED, VACANT_COMMITTEE, NOBODY_REACHABLE. */
  askedVia: string;

  outcome: ApprovalOutcome;
  decidedBy?: ApprovalDecidedBy;
  decidedByUserId?: mongoose.Types.ObjectId;
  decidedByName?: string;
  decidedAt?: Date;
  /** Required for a guard override, by rule rather than by hope — enforced in the service. */
  reason?: string;

  /** When the request stops waiting. Read by the sweep that applies onTimeout. */
  expiresAt: Date;
  /** What to do when it expires, copied from policy at creation so a later policy edit cannot rewrite history. */
  onTimeout: string;

  /** The entry this produced, when it produced one. */
  visitorEntryId?: mongoose.Types.ObjectId;

  guardName: string;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ApprovalRequestSchema = new Schema<IApprovalRequest>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat' },
  flatLabel: { type: String, trim: true },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },

  hostKind: { type: String, enum: ['FLAT', 'COMMITTEE', 'OFFICE', 'STAFF'], default: 'FLAT' },
  hostUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  hostStaffId: { type: Schema.Types.ObjectId, ref: 'SocietyStaff' },
  hostLabel: { type: String, trim: true, maxlength: 160, default: '' },

  visitorName: { type: String, required: true, trim: true, maxlength: 120 },
  visitorPhone: { type: String, trim: true, maxlength: 20 },
  category: { type: String, required: true },
  photoKey: { type: String, trim: true },
  vehicleNumber: { type: String, trim: true, uppercase: true, maxlength: 20 },
  notes: { type: String, trim: true, maxlength: 500 },

  askedUserIds: { type: [Schema.Types.ObjectId], default: [] },
  askedVia: { type: String, required: true },

  outcome: { type: String, default: 'PENDING' },
  decidedBy: { type: String, enum: ['RESIDENT', 'GUARD', 'SYSTEM'] },
  decidedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  decidedByName: { type: String, trim: true },
  decidedAt: { type: Date },
  reason: { type: String, trim: true, maxlength: 300 },

  expiresAt: { type: Date, required: true },
  onTimeout: { type: String, required: true },

  visitorEntryId: { type: Schema.Types.ObjectId, ref: 'VisitorEntry' },

  guardName: { type: String, required: true, trim: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

// Same guarantee as the entry: a request can always name who it is about, so
// no notification body ever has to fall back to "somebody is at the gate".
ApprovalRequestSchema.pre('validate', function (next) {
  if (!this.hostLabel) this.hostLabel = this.flatLabel || 'The society';
  next();
});

// The guard's live list, and the sweep that retires stale ones.
ApprovalRequestSchema.index({ societyId: 1, outcome: 1, createdAt: -1 });
ApprovalRequestSchema.index({ outcome: 1, expiresAt: 1 });
// "What was I asked?" — a resident's own pending list.
ApprovalRequestSchema.index({ societyId: 1, askedUserIds: 1, outcome: 1 });

export const ApprovalRequest = mongoose.model<IApprovalRequest>('ApprovalRequest', ApprovalRequestSchema);
export default ApprovalRequest;
