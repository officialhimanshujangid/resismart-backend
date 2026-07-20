import mongoose from 'mongoose';
import { VisitorEntry, IVisitorEntry } from '../models/visitor-entry.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Flat } from '../models/flat.model';
import { getOrCreateOpsPolicy, approvalRuleFor, expectedStayFor } from './ops-policy.service';
import { EffectiveAccess, allowsBlock } from './access-role.service';
import s3Service from './s3.service';
import { notify } from './notification.service';
import { usersOfFlat } from './notify-recipients';
import { checkBlocked } from './gate-depth.service';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class VisitorError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Actor { userId: string; userName: string }

/**
 * Recording who comes and goes.
 *
 * Two rules run through everything here:
 *
 * 1. **A resident sees their own flat and nothing else.** Not a setting. The
 *    documented real-world failure of these systems is not a hack — it is a
 *    resident discovering their neighbours could read who had visited them.
 *
 * 2. **A guess must admit it is a guess.** Exit tracking has no forcing
 *    function, so entries get closed off automatically at night. Those are
 *    marked `isEstimated` and counted separately, which turns an unreliable
 *    "who is inside" list into one that states its own error bar.
 */

/**
 * A short per-day code, so a guard can say "number fourteen" out loud.
 *
 * Deliberately not gapless and not a sequence counter: this is a label for
 * humans standing at a gate, not a document number an auditor will trace. Using
 * the finance numbering machinery here would imply a permanence it does not
 * have — and would make a failed entry burn a number.
 */
async function nextEntryCode(societyId: string, when: Date): Promise<string> {
  const dayStart = new Date(when.getFullYear(), when.getMonth(), when.getDate());
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const todays = await VisitorEntry.countDocuments({
    societyId: oid(societyId),
    enteredAt: { $gte: dayStart, $lt: dayEnd },
  });
  const dd = String(when.getDate()).padStart(2, '0');
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  return `${dd}${mm}-${String(todays + 1).padStart(3, '0')}`;
}

export interface RecordEntryInput {
  category: string;
  visitorName: string;
  visitorPhone?: string;
  photoKey?: string;
  idType?: string;
  idLast4?: string;
  flatId?: string;
  vehicleNumber?: string;
  vehiclePhotoKey?: string;
  notes?: string;
}

/**
 * Log an arrival.
 *
 * Phase 4 deliberately stops short of asking the resident: everything here
 * works with no push infrastructure at all, which is what lets a society
 * replace its paper register on day one. The approval step lands in Phase 8 and
 * slots in front of this without changing what it writes.
 */
export async function recordEntry(
  societyId: string, input: RecordEntryInput, actor: Actor,
): Promise<IVisitorEntry> {
  const policy = await getOrCreateOpsPolicy(societyId, actor.userId, actor.userName);

  if (!policy.gate.capture.categoriesEnabled.includes(input.category)) {
    throw new VisitorError(`This society does not record "${input.category}" visitors.`);
  }
  if (policy.gate.capture.phone === 'REQUIRED' && !input.visitorPhone) {
    throw new VisitorError('A phone number is required for every visitor here.');
  }
  if (policy.gate.capture.photo === 'REQUIRED' && !input.photoKey) {
    throw new VisitorError('A photo is required for every visitor here.');
  }
  if (!input.visitorName?.trim()) throw new VisitorError('Who is at the gate?');

  // The flat must be ours. A flatId from elsewhere would file a stranger's
  // visitor against a flat this society cannot even see.
  let flat: any = null;
  if (input.flatId) {
    flat = await Flat.findOne({ _id: input.flatId, societyId: oid(societyId) })
      .select('number blockName blockId').lean();
    if (!flat) throw new VisitorError('That flat does not belong to this society.');
  }

  const now = new Date();
  const stay = expectedStayFor(policy, input.category);

  // Checked on phone and plate only — never on name. See gate-blocklist.model
  // for why matching a hand-typed name is how you turn away the wrong Ramesh.
  const flagged = await checkBlocked(societyId, {
    phone: input.visitorPhone,
    vehicleNumber: input.vehicleNumber,
  });

  const entry = await VisitorEntry.create({
    societyId: oid(societyId),
    entryCode: await nextEntryCode(societyId, now),
    category: input.category,
    visitorName: input.visitorName.trim(),
    visitorPhone: policy.gate.capture.phone === 'OFF' ? undefined : input.visitorPhone,
    photoKey: policy.gate.capture.photo === 'OFF' ? undefined : input.photoKey,
    idType: policy.gate.capture.idProof === 'OFF' ? undefined : input.idType,
    idLast4: policy.gate.capture.idProof === 'OFF' ? undefined : input.idLast4,
    flatId: flat?._id,
    flatLabel: flat ? `${flat.blockName || ''} ${flat.number}`.trim() : undefined,
    blockId: flat?.blockId,
    vehicleNumber: policy.gate.vehicles.track ? input.vehicleNumber : undefined,
    vehiclePhotoKey: policy.gate.vehicles.track ? input.vehiclePhotoKey : undefined,
    status: 'INSIDE',
    enteredAt: now,
    // A warning, carried onto the record. The guard is not stopped — the
    // software cannot know whether tonight is the emergency — but "did anybody
    // know?" must be answerable afterwards, and a banner that flashed for four
    // seconds cannot answer it.
    flaggedReason: flagged.blocked
      ? `Matched the blocklist on ${flagged.matchedOn?.toLowerCase()}: ${flagged.reason}`
      : undefined,
    // Only meaningful when the society tracks exits at all — otherwise it would
    // generate overstay alerts for a register that never records departures.
    expectedOutAt: policy.gate.exit.trackExit ? new Date(now.getTime() + stay * 60_000) : undefined,
    isEstimated: false,
    guardName: actor.userName,
    notes: input.notes,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });

  /**
   * Tell the flat somebody has arrived.
   *
   * Not awaited: the guard is standing at the gate with a visitor in front of
   * them, and the entry is already saved. A slow push must never be the reason
   * the console spins.
   *
   * This is a *notice*, not an approval — nobody is being asked to allow
   * anything, and the visitor is already inside. Approval is Phase 8, and
   * conflating the two would mean shipping a message that implies a decision
   * the software cannot yet act on.
   */
  if (entry.flatId) {
    (async () => {
      const to = await usersOfFlat(societyId, String(entry.flatId));
      await notify({
        societyId, userIds: to, kind: 'GATE_ENTRY',
        title: `${entry.visitorName} has arrived`,
        body: `${entry.category.toLowerCase()} at the gate for ${entry.flatLabel || 'your flat'}`,
        link: `/dashboard/gate/log?id=${entry._id}`,
        entityType: 'VisitorEntry', entityId: String(entry._id),
      });
    })().catch(e => logger.error(`Gate arrival notification failed: ${e.message}`));
  }

  return entry;
}

/** Mark a visitor as gone. */
export async function recordExit(
  societyId: string, entryId: string, actor: Actor, source: 'GUARD' | 'SCAN' = 'GUARD',
): Promise<IVisitorEntry> {
  const entry = await VisitorEntry.findOne({ _id: entryId, societyId: oid(societyId) });
  if (!entry) throw new VisitorError('That entry could not be found.', 404);
  if (entry.status === 'LEFT') throw new VisitorError('That visitor is already marked as gone.');
  if (entry.status === 'DENIED') throw new VisitorError('That visitor was never let in.');

  entry.status = 'LEFT';
  entry.exitedAt = new Date();
  entry.exitSource = source;
  entry.isEstimated = false;
  entry.exitGuardName = actor.userName;
  entry.updatedBy = oid(actor.userId);
  entry.updatedByName = actor.userName;
  await entry.save();
  return entry;
}

export interface InsideRow {
  _id: string;
  entryCode: string;
  category: string;
  visitorName: string;
  flatLabel?: string;
  enteredAt: Date;
  expectedOutAt?: Date;
  /** Minutes past the expected departure. Zero when still within it. */
  overdueMinutes: number;
  vehicleNumber?: string;
}

/** Who is inside right now, with how long each has overstayed. */
export async function whoIsInside(societyId: string, access?: EffectiveAccess): Promise<InsideRow[]> {
  const rows = await VisitorEntry.find({ societyId: oid(societyId), status: 'INSIDE' })
    .sort({ enteredAt: -1 })
    .select('entryCode category visitorName flatLabel blockId enteredAt expectedOutAt vehicleNumber')
    .lean();

  const now = Date.now();
  return rows
    // A wing-scoped role sees its own wings. Society-wide visitors (no wing at
    // all) stay visible to everyone — otherwise a wing-scoped member's list
    // would be missing the contractor standing in the compound.
    .filter(r => !access || allowsBlock(access, r.blockId ? String(r.blockId) : undefined))
    .map(r => ({
      _id: String(r._id),
      entryCode: r.entryCode,
      category: r.category,
      visitorName: r.visitorName,
      flatLabel: r.flatLabel,
      enteredAt: r.enteredAt,
      expectedOutAt: r.expectedOutAt,
      overdueMinutes: r.expectedOutAt && r.expectedOutAt.getTime() < now
        ? Math.floor((now - r.expectedOutAt.getTime()) / 60_000)
        : 0,
      vehicleNumber: r.vehicleNumber,
    }));
}

export interface LogQuery {
  from?: string;
  to?: string;
  category?: string;
  flatId?: string;
  status?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

/**
 * The gate log.
 *
 * `residentFlatIds` is the whole privacy story: when it is passed, the query is
 * clamped to those flats and no argument from the caller can widen it. The
 * controller decides who gets clamped; this function cannot be talked out of it.
 */
export async function listEntries(
  societyId: string, query: LogQuery, opts: { residentFlatIds?: string[]; access?: EffectiveAccess } = {},
) {
  const filter: any = { societyId: oid(societyId) };

  if (opts.residentFlatIds) {
    // Even an empty list must mean "nothing", not "everything".
    filter.flatId = { $in: opts.residentFlatIds.map(oid) };
  } else if (query.flatId) {
    filter.flatId = oid(query.flatId);
  }

  if (query.category) filter.category = query.category;
  if (query.status) filter.status = query.status;
  if (query.from || query.to) {
    filter.enteredAt = {};
    if (query.from) filter.enteredAt.$gte = new Date(query.from);
    if (query.to) filter.enteredAt.$lte = new Date(query.to);
  }
  if (query.q) {
    const rx = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ visitorName: rx }, { visitorPhone: rx }, { vehicleNumber: rx }, { entryCode: rx }];
  }

  // A wing-scoped role is filtered, not refused — a 403 would leave them unable
  // to see the wings they ARE responsible for.
  if (opts.access && !opts.access.isAdmin && !opts.access.scope.allBlocks) {
    filter.$and = [
      ...(filter.$and || []),
      { $or: [{ blockId: { $in: opts.access.scope.blockIds.map(oid) } }, { blockId: { $exists: false } }] },
    ];
  }

  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));

  const [rows, total] = await Promise.all([
    VisitorEntry.find(filter).sort({ enteredAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    VisitorEntry.countDocuments(filter),
  ]);

  return { rows, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
}

/** A presigned link for a visitor photo, checked against the same rules as the log. */
export async function photoUrl(
  societyId: string, entryId: string, which: 'visitor' | 'vehicle', residentFlatIds?: string[],
): Promise<string> {
  const filter: any = { _id: entryId, societyId: oid(societyId) };
  if (residentFlatIds) filter.flatId = { $in: residentFlatIds.map(oid) };

  const entry = await VisitorEntry.findOne(filter).select('photoKey vehiclePhotoKey').lean();
  if (!entry) throw new VisitorError('That entry could not be found.', 404);
  const key = which === 'vehicle' ? entry.vehiclePhotoKey : entry.photoKey;
  if (!key) throw new VisitorError('There is no photo on that entry.', 404);
  return s3Service.getSignedDownloadUrl(key, { expiresIn: 300 });
}

// -------------------------------------------------------------- nightly jobs

export interface CloseOffResult { societyId: string; closed: number }

/**
 * Close off the day's stragglers.
 *
 * This is the honest half of the exit problem. Nobody tapped "left" for these,
 * so we say so — `isEstimated` is set, `exitSource` is AUTO_CLOSE, and the
 * morning report counts them. What it must never do is quietly mark them as a
 * clean departure, because then the "who is inside" list would look perfect
 * while being wrong.
 */
export async function autoCloseStragglers(societyId: string, at = new Date()): Promise<number> {
  const policy = await SocietyOpsPolicy.findOne({ societyId }).select('gate.exit').lean();
  if (!policy?.gate?.exit?.trackExit) return 0;

  const res = await VisitorEntry.updateMany(
    { societyId: oid(societyId), status: 'INSIDE', enteredAt: { $lt: at } },
    { $set: { status: 'LEFT', exitedAt: at, exitSource: 'AUTO_CLOSE', isEstimated: true } },
  );
  if (res.modifiedCount) {
    logger.info(`Society ${societyId}: auto-closed ${res.modifiedCount} visitor(s) still marked inside`);
  }
  return res.modifiedCount;
}

export interface DayReconciliation {
  date: string;
  entries: number;
  exitsRecorded: number;
  estimated: number;
  /**
   * Percentage of departures a person actually recorded — or `null` for a
   * society that does not track exits at all.
   *
   * `null`, not `0`. A register-only society never promised to record
   * departures, and reporting it as 0% accurate would be an accusation about a
   * feature it deliberately switched off. The number only means something where
   * somebody was supposed to be tapping "left".
   */
  accuracy: number | null;
}

/**
 * Yesterday, in one line the committee can act on.
 *
 * The number that matters is `accuracy`. MyGate's answer to a broken exit log
 * is to retrain the guard; this makes the case for that conversation, with a
 * figure, every morning — which is a management problem being handed to
 * management rather than a software problem being hidden.
 */
export async function reconcileDay(societyId: string, day = new Date()): Promise<DayReconciliation> {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(start.getTime() + 86_400_000);

  const [policy, rows] = await Promise.all([
    SocietyOpsPolicy.findOne({ societyId }).select('gate.exit.trackExit').lean(),
    VisitorEntry.find({
      societyId: oid(societyId),
      enteredAt: { $gte: start, $lt: end },
    }).select('status isEstimated').lean(),
  ]);
  const tracksExit = policy?.gate?.exit?.trackExit !== false;

  const entries = rows.length;
  const left = rows.filter(r => r.status === 'LEFT');
  const estimated = left.filter(r => r.isEstimated).length;
  const exitsRecorded = left.length - estimated;

  return {
    date: start.toISOString().slice(0, 10),
    entries,
    exitsRecorded,
    estimated,
    accuracy: !tracksExit ? null : entries ? Math.round((exitsRecorded / entries) * 100) : 100,
  };
}

/** Visitors past their expected departure who have not been flagged yet. */
export async function findOverstays(societyId: string, at = new Date()) {
  const policy = await SocietyOpsPolicy.findOne({ societyId }).select('gate.exit').lean();
  if (!policy?.gate?.exit?.trackExit) return [];

  const grace = (policy.gate.exit.overstayAlertAfterMinutes ?? 60) * 60_000;
  return VisitorEntry.find({
    societyId: oid(societyId),
    status: 'INSIDE',
    expectedOutAt: { $lt: new Date(at.getTime() - grace) },
    overstayNotifiedAt: { $exists: false },
  }).select('entryCode visitorName flatLabel enteredAt expectedOutAt').lean();
}

/** Stamp an overstay as flagged, so the same visitor is not reported nightly. */
export async function markOverstayNotified(ids: string[]) {
  if (!ids.length) return;
  await VisitorEntry.updateMany({ _id: { $in: ids.map(oid) } }, { $set: { overstayNotifiedAt: new Date() } });
}

/**
 * Delete entries older than the society's retention window — and their photos.
 *
 * Under DPDP the society is the data fiduciary and personal data must go once
 * its purpose is served. A visitor's face is personal data; leaving the S3
 * object behind while deleting the row would be the worst of both worlds, so
 * the objects go first and the rows only after.
 */
export async function purgeOldEntries(societyId: string, at = new Date()): Promise<number> {
  const policy = await SocietyOpsPolicy.findOne({ societyId }).select('privacy').lean();
  const days = policy?.privacy?.retentionDays ?? 90;
  const cutoff = new Date(at.getTime() - days * 86_400_000);

  const doomed = await VisitorEntry.find({ societyId: oid(societyId), createdAt: { $lt: cutoff } })
    .select('photoKey vehiclePhotoKey').lean();
  if (!doomed.length) return 0;

  if (policy?.privacy?.purgePhotosWithEntry !== false) {
    const keys = doomed.flatMap(d => [d.photoKey, d.vehiclePhotoKey].filter(Boolean) as string[]);
    for (const key of keys) {
      // One failure must not strand the rest. A missing object is the desired
      // end state anyway, so a failed delete is worth logging, not retrying.
      try { await s3Service.deleteObject(key); }
      catch (e: any) { logger.warn(`Society ${societyId}: could not delete ${key}: ${e.message}`); }
    }
  }

  const res = await VisitorEntry.deleteMany({ societyId: oid(societyId), createdAt: { $lt: cutoff } });
  logger.info(`Society ${societyId}: purged ${res.deletedCount} visitor entries older than ${days} days`);
  return res.deletedCount || 0;
}
