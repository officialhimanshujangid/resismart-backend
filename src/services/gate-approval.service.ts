import mongoose from 'mongoose';
import { ApprovalRequest, IApprovalRequest, ApprovalOutcome } from '../models/approval-request.model';
import { ResidentGatePreference } from '../models/resident-gate-preference.model';
import { SocietyOpsPolicy, IApprovalRule, ApprovalMode } from '../models/society-ops-policy.model';
import { Resident } from '../models/resident.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { getOrCreateOpsPolicy, approvalRuleFor } from './ops-policy.service';
import { usersOfCommittee } from './notify-recipients';
import { notify } from './notification.service';
import { publishToSociety } from './sse.service';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class ApprovalError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Actor { userId: string; userName: string }

/**
 * Asking the flat before letting somebody in.
 *
 * Three ideas carry this file, and everything else follows from them.
 *
 * **1. There is exactly one function that decides who gets asked.** Every
 * competitor's privacy failure is really the same bug: two code paths that
 * each work out the audience, and one of them being wrong. `whoToAsk` below is
 * the only place that question is answered, and `askedUserIds` records its
 * answer permanently so it can be argued with later.
 *
 * **2. A rented flat means the TENANT, and only the tenant.** This is the
 * single most important rule here. An owner who no longer lives there has no
 * business seeing a stream of who visits their tenant — that is surveillance
 * of somebody's private life, and ADDA's own FAQ admits to getting it wrong.
 *
 * **3. Nobody reachable is a real answer, not an error.** Data-only members,
 * a vacant flat, a society that never onboarded its residents — the guard
 * still has a person standing in front of them. The request falls through to
 * the guard immediately rather than sitting in a queue nobody is watching.
 */

// -------------------------------------------------------- effective policy

export interface EffectiveRule extends IApprovalRule {
  /** What actually happens, after the resident's own preference is applied. */
  effectiveMode: ApprovalMode | 'LEAVE_AT_GATE';
  /** Why it differs from the society rule, for the guard's screen. */
  because?: string;
}

/**
 * The society's rule, narrowed by the resident's preference — and never widened.
 *
 * The ceiling is the whole point. A resident can ask to be interrupted less;
 * they cannot grant entry the society has not agreed to. So a preference may
 * turn REQUIRED into NOTIFY_ONLY or LEAVE_AT_GATE for their own flat, but no
 * preference can turn NONE into REQUIRED-with-authority or lift a society's
 * requirement that somebody be asked at all where the society said NONE.
 *
 * Called by the gate console, the entry path and the settings screen. One
 * answer, so a guard is never shown a rule the backend will not honour.
 */
export async function effectivePolicy(
  societyId: string,
  category: string,
  opts: { flatId?: string | null; at?: Date } = {},
): Promise<EffectiveRule> {
  const policy = await SocietyOpsPolicy.findOne({ societyId: oid(societyId) });
  const societyRule = policy
    ? approvalRuleFor(policy, category)
    : { mode: 'NOTIFY_ONLY' as ApprovalMode, timeoutSeconds: 60, onTimeout: 'GUARD_DECIDES', whoCanApprove: 'ANY_ADULT', allowGuardOverride: true, overrideRequiresReason: true } as IApprovalRule;

  // `toObject()` and not a bare spread: `approvalRuleFor` hands back a Mongoose
  // subdocument out of a Map, and spreading one of those copies its internals
  // rather than its schema paths — leaving timeoutSeconds and onTimeout
  // undefined, which fails at ApprovalRequest.create with a validation error
  // several layers away from the cause.
  const plain = typeof (societyRule as any).toObject === 'function'
    ? (societyRule as any).toObject()
    : societyRule;
  const base: EffectiveRule = { ...plain, effectiveMode: plain.mode };
  if (!opts.flatId || societyRule.mode === 'NONE') return base;

  const prefs = await ResidentGatePreference.find({
    societyId: oid(societyId), flatId: oid(opts.flatId),
  }).lean();
  if (!prefs.length) return base;

  const at = opts.at || new Date();
  const minuteOfDay = at.getHours() * 60 + at.getMinutes();

  // Quiet hours first, and they only ever soften. Somebody asleep cannot
  // answer, and a REQUIRED that nobody can answer is just a delay before the
  // guard decides anyway — better to say so honestly on the guard's screen.
  const quiet = prefs.some(p => p.quietHours && inQuietHours(minuteOfDay, p.quietHours));
  if (quiet && societyRule.mode === 'REQUIRED') {
    return { ...base, effectiveMode: 'NOTIFY_ONLY', because: 'Quiet hours for this flat' };
  }

  // An explicit per-category choice. Any resident of the flat setting
  // LEAVE_AT_GATE is enough — the strictest interpretation would need every
  // member to agree, which in practice means it never takes effect.
  // `.lean()` turns a Mongoose Map into a plain object, so this is an index and
  // NOT `.get()` — which would be undefined at runtime and would silently make
  // every preference here do nothing.
  const choices = prefs
    .map(p => (p.categoryMode as unknown as Record<string, string> | undefined)?.[category])
    .filter(Boolean) as ('ASK' | 'NOTIFY_ONLY' | 'LEAVE_AT_GATE')[];

  if (choices.includes('LEAVE_AT_GATE')) {
    return { ...base, effectiveMode: 'LEAVE_AT_GATE', because: 'This flat asks for deliveries to be left at the gate' };
  }
  if (choices.includes('NOTIFY_ONLY') && societyRule.mode === 'REQUIRED') {
    return { ...base, effectiveMode: 'NOTIFY_ONLY', because: 'This flat asked not to be asked for this' };
  }
  // 'ASK' is never an escalation: where the society says NOTIFY_ONLY, a
  // resident wanting to be asked gets a notification and not a veto.
  return base;
}

function inQuietHours(minute: number, q: { fromMinute: number; toMinute: number }): boolean {
  // Wrapping past midnight is the normal case (22:00 → 07:00), so it cannot be
  // a plain range test.
  return q.fromMinute <= q.toMinute
    ? minute >= q.fromMinute && minute < q.toMinute
    : minute >= q.fromMinute || minute < q.toMinute;
}

/** Does this flat already expect this person? Then stop asking every time. */
export async function isExpected(societyId: string, flatId: string, name: string, phone?: string): Promise<boolean> {
  const prefs = await ResidentGatePreference.find({ societyId: oid(societyId), flatId: oid(flatId) }).lean();
  const wanted = name.trim().toLowerCase();
  return prefs.some(p => p.expectedVisitors?.some(v =>
    // Phone is the strong match; the name alone is enough only when no phone
    // was recorded, because two "Ramesh"es is not a rare event in a society.
    (phone && v.phone && v.phone.replace(/\D/g, '').endsWith(phone.replace(/\D/g, '').slice(-10)))
    || (!v.phone && v.name.trim().toLowerCase() === wanted)
  ));
}

// -------------------------------------------------------------- who to ask

export interface Audience {
  userIds: string[];
  via: string;
}

/**
 * THE privacy boundary. Everything else in the gate defers to this.
 *
 * Deliberately returns an empty list rather than falling back to "anyone
 * associated with the flat" — a fallback that widens the audience is exactly
 * how a tenant's visitors end up on a landlord's phone.
 */
export async function whoToAsk(societyId: string, flatId: string | null | undefined): Promise<Audience> {
  if (!flatId) return { userIds: [], via: 'NO_FLAT' };

  const flat = await Flat.findOne({ _id: oid(flatId), societyId: oid(societyId) }).lean();
  if (!flat) return { userIds: [], via: 'NO_FLAT' };

  // A vacant flat has nobody to ask, and asking the owner of a vacant flat is
  // reasonable — but they may not exist either. The committee is the honest
  // fallback: somebody is accountable for an empty flat.
  if (flat.status === FlatStatus.VACANT) {
    return { userIds: await usersOfCommittee(societyId), via: 'VACANT_COMMITTEE' };
  }

  // A person can only answer if they have a login. A resident recorded in the
  // register with no contact details is not a silent "no" — they are simply
  // not reachable, and the request must fall through rather than hang.
  const base = {
    societyId: oid(societyId), flatId: oid(flatId),
    isActive: true, userId: { $exists: true },
  };

  if (flat.status === FlatStatus.RENTED) {
    // The tenant household ONLY. Not the owner, not the owner's family.
    const tenants = await Resident.find({ ...base, householdType: 'TENANT' }, { userId: 1 }).lean();
    if (tenants.length) {
      return { userIds: tenants.map(t => String(t.userId)), via: 'RENTED_TENANT_ONLY' };
    }
    // Marked rented with no reachable tenant on file. NOT a reason to ask the
    // owner — that would quietly re-open the exact privacy hole. The guard
    // decides, and the gap is visible in the record as this via value.
    return { userIds: [], via: 'RENTED_NO_TENANT_REACHABLE' };
  }

  const household = await Resident.find({ ...base, householdType: 'OWNER' }, { userId: 1 }).lean();
  return { userIds: household.map(r => String(r.userId)), via: 'OWNER_OCCUPIED' };
}

// --------------------------------------------------------------- requesting

export interface RequestInput {
  flatId?: string | null;
  visitorName: string;
  visitorPhone?: string;
  category: string;
  photoKey?: string;
  vehicleNumber?: string;
  notes?: string;
}

export interface RequestResult {
  request: IApprovalRequest | null;
  /** What the guard should do right now. */
  verdict: 'ASK' | 'LET_IN' | 'LEAVE_AT_GATE';
  reason: string;
}

/**
 * Decide whether to ask, and if so, ask.
 *
 * Returns a verdict rather than doing the letting-in itself: recording the
 * entry stays with visitor.service, which already owns capture rules,
 * expected-stay and the register. Splitting the decision from the record keeps
 * one of them from quietly re-implementing the other.
 */
export async function requestApproval(
  societyId: string, input: RequestInput, actor: Actor,
): Promise<RequestResult> {
  const policy = await getOrCreateOpsPolicy(societyId, actor.userId, actor.userName);
  const rule = await effectivePolicy(societyId, input.category, { flatId: input.flatId });

  if (rule.effectiveMode === 'LEAVE_AT_GATE') {
    return { request: null, verdict: 'LEAVE_AT_GATE', reason: rule.because || 'This flat leaves these at the gate' };
  }
  if (rule.effectiveMode === 'NONE') {
    return { request: null, verdict: 'LET_IN', reason: 'No approval needed for this kind of visitor' };
  }

  // Somebody the flat already expects is not asked about again. This is the
  // difference between a system residents keep using and one they mute in the
  // second week.
  if (input.flatId && await isExpected(societyId, input.flatId, input.visitorName, input.visitorPhone)) {
    await tellTheFlat(societyId, input, 'GATE_EXPECTED', `${input.visitorName} has arrived`, actor);
    return { request: null, verdict: 'LET_IN', reason: 'This flat expects them' };
  }

  const audience = await whoToAsk(societyId, input.flatId);

  if (rule.effectiveMode === 'NOTIFY_ONLY') {
    await tellTheFlat(societyId, input, 'GATE_ARRIVAL', `${input.visitorName} is at the gate`, actor);
    return { request: null, verdict: 'LET_IN', reason: 'The flat has been told' };
  }

  // REQUIRED, but nobody can answer. Falling through to the guard immediately
  // is the honest outcome — the alternative is a resident-approval feature
  // that silently makes every visitor wait sixty seconds for nothing.
  if (!audience.userIds.length) {
    return {
      request: null,
      verdict: 'LET_IN',
      reason: audience.via === 'RENTED_NO_TENANT_REACHABLE'
        ? 'No tenant on file for this flat — your decision, and it will be recorded'
        : 'Nobody at this flat can be asked — your decision, and it will be recorded',
    };
  }

  const flat = input.flatId ? await Flat.findById(input.flatId).lean() : null;
  const request = await ApprovalRequest.create({
    societyId: oid(societyId),
    flatId: input.flatId ? oid(input.flatId) : undefined,
    flatLabel: flat ? `${flat.blockName || ''} ${flat.number}`.trim() : undefined,
    blockId: flat?.blockId,
    visitorName: input.visitorName.trim(),
    visitorPhone: input.visitorPhone,
    category: input.category,
    photoKey: input.photoKey,
    vehicleNumber: input.vehicleNumber,
    notes: input.notes,
    askedUserIds: audience.userIds.map(oid),
    askedVia: audience.via,
    outcome: 'PENDING',
    // Copied, not referenced: a policy edited at 9pm must not change what a
    // request created at 8pm was promised.
    expiresAt: new Date(Date.now() + (rule.timeoutSeconds || 60) * 1000),
    onTimeout: rule.onTimeout,
    guardName: actor.userName,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });

  await notify({
    societyId, userIds: audience.userIds,
    kind: 'GATE_APPROVAL',
    title: `${input.visitorName} is at the gate`,
    body: `${input.category.toLowerCase()} for ${request.flatLabel || 'your flat'} — please allow or deny`,
    link: `/dashboard/gate/approvals?id=${request._id}`,
    entityType: 'ApprovalRequest', entityId: String(request._id),
    // The one thing in this system genuinely worth ringing through: somebody is
    // standing at the gate, and the answer is wanted within the minute.
    priority: 'HIGH',
  });

  return { request, verdict: 'ASK', reason: `Waiting for ${request.flatLabel || 'the flat'}` };
}

async function tellTheFlat(
  societyId: string, input: RequestInput, kind: string, title: string, actor: Actor,
) {
  const audience = await whoToAsk(societyId, input.flatId);
  if (!audience.userIds.length) return;
  await notify({
    societyId, userIds: audience.userIds, kind, title,
    body: `${input.category.toLowerCase()} at the gate`,
    link: '/dashboard/gate/log',
  });
}

// ---------------------------------------------------------------- deciding

/**
 * A resident answers.
 *
 * The filtered update is the whole mechanism: `outcome: 'PENDING'` is part of
 * the query, so two residents tapping at the same moment cannot both win. The
 * second one gets zero modified documents and is told what was already
 * decided, rather than silently overwriting their neighbour's answer.
 */
export async function decide(
  societyId: string, id: string, allow: boolean, actor: Actor,
  opts: { leaveAtGate?: boolean } = {},
): Promise<IApprovalRequest> {
  const req = await ApprovalRequest.findOne({ _id: oid(id), societyId: oid(societyId) });
  if (!req) throw new ApprovalError('That request could not be found.', 404);

  // Being ASKED is the authority here — not a role, not a permission. The
  // snapshot taken at request time is what decides, so a tenancy ending
  // mid-request cannot retroactively strip somebody's answer.
  if (!req.askedUserIds.some(u => String(u) === String(actor.userId))) {
    throw new ApprovalError('You were not asked about this visitor.', 403);
  }

  const outcome: ApprovalOutcome = opts.leaveAtGate ? 'LEFT_AT_GATE' : allow ? 'APPROVED' : 'DENIED';
  const claim = await ApprovalRequest.updateOne(
    { _id: req._id, outcome: 'PENDING' },
    {
      $set: {
        outcome, decidedBy: 'RESIDENT',
        decidedByUserId: oid(actor.userId), decidedByName: actor.userName,
        decidedAt: new Date(),
        updatedBy: oid(actor.userId), updatedByName: actor.userName,
      },
    },
  );

  if (claim.modifiedCount === 0) {
    const now = await ApprovalRequest.findById(req._id).lean();
    throw new ApprovalError(
      `This was already ${describe(now?.outcome)} by ${now?.decidedByName || 'somebody else'}.`,
      409,
    );
  }

  const fresh = (await ApprovalRequest.findById(req._id))!;
  // The guard is staring at the screen waiting for exactly this.
  publishToSociety(societyId, 'gate-approval', {
    _id: String(fresh._id), outcome: fresh.outcome,
    decidedByName: fresh.decidedByName, visitorName: fresh.visitorName,
  });
  return fresh;
}

function describe(outcome?: string): string {
  switch (outcome) {
    case 'APPROVED': return 'allowed';
    case 'DENIED': return 'refused';
    case 'LEFT_AT_GATE': return 'left at the gate';
    case 'GUARD_OVERRIDE': return 'decided by the guard';
    case 'TIMED_OUT': return 'left waiting';
    case 'AUTO_DENIED': return 'refused automatically';
    case 'CANCELLED': return 'cancelled';
    default: return 'answered';
  }
}

/**
 * The guard decides anyway.
 *
 * Allowed, because the alternative is a guard with a visitor in front of them
 * and no way forward — and every gate system that forbade it grew a habit of
 * fake entries instead. But it is never quiet: a reason is required when the
 * society says so, the resident is told immediately, and it shows up in the
 * monthly override report whether anybody looks or not.
 */
export async function override(
  societyId: string, id: string, allow: boolean, reason: string | undefined, actor: Actor,
): Promise<IApprovalRequest> {
  const req = await ApprovalRequest.findOne({ _id: oid(id), societyId: oid(societyId) });
  if (!req) throw new ApprovalError('That request could not be found.', 404);

  const rule = await effectivePolicy(societyId, req.category, { flatId: req.flatId ? String(req.flatId) : null });
  if (!rule.allowGuardOverride) {
    throw new ApprovalError('This society does not let the gate override the flat.', 403);
  }
  if (rule.overrideRequiresReason && !reason?.trim()) {
    throw new ApprovalError('Please say why you are overriding — it goes on the record.');
  }

  const claim = await ApprovalRequest.updateOne(
    { _id: req._id, outcome: 'PENDING' },
    {
      $set: {
        outcome: allow ? 'GUARD_OVERRIDE' : 'DENIED',
        decidedBy: 'GUARD',
        decidedByUserId: oid(actor.userId), decidedByName: actor.userName,
        decidedAt: new Date(),
        reason: reason?.trim(),
        updatedBy: oid(actor.userId), updatedByName: actor.userName,
      },
    },
  );
  if (claim.modifiedCount === 0) {
    const now = await ApprovalRequest.findById(req._id).lean();
    throw new ApprovalError(`This was already ${describe(now?.outcome)}.`, 409);
  }

  const fresh = (await ApprovalRequest.findById(req._id))!;

  // Told, not asked. The decision is made; the flat finding out an hour later
  // from the register is how trust in the gate disappears.
  if (fresh.askedUserIds.length) {
    notify({
      societyId,
      userIds: fresh.askedUserIds.map(String),
      kind: 'GATE_OVERRIDE',
      title: `The gate let ${fresh.visitorName} in`,
      body: reason?.trim()
        ? `${actor.userName} decided without waiting — "${reason.trim()}"`
        : `${actor.userName} decided without waiting for your answer`,
      link: `/dashboard/gate/log?id=${fresh._id}`,
      entityType: 'ApprovalRequest', entityId: String(fresh._id),
      priority: 'HIGH',
      emailIfUnreachable: true,
    }).catch(e => logger.error(`Override notice failed: ${e.message}`));
  }

  return fresh;
}

// ---------------------------------------------------------------- the sweep

/**
 * Apply the timeout ladder to everything that ran out of time.
 *
 * Runs on a timer rather than on read, deliberately: a request nobody looks at
 * must still resolve, or the register quietly fills with PENDING rows that
 * make "who is inside" wrong. Each society's own policy decided the action
 * when the request was made, so a policy change today cannot rewrite what
 * yesterday's visitor was promised.
 */
export async function sweepExpired(now = new Date()): Promise<{ resolved: number }> {
  const due = await ApprovalRequest.find({ outcome: 'PENDING', expiresAt: { $lte: now } }).limit(500);
  let resolved = 0;

  for (const req of due) {
    const outcome: ApprovalOutcome =
      req.onTimeout === 'AUTO_DENY' ? 'AUTO_DENIED'
      : req.onTimeout === 'GUARD_DECIDES' ? 'TIMED_OUT'
      : 'TIMED_OUT';   // HOLD also lands here; the guard's screen shows it as still waiting on them

    const claim = await ApprovalRequest.updateOne(
      { _id: req._id, outcome: 'PENDING' },
      {
        $set: {
          outcome, decidedBy: 'SYSTEM', decidedByName: 'No answer', decidedAt: now,
        },
      },
    );
    if (claim.modifiedCount === 0) continue;   // a resident answered in the same instant; theirs wins
    resolved++;

    publishToSociety(String(req.societyId), 'gate-approval', {
      _id: String(req._id), outcome, visitorName: req.visitorName,
      decidedByName: 'No answer',
    });
  }

  return { resolved };
}

// ----------------------------------------------------------------- reading

export async function pending(societyId: string): Promise<IApprovalRequest[]> {
  return ApprovalRequest.find({ societyId: oid(societyId), outcome: 'PENDING' })
    .sort({ createdAt: 1 }).limit(50).lean() as any;
}

/** What a resident has been asked — theirs only, by the same snapshot rule. */
export async function myRequests(societyId: string, userId: string, includeDecided = false) {
  const filter: Record<string, unknown> = {
    societyId: oid(societyId),
    askedUserIds: oid(userId),
  };
  if (!includeDecided) filter.outcome = 'PENDING';
  return ApprovalRequest.find(filter).sort({ createdAt: -1 }).limit(50).lean();
}

/**
 * The monthly override report.
 *
 * Exists so overrides are counted rather than merely permitted. A guard who
 * overrides twice a month is doing their job; one who overrides forty times is
 * telling the committee that a rule does not fit the gate, and that is worth
 * knowing before it becomes an argument about a specific visitor.
 */
export async function overrideReport(societyId: string, from: Date, to: Date) {
  const rows = await ApprovalRequest.find({
    societyId: oid(societyId),
    outcome: 'GUARD_OVERRIDE',
    decidedAt: { $gte: from, $lte: to },
  }).sort({ decidedAt: -1 }).lean();

  const byGuard = new Map<string, number>();
  for (const r of rows) {
    const name = r.decidedByName || 'Unknown';
    byGuard.set(name, (byGuard.get(name) || 0) + 1);
  }

  const totalDecided = await ApprovalRequest.countDocuments({
    societyId: oid(societyId),
    outcome: { $ne: 'PENDING' },
    decidedAt: { $gte: from, $lte: to },
  });

  return {
    from, to,
    total: rows.length,
    // Without the denominator, "12 overrides" means nothing — 12 out of 15 and
    // 12 out of 900 are completely different conversations.
    outOf: totalDecided,
    rate: totalDecided ? Math.round((rows.length / totalDecided) * 1000) / 10 : 0,
    byGuard: [...byGuard.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    rows: rows.slice(0, 200),
  };
}
