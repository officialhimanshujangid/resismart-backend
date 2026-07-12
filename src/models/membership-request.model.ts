import mongoose, { Schema, Document } from 'mongoose';
import { UserRole } from '../constants/roles';

export type MembershipRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';
export type ApprovalSide = 'SOCIETY' | 'FLAT_OWNER' | 'INVITED_USER';
export type InitiatorSide = 'SOCIETY' | 'FLAT_OWNER' | 'TENANT_HEAD';

/**
 * A pending request to register a person into a flat. Kept SEPARATE from the Resident
 * collection so a request creates NO live membership/context until approved (Resident rows
 * are the source of truth read by resolveUserContexts). Two-way approval:
 *   - society-initiated  → the flat owner approves (or auto when the flat has no owner yet)
 *   - flat-owner-initiated → the society admin approves
 *   - household add by the flat head → auto-approved (society notified)
 * On approval the request materializes into User membership(s) + Resident row(s).
 */
export interface IMembershipRequest extends Document {
  flatId: mongoose.Types.ObjectId;
  societyId: mongoose.Types.ObjectId;

  // The person being registered (identity resolved/created at approval time).
  targetName: string;
  targetEmail?: string;
  targetPhone?: string;
  relationship: string; // OWNER | SPOUSE | CHILD | PARENT | TENANT | OTHER
  requestedRole: UserRole; // derived: RESIDENT_OWNER | RESIDENT_TENANT | FAMILY_MEMBER

  initiatedBy: { userId: mongoose.Types.ObjectId; name: string; side: InitiatorSide };
  approver: { side: ApprovalSide; userId?: mongoose.Types.ObjectId };

  status: MembershipRequestStatus;
  decisionByUserId?: mongoose.Types.ObjectId;
  decisionByName?: string;
  decisionAt?: Date;
  rejectionReason?: string;

  // Set in Phase 2 when a request is part of a rent/sale transition.
  tenureId?: mongoose.Types.ObjectId;

  expiresAt: Date;

  // Audit columns
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const MembershipRequestSchema = new Schema<IMembershipRequest>({
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },

  targetName: { type: String, required: true, trim: true },
  targetEmail: { type: String, lowercase: true, trim: true },
  targetPhone: { type: String, trim: true },
  relationship: { type: String, enum: ['OWNER', 'SPOUSE', 'CHILD', 'PARENT', 'TENANT', 'OTHER'], required: true },
  requestedRole: { type: String, enum: Object.values(UserRole), required: true },

  initiatedBy: {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    side: { type: String, enum: ['SOCIETY', 'FLAT_OWNER', 'TENANT_HEAD'], required: true },
  },
  approver: {
    side: { type: String, enum: ['SOCIETY', 'FLAT_OWNER', 'INVITED_USER'], required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
  },

  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'], default: 'PENDING' },
  decisionByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  decisionByName: { type: String },
  decisionAt: { type: Date },
  rejectionReason: { type: String, trim: true },

  tenureId: { type: Schema.Types.ObjectId, ref: 'FlatTenure' },

  expiresAt: { type: Date, required: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, {
  timestamps: true,
});

MembershipRequestSchema.index({ societyId: 1, status: 1 });
MembershipRequestSchema.index({ flatId: 1, status: 1 });
MembershipRequestSchema.index({ 'approver.userId': 1, status: 1 });
MembershipRequestSchema.index({ 'initiatedBy.userId': 1, status: 1 });
MembershipRequestSchema.index({ targetEmail: 1 });
// Prevent duplicate OPEN requests for the same person in the same flat (partial unique on PENDING).
MembershipRequestSchema.index(
  { flatId: 1, targetEmail: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING', targetEmail: { $type: 'string' } } }
);

export const MembershipRequest = mongoose.model<IMembershipRequest>('MembershipRequest', MembershipRequestSchema);
export default MembershipRequest;
