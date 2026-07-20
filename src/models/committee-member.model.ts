import mongoose, { Schema, Document } from 'mongoose';

export type CommitteeMemberStatus = 'ACTIVE' | 'INACTIVE';
export type Appointment = 'ELECTED' | 'CO_OPTED' | 'APPOINTED';

/**
 * A person holding an office/seat within a committee term. Members can be added, changed,
 * or ended mid-term (resignation, co-option, removal) — status flips to INACTIVE with an
 * endDate rather than being deleted, preserving history. An ACTIVE member holds the
 * SOCIETY_COMMITTEE role (granted/reconciled by committee.service).
 */
export interface ICommitteeMember extends Document {
  committeeId: mongoose.Types.ObjectId;
  societyId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  residentId?: mongoose.Types.ObjectId;
  memberSnapshot: { name: string; flatLabel?: string };
  designationKey: string;
  designationLabel: string;
  isOfficeBearer: boolean;
  /**
   * What this member can actually see and do. Separate from the designation:
   * the designation is what the bye-laws call them, this is what the software
   * lets them touch, and a society may well want two Treasurers with different
   * access. Unset means the society has not decided — read-only until it does.
   */
  accessRoleId?: mongoose.Types.ObjectId;
  appointment: Appointment;
  startDate: Date;
  endDate?: Date | null;
  status: CommitteeMemberStatus;
  notes?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const CommitteeMemberSchema = new Schema<ICommitteeMember>({
  committeeId: { type: Schema.Types.ObjectId, ref: 'Committee', required: true },
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  residentId: { type: Schema.Types.ObjectId, ref: 'Resident' },
  memberSnapshot: {
    name: { type: String, required: true, trim: true },
    flatLabel: { type: String, trim: true },
  },
  designationKey: { type: String, required: true, trim: true },
  designationLabel: { type: String, required: true, trim: true },
  isOfficeBearer: { type: Boolean, default: false },
  accessRoleId: { type: Schema.Types.ObjectId, ref: 'AccessRole' },
  appointment: { type: String, enum: ['ELECTED', 'CO_OPTED', 'APPOINTED'], default: 'ELECTED' },
  startDate: { type: Date, required: true },
  endDate: { type: Date, default: null },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  notes: { type: String, trim: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

CommitteeMemberSchema.index({ committeeId: 1, status: 1 });
CommitteeMemberSchema.index({ societyId: 1, status: 1 });
CommitteeMemberSchema.index({ userId: 1 });

export const CommitteeMember = mongoose.model<ICommitteeMember>('CommitteeMember', CommitteeMemberSchema);
export default CommitteeMember;
