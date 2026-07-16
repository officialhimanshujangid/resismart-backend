import mongoose, { Schema, Document } from 'mongoose';
import { AgingBuckets } from '../services/reports.service';

export type NoticeStage = 'FIRST' | 'SECOND' | 'FINAL' | 'RECOVERY_101';
export type DeliveryChannel = 'EMAIL' | 'HAND' | 'POST';

/**
 * A written demand served on a defaulting member.
 *
 * Under co-operative law a society cannot jump straight to recovery — recovery
 * proceedings follow a documented trail of written notices, and skipping a step
 * is exactly what gets a case thrown out. Each notice is therefore a permanent
 * record of what was demanded, of whom, on what date, and how it was delivered.
 *
 * `outstandingPaise` is a SNAPSHOT taken when the notice was issued, never a
 * live figure. What the notice demanded is what was owed the day it was sent;
 * recomputing it later would mean a re-printed notice disagreed with the paper
 * the member was actually served — and the ledger keeps moving underneath.
 */
export interface IDefaulterNotice extends Document {
  societyId: mongoose.Types.ObjectId;
  flatId: mongoose.Types.ObjectId;
  blockName: string;
  flatNumber: string;
  memberName: string;

  stage: NoticeStage;
  /** What was owed on `issuedOn`. Frozen — see the note above. */
  outstandingPaise: number;
  /**
   * The aging split behind `outstandingPaise`, frozen with it.
   *
   * Printed on the notice, so it must age with the amount it explains. Deriving
   * it live would put today's buckets next to the issue-day total on the same
   * sheet — two numbers that no longer describe the same debt.
   */
  buckets: AgingBuckets;

  issuedOn: Date;
  /** The date the notice gives the member to pay by. */
  dueByOn: Date;
  deliveredVia: DeliveryChannel[];
  notes?: string;

  /**
   * The certificate/application reference of a recovery filing. Tracking only —
   * this system records THAT an application was filed, not the legal process.
   */
  recoveryRef?: string;
  /** Set when the dues behind this notice were settled or it was withdrawn. */
  resolvedOn?: Date;

  issuedBy: mongoose.Types.ObjectId;
  issuedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const BucketsSchema = new Schema<AgingBuckets>({
  current: { type: Number, required: true, default: 0 },
  d31_60: { type: Number, required: true, default: 0 },
  d61_90: { type: Number, required: true, default: 0 },
  d90plus: { type: Number, required: true, default: 0 },
}, { _id: false });

const DefaulterNoticeSchema = new Schema<IDefaulterNotice>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  flatId: { type: Schema.Types.ObjectId, ref: 'Flat', required: true },
  blockName: { type: String, required: true },
  flatNumber: { type: String, required: true },
  memberName: { type: String, required: true, trim: true },

  stage: { type: String, enum: ['FIRST', 'SECOND', 'FINAL', 'RECOVERY_101'], required: true },
  outstandingPaise: { type: Number, required: true, min: 0 },
  buckets: { type: BucketsSchema, required: true },

  issuedOn: { type: Date, required: true },
  dueByOn: { type: Date, required: true },
  deliveredVia: { type: [{ type: String, enum: ['EMAIL', 'HAND', 'POST'] }], default: [] },
  notes: { type: String, trim: true },

  recoveryRef: { type: String, trim: true },
  resolvedOn: { type: Date },

  issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  issuedByName: { type: String, required: true },
}, { timestamps: true });

// The flat's notice history, newest first — the read every screen and every
// escalation check makes.
DefaulterNoticeSchema.index({ societyId: 1, flatId: 1, issuedOn: -1 });

export const DefaulterNotice = mongoose.model<IDefaulterNotice>('DefaulterNotice', DefaulterNoticeSchema);
export default DefaulterNotice;
