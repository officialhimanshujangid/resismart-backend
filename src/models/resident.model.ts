import mongoose, { Schema, Document } from 'mongoose';

/** A document attached to a resident (ID proof, rental agreement, police verification, etc.). */
export interface IResidentDocument {
  kind: string; // ID_PROOF | AGREEMENT | POLICE_VERIFICATION | OTHER
  label: string;
  key: string; // private S3 object key
  url: string; // service URL (download goes through a presigned link, not this directly)
  uploadedAt: Date;
  uploadedByName: string;
}

export interface IResident extends Document {
  flatId: mongoose.Types.ObjectId;
  societyId: mongoose.Types.ObjectId;
  /**
   * The login identity this row belongs to. OPTIONAL: a "data-only" household member
   * (no email/phone, no login) has no userId — their details live in `person`. When a
   * contact is later added and verified, an identity is provisioned and userId is set.
   */
  userId?: mongoose.Types.ObjectId;
  /** Snapshot of the person so lists/data-only members don't require a populated User. */
  person: {
    name: string;
    email?: string;
    phone?: string;
    emailVerifiedAt?: Date;
    phoneVerifiedAt?: Date;
  };
  relationship: string; // OWNER | SPOUSE | CHILD | PARENT | SIBLING | RELATIVE | TENANT | STAFF | OTHER
  /**
   * Which household this person belongs to. OWNER = the owner + owner's family (tied to
   * ownership, persists across occupancy); TENANT = the tenant + tenant's family (present
   * only during a tenancy, moved out when it ends). Lets the owner household and the
   * current tenant household be shown/managed separately.
   */
  householdType: 'OWNER' | 'TENANT';
  isOwner: boolean;
  /** Head of the household (owner household, or tenant household when rented). One per active household. */
  isHead: boolean;
  isActive: boolean;
  moveInDate?: Date;
  moveOutDate?: Date;
  deactivatedReason?: string;
  documents: IResidentDocument[];

  // Audit columns
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ResidentDocumentSchema = new Schema<IResidentDocument>({
  kind: { type: String, default: 'OTHER', trim: true },
  label: { type: String, required: true, trim: true },
  key: { type: String, required: true },
  url: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  uploadedByName: { type: String, default: '' },
}, { _id: true });

const ResidentSchema = new Schema<IResident>({
  flatId: {
    type: Schema.Types.ObjectId,
    ref: 'Flat',
    required: true,
  },
  societyId: {
    type: Schema.Types.ObjectId,
    ref: 'Society',
    required: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  person: {
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date },
  },
  relationship: {
    type: String,
    enum: ['OWNER', 'SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'RELATIVE', 'TENANT', 'STAFF', 'OTHER'],
    required: true,
  },
  householdType: {
    type: String,
    enum: ['OWNER', 'TENANT'],
    default: 'OWNER',
  },
  isOwner: {
    type: Boolean,
    default: false,
  },
  isHead: {
    type: Boolean,
    default: false,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  moveInDate: { type: Date },
  moveOutDate: { type: Date },
  deactivatedReason: { type: String, trim: true },
  documents: { type: [ResidentDocumentSchema], default: [] },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdByName: {
    type: String,
    required: true,
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  updatedByName: {
    type: String,
    required: true,
  },
}, {
  timestamps: true,
});

// Optimization Indexes
ResidentSchema.index({ flatId: 1 });
ResidentSchema.index({ societyId: 1 });
ResidentSchema.index({ userId: 1 });
ResidentSchema.index({ flatId: 1, isActive: 1 });
ResidentSchema.index({ flatId: 1, isHead: 1 });
// A user can only be added to a flat once — but data-only members (no userId) are exempt,
// so the uniqueness is PARTIAL (applies only when userId exists).
ResidentSchema.index(
  { flatId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }
);

export const Resident = mongoose.model<IResident>('Resident', ResidentSchema);
export default Resident;
