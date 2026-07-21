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

/**
 * WHO they came to see — and why a flat id was never enough.
 *
 * A visit used to be, structurally, a visit to a flat. Anybody arriving for the
 * secretary, for the society office, or for the manager had no flat to be filed
 * against, so the audience resolved to `{userIds: [], via: 'NO_FLAT'}`: nobody
 * was notified, nobody could approve, and the entry was invisible to every
 * resident including the person actually being visited. That is not a gap in
 * the notification code — it is a gap in the record, and it has to be closed in
 * the model.
 *
 *   FLAT      — the normal case; `flatId` carries it and the household rules apply
 *   COMMITTEE — a serving committee member, named in `hostUserId`
 *   STAFF     — somebody on the society's own roll, named in `hostStaffId`
 *   OFFICE    — the society itself: the office, an AGM, a vendor meeting. There
 *               is no one person, so the audience comes from whoever is on duty
 *
 * `hostLabel` is denormalised and always present because the notification body
 * has to be able to NAME the host — "somebody came to the gate" with no host is
 * the message that reads as a leak even when it is a duty.
 */
export type HostKind = 'FLAT' | 'COMMITTEE' | 'OFFICE' | 'STAFF';

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

  /** See `HostKind`. Defaults to FLAT, which is what every existing row is. */
  hostKind: HostKind;
  /** The committee member or resident actually being visited. */
  hostUserId?: mongoose.Types.ObjectId;
  /** The manager, the supervisor — somebody on the society's own roll. */
  hostStaffId?: mongoose.Types.ObjectId;
  /** "A Wing 102", "Secretary — R. Nair". Always set; see the pre-validate hook. */
  hostLabel: string;

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

  /**
   * The queue id a guard device gave this arrival while it was offline.
   *
   * The dedupe key for reconciliation, and it lives on the ENTRY rather than on
   * the pass on purpose: the entry is the thing that must not exist twice. A
   * device that syncs, loses the response and retries would otherwise write the
   * same visitor into the register again — and a unique index is the only
   * version of "sync is idempotent" that survives two devices retrying at once.
   */
  offlineClientId?: string;

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

  hostKind: { type: String, enum: ['FLAT', 'COMMITTEE', 'OFFICE', 'STAFF'], default: 'FLAT' },
  hostUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  hostStaffId: { type: Schema.Types.ObjectId, ref: 'SocietyStaff' },
  // Defaulted rather than `required`, and filled by the hook below. Requiring it
  // would reject every row written by anything that predates the host model —
  // including the fixtures other verify scripts build by hand — and a schema
  // that refuses old-shaped data is a migration disguised as a validation rule.
  hostLabel: { type: String, trim: true, maxlength: 160, default: '' },

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
  offlineClientId: { type: String, trim: true, maxlength: 64 },

  guardStaffId: { type: Schema.Types.ObjectId, ref: 'SocietyStaff' },
  guardName: { type: String, required: true },
  exitGuardName: { type: String },

  notes: { type: String, trim: true },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

/**
 * A host label, always, even on a row nobody set one on.
 *
 * "Always present" is the whole value of the field: every screen and every
 * notification body can then say who the visit is FOR without a null check and
 * without a join. A hook rather than a `required` so the guarantee also covers
 * rows written before the host model existed and rows written by a caller that
 * has not been taught about it yet — the invariant belongs to the collection,
 * not to one code path.
 */
VisitorEntrySchema.pre('validate', function (next) {
  if (!this.hostLabel) this.hostLabel = this.flatLabel || 'The society';
  next();
});

// "Who is inside right now" is the busiest query on the gate console.
VisitorEntrySchema.index({ societyId: 1, status: 1, enteredAt: -1 });
VisitorEntrySchema.index({ societyId: 1, enteredAt: -1 });
// A resident reading their own flat's log, which is the only log they get.
VisitorEntrySchema.index({ societyId: 1, flatId: 1, enteredAt: -1 });
// The nightly close-off and the overstay sweep both scan on this pair.
VisitorEntrySchema.index({ societyId: 1, status: 1, expectedOutAt: 1 });
// The retention purge.
VisitorEntrySchema.index({ societyId: 1, createdAt: 1 });
// A non-FLAT host reading their OWN visits. Without this the only way to answer
// "who came to see the secretary" is a collection scan, which is why the
// question was never asked at all.
VisitorEntrySchema.index({ societyId: 1, hostUserId: 1, enteredAt: -1 });
// Offline sync, exactly once. Partial rather than sparse: two entries with no
// clientId at all are the normal case and must not collide with each other.
VisitorEntrySchema.index(
  { societyId: 1, offlineClientId: 1 },
  { unique: true, partialFilterExpression: { offlineClientId: { $type: 'string' } } },
);

export const VisitorEntry = mongoose.model<IVisitorEntry>('VisitorEntry', VisitorEntrySchema);
export default VisitorEntry;
