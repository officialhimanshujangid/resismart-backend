import mongoose, { Schema, Document } from 'mongoose';

/**
 * What a society lets people complain about, and how fast it promises to answer.
 *
 * Two levels, and the timings hang off the SECOND one. "Water leakage" and "tap
 * not working" are both plumbing and deserve wildly different answers — one is
 * two hours, the other is two days. Hanging the SLA off the parent category
 * would average them into a promise that is wrong in both directions.
 */
export interface IComplaintCategory extends Document {
  societyId: mongoose.Types.ObjectId;
  category: string;
  subCategory?: string;
  /** Which trade this routes to — see `StaffAssignment.categories`. */
  workCategory: string;

  /**
   * Minutes. Two clocks, deliberately.
   *
   * First response is the one residents actually judge: an unanswered complaint
   * feels ignored long before it feels slow. No competitor separates them.
   */
  firstResponseMinutes: number;
  resolutionMinutes: number;

  /** Skips the lower escalation rungs — a fire or a burst pipe cannot queue. */
  isEmergency: boolean;
  isActive: boolean;
  sortOrder: number;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ComplaintCategorySchema = new Schema<IComplaintCategory>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  category: { type: String, required: true, trim: true },
  subCategory: { type: String, trim: true },
  workCategory: { type: String, required: true },

  firstResponseMinutes: { type: Number, default: 240, min: 5 },
  resolutionMinutes: { type: Number, default: 2880, min: 15 },

  isEmergency: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

ComplaintCategorySchema.index({ societyId: 1, category: 1, subCategory: 1 }, { unique: true });

export const ComplaintCategory = mongoose.model<IComplaintCategory>('ComplaintCategory', ComplaintCategorySchema);
export default ComplaintCategory;
