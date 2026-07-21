import mongoose, { Schema, Document } from 'mongoose';

/**
 * Append-only history for one complaint.
 *
 * Separate from the complaint itself so the ticket stays small and the story
 * stays complete. When a resident says "nobody did anything for a week", this
 * is what answers them — including the reason the clock was paused, which is
 * usually that nobody was home.
 */
/**
 * `COMMENT` is the household's own voice, and it is new.
 *
 * `NOTE` was doing two incompatible jobs: the automatic internal commentary
 * this service writes about itself ("nobody covers PLUMBING in A Wing"), and —
 * in intention only — anything a person typed. In practice nothing a resident
 * did could produce an event at all, because the only route that wrote one was
 * `respond`, which is behind a staff permission. Splitting the two means the
 * timeline can say "Message from the flat" instead of "Note", and means the
 * internal channel has a name that is honestly its own.
 */
export type ComplaintEventType =
  | 'RAISED' | 'ASSIGNED' | 'REASSIGNED' | 'RESPONDED' | 'NOTE' | 'COMMENT'
  | 'PAUSED' | 'RESUMED' | 'WORK_DONE' | 'RESOLVED' | 'CLOSED'
  | 'REOPENED' | 'REJECTED' | 'ESCALATED' | 'ME_TOO' | 'RATED';

export interface IComplaintEvent extends Document {
  societyId: mongoose.Types.ObjectId;
  complaintId: mongoose.Types.ObjectId;
  type: ComplaintEventType;
  note?: string;
  /**
   * S3 object keys, never URLs.
   *
   * The field has existed since the beginning and was written by the service;
   * nothing ever read it, so the "after" photograph a technician was invited to
   * attach went nowhere and was seen by nobody. A key is not a URL on purpose —
   * the bucket is private, and every read goes through a presigned link minted
   * for a caller who has already passed `detail`'s scoping.
   */
  photoKeys: string[];
  byUserId?: mongoose.Types.ObjectId;
  byName: string;
  /**
   * Visible to the resident, or internal to staff and committee.
   *
   * `detail` filters on this for anybody holding `residentFlatIds`, and the
   * photo endpoint filters the SAME list before presigning — otherwise the
   * gallery would have quietly handed back the picture attached to a note the
   * resident is not allowed to read.
   */
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
