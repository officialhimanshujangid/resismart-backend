import mongoose from 'mongoose';
import { VisitorEntry, IVisitorEntry, EntryStatus, AdmittedVia, HostKind } from '../models/visitor-entry.model';
import {
  SocietyOpsPolicy, RESIDENT_MOVEMENT, ISocietyOpsPolicy, ID_PROOF_LABELS,
} from '../models/society-ops-policy.model';
import { Flat } from '../models/flat.model';
import { getOrCreateOpsPolicy, approvalRuleFor, expectedStayFor } from './ops-policy.service';
import { EffectiveAccess, allowsBlock } from './access-role.service';
import s3Service from './s3.service';
import { notify } from './notification.service';
import { resolveHostAudience, HostAudience } from './gate-approval.service';
import { checkBlocked } from './gate-depth.service';
import { assertGateFor, defaultGate } from './gate-crud.service';
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
  /** The staff member on the gate — closes the dead `guardStaffId` link. */
  guardStaffId?: string;
  /** The physical gate they came in by. */
  entryGateId?: string;
  /** Who they came to see, when it is not simply a flat. See `HostKind`. */
  hostKind?: HostKind;
  hostUserId?: string;
  hostStaffId?: string;
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
  // Thin wrapper kept for the tests and any caller that just wants a plain
  // admit-now entry. The real decision — ask, notify, or let straight in —
  // lives in arrival.service, which calls createEntry below.
  return createEntry(societyId, input, actor, { status: 'INSIDE', admittedVia: 'GUARD', notifyArrival: true });
}

export interface CreateEntryOptions {
  status: EntryStatus;
  admittedVia?: AdmittedVia;
  approvalRequestId?: string;
  gatePassId?: string;
  decidedByName?: string;
  decisionReason?: string;
  /** Send the host a "somebody arrived" notice. Off for AWAITING — the approval already notified. */
  notifyArrival?: boolean;
  /**
   * The host, already resolved by the caller.
   *
   * Passed in rather than looked up again so the label stored on the entry and
   * the people notified about it come from ONE resolution. Two lookups either
   * side of a decision is how a notice ends up naming a host nobody was told
   * about; it is the same class of bug as having two audience functions.
   */
  host?: HostAudience;
  /**
   * When they actually walked in — for offline reconciliation only.
   *
   * A queued arrival synced at 19:40 happened at 19:05, and writing 19:40
   * would make the register lie about the evening and give the visitor an
   * expected departure half an hour late.
   */
  enteredAt?: Date;
  /** The guard device's queue id. The dedupe key; see the model. */
  offlineClientId?: string;
  /** See `assertEntryAllowed` — the capture rules do not apply to a fact. */
  reconciling?: boolean;
}

/**
 * Everything that can REFUSE an entry, separated from writing one.
 *
 * Pulled out of `createEntry` because of the ordering bug it existed inside:
 * `arriveByPass` burned the pass first and validated second, so in any society
 * with `capture.photo = 'REQUIRED'` every single pass redemption threw AFTER
 * `usedCount` had been incremented. The visitor was turned away and the
 * invitation was destroyed in the same breath, with no transaction and no
 * compensating decrement. A caller that is about to do something irreversible
 * can now ask, first, whether the entry it is going to write is even allowed.
 *
 * Returns the policy and the flat it had to load anyway, so the check costs
 * nothing when `createEntry` immediately follows it.
 */
export async function assertEntryAllowed(
  societyId: string, input: RecordEntryInput, actor: Actor,
  opts: { reconciling?: boolean } = {},
): Promise<{ policy: ISocietyOpsPolicy; flat: any }> {
  const policy = await getOrCreateOpsPolicy(societyId, actor.userId, actor.userName);

  /**
   * A resident's own coming and going.
   *
   * This is the one category the software refuses by default, and the refusal
   * is the feature. `gate.residents.logMovement` has existed since the module
   * was written — stored, validated and drawn as a switch — while nothing
   * anywhere read it, so a society that left it OFF was recording residents
   * exactly as if it were ON, and a society that turned it on gained nothing.
   *
   * Now the switch is the gate itself: with it off there is no way to write a
   * resident movement at all, which is a stronger guarantee than a policy
   * everybody promises to follow. `logVehicleOnly` narrows it further to the
   * plate — the society learns a car came in, not who was in it.
   */
  if (input.category === RESIDENT_MOVEMENT) {
    if (!policy.gate.residents.logMovement) {
      throw new VisitorError(
        'This society does not record residents coming and going. A committee can switch it on in gate settings.',
        403,
      );
    }
    if (policy.gate.residents.logVehicleOnly && !input.vehicleNumber?.trim()) {
      throw new VisitorError('Only resident vehicles are recorded here — a registration number is needed.');
    }
  } else if (!opts.reconciling && !policy.gate.capture.categoriesEnabled.includes(input.category)) {
    throw new VisitorError(`This society does not record "${input.category}" visitors.`);
  }

  // Every capture rule below is about a VISITOR. A resident has already been
  // identified by the flat they live in, and demanding their photo and phone
  // at their own front gate is the surveillance this setting exists to refuse.
  const isResident = input.category === RESIDENT_MOVEMENT;

  if (!isResident) {
    /**
     * REQUIRED means "do not admit without it" — and admitting is exactly what
     * is no longer on the table when `reconciling` is set.
     *
     * That flag is only ever true for an arrival a guard device already let in
     * while it had no network. The person has been inside for half an hour.
     * Enforcing a photo rule now cannot produce a photo; it can only decide
     * whether the register knows they are in the building. Refusing the record
     * to honour a rule about admission is how a society ends up with a
     * compliant policy and a wrong list of who is inside.
     */
    if (!opts.reconciling) {
      if (policy.gate.capture.phone === 'REQUIRED' && !input.visitorPhone) {
        throw new VisitorError('A phone number is required for every visitor here.');
      }
      if (policy.gate.capture.photo === 'REQUIRED' && !input.photoKey) {
        throw new VisitorError('A photo is required for every visitor here.');
      }
    }
    if (!input.visitorName?.trim()) throw new VisitorError('Who is at the gate?');

    /**
     * The ID the society actually said it accepts.
     *
     * `gate.capture.allowedIdTypes` was configurable-looking and read by
     * nothing: `idType` arrived as a free string and was written to the register
     * exactly as sent. So a society that said "driving licence or passport" got
     * whatever the guard's device happened to send — including, in a keyboard
     * field, "Aadhaar", the one document this product refuses to hold at a gate
     * (see `ID_PROOF_TYPES`). A list nobody checks is a list that describes
     * nothing.
     *
     * The check is skipped entirely when `idProof: OFF`, because `createEntry`
     * then drops `idType` on the floor anyway — refusing an entry over a field
     * about to be discarded would turn a switched-off feature into an error
     * message.
     *
     * `reconciling` is exempt for the same reason the photo and phone rules are:
     * the person was admitted an hour ago by a device with no network, and the
     * only question left is whether the register knows they are in the building.
     */
    if (!opts.reconciling && policy.gate.capture.idProof !== 'OFF') {
      const allowed = policy.gate.capture.allowedIdTypes || [];
      const said = (ID_PROOF_LABELS[String(input.idType || '')] || String(input.idType || '')).trim();
      const listed = allowed.map(t => ID_PROOF_LABELS[t] || t).join(', ');

      if (input.idType && !allowed.includes(input.idType)) {
        throw new VisitorError(
          listed
            ? `This society accepts a ${listed} — not a ${said}.`
            : 'This society does not accept any ID proof at the gate.',
        );
      }
      if (policy.gate.capture.idProof === 'REQUIRED' && (!input.idType || !input.idLast4?.trim())) {
        throw new VisitorError(
          `An ID is required for every visitor here — a ${listed || 'proof of identity'}, and its last four digits.`,
        );
      }
    }
  } else if (!input.flatId) {
    throw new VisitorError('Which flat is the resident from?');
  }

  // The flat must be ours. A flatId from elsewhere would file a stranger's
  // visitor against a flat this society cannot even see.
  let flat: any = null;
  if (input.flatId) {
    flat = await Flat.findOne({ _id: input.flatId, societyId: oid(societyId) })
      .select('number blockName blockId').lean();
    if (!flat) throw new VisitorError('That flat does not belong to this society.');
  }

  return { policy, flat };
}

/**
 * Write one visitor entry, in whatever state the caller decided.
 *
 * This is the single place a `VisitorEntry` is born. Everything that used to
 * be three unconnected paths — the guard's log, an approved visitor, a
 * redeemed pass — now goes through here with a different `status` and
 * `admittedVia`, so the register can never again disagree with itself about
 * who is inside.
 */
export async function createEntry(
  societyId: string, input: RecordEntryInput, actor: Actor, opts: CreateEntryOptions,
): Promise<IVisitorEntry> {
  const { policy, flat } = await assertEntryAllowed(societyId, input, actor, { reconciling: opts.reconciling });
  const isResident = input.category === RESIDENT_MOVEMENT;

  const hostKind: HostKind = input.hostKind || 'FLAT';

  /**
   * The host, resolved once and used for both the label and the audience.
   *
   * Only looked up here when the caller did not already do it. For an ordinary
   * flat arrival that nobody needs telling about, the flat row this function
   * already loaded IS the answer, and a second round trip to learn a label we
   * are holding would be work for nothing.
   */
  const host: HostAudience = opts.host
    || (hostKind !== 'FLAT' || opts.notifyArrival
      ? await resolveHostAudience(societyId, {
          hostKind, flatId: input.flatId, hostUserId: input.hostUserId, hostStaffId: input.hostStaffId,
        })
      : {
          userIds: [], via: 'NOT_RESOLVED', hostKind: 'FLAT',
          hostLabel: flat ? `${flat.blockName || ''} ${flat.number}`.trim() : 'The society',
        });

  const now = opts.enteredAt || new Date();
  const stay = expectedStayFor(policy, input.category);

  // Checked on phone and plate only — never on name. See gate-blocklist.model
  // for why matching a hand-typed name is how you turn away the wrong Ramesh.
  const flagged = await checkBlocked(societyId, {
    phone: input.visitorPhone,
    vehicleNumber: input.vehicleNumber,
  });

  // The physical gate they came in by. Falls back to the society's only gate
  // when it has one, so a single-gate society never has to pick.
  const gate = input.entryGateId
    ? await assertGateFor(societyId, input.entryGateId, 'entry')
    : (await defaultGate(societyId).then(g => g ? { id: g._id as any, name: g.name } : undefined));

  // The exit clock only starts once they are actually inside. An AWAITING or
  // AT_GATE entry has not entered, so an expected-out time would generate a
  // bogus overstay for somebody who was never admitted.
  const inside = opts.status === 'INSIDE';

  const entry = await VisitorEntry.create({
    societyId: oid(societyId),
    entryCode: await nextEntryCode(societyId, now),
    category: input.category,
    // With `logVehicleOnly` the society has said it wants to know a car came
    // in, not who was in it — so the name is deliberately replaced by the flat
    // rather than merely left blank. Storing the name and choosing not to show
    // it would be the same data with a thinner promise.
    visitorName: isResident
      ? (policy.gate.residents.logVehicleOnly
          ? `Resident vehicle · ${flat ? `${flat.blockName || ''} ${flat.number}`.trim() : ''}`.trim()
          : (input.visitorName?.trim() || 'Resident'))
      : input.visitorName!.trim(),
    visitorPhone: (isResident || policy.gate.capture.phone === 'OFF') ? undefined : input.visitorPhone,
    photoKey: (isResident || policy.gate.capture.photo === 'OFF') ? undefined : input.photoKey,
    idType: (isResident || policy.gate.capture.idProof === 'OFF') ? undefined : input.idType,
    idLast4: (isResident || policy.gate.capture.idProof === 'OFF') ? undefined : input.idLast4,
    flatId: flat?._id,
    flatLabel: flat ? `${flat.blockName || ''} ${flat.number}`.trim() : undefined,
    blockId: flat?.blockId,
    hostKind,
    hostUserId: input.hostUserId ? oid(input.hostUserId) : undefined,
    hostStaffId: input.hostStaffId ? oid(input.hostStaffId) : undefined,
    // Denormalised deliberately: this is what every screen and every message
    // says the visit was FOR, and it must keep saying it after the committee
    // term ends and the seat changes hands.
    hostLabel: host.hostLabel,
    offlineClientId: opts.offlineClientId,
    // A resident movement carries its plate whatever `vehicles.track` says: the
    // society switched resident logging on for the car, and dropping the number
    // would leave a row that records nothing at all.
    vehicleNumber: (isResident || policy.gate.vehicles.track) ? input.vehicleNumber : undefined,
    vehiclePhotoKey: (!isResident && policy.gate.vehicles.track) ? input.vehiclePhotoKey : undefined,
    status: opts.status,
    admittedVia: inside ? opts.admittedVia : undefined,
    approvalRequestId: opts.approvalRequestId ? oid(opts.approvalRequestId) : undefined,
    gatePassId: opts.gatePassId ? oid(opts.gatePassId) : undefined,
    decidedByName: opts.decidedByName,
    decisionReason: opts.decisionReason,
    decidedAt: opts.admittedVia ? now : undefined,
    enteredAt: now,
    // A warning, carried onto the record. The guard is not stopped — the
    // software cannot know whether tonight is the emergency — but "did anybody
    // know?" must be answerable afterwards, and a banner that flashed for four
    // seconds cannot answer it.
    flaggedReason: flagged.blocked
      ? `Matched the blocklist on ${flagged.matchedOn?.toLowerCase()}: ${flagged.reason}`
      : undefined,
    // No expected-out time for a resident. They live here; there is no length
    // of stay at which somebody in their own home becomes an overstay to be
    // reported to the committee.
    expectedOutAt: (inside && !isResident && policy.gate.exit.trackExit)
      ? new Date(now.getTime() + stay * 60_000) : undefined,
    isEstimated: false,
    entryGateId: gate?.id,
    entryGateName: gate?.name,
    guardStaffId: input.guardStaffId ? oid(input.guardStaffId) : undefined,
    guardName: actor.userName,
    notes: input.notes,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });

  // A "somebody arrived" notice — a NOTICE, not an ask. Suppressed for an
  // AWAITING entry, because the approval request already asked and a second
  // message would read as two visitors.
  //
  // The test is on the HOST, not on `entry.flatId`. It used to be the latter,
  // which meant a visitor for the secretary or for the office — who by
  // definition has no flat — produced no notice at all, silently.
  if (opts.notifyArrival && inside && (entry.flatId || entry.hostUserId || hostKind === 'OFFICE')) {
    (async () => {
      // The audience as the gate defines it — a rented flat's tenant and never
      // its landlord, the committee member actually being visited and not the
      // whole committee. One function answers this for every kind of host; the
      // moment there were two, an owner three years gone was being told the
      // name of every person who visited their tenant.
      const to = host.userIds;
      if (!to.length) return;
      await notify({
        societyId, userIds: to, kind: 'GATE_ENTRY',
        title: `${entry.visitorName} has arrived`,
        body: `${entry.category.toLowerCase()} at the gate for ${entry.hostLabel}`,
        link: `/dashboard/visitors/log?id=${entry._id}`,
        entityType: 'VisitorEntry', entityId: String(entry._id),
      });
    })().catch(e => logger.error(`Gate arrival notification failed: ${e.message}`));
  }

  return entry;
}

/**
 * Move an existing entry to its final state once a decision arrives.
 *
 * Used when a visitor was AWAITING and the flat (or the guard, or a timeout)
 * has now answered. The entry already exists — the person was recorded the
 * moment they reached the gate — so this only settles it.
 */
export async function settleEntry(
  societyId: string, entryId: string,
  decision: { status: EntryStatus; admittedVia?: AdmittedVia; decidedByName?: string; reason?: string },
  actor: Actor,
): Promise<IVisitorEntry | null> {
  const entry = await VisitorEntry.findOne({ _id: oid(entryId), societyId: oid(societyId) });
  // Only an entry still waiting may be settled. If it already resolved — a
  // race between the resident tapping and the guard overriding — leave the
  // first answer standing.
  if (!entry || entry.status !== 'AWAITING') return entry;

  const now = new Date();
  entry.status = decision.status;
  if (decision.status === 'INSIDE') {
    entry.admittedVia = decision.admittedVia;
    entry.enteredAt = now;
    const policy = await getOrCreateOpsPolicy(societyId, actor.userId, actor.userName);
    if (policy.gate.exit.trackExit) {
      entry.expectedOutAt = new Date(now.getTime() + expectedStayFor(policy, entry.category) * 60_000);
    }
  }
  entry.decidedByName = decision.decidedByName;
  entry.decisionReason = decision.reason;
  entry.decidedAt = now;
  entry.updatedBy = oid(actor.userId); entry.updatedByName = actor.userName;
  await entry.save();
  return entry;
}

/** Mark a visitor as gone. */
export async function recordExit(
  societyId: string, entryId: string, actor: Actor,
  source: 'GUARD' | 'SCAN' = 'GUARD', exitGateId?: string,
): Promise<IVisitorEntry> {
  const entry = await VisitorEntry.findOne({ _id: entryId, societyId: oid(societyId) });
  if (!entry) throw new VisitorError('That entry could not be found.', 404);
  if (entry.status === 'LEFT') throw new VisitorError('That visitor is already marked as gone.');
  if (entry.status === 'DENIED') throw new VisitorError('That visitor was never let in.');

  // The gate they LEFT by, which may differ from the one they came in by —
  // that difference is the whole reason entry and exit gates are separate.
  const gate = await assertGateFor(societyId, exitGateId, 'exit');

  entry.status = 'LEFT';
  entry.exitedAt = new Date();
  entry.exitSource = source;
  entry.exitGateId = gate?.id;
  entry.exitGateName = gate?.name;
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
  societyId: string, query: LogQuery,
  opts: { residentFlatIds?: string[]; hostUserId?: string; access?: EffectiveAccess } = {},
) {
  const filter: any = { societyId: oid(societyId) };

  if (opts.residentFlatIds) {
    /**
     * Even an empty list must mean "nothing", not "everything" — and the clamp
     * is on the FLAT or on being the host, never on one alone.
     *
     * Without the second half, a committee member who is visited at the office
     * cannot see their own visitor. The register recorded the visit, named
     * them as the host, notified them about it, and then hid it from them,
     * because "your visitors" was defined as "visitors to a flat you live in".
     * Attribution that the host themselves cannot read is not attribution.
     */
    const own: any[] = [{ flatId: { $in: opts.residentFlatIds.map(oid) } }];
    if (opts.hostUserId) own.push({ hostUserId: oid(opts.hostUserId) });
    filter.$and = [...(filter.$and || []), { $or: own }];
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
  societyId: string, entryId: string, which: 'visitor' | 'vehicle',
  residentFlatIds?: string[], access?: EffectiveAccess, hostUserId?: string,
): Promise<string> {
  const filter: any = { _id: entryId, societyId: oid(societyId) };
  // The same clamp as the log, including the host half — a resident who was
  // themselves the host may see the face of the person who came to see them.
  if (residentFlatIds) {
    const own: any[] = [{ flatId: { $in: residentFlatIds.map(oid) } }];
    if (hostUserId) own.push({ hostUserId: oid(hostUserId) });
    filter.$or = own;
  }

  // The wing scope, which `listEntries` has always applied and this did not.
  // A face photograph is the most sensitive thing the gate holds; it should be
  // the LAST place a scope is forgotten, and it was the only one.
  if (access && !access.isAdmin && !access.scope.allBlocks) {
    filter.blockId = { $in: access.scope.blockIds.map(oid) };
  }

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
 *
 * **The day bound is load-bearing.** The filter used to be `enteredAt < now`,
 * which is a tautology — every entry still marked INSIDE was entered in the
 * past — so the function did not close the day's stragglers, it closed
 * everybody in the building. Called at any moment other than the society's own
 * close-off hour it would mark a visitor who walked in thirty seconds earlier
 * as an unseen departure, which is worse than leaving them open: it fabricates
 * an exit that never happened and then reports itself as a guess about it.
 *
 * Bounding below matters for a second reason. `reconcileDay` scores a day by
 * `enteredAt`, so sweeping yesterday's leftovers into tonight's run would
 * silently rewrite an accuracy figure the committee has already read. A close-
 * off belongs to exactly one day, and only ever settles that day.
 */
export async function autoCloseStragglers(societyId: string, at = new Date()): Promise<number> {
  const policy = await SocietyOpsPolicy.findOne({ societyId }).select('gate.exit').lean();
  if (!policy?.gate?.exit?.trackExit) return 0;

  const dayStart = new Date(at.getFullYear(), at.getMonth(), at.getDate());

  const res = await VisitorEntry.updateMany(
    {
      societyId: oid(societyId), status: 'INSIDE',
      enteredAt: { $gte: dayStart, $lt: at },
    },
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
 * Actually tell somebody — the caller these two functions never had.
 *
 * `findOverstays` and `markOverstayNotified` shipped correct and complete, with
 * an index behind them, a `expectedOutAt` written on every entry, an
 * `overstayNotifiedAt` to keep the alert from repeating, and a policy field
 * (`gate.exit.overstayAlertAfterMinutes`) a society could configure in the
 * settings screen. Nothing anywhere called either of them. A society set "alert
 * after 60 minutes", the switch saved, and no alert was ever sent — the whole
 * feature existed except for the one line that made it happen.
 *
 * The host is told, not the committee. A contractor who is four hours over at
 * A-102 is A-102's business; broadcasting it to the society would be the same
 * mistake the vacant-flat branch was making, in a different place.
 *
 * Marked BEFORE the notification is awaited, deliberately: a mail failure that
 * left the stamp unset would re-report the same visitor every hour, and an
 * alert that repeats is an alert people learn to swipe away.
 */
export async function sweepOverstays(societyId: string, at = new Date()): Promise<number> {
  /**
   * A society on AUTO_EXPIRE is not chasing anybody, and telling it to would be
   * the opposite of what it asked for — see `expireDueVisits`. It shares this
   * caller deliberately: the hourly sweep already runs for every society that
   * tracks exits, and a second cron entry for the same question is how two
   * answers to one question start.
   */
  const mode = await SocietyOpsPolicy.findOne({ societyId }).select('gate.exit.mode').lean();
  if (mode?.gate?.exit?.mode === 'AUTO_EXPIRE') return expireDueVisits(societyId, at);

  const rows = await findOverstays(societyId, at);
  if (!rows.length) return 0;

  await markOverstayNotified(rows.map(r => String(r._id)));

  for (const row of rows) {
    try {
      const full = await VisitorEntry.findById(row._id)
        .select('flatId hostKind hostUserId hostStaffId hostLabel expectedOutAt').lean();
      if (!full) continue;

      const { userIds } = await resolveHostAudience(societyId, {
        hostKind: (full.hostKind as HostKind) || 'FLAT',
        flatId: full.flatId ? String(full.flatId) : undefined,
        hostUserId: full.hostUserId ? String(full.hostUserId) : undefined,
        hostStaffId: full.hostStaffId ? String(full.hostStaffId) : undefined,
      });
      if (!userIds.length) continue;

      const over = full.expectedOutAt
        ? Math.max(1, Math.round((at.getTime() - full.expectedOutAt.getTime()) / 60_000))
        : 0;
      await notify({
        societyId, userIds, kind: 'GATE_OVERSTAY',
        title: `${row.visitorName} is still inside`,
        body: over
          ? `${over} minute(s) past the expected departure for ${full.hostLabel || row.flatLabel || 'your flat'}. Tell the gate if they have already gone.`
          : `Still marked as inside for ${full.hostLabel || row.flatLabel || 'your flat'}. Tell the gate if they have already gone.`,
        link: `/dashboard/visitors/log?id=${row._id}`,
        entityType: 'VisitorEntry', entityId: String(row._id),
      });
    } catch (e: any) {
      // One bad row must not cost the rest their alert.
      logger.error(`Overstay alert failed for entry ${row._id}: ${e.message}`);
    }
  }

  logger.info(`Society ${societyId}: flagged ${rows.length} overstaying visitor(s)`);
  return rows.length;
}

/**
 * `gate.exit.mode: AUTO_EXPIRE` — the third exit mode, which until now existed
 * only as a word in a dropdown.
 *
 * MANUAL means a guard taps "left" and SCAN means the code is scanned on the
 * way out; both were implemented. AUTO_EXPIRE said "we do not record
 * departures — close each visit when it is expected to end" and did nothing at
 * all, so a society that chose it got MANUAL and an "inside" list that grew all
 * day. A promised behaviour with no implementation is worse than the absence of
 * the option: the society believes the question is handled.
 *
 * Three decisions worth stating:
 *
 *   **The exit time is the EXPECTED one, not now.** A visit expected to end at
 *   16:00 and closed by the 17:10 sweep left at 16:00 as far as this society's
 *   own policy is concerned. Stamping 17:10 would invent a fact about a person
 *   from the time the cron happened to run.
 *
 *   **`isEstimated` is set, always.** Nobody watched them leave. The exit is a
 *   policy, not an observation, and `reconcileDay` must keep counting it as a
 *   guess — otherwise choosing AUTO_EXPIRE would show a society 100% exit
 *   accuracy for recording nothing, which is the one number the whole exit
 *   design rests on.
 *
 *   **The host is not told.** In this mode an overstay is not an event; the
 *   visit simply ended. Alerting would be the nagging the society switched off.
 */
export async function expireDueVisits(societyId: string, at = new Date()): Promise<number> {
  const policy = await SocietyOpsPolicy.findOne({ societyId }).select('gate.exit').lean();
  // Not tracking exits at all, or tracking them some other way: not ours.
  if (!policy?.gate?.exit?.trackExit || policy.gate.exit.mode !== 'AUTO_EXPIRE') return 0;

  const res = await VisitorEntry.updateMany(
    {
      societyId: oid(societyId), status: 'INSIDE',
      expectedOutAt: { $exists: true, $lte: at },
    },
    // A pipeline update, because `exitedAt` is copied from the row's own
    // `expectedOutAt` rather than set to a constant.
    [{
      $set: {
        status: 'LEFT', exitedAt: '$expectedOutAt',
        exitSource: 'AUTO_CLOSE', isEstimated: true,
      },
    }],
  );
  if (res.modifiedCount) {
    logger.info(`Society ${societyId}: auto-expired ${res.modifiedCount} visit(s) at their expected departure`);
  }
  return res.modifiedCount || 0;
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
