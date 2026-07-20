import mongoose, { Schema, Document } from 'mongoose';

/**
 * Append-only history for one complaint.
 *
 * Separate from the complaint itself so the ticket stays small and the story
 * stays complete. When a resident says "nobody did anything for a week", this
 * is what answers them — including the reason the clock was paused, which is
 * usually that nobody was home.
 */
export type ComplaintEventType =
  | 'RAISED' | 'ASSIGNED' | 'REASSIGNED' | 'RESPONDED' | 'NOTE'
  | 'PAUSED' | 'RESUMED' | 'WORK_DONE' | 'RESOLVED' | 'CLOSED'
  | 'REOPENED' | 'REJECTED' | 'ESCALATED' | 'ME_TOO' | 'RATED';

export interface IComplaintEvent extends Document {
  societyId: mongoose.Types.ObjectId;
  complaintId: mongoose.Types.ObjectId;
  type: ComplaintEventType;
  note?: string;
  photoKeys: string[];
  byUserId?: mongoose.Types.ObjectId;
  byName: string;
  /** Visible to the resident, or internal to staff and committee. */
  isInternal: boolean;
  createdAt: Date;
}

const ComplaintEventSchema = new Schema<IComplaintEvent>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  complaintId: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true },
  type: { type: String, required: true },
  note: { type: String, trim: true },
  photoKeys: { type: [String], default: [] },
  byUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  byName: { type: String, required: true },
  isInternal: { type: Boolean, default: false },
}, { timestamps: { createdAt: true, updatedAt: false } });

ComplaintEventSchema.index({ complaintId: 1, createdAt: 1 });

export const ComplaintEvent = mongoose.model<IComplaintEvent>('ComplaintEvent', ComplaintEventSchema);
export default ComplaintEvent;
