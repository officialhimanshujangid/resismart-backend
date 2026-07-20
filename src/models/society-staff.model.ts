import mongoose, { Schema, Document } from 'mongoose';

/**
 * Somebody the SOCIETY employs — a guard, a gardener, a manager.
 *
 * Deliberately not the same thing as household staff. A resident's cook or
 * driver is a `Resident` with relationship STAFF: the society does not pay
 * them, does not employ them, and carries no liability for them. Collapsing the
 * two would put a resident's maid on the society's books.
 *
 * Note what this model does NOT carry: salary, PF, ESIC, UAN, or anything else
 * payroll-shaped. We do not compute anyone's wages, and a field we never fill
 * is worse than no field — it looks like an answer.
 */

export type StaffDesignation =
  | 'SECURITY_GUARD' | 'HEAD_GUARD' | 'GARDENER' | 'HOUSEKEEPING'
  | 'PLUMBER' | 'ELECTRICIAN' | 'LIFT_OPERATOR' | 'PUMP_OPERATOR'
  | 'MANAGER' | 'ACCOUNTANT' | 'CLERK' | 'OTHER';

export const STAFF_DESIGNATIONS: StaffDesignation[] = [
  'SECURITY_GUARD', 'HEAD_GUARD', 'GARDENER', 'HOUSEKEEPING',
  'PLUMBER', 'ELECTRICIAN', 'LIFT_OPERATOR', 'PUMP_OPERATOR',
  'MANAGER', 'ACCOUNTANT', 'CLERK', 'OTHER',
];

/**
 * DIRECT   — the society employs them and pays them itself.
 * AGENCY   — supplied by a contractor, who bills the society. Most guards.
 * CONTRACT — engaged for a job, not a post. The plumber who comes when called.
 *
 * All three are paid through the existing Expense module. The distinction is
 * recorded because it changes who is answerable for them, not because it
 * changes any calculation here.
 */
export type EmploymentType = 'DIRECT' | 'AGENCY' | 'CONTRACT';

export interface IStaffDocument {
  name: string;
  key: string;
  uploadedAt: Date;
  uploadedByName: string;
}

export interface ISocietyStaff extends Document {
  societyId: mongoose.Types.ObjectId;
  staffCode: string;

  person: { name: string; phone: string; email?: string; photoKey?: string };
  designation: StaffDesignation;
  employmentType: EmploymentType;
  /** Which agency supplies them, when AGENCY. */
  vendorId?: mongoose.Types.ObjectId;
  vendorName?: string;

  /**
   * Optional on purpose. A sweeper does not need a login; a manager does. Same
   * reasoning as `Resident.userId` — being in the records and being able to
   * sign in are two different questions.
   */
  userId?: mongoose.Types.ObjectId;
  accessRoleId?: mongoose.Types.ObjectId;

  joinedOn: Date;
  leftOn?: Date | null;
  isActive: boolean;

  /**
   * Police verification. `expiresOn` drives a reminder — a verification that
   * lapsed two years ago reads exactly like one that never happened, and no
   * competitor tracks the expiry at all.
   *
   * There is no Aadhaar field, here or anywhere. A private body cannot lawfully
   * demand it, and UIDAI treats storing a copy as an offence in itself.
   */
  verification: {
    policeVerifiedOn?: Date;
    verifiedBy?: string;
    documentKey?: string;
    expiresOn?: Date;
  };

  emergencyContact?: { name: string; phone: string; relation?: string };
  documents: IStaffDocument[];
  notes?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

// Same stored shape as flat and resident documents. One upload route, one
// presigned-download habit, nothing new to learn or to get wrong.
const StaffDocumentSchema = new Schema<IStaffDocument>({
  name: { type: String, required: true, trim: true },
  key: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  uploadedByName: { type: String, required: true },
}, { _id: true });

const SocietyStaffSchema = new Schema<ISocietyStaff>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  staffCode: { type: String, required: true },

  person: {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    photoKey: { type: String },
  },
  designation: { type: String, required: true },
  employmentType: { type: String, enum: ['DIRECT', 'AGENCY', 'CONTRACT'], default: 'DIRECT' },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
  vendorName: { type: String },

  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  accessRoleId: { type: Schema.Types.ObjectId, ref: 'AccessRole' },

  joinedOn: { type: Date, required: true, default: Date.now },
  leftOn: { type: Date, default: null },
  isActive: { type: Boolean, default: true },

  verification: {
    policeVerifiedOn: { type: Date },
    verifiedBy: { type: String, trim: true },
    documentKey: { type: String },
    expiresOn: { type: Date },
  },

  emergencyContact: {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    relation: { type: String, trim: true },
  },
  documents: { type: [StaffDocumentSchema], default: [] },
  notes: { type: String, trim: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

SocietyStaffSchema.index({ societyId: 1, staffCode: 1 }, { unique: true });
SocietyStaffSchema.index({ societyId: 1, isActive: 1, designation: 1 });
SocietyStaffSchema.index({ societyId: 1, userId: 1 });
// Drives the "verification is about to lapse" sweep.
SocietyStaffSchema.index({ societyId: 1, 'verification.expiresOn': 1 });

export const SocietyStaff = mongoose.model<ISocietyStaff>('SocietyStaff', SocietyStaffSchema);
export default SocietyStaff;
