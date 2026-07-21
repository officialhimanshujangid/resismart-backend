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

/**
 * Every state a visit can be in, and the reason there are more than three.
 *
 * The old set — INSIDE / LEFT / DENIED — could only describe a visit that was
 * already resolved. It had no way to say "standing at the gate, waiting for the
 * flat to answer", so the console never asked: it went straight to INSIDE and
 * the whole approval module became unreachable. A person physically at the gate
 * is a real state, and the record has to be able to hold it.
 *
 *   AWAITING  — at the gate, the flat has been asked, nobody is inside yet
 *   AT_GATE   — a delivery left at the gate; the courier did not come in
 *   INSIDE    — admitted and present
 *   LEFT      — gone (recorded, scanned, or guessed by the nightly job)
 *   DENIED    — refused, by the flat or the guard
 */
export type EntryStatus = 'AWAITING' | 'AT_GATE' | 'INSIDE' | 'LEFT' | 'DENIED';
export type ExitSource = 'GUARD' | 'SCAN' | 'AUTO_CLOSE';

/**
 * HOW they came to be inside — the single field that makes the gate auditable.
 *
 *   GUARD            — the guard logged them, no approval was required
 *   RESIDENT_APPROVAL — a resident tapped allow
 *   PASS             — they redeemed a pre-issued invitation
 *   EXPECTED         — the flat had listed them as an expected visitor
 *   OVERRIDE         — the guard decided without waiting, with a reason on record
 *   NOTIFY           — approval was NOTIFY_ONLY; the flat was told, not asked
 */
export type AdmittedVia = 'GUARD' | 'RESIDENT_APPROVAL' | 'PASS' | 'EXPECTED' | 'OVERRIDE' | 'NOTIFY';

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

  /**
   * The physical gate they came in by, and — separately — the one they left by.
   * Two fields because "came in the main gate, left by the service gate" is a
   * real and useful thing to know, and a single gateId cannot hold it.
   */
  entryGateId?: mongoose.Types.ObjectId;
  entryGateName?: string;
  exitGateId?: mongoose.Types.ObjectId;
  exitGateName?: string;

  /** Who they came to see. Absent for a society-wide visitor (a contractor). */
  flatId?: mongoose.Types.ObjectId;
  flatLabel?: string;
  blockId?: mongoose.Types.ObjectId;

  vehicleNumber?: string;
  vehiclePhotoKey?: string;

  status: EntryStatus;
  /** How they got in. Absent while AWAITING — set the moment they are admitted. */
  admittedVia?: AdmittedVia;
  /** The approval this entry came from, when one was raised. Closes the dangling link. */
  approvalRequestId?: mongoose.Types.ObjectId;
  /** The pass this entry burned, when a QR or code was scanned. */
  gatePassId?: mongoose.Types.ObjectId;
  /** Who admitted or refused them, and why — for the record, and for an override. */
  decidedByName?: string;
  decisionReason?: string;
  decidedAt?: Date;

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

  entryGateId: { type: Schema.Types.ObjectId, ref: 'Gate' },
  entryGateName: { type: String },
  exitGateId: { type: Schema.Types.ObjectId, ref: 'Gate' },
  exitGateName: { type: String },

  flatId: { type: Schema.Types.ObjectId, ref: 'Flat' },
  flatLabel: { type: String },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block' },

  vehicleNumber: { type: String, trim: true, uppercase: true },
  vehiclePhotoKey: { type: String },

  status: { type: String, enum: ['AWAITING', 'AT_GATE', 'INSIDE', 'LEFT', 'DENIED'], default: 'INSIDE' },
  admittedVia: { type: String, enum: ['GUARD', 'RESIDENT_APPROVAL', 'PASS', 'EXPECTED', 'OVERRIDE', 'NOTIFY'] },
  approvalRequestId: { type: Schema.Types.ObjectId, ref: 'ApprovalRequest' },
  gatePassId: { type: Schema.Types.ObjectId, ref: 'GatePass' },
  decidedByName: { type: String, trim: true },
  decisionReason: { type: String, trim: true, maxlength: 300 },
  decidedAt: { type: Date },
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
