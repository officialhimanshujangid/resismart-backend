import mongoose from 'mongoose';
import { ApprovalRequest, IApprovalRequest, ApprovalOutcome } from '../models/approval-request.model';
import { ResidentGatePreference } from '../models/resident-gate-preference.model';
import {
  SocietyOpsPolicy, IApprovalRule, ApprovalMode, RESIDENT_MOVEMENT, VacantFlatHandler,
} from '../models/society-ops-policy.model';
import { Resident } from '../models/resident.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { VisitorEntry, HostKind, AdmittedVia } from '../models/visitor-entry.model';
import { User } from '../models/user.model';
import { SocietyStaff } from '../models/society-staff.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { getOrCreateOpsPolicy, approvalRuleFor, onDutyNow } from './ops-policy.service';
import { usersOfCommittee, householdOfFlat } from './notify-recipients';
import { notify } from './notification.service';
import { publish } from './sse.service';
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
 * each work out the audience, and one of them being wrong. `resolveHostAudience`
 * below is the only place that question is answered — for a flat, a committee
 * member, the office or a staff host alike — and `askedUserIds` records its
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
 * Who gets ASKED. The household rule itself lives in one place —
 * `householdOfFlat` — and this adds the one thing that is specific to asking:
 * an empty flat has no household, but somebody is still accountable for it.
 *
 * Keeping the two apart matters. "Who lives here" and "who answers for this
 * flat" are different questions, and the second one is why a committee member
 * was being pinged at all. Telling a household uses the first; only the gate's
 * decision path uses the second.
 */
export async function whoToAsk(societyId: string, flatId: string | null | undefined): Promise<Audience> {
  const household = await householdOfFlat(societyId, flatId);

  if (household.via === 'VACANT_NO_HOUSEHOLD') {
    return whoAnswersForAnEmptyFlat(societyId, flatId!);
  }

  return { userIds: household.userIds, via: household.via };
}

/** The ladder, in the order a fall-through walks it. */
const VACANT_LADDER: VacantFlatHandler[] = ['OWNER_OF_RECORD', 'DUTY_ROSTER', 'NAMED_MEMBERS', 'COMMITTEE_ALL'];

/**
 * A flat nobody lives in — the branch a resident reported as a privacy breach.
 *
 * This used to be one line: every serving committee member in the society, for
 * every arrival at every empty flat. Two things made that read as surveillance
 * rather than as a duty. First, `Flat.status` defaulted to VACANT, so in any
 * society that onboarded flats without setting it, EVERY visitor took this
 * branch — the edge case was the normal path. Second, and worse, a committee
 * member has no basis whatsoever to say yes to a stranger at an empty flat.
 * They do not know who is expected there; nobody is.
 *
 * So the society now says who answers, and the default says the obvious thing:
 * an empty flat still has an OWNER, and an owner is the one person with a real
 * reason to have an opinion about who walks into their property.
 *
 * Every rung falls through to the next when it resolves to nobody, and the
 * fall-through is the important half. A society that picks NAMED_MEMBERS and
 * then never names anybody must not silently stop being told about its empty
 * flats — a handler that resolves to zero people is a misconfiguration, and the
 * safe reading of a misconfiguration here is "tell somebody", not "tell nobody".
 */
async function whoAnswersForAnEmptyFlat(societyId: string, flatId: string): Promise<Audience> {
  const policy = await SocietyOpsPolicy.findOne({ societyId: oid(societyId) })
    .select('gate.vacantFlat').lean();
  const chosen: VacantFlatHandler = policy?.gate?.vacantFlat?.handler || 'OWNER_OF_RECORD';
  const named = (policy?.gate?.vacantFlat?.namedUserIds || []).map(String).filter(Boolean);

  // Start at the society's own choice and walk down. Starting at the top
  // regardless would make COMMITTEE_ALL unreachable: a society that deliberately
  // wants the whole committee told would keep getting the owner instead.
  for (const rung of VACANT_LADDER.slice(VACANT_LADDER.indexOf(chosen))) {
    if (rung === 'OWNER_OF_RECORD') {
      const flat = await Flat.findOne({ _id: oid(flatId), societyId: oid(societyId) })
        .select('ownerUserId').lean();
      // The row can name an owner who no longer has a login — a sale recorded
      // before the buyer signed up, an account closed. Asking them is asking
      // nobody, and a request nobody can answer is worse than no request, so it
      // falls through rather than resolving to an unreachable id.
      if (flat?.ownerUserId) {
        const reachable = await User.exists({
          _id: flat.ownerUserId, 'memberships.tenantId': oid(societyId),
        });
        if (reachable) return { userIds: [String(flat.ownerUserId)], via: 'VACANT_OWNER_OF_RECORD' };
      }
      continue;
    }

    if (rung === 'DUTY_ROSTER') {
      /**
       * "Whoever is responsible this week", by name and by wing.
       *
       * This rung was a deliberate no-op until `OpsDutyRoster` existed, and the
       * no-op was the honest choice at the time: a society that selected
       * DUTY_ROSTER got the next rung rather than silence. Now it can be
       * answered, and answering it is the whole point of the ladder — one named
       * person who knows they are on duty tonight will actually look at the
       * notification, where a committee-wide broadcast about a flat none of them
       * can speak for is the thing residents reported as surveillance.
       *
       * The wing is read from the flat, not from the request, and an empty rota
       * still falls through: `onDutyNow` returns nobody rather than throwing, so
       * a society that picked this handler and never filled the rota in keeps
       * getting told about its empty flats.
       */
      const flat = await Flat.findOne({ _id: oid(flatId), societyId: oid(societyId) })
        .select('blockId').lean();
      const duty = await onDutyNow(societyId, flat?.blockId ? String(flat.blockId) : null);
      if (duty.userIds.length) return { userIds: duty.userIds, via: 'VACANT_DUTY_ROSTER' };
      continue;
    }

    if (rung === 'NAMED_MEMBERS') {
      if (named.length) return { userIds: named, via: 'VACANT_NAMED_MEMBERS' };
      continue;
    }

    const committee = await usersOfCommittee(societyId);
    if (committee.length) return { userIds: committee, via: 'VACANT_COMMITTEE' };
  }

  // Not even a committee. Recorded honestly: the guard decides and the record
  // says there was nobody in the society to tell.
  return { userIds: [], via: 'VACANT_NOBODY_ACCOUNTABLE' };
}

// ------------------------------------------------------------ the host model

/** What a caller knows about who the visitor came to see. */
export interface HostRef {
  hostKind?: HostKind;
  flatId?: string | null;
  hostUserId?: string | null;
  hostStaffId?: string | null;
}

export interface HostAudience extends Audience {
  hostKind: HostKind;
  /** Always a real string — the notification body is built from it. */
  hostLabel: string;
}

/**
 * THE audience function. Everything the gate tells or asks resolves here.
 *
 * `whoToAsk` answered one question well — who speaks for a FLAT — and had
 * nothing to say about the rest of a society. A visitor for the secretary, for
 * the office, or for the manager produced `{userIds: [], via: 'NO_FLAT'}`:
 * nobody notified, nobody able to approve, and an entry no resident could see,
 * including the person actually being visited. That is the second gap the
 * resident reported, and it is a design hole rather than a bug — there was no
 * field in which to record a host who is not a flat.
 *
 * The rule that does not bend: **the person actually being visited is the one
 * asked.** Not the whole committee, and not nobody.
 *
 * Returns the label as well as the ids, so a caller can never assemble a
 * message about a host it resolved separately from the audience — that
 * separation is exactly how the vacant-flat notice ended up naming no flat.
 */
export async function resolveHostAudience(societyId: string, host: HostRef): Promise<HostAudience> {
  const kind: HostKind = host.hostKind || 'FLAT';

  try {
    if (kind === 'COMMITTEE') {
      if (!host.hostUserId) return { userIds: [], via: 'HOST_UNKNOWN', hostKind: kind, hostLabel: 'The committee' };
      const label = await committeeLabel(societyId, host.hostUserId);
      return { userIds: [String(host.hostUserId)], via: 'HOST_COMMITTEE_MEMBER', hostKind: kind, hostLabel: label };
    }

    if (kind === 'STAFF') {
      if (!host.hostStaffId) return { userIds: [], via: 'HOST_UNKNOWN', hostKind: kind, hostLabel: 'Society staff' };
      const staff = await SocietyStaff.findOne(
        { _id: oid(host.hostStaffId), societyId: oid(societyId), isActive: true },
        { userId: 1, person: 1, designation: 1 },
      ).lean();
      if (!staff) return { userIds: [], via: 'HOST_UNKNOWN', hostKind: kind, hostLabel: 'Society staff' };
      const label = `${prettyDesignation(staff.designation)} — ${staff.person?.name || 'Staff'}`;
      // A staff member with no login cannot be told, and that is honest rather
      // than broken: it shows on their row in the register, where somebody can
      // do something about it.
      return {
        userIds: staff.userId ? [String(staff.userId)] : [],
        via: staff.userId ? 'HOST_STAFF' : 'HOST_STAFF_NO_LOGIN',
        hostKind: kind, hostLabel: label,
      };
    }

    if (kind === 'OFFICE') {
      // The society itself: an AGM, a vendor meeting, somebody at the office
      // window. There is no one host, so it goes to whoever is on duty — and
      // until the rota model exists, to the serving committee, which is the
      // group that IS the office.
      const committee = await usersOfCommittee(societyId);
      return {
        userIds: committee,
        via: committee.length ? 'HOST_OFFICE_COMMITTEE' : 'HOST_OFFICE_NOBODY',
        hostKind: kind, hostLabel: 'Society office',
      };
    }

    const audience = await whoToAsk(societyId, host.flatId);
    return { ...audience, hostKind: 'FLAT', hostLabel: await flatLabel(societyId, host.flatId) };
  } catch (e: any) {
    // Same contract as `householdOfFlat`: never throw. A visitor standing at the
    // gate must be recorded even when working out who to tell fails.
    logger.error(`Could not resolve the host audience: ${e.message}`);
    return { userIds: [], via: 'HOST_UNKNOWN', hostKind: kind, hostLabel: 'The society' };
  }
}

async function flatLabel(societyId: string, flatId?: string | null): Promise<string> {
  if (!flatId) return 'The society';
  const flat = await Flat.findOne({ _id: oid(flatId), societyId: oid(societyId) })
    .select('number blockName').lean();
  return flat ? `${flat.blockName || ''} ${flat.number}`.trim() : 'The society';
}

/** "Secretary — R. Nair", which is how a guard and a resident both refer to them. */
async function committeeLabel(societyId: string, userId: string): Promise<string> {
  const term = await Committee.findOne({ societyId: oid(societyId), status: 'ACTIVE' }, { _id: 1 }).lean();
  const seat = term && await CommitteeMember.findOne(
    { societyId: oid(societyId), committeeId: term._id, userId: oid(userId), status: 'ACTIVE' },
    { designationLabel: 1, memberSnapshot: 1 },
  ).lean();
  if (seat) return `${seat.designationLabel} — ${seat.memberSnapshot?.name || 'Committee member'}`;
  // Being visited does not require holding a seat today. A former secretary the
  // visitor still asks for by name is a real arrival, and the entry has to be
  // filed against somebody rather than against nobody.
  const user = await User.findById(oid(userId)).select('name').lean();
  return user?.name || 'A committee member';
}

const prettyDesignation = (d?: string) =>
  (d || 'Staff').toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

// --------------------------------------------------------------- requesting

export interface RequestInput extends HostRef {
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
  /**
   * HOW they got in, as a value rather than as English.
   *
   * `admittedVia` used to be derived downstream by substring-matching this
   * object's `reason` — `reason.includes('expects them')`. Two things were
   * wrong with that, and both were live. A resident's own movement returns "A
   * resident of this flat", which matches none of the patterns, so it fell
   * through to GUARD and the flat was sent a "somebody has arrived" notice
   * about its own household. And any copy-edit to a sentence a guard reads on
   * screen silently rewrote a permanent audit value on every entry after it.
   *
   * The decision knows what it decided. It says so.
   */
  admittedVia: AdmittedVia;
  /** Whether the register still owes the host a "somebody arrived" notice. */
  notifyArrival: boolean;
  /** Resolved once here, so the entry cannot be filed against a different host. */
  host?: HostAudience;
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
  // A resident is never asked for permission to enter their own home, and the
  // flat is never notified that its own household arrived. Returned before the
  // policy is even loaded, so no setting a society could choose can turn this
  // into a request — including a CUSTOM approval map with a stray RESIDENT key.
  if (input.category === RESIDENT_MOVEMENT) {
    return {
      request: null, verdict: 'LET_IN', reason: 'A resident of this flat',
      admittedVia: 'GUARD',
      // The second half of that promise, and the half that was broken. A
      // resident walking into their own home used to trigger "X has arrived" to
      // their own flat, because the via-by-prose fell through to GUARD and GUARD
      // meant "tell them". Nobody needs to be told they came home.
      notifyArrival: false,
    };
  }

  const policy = await getOrCreateOpsPolicy(societyId, actor.userId, actor.userName);
  const rule = await effectivePolicy(societyId, input.category, { flatId: input.flatId });

  if (rule.effectiveMode === 'LEAVE_AT_GATE') {
    return {
      request: null, verdict: 'LEAVE_AT_GATE',
      reason: rule.because || 'This flat leaves these at the gate',
      admittedVia: 'GUARD', notifyArrival: false,
    };
  }
  if (rule.effectiveMode === 'NONE') {
    return {
      request: null, verdict: 'LET_IN',
      reason: 'No approval needed for this kind of visitor',
      admittedVia: 'GUARD', notifyArrival: true,
    };
  }

  // Somebody the flat already expects is not asked about again. This is the
  // difference between a system residents keep using and one they mute in the
  // second week.
  if (input.flatId && await isExpected(societyId, input.flatId, input.visitorName, input.visitorPhone)) {
    const host = await tellTheHost(societyId, input, 'GATE_EXPECTED', `${input.visitorName} has arrived`, actor);
    return {
      request: null, verdict: 'LET_IN', reason: 'This flat expects them',
      admittedVia: 'EXPECTED', notifyArrival: false, host,
    };
  }

  const audience = await resolveHostAudience(societyId, input);

  /**
   * An empty flat: the committee is TOLD, never ASKED.
   *
   * This used to raise a real approval request against every serving committee
   * member, and a resident of A-102 would find "somebody is at the gate for
   * A-103, let them in?" sitting in their own approvals list — indistinguishable
   * from a question about their own home. They reasonably read it as a leak.
   *
   * It was not a leak, but it was worse than one in a way: a committee member
   * has no basis whatsoever to say yes to a stranger at an empty flat. They do
   * not know who is expected there; nobody is. Asking them manufactures a
   * decision out of nothing and then records it as though somebody had
   * authority. The guard is the only person who can actually judge who is
   * standing there, so the guard decides — and the committee finds out, which
   * is the part that genuinely matters for an empty flat.
   */
  //
  // Note the narrowness of the test: `VACANT_COMMITTEE` only, not every vacant
  // branch. Where the ladder produced a NAMED person — the owner of record, or
  // members this society appointed for exactly this — they are ASKED like any
  // other host, because they do have standing to answer for that flat. Only the
  // blanket "tell all of them" fallback keeps the tell-don't-ask treatment.
  if (audience.via === 'VACANT_COMMITTEE') {
    if (audience.userIds.length) {
      // Name the flat, and link where the recipient can actually look.
      //
      // This notice used to say only "Somebody came to an empty flat" and link
      // to /gate/log — which for a committee member is clamped to their OWN
      // flats, so they opened it and the visit was not there. An unexplained
      // alert about a visit you cannot see reads as a leak even when it is a
      // duty: the reader's honest conclusion is that the system is telling
      // them about somebody else's home. Saying which flat, and pointing at
      // the society-wide record where that entry genuinely is, turns the same
      // message into the thing it was always meant to be.
      await notify({
        societyId, userIds: audience.userIds,
        kind: 'GATE_VACANT_FLAT',
        title: `Somebody came to ${audience.hostLabel} — an empty flat`,
        body: `${input.visitorName} — ${input.category.toLowerCase()}. Nobody lives there right now, so the guard decided. You are seeing this as a committee member.`,
        link: '/dashboard/visitors/log',
      }).catch(e => logger.error(`Could not tell the committee about a vacant-flat caller: ${e.message}`));
    }
    return {
      request: null,
      verdict: 'LET_IN',
      reason: 'That flat is empty — your decision, and the committee will be told',
      admittedVia: 'GUARD', notifyArrival: false, host: audience,
    };
  }

  if (rule.effectiveMode === 'NOTIFY_ONLY') {
    await tellTheHost(societyId, input, 'GATE_ARRIVAL', `${input.visitorName} is at the gate`, actor);
    return {
      request: null, verdict: 'LET_IN', reason: 'The flat has been told',
      admittedVia: 'NOTIFY', notifyArrival: false, host: audience,
    };
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
        // An empty flat where the ladder ran out — no owner on record, no duty
        // roster, nobody named. The guard is deciding either way, but WHY they
        // are deciding is the useful half: "that flat is empty" tells them a
        // stranger at an unoccupied door is worth a second look, where "nobody
        // can be asked" reads like a system fault they should ignore.
        : audience.via.startsWith('VACANT')
          ? 'That flat is empty and nobody is on record for it — your decision, and it will be recorded'
          : audience.hostKind !== 'FLAT'
            ? `${audience.hostLabel} cannot be reached — your decision, and it will be recorded`
            : 'Nobody at this flat can be asked — your decision, and it will be recorded',
      admittedVia: 'GUARD', notifyArrival: true, host: audience,
    };
  }

  const flat = input.flatId ? await Flat.findById(input.flatId).lean() : null;
  const request = await ApprovalRequest.create({
    societyId: oid(societyId),
    flatId: input.flatId ? oid(input.flatId) : undefined,
    flatLabel: flat ? `${flat.blockName || ''} ${flat.number}`.trim() : undefined,
    blockId: flat?.blockId,
    hostKind: audience.hostKind,
    hostUserId: input.hostUserId ? oid(input.hostUserId) : undefined,
    hostStaffId: input.hostStaffId ? oid(input.hostStaffId) : undefined,
    hostLabel: audience.hostLabel,
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
    // The host is named, always — `hostLabel` is guaranteed by the model, so
    // there is no "your flat" fallback left for a committee member to squint at.
    body: `${input.category.toLowerCase()} for ${audience.hostLabel} — please allow or deny`,
    link: `/dashboard/visitors/approvals?id=${request._id}`,
    entityType: 'ApprovalRequest', entityId: String(request._id),
    // The one thing in this system genuinely worth ringing through: somebody is
    // standing at the gate, and the answer is wanted within the minute.
    priority: 'HIGH',
  });

  return {
    request, verdict: 'ASK', reason: `Waiting for ${audience.hostLabel}`,
    // Nothing is admitted yet; the entry is written AWAITING and settles later
    // through `applyDecision`, which is what fills these in for real.
    admittedVia: 'RESIDENT_APPROVAL', notifyArrival: false, host: audience,
  };
}

/**
 * Tell the host — whoever that turns out to be.
 *
 * Was `tellTheFlat`, and the rename is the point: a flat is one kind of host,
 * not the only one, and this path silently reached nobody for every arrival
 * that was not for a flat. Returns the audience so the caller can hand the same
 * resolution to the register instead of working the host out a second time.
 */
async function tellTheHost(
  societyId: string, input: RequestInput, kind: string, title: string, actor: Actor,
): Promise<HostAudience> {
  const audience = await resolveHostAudience(societyId, input);
  if (!audience.userIds.length) return audience;
  await notify({
    societyId, userIds: audience.userIds, kind, title,
    body: `${input.category.toLowerCase()} at the gate for ${audience.hostLabel}`,
    link: '/dashboard/visitors/log',
  });
  return audience;
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
  liveUpdate(fresh);
  return fresh;
}

/**
 * Tell the two parties who are actually waiting: the guard who asked, and the
 * people who were asked.
 *
 * This used to be `publishToSociety`, which had no user filter at all — so
 * every resident with a tab open received the visitor's name and the name of
 * the neighbour who answered, for every flat in the building. A frame carrying
 * "who is visiting whom" is exactly the payload this module refuses to put in
 * a notification, and putting it on a broadcast channel instead was worse: it
 * reached people no notification would have gone to, silently, in the DOM.
 *
 * `createdBy` rather than "whoever holds GATE_CONSOLE": the request records the
 * guard who raised it, so no lookup is needed and no wider audience is implied.
 * A guard who came on shift after the ask still sees the answer — their console
 * re-reads the pending list on its own timer; the live frame is an optimisation
 * for the person standing there, not the source of truth.
 */
function liveUpdate(req: IApprovalRequest): void {
  const audience = [
    ...req.askedUserIds.map(String),
    ...(req.createdBy ? [String(req.createdBy)] : []),
  ];
  publish(String(req.societyId), audience, 'gate-approval', {
    _id: String(req._id), outcome: req.outcome,
    decidedByName: req.decidedByName, visitorName: req.visitorName,
  });
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
      link: `/dashboard/visitors/log?id=${fresh._id}`,
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

    // Settle the waiting entry to match. AUTO_DENY turns it away; HOLD and
    // GUARD_DECIDES leave it AWAITING, because the guard is still expected to
    // make the call — the timeout only means "nobody upstairs answered", not
    // "this person goes home". The model, not the service, so no import cycle.
    if (req.visitorEntryId && req.onTimeout === 'AUTO_DENY') {
      await VisitorEntry.updateOne(
        { _id: req.visitorEntryId, status: 'AWAITING' },
        { $set: { status: 'DENIED', decidedByName: 'No answer', decidedAt: now } },
      ).catch(e => logger.error(`Could not deny timed-out entry: ${e.message}`));
    }

    // Re-read so the frame carries what was actually stored, not what this
    // loop hoped to store — the claim above can lose to a resident answering
    // in the same instant.
    const settled = await ApprovalRequest.findById(req._id);
    if (settled) liveUpdate(settled);
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
