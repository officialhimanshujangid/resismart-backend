import mongoose, { Schema, Document } from 'mongoose';

export type CommitteeStatus = 'ACTIVE' | 'DISSOLVED';

/**
 * A managing-committee TERM for a society (Indian CHS model). A society has at most one
 * ACTIVE committee at a time; dissolving it (or starting a new term) archives the previous
 * one. The sequence of terms + their member changes forms the committee history.
 */
export interface ICommittee extends Document {
  societyId: mongoose.Types.ObjectId;
  name: string; // e.g. "Managing Committee 2026–2031"
  termStartDate: Date;
  termEndDate?: Date | null;
  electionDate?: Date | null;
  status: CommitteeStatus;
  notes?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const CommitteeSchema = new Schema<ICommittee>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  name: { type: String, required: true, trim: true },
  termStartDate: { type: Date, required: true },
  termEndDate: { type: Date, default: null },
  electionDate: { type: Date, default: null },
  status: { type: String, enum: ['ACTIVE', 'DISSOLVED'], default: 'ACTIVE' },
  notes: { type: String, trim: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

CommitteeSchema.index({ societyId: 1, status: 1 });
CommitteeSchema.index({ societyId: 1, termStartDate: -1 });

export const Committee = mongoose.model<ICommittee>('Committee', CommitteeSchema);
export default Committee;
