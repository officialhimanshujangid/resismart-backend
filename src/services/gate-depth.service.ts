import mongoose from 'mongoose';
import { ResidentVehicle, IResidentVehicle, VehicleKind } from '../models/resident-vehicle.model';
import { GateBlocklist, IGateBlocklist, BlockBasis } from '../models/gate-blocklist.model';
import { Flat } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { GatePass } from '../models/gate-pass.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { Complaint } from '../models/complaint.model';
import { SocietyStaff } from '../models/society-staff.model';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class DepthError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Actor { userId: string; userName: string }

// ------------------------------------------------------------------ vehicles

/** "MH 12 AB 1234", "mh-12-ab-1234" and "MH12AB1234" are one car. */
export const normalisePlate = (raw: string): string =>
  String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A phone matches on its last ten digits — country codes are typed inconsistently. */
export const normalisePhone = (raw: string): string =>
  String(raw || '').replace(/\D/g, '').slice(-10);

export async function addVehicle(
  societyId: string,
  input: { flatId: string; number: string; kind?: VehicleKind; make?: string; colour?: string; parkingSlot?: string },
  actor: Actor,
): Promise<IResidentVehicle> {
  const flat = await Flat.findOne({ _id: oid(input.flatId), societyId: oid(societyId) }).lean();
  if (!flat) throw new DepthError('That flat could not be found.', 404);

  const number = normalisePlate(input.number);
  if (number.length < 4) throw new DepthError('That does not look like a registration number.');

  const clash = await ResidentVehicle.findOne({ societyId: oid(societyId), number, isActive: true }).lean();
  if (clash) {
    throw new DepthError(
      String(clash.flatId) === String(flat._id)
        ? 'That vehicle is already on this flat.'
        : `That vehicle is already registered to ${clash.flatLabel || 'another flat'}.`,
    );
  }

  return ResidentVehicle.create({
    societyId: oid(societyId),
    flatId: flat._id,
    flatLabel: `${flat.blockName || ''} ${flat.number}`.trim(),
    blockId: flat.blockId,
    number,
    displayNumber: String(input.number).trim().toUpperCase(),
    kind: input.kind || 'CAR',
    make: input.make, colour: input.colour, parkingSlot: input.parkingSlot,
    isActive: true,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });
}

export async function removeVehicle(societyId: string, id: string, actor: Actor): Promise<boolean> {
  // Deactivated, not deleted. The register still refers to it, and a car that
  // vanishes from history makes last month's entries unexplainable.
  const res = await ResidentVehicle.updateOne(
    { _id: oid(id), societyId: oid(societyId), isActive: true },
    { $set: { isActive: false, updatedBy: oid(actor.userId), updatedByName: actor.userName } },
  );
  return res.modifiedCount > 0;
}

export async function listVehicles(societyId: string, flatId?: string) {
  const filter: Record<string, unknown> = { societyId: oid(societyId), isActive: true };
  if (flatId) filter.flatId = oid(flatId);
  return ResidentVehicle.find(filter).sort({ flatLabel: 1, number: 1 }).limit(2000).lean();
}

/**
 * What the guard's plate box offers as they type.
 *
 * Prefix-anchored on the normalised plate, because a guard reads a number plate
 * left to right and typing the middle of one is not a thing that happens.
 *
 * No regex escaping, and that is safe rather than sloppy: `normalisePlate`
 * has already reduced the input to `[A-Z0-9]`, so there is nothing left with
 * meaning to a regex engine. An escape here would look prudent while quietly
 * being unreachable — and unreachable defences are how the next reader comes
 * to believe normalisePlate is optional.
 */
export async function suggestVehicles(societyId: string, prefix: string, limit = 8) {
  const q = normalisePlate(prefix);
  if (q.length < 2) return [];
  return ResidentVehicle.find(
    { societyId: oid(societyId), isActive: true, number: { $regex: `^${q}` } },
    { number: 1, displayNumber: 1, flatId: 1, flatLabel: 1, kind: 1, make: 1, colour: 1 },
  ).limit(limit).lean();
}

/** Whose car is this — if it belongs to anybody here at all. */
export async function whoseVehicle(societyId: string, plate: string) {
  const number = normalisePlate(plate);
  if (!number) return null;
  return ResidentVehicle.findOne(
    { societyId: oid(societyId), number, isActive: true },
    { number: 1, displayNumber: 1, flatId: 1, flatLabel: 1, kind: 1 },
  ).lean();
}

// ---------------------------------------------------------------- blocklist

export interface BlockInput {
  basis: BlockBasis;
  value: string;
  label?: string;
  reason: string;
  approverUserIds: string[];
  sourceEntryId?: string;
}

/**
 * Add somebody to the blocklist.
 *
 * Two gates, and both are the point:
 *
 * **Identity must already be resolved.** A PHONE basis has to correspond to a
 * number that actually redeemed a pass or appears on a recorded entry — not a
 * number somebody typed into this form. Otherwise the list is built on the same
 * unreliable data that made everybody else abandon the feature.
 *
 * **It takes two committee members.** Refusing a named person entry to a
 * building is a society decision, not a guard's bad evening.
 */
export async function block(societyId: string, input: BlockInput, actor: Actor): Promise<IGateBlocklist> {
  if (!input.reason?.trim()) throw new DepthError('Please say why. This is kept permanently.');

  const term = await Committee.findOne({ societyId: oid(societyId), status: 'ACTIVE' }).lean();
  if (!term) throw new DepthError('Only a serving committee can block somebody.', 409);

  const approverIds = [...new Set([...(input.approverUserIds || []), actor.userId].map(String))];
  const approvers = await CommitteeMember.find({
    societyId: oid(societyId), committeeId: term._id, status: 'ACTIVE',
    userId: { $in: approverIds.map(oid) },
  }).lean();
  if (approvers.length < 2) {
    throw new DepthError('Blocking somebody needs two serving committee members to agree.');
  }

  const value = input.basis === 'PHONE' ? normalisePhone(input.value) : normalisePlate(input.value);
  if (!value) throw new DepthError('That is not something we can block on.');

  // The identity check. This is the whole reason the feature is shippable.
  const seen = await hasBeenSeen(societyId, input.basis, value);
  if (!seen) {
    throw new DepthError(
      input.basis === 'PHONE'
        ? 'That number has never been recorded at this gate, so blocking it would be guesswork. Block from an actual entry.'
        : 'That vehicle has never been recorded at this gate, so blocking it would be guesswork.',
    );
  }

  const existing = await GateBlocklist.findOne({
    societyId: oid(societyId), basis: input.basis, value, isActive: true,
  });
  if (existing) throw new DepthError('That is already on the list.');

  return GateBlocklist.create({
    societyId: oid(societyId),
    basis: input.basis, value,
    label: input.label?.trim(),
    reason: input.reason.trim(),
    approvedByUserIds: approvers.map(a => a.userId),
    approvedByNames: approvers.map(a => (a as any).memberSnapshot?.name || a.designationLabel),
    sourceEntryId: input.sourceEntryId ? oid(input.sourceEntryId) : undefined,
    isActive: true,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });
}

/**
 * Has this identifier genuinely turned up here before?
 *
 * A PHONE counts if it appears on a recorded entry or on a redeemed pass — in
 * both cases somebody was physically present and it was written down at the
 * time. A VEHICLE counts if a plate was recorded at the gate.
 */
async function hasBeenSeen(societyId: string, basis: BlockBasis, value: string): Promise<boolean> {
  if (basis === 'VEHICLE') {
    // Plates are stored as typed, so compare on the normalised form rather
    // than hoping the guard punctuated it the same way twice.
    const entries = await VisitorEntry.find(
      { societyId: oid(societyId), vehicleNumber: { $exists: true, $ne: '' } },
      { vehicleNumber: 1 },
    ).limit(5000).lean();
    return entries.some(e => normalisePlate(e.vehicleNumber || '') === value);
  }

  if (basis === 'PHONE') {
    const entries = await VisitorEntry.find(
      { societyId: oid(societyId), visitorPhone: { $exists: true, $ne: '' } },
      { visitorPhone: 1 },
    ).limit(5000).lean();
    if (entries.some(e => normalisePhone(e.visitorPhone || '') === value)) return true;

    const passes = await GatePass.find(
      { societyId: oid(societyId), usedCount: { $gt: 0 }, visitorPhone: { $exists: true, $ne: '' } },
      { visitorPhone: 1 },
    ).limit(5000).lean();
    return passes.some(p => normalisePhone(p.visitorPhone || '') === value);
  }

  // PASS_ISSUER is a resident account id, which is by definition resolved.
  return true;
}

export async function unblock(societyId: string, id: string, reason: string | undefined, actor: Actor): Promise<boolean> {
  const res = await GateBlocklist.updateOne(
    { _id: oid(id), societyId: oid(societyId), isActive: true },
    {
      $set: {
        isActive: false, liftedAt: new Date(), liftedReason: reason?.trim(),
        updatedBy: oid(actor.userId), updatedByName: actor.userName,
      },
    },
  );
  return res.modifiedCount > 0;
}

export async function listBlocked(societyId: string, includeLifted = false) {
  const filter: Record<string, unknown> = { societyId: oid(societyId) };
  if (!includeLifted) filter.isActive = true;
  return GateBlocklist.find(filter).sort({ createdAt: -1 }).limit(500).lean();
}

export interface BlockCheck {
  blocked: boolean;
  reason?: string;
  matchedOn?: BlockBasis;
  label?: string;
}

/**
 * Is this visitor on the list?
 *
 * Called at the gate. Matches on phone and plate ONLY — never on name, for the
 * reason set out on the model. A warning to the guard rather than a hard
 * refusal: the software does not know whether the person at the gate today is
 * an emergency, and a guard who cannot override a stale list will stop
 * trusting the list entirely.
 */
export async function checkBlocked(
  societyId: string,
  visitor: { phone?: string; vehicleNumber?: string },
): Promise<BlockCheck> {
  const candidates: { basis: BlockBasis; value: string }[] = [];
  if (visitor.phone) {
    const v = normalisePhone(visitor.phone);
    if (v) candidates.push({ basis: 'PHONE', value: v });
  }
  if (visitor.vehicleNumber) {
    const v = normalisePlate(visitor.vehicleNumber);
    if (v) candidates.push({ basis: 'VEHICLE', value: v });
  }
  if (!candidates.length) return { blocked: false };

  const hit = await GateBlocklist.findOne({
    societyId: oid(societyId),
    isActive: true,
    $or: candidates.map(c => ({ basis: c.basis, value: c.value })),
  }).lean();

  return hit
    ? { blocked: true, reason: hit.reason, matchedOn: hit.basis, label: hit.label }
    : { blocked: false };
}

// ------------------------------------------------------------------ reports

/**
 * How the gate and the complaints desk actually behaved over a period.
 *
 * Built as one call rather than five endpoints because a committee looks at
 * these together — "we had 40 overrides and our SLA slipped" is one
 * conversation, and making them load four screens to have it means they have
 * it once and never again.
 */
export async function opsReport(societyId: string, from: Date, to: Date) {
  const sid = oid(societyId);
  const window = { $gte: from, $lte: to };

  const [entries, complaints, staff] = await Promise.all([
    VisitorEntry.find({ societyId: sid, enteredAt: window },
      { category: 1, enteredAt: 1, exitedAt: 1, isEstimated: 1, blockId: 1, flatLabel: 1 }).lean(),
    Complaint.find({ societyId: sid, createdAt: window },
      { category: 1, status: 1, createdAt: 1, firstRespondedAt: 1, resolvedAt: 1, closedAt: 1,
        assigneeStaffId: 1, assigneeName: 1, assetId: 1, reopenCount: 1, rating: 1,
        firstResponseDueAt: 1, resolutionDueAt: 1 }).lean(),
    SocietyStaff.find({ societyId: sid, isActive: true }, { 'person.name': 1, category: 1 }).lean(),
  ]);

  // ------------------------------------------------------------ gate figures
  const byCategory = new Map<string, number>();
  for (const e of entries) byCategory.set(e.category, (byCategory.get(e.category) || 0) + 1);

  const closed = entries.filter(e => e.exitedAt);
  const guessed = closed.filter(e => e.isEstimated).length;

  // ------------------------------------------------------- complaint figures
  const done = complaints.filter(c => c.resolvedAt);
  const responded = complaints.filter(c => c.firstRespondedAt);

  const avgMinutes = (rows: any[], startKey: string, endKey: string) => {
    const spans = rows
      .filter(r => r[startKey] && r[endKey])
      .map(r => (new Date(r[endKey]).getTime() - new Date(r[startKey]).getTime()) / 60000);
    return spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null;
  };

  /**
   * Two promises, measured separately — because they fail differently.
   *
   * The complaint everybody remembers is the one nobody replied to for a week;
   * the one that actually costs money is the one answered promptly and never
   * fixed. Collapsing them into a single "SLA met" number hides whichever of
   * the two a society is bad at.
   *
   * Measured against the deadline written on each complaint at the time, not
   * against a global target — a society promising 4 hours and one promising 48
   * are not comparable, and averaging them flatters the slow one.
   */
  const withResponseDue = complaints.filter(c => c.firstResponseDueAt && c.firstRespondedAt);
  const respondedOnTime = withResponseDue.filter(
    c => new Date(c.firstRespondedAt!) <= new Date(c.firstResponseDueAt!),
  ).length;

  const withDue = complaints.filter(c => c.resolutionDueAt && (c.resolvedAt || c.closedAt));
  const onTime = withDue.filter(
    c => new Date(c.resolvedAt || c.closedAt!) <= new Date(c.resolutionDueAt!),
  ).length;

  const byComplaintCategory = new Map<string, { raised: number; resolved: number; reopened: number }>();
  for (const c of complaints) {
    const key = c.category || 'Other';
    const row = byComplaintCategory.get(key) || { raised: 0, resolved: 0, reopened: 0 };
    row.raised++;
    if (c.resolvedAt) row.resolved++;
    if ((c.reopenCount || 0) > 0) row.reopened++;
    byComplaintCategory.set(key, row);
  }

  const byStaff = new Map<string, { name: string; assigned: number; resolved: number; reopened: number }>();
  for (const c of complaints) {
    if (!c.assigneeStaffId) continue;
    const key = String(c.assigneeStaffId);
    const row = byStaff.get(key) || { name: c.assigneeName || 'Unknown', assigned: 0, resolved: 0, reopened: 0 };
    row.assigned++;
    if (c.resolvedAt) row.resolved++;
    if ((c.reopenCount || 0) > 0) row.reopened++;
    byStaff.set(key, row);
  }

  const byAsset = new Map<string, number>();
  for (const c of complaints) {
    if (!c.assetId) continue;
    const key = String(c.assetId);
    byAsset.set(key, (byAsset.get(key) || 0) + 1);
  }

  const rated = complaints.filter(c => typeof c.rating === 'number');

  return {
    from, to,
    gate: {
      entries: entries.length,
      byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
      exitsRecorded: closed.length,
      // The honesty figure. Every competitor's "who is inside" is quietly
      // wrong; this one states how much of it was a guess.
      autoClosedGuesses: guessed,
      exitAccuracy: closed.length ? Math.round(((closed.length - guessed) / closed.length) * 1000) / 10 : null,
    },
    complaints: {
      raised: complaints.length,
      resolved: done.length,
      stillOpen: complaints.filter(c => !c.resolvedAt && !c.closedAt).length,
      reopened: complaints.filter(c => (c.reopenCount || 0) > 0).length,
      avgFirstResponseMinutes: avgMinutes(responded, 'createdAt', 'firstRespondedAt'),
      avgResolutionMinutes: avgMinutes(done, 'createdAt', 'resolvedAt'),
      firstResponseSlaMet: withResponseDue.length
        ? Math.round((respondedOnTime / withResponseDue.length) * 1000) / 10 : null,
      firstResponseMeasuredOn: withResponseDue.length,
      slaMet: withDue.length ? Math.round((onTime / withDue.length) * 1000) / 10 : null,
      slaMeasuredOn: withDue.length,
      avgRating: rated.length
        ? Math.round((rated.reduce((a, c) => a + (c.rating || 0), 0) / rated.length) * 10) / 10
        : null,
      byCategory: [...byComplaintCategory.entries()].map(([category, v]) => ({ category, ...v }))
        .sort((a, b) => b.raised - a.raised),
      byStaff: [...byStaff.values()].sort((a, b) => b.assigned - a.assigned),
      // A single machine with five faults in a month is the sentence worth
      // reading out at the AMC renewal.
      worstAssets: [...byAsset.entries()].map(([assetId, faults]) => ({ assetId, faults }))
        .sort((a, b) => b.faults - a.faults).slice(0, 10),
    },
    staffOnBooks: staff.length,
  };
}
