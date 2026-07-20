import mongoose, { Schema, Document } from 'mongoose';

/**
 * Which staff member looks after which wing, for which kind of work.
 *
 * No competitor models this at all. MyGate can filter a ticket list by
 * building; ApnaComplex routes purely by category, with no spatial dimension
 * whatsoever. But "Vijay does plumbing for A and B wing" is exactly how a large
 * society organises itself on the ground, and without it every complaint has to
 * be assigned by hand.
 *
 * One person can hold several of these — primary for their own wings, backup
 * for a neighbour's — which is also how cover actually works when somebody is
 * on leave.
 */

export const WORK_CATEGORIES = [
  'PLUMBING', 'ELECTRICAL', 'GARDEN', 'CLEANING', 'LIFT', 'SECURITY', 'CARPENTRY', 'OTHER',
] as const;
export type WorkCategory = typeof WORK_CATEGORIES[number];

export interface IStaffAssignment extends Document {
  societyId: mongoose.Types.ObjectId;
  staffId: mongoose.Types.ObjectId;
  /** Staff name at the time of assigning, so a list reads without a join. */
  staffName: string;

  /** SOCIETY covers everywhere; BLOCK covers one wing. */
  scope: 'SOCIETY' | 'BLOCK';
  blockId?: mongoose.Types.ObjectId;
  blockName?: string;

  categories: string[];
  /**
   * PRIMARY is tried first; BACKUP catches what they cannot take. Routing walks
   * primary → backup → society-wide → unassigned, and never drops a complaint
   * on the floor because nobody matched.
   */
  rank: 'PRIMARY' | 'BACKUP';
  isActive: boolean;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const StaffAssignmentSchema = new Schema<IStaffAssignment>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  staffId: { type: Schema.Types.ObjectId, ref: 'SocietyStaff', required: true },
  staffName: { type: String, required: true },

  scope: { type: String, enum: ['SOCIETY', 'BLOCK'], default: 'BLOCK' },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },
  blockName: { type: String },

  categories: { type: [String], default: [] },
  rank: { type: String, enum: ['PRIMARY', 'BACKUP'], default: 'PRIMARY' },
  isActive: { type: Boolean, default: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

// The routing lookup: "who covers this wing for this kind of work?"
StaffAssignmentSchema.index({ societyId: 1, isActive: 1, blockId: 1, rank: 1 });
StaffAssignmentSchema.index({ societyId: 1, staffId: 1 });

export const StaffAssignment = mongoose.model<IStaffAssignment>('StaffAssignment', StaffAssignmentSchema);
export default StaffAssignment;
