import mongoose, { Schema, Document } from 'mongoose';

/**
 * A committee office/title configurable per society. Seeded with the standard Indian
 * managing-committee office bearers on first committee creation; each society can
 * rename / add / remove / reorder them.
 */
export interface ICommitteeDesignation extends Document {
  societyId: mongoose.Types.ObjectId;
  key: string; // stable machine key, e.g. CHAIRMAN
  label: string; // display label, editable
  rank: number; // sort order (lower = higher office)
  isOfficeBearer: boolean;
  isSystem: boolean; // seeded default (cannot be hard-deleted, only deactivated)
  active: boolean;
}

/** Standard Indian CHS office bearers seeded per society. */
export const DEFAULT_DESIGNATIONS: Array<{ key: string; label: string; rank: number; isOfficeBearer: boolean }> = [
  { key: 'CHAIRMAN', label: 'Chairman / President', rank: 1, isOfficeBearer: true },
  { key: 'VICE_CHAIRMAN', label: 'Vice-Chairman', rank: 2, isOfficeBearer: true },
  { key: 'SECRETARY', label: 'Secretary', rank: 3, isOfficeBearer: true },
  { key: 'JOINT_SECRETARY', label: 'Joint Secretary', rank: 4, isOfficeBearer: true },
  { key: 'TREASURER', label: 'Treasurer', rank: 5, isOfficeBearer: true },
  { key: 'MEMBER', label: 'Committee Member', rank: 6, isOfficeBearer: false },
];

const CommitteeDesignationSchema = new Schema<ICommitteeDesignation>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  key: { type: String, required: true, trim: true },
  label: { type: String, required: true, trim: true },
  rank: { type: Number, default: 100 },
  isOfficeBearer: { type: Boolean, default: false },
  isSystem: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
}, { timestamps: true });

CommitteeDesignationSchema.index({ societyId: 1, key: 1 }, { unique: true });

export const CommitteeDesignation = mongoose.model<ICommitteeDesignation>('CommitteeDesignation', CommitteeDesignationSchema);
export default CommitteeDesignation;
