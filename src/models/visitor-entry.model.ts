import mongoose, { Schema, Document } from 'mongoose';

/**
 * One person coming in, and — if the society tracks it — going out again.
 *
 * The design point that matters most here is `exitSource` and `isEstimated`.
 * Exit tracking is broken across the entire industry: entry enforces itself
 * because the visitor stands at the gate until they are let in, while nothing
 * at all pushes the guard to tap "left" afterwards. Every competitor's
 * "currently inside" list is therefore fiction, and the vendors' own answer is
 * to retrain the guard.
 *
 * So this record is allowed to guess — and required to say so. A closed-off
 * entry that nobody actually saw leave is marked, counted, and reported to the
 * committee each morning. The list is not perfect; it knows how imperfect it is,
 * which is the part that can be acted on.
 */

export type EntryStatus = 'INSIDE' | 'LEFT' | 'DENIED';
export type ExitSource = 'GUARD' | 'SCAN' | 'AUTO_CLOSE';

export interface IVisitorEntry extends Document {
  societyId: mongoose.Types.ObjectId;
  /** Sequential per society per day, so a guard can call out "number 14". */
  entryCode: string;

  category: string;
  visitorName: string;
  visitorPhone?: string;
  /** Private S3 key. Downloaded through a presigned link, never served raw. */
  photoKey?: string;
  idType?: string;
  idLast4?: string;

  /** Who they came to see. Absent for a society-wide visitor (a contractor). */
  flatId?: mongoose.Types.ObjectId;
  flatLabel?: string;
  blockId?: mongoose.Types.ObjectId;

  vehicleNumber?: string;
  vehiclePhotoKey?: string;

  status: EntryStatus;
  enteredAt: Date;
  /** What the policy expects for this category — gives exit a forcing function. */
  expectedOutAt?: Date;
  exitedAt?: Date;
  exitSource?: ExitSource;
  /**
   * True when nobody actually saw them leave and the nightly job closed it off.
   * Never quietly true: the reports count these separately.
   */
  isEstimated: boolean;
  /**
   * This visitor matched the society's blocklist and the guard let them in
   * anyway.
   *
   * Recorded on the ENTRY rather than only warned about at the time, because
   * the question that gets asked afterwards is "did anybody know?" — and a
   * warning that existed only on a screen for four seconds cannot answer it.
   */
  flaggedReason?: string;
  /** Set once so the overstay alert cannot fire twice for the same visitor. */
  overstayNotifiedAt?: Date;

  guardStaffId?: mongoose.Types.ObjectId;
  guardName: string;
  exitGuardName?: string;

  notes?: string;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const VisitorEntrySchema = new Schema<IVisitorEntry>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  entryCode: { type: String, required: true },

  category: { type: String, required: true },
  visitorName: { type: String, required: true, trim: true },
  visitorPhone: { type: String, trim: true },
  photoKey: { type: String },
  idType: { type: String },
  idLast4: { type: String },

  flatId: { type: Schema.Types.ObjectId, ref: 'Flat' },
  flatLabel: { type: String },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },

  vehicleNumber: { type: String, trim: true, uppercase: true },
  vehiclePhotoKey: { type: String },

  status: { type: String, enum: ['INSIDE', 'LEFT', 'DENIED'], default: 'INSIDE' },
  enteredAt: { type: Date, required: true, default: Date.now },
  expectedOutAt: { type: Date },
  exitedAt: { type: Date },
  exitSource: { type: String, enum: ['GUARD', 'SCAN', 'AUTO_CLOSE'] },
  isEstimated: { type: Boolean, default: false },
  flaggedReason: { type: String, trim: true, maxlength: 300 },
  overstayNotifiedAt: { type: Date },

  guardStaffId: { type: Schema.Types.ObjectId, ref: 'SocietyStaff' },
  guardName: { type: String, required: true },
  exitGuardName: { type: String },

  notes: { type: String, trim: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

// "Who is inside right now" is the busiest query on the gate console.
VisitorEntrySchema.index({ societyId: 1, status: 1, enteredAt: -1 });
VisitorEntrySchema.index({ societyId: 1, enteredAt: -1 });
// A resident reading their own flat's log, which is the only log they get.
VisitorEntrySchema.index({ societyId: 1, flatId: 1, enteredAt: -1 });
// The nightly close-off and the overstay sweep both scan on this pair.
VisitorEntrySchema.index({ societyId: 1, status: 1, expectedOutAt: 1 });
// The retention purge.
VisitorEntrySchema.index({ societyId: 1, createdAt: 1 });

export const VisitorEntry = mongoose.model<IVisitorEntry>('VisitorEntry', VisitorEntrySchema);
export default VisitorEntry;
