import mongoose from 'mongoose';
import {
  SocietyOpsPolicy, ISocietyOpsPolicy, OPS_MODULES, OpsModule,
  GateLevel, VISITOR_CATEGORIES, IApprovalRule,
} from '../models/society-ops-policy.model';
import {
  OpsDutyRoster, IOpsDutyRoster, DutyShift, DAY_SHIFT_FROM_HOUR, DAY_SHIFT_TO_HOUR,
} from '../models/ops-duty-roster.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { SocietyStaff } from '../models/society-staff.model';
import { Complaint } from '../models/complaint.model';
import { Asset } from '../models/asset.model';
import { Block } from '../models/block.model';
import { User } from '../models/user.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class OpsPolicyError extends Error {}

const isModule = (m: string): m is OpsModule => (OPS_MODULES as readonly string[]).includes(m);

/**
 * What a society gets before it says otherwise: all of it.
 *
 * This was `['GATE']` and that was wrong — not as a preference, as a bug. An
 * admin cannot switch on a feature they have never seen, so a module that is
 * off by default is a module that does not exist for most societies. Off is
 * for the society that looked at Complaints and decided against it.
 *
 * PARKING is the one deliberate exception, and it is not an oversight. The
 * other four describe things every society already does on paper, so showing
 * them costs nothing and teaches something. A parking map with no bays drawn on
 * it teaches a new admin only that the screen looks broken — so parking is
 * switched on by the wizard in `parking.service`, which is the same act that
 * draws the zones and sets the rate. Anything that changes this list must also
 * read the note above `resolveOpsModules` in `entitlement.service`.
 */
export const DEFAULT_MODULES: OpsModule[] = ['GATE', 'COMPLAINTS', 'STAFF', 'ASSETS'];

export interface OpsModuleInfo {
  key: OpsModule;
  label: string;
  blurb: string;
  pages: string[];
  /**
   * Set when this module is switched on and off from its OWN screen rather
   * than from the modules list — because its on/off decision does more than
   * show and hide pages. A renderer that sees this must link, not toggle.
   */
  settingsHref?: string;
}

export const OPS_MODULE_CATALOG: OpsModuleInfo[] = [
  { key: 'GATE', label: 'Gate & visitors', blurb: 'Who comes in and who goes out.', pages: ['Gate Console', 'Gate Records'] },
  { key: 'COMPLAINTS', label: 'Complaints', blurb: 'Residents report a problem; somebody is made responsible for fixing it.', pages: ['Complaints'] },
  { key: 'STAFF', label: 'Staff', blurb: 'The people the society employs, and which wing each looks after.', pages: ['Staff'] },
  { key: 'ASSETS', label: 'Assets', blurb: 'Lifts, pumps and tanks — with a QR sticker that raises a complaint against the right one.', pages: ['Assets'] },
  {
    key: 'PARKING', label: 'Parking',
    blurb: 'Bays, who parks where, and the charge for it — set up in its own screen.',
    pages: ['Parking Map', 'Who Parks Where'],
    // Parking cannot be switched here, and that is not a UI preference.
    // Its on/off decision also creates or deactivates a real ChargeHead, so a
    // plain switch in the modules list would hide the screens and leave every
    // flat still being billed for a module nobody can see. The wizard owns the
    // whole decision; this row sends you there. `updateOpsPolicy` refuses the
    // shortcut server-side, so a hand-rolled PUT cannot get it wrong either.
    settingsHref: '/dashboard/parking/settings',
  },
];

/**
 * The five presets, as plain sets of switches.
 *
 * A preset is applied once and then forgotten — every switch stays
 * independently changeable, so a society that wants "L2 but with approval on
 * deliveries only" can have exactly that. The level is recorded as CUSTOM the
 * moment anything is hand-tuned, so the screen never claims a preset the
 * society has since moved away from.
 */
export const GATE_LEVELS: { level: Exclude<GateLevel, 'CUSTOM'>; label: string; blurb: string }[] = [
  { level: 'L1', label: 'Digital register', blurb: 'Entry only. No approval, no scanning, no exit. Replaces the paper book.' },
  { level: 'L2', label: '+ Exit tracking', blurb: 'Check in and out, see who is inside, get told when somebody overstays.' },
  { level: 'L3', label: '+ Resident approval', blurb: 'Ask the flat before letting someone in. Deliveries can be left at the gate.' },
  { level: 'L4', label: '+ Passes & scanning', blurb: 'Invite guests in advance; the guard scans a code instead of typing.' },
  { level: 'L5', label: '+ Vehicles', blurb: 'Vehicle entry and exit, and a register of residents’ own vehicles.' },
];

const approvalFor = (mode: 'NONE' | 'NOTIFY_ONLY' | 'REQUIRED'): IApprovalRule => ({
  mode,
  timeoutSeconds: 60,
  onTimeout: 'GUARD_DECIDES',
  whoCanApprove: 'ANY_ADULT',
  allowGuardOverride: true,
  overrideRequiresReason: true,
});

/** Turn a preset into the switches it stands for. */
export function presetFor(level: Exclude<GateLevel, 'CUSTOM'>) {
  const approval = new Map<string, IApprovalRule>();
  for (const c of VISITOR_CATEGORIES) {
    approval.set(c, approvalFor(
      level === 'L1' || level === 'L2' ? 'NONE'
        // Household staff are known and expected; asking every morning is the
        // fastest way to teach a resident to ignore the notifications.
        : c === 'HOUSEHOLD_STAFF' ? 'NONE'
        : c === 'CAB' ? 'NOTIFY_ONLY'
        : 'REQUIRED',
    ));
  }

  return {
    level,
    exit: { trackExit: level !== 'L1', mode: (level >= 'L4' ? 'SCAN' : 'MANUAL') as 'SCAN' | 'MANUAL' },
    approval,
    vehicles: { track: level === 'L5', trackExit: level === 'L5', residentRegistry: level === 'L5' },
  };
}

/**
 * Load or lazily create a society's ops policy.
 *
 * Mirrors `getOrCreatePolicy` in finance: one door every read goes through, so
 * defaults and any future self-healing live in a single place rather than being
 * scattered across callers.
 */
export async function getOrCreateOpsPolicy(
  societyId: string, userId: string, userName: string,
): Promise<ISocietyOpsPolicy> {
  let policy = await SocietyOpsPolicy.findOne({ societyId });
  if (!policy) {
    policy = await SocietyOpsPolicy.create({
      societyId,
      createdBy: oid(userId), createdByName: userName,
      updatedBy: oid(userId), updatedByName: userName,
    });
    // A brand new policy carries no approval rules at all, which would read as
    // "never ask anyone". Seed the L2 preset so the defaults are a coherent
    // position rather than an accidental one.
    applyPreset(policy, 'L2');
    await policy.save();
  }
  return policy;
}

/** Overwrite the switches a preset owns. Everything else is left alone. */
export function applyPreset(policy: ISocietyOpsPolicy, level: Exclude<GateLevel, 'CUSTOM'>) {
  const p = presetFor(level);
  policy.gate.level = level;
  policy.gate.exit.trackExit = p.exit.trackExit;
  policy.gate.exit.mode = p.exit.mode;
  policy.gate.approval = p.approval as any;
  policy.gate.vehicles.track = p.vehicles.track;
  policy.gate.vehicles.trackExit = p.vehicles.trackExit;
  policy.gate.vehicles.residentRegistry = p.vehicles.residentRegistry;
}

/**
 * Which optional parts a society uses, inferred once from its own data if it
 * has never said.
 *
 * The same protection `resolveModules` carries in finance, for the same reason:
 * switching this on must not hide a screen somebody is already using. Here it
 * matters less (nothing exists yet to infer from) but the shape is worth
 * keeping identical — the next module to be added will need it.
 */
export async function resolveOpsModules(societyId: string): Promise<OpsModule[]> {
  const policy = await SocietyOpsPolicy.findOne({ societyId })
    .select('modules modulesInferredAt').lean();

  // A CHOICE is final. Only a stored guess is revisited — otherwise a society
  // that deliberately switched Complaints off would find it back tomorrow.
  if (policy?.modules?.length && !policy.modulesInferredAt) {
    return policy.modules.filter(isModule);
  }

  /**
   * What this society appears to use.
   *
   * Everything is on unless the society says otherwise, and that is a reversal
   * of the earlier default. The reason is discoverability: an admin cannot
   * switch on a module they have never heard of, so shipping Staff and
   * Complaints switched off meant shipping them invisible. Turning a module
   * off is a deliberate act by somebody who has seen it; leaving it off by
   * default was a decision nobody ever actually made.
   *
   * The data counts still matter — they are what stops a society that IS using
   * complaints from ever having them hidden, whatever a future default says.
   */
  const [entries, staff, complaints, assets] = await Promise.all([
    VisitorEntry.countDocuments({ societyId: oid(societyId) }),
    SocietyStaff.countDocuments({ societyId: oid(societyId) }),
    Complaint.countDocuments({ societyId: oid(societyId) }),
    Asset.countDocuments({ societyId: oid(societyId) }),
  ]);

  const on = new Set<OpsModule>(DEFAULT_MODULES);
  if (entries > 0) on.add('GATE');
  if (staff > 0) on.add('STAFF');
  if (complaints > 0) on.add('COMPLAINTS');
  if (assets > 0) on.add('ASSETS');
  const inferred = [...on];

  // Written back so the settings screen has something to show, and marked as
  // a guess so this can be improved again later. The mark is the whole point:
  // without it the guess hardens into a choice nobody made.
  await SocietyOpsPolicy.updateOne(
    { societyId },
    { $set: { modules: inferred, modulesInferredAt: new Date() } },
  ).catch(() => undefined);
  return inferred;
}

export async function hasOpsModule(societyId: string, module: OpsModule): Promise<boolean> {
  return (await resolveOpsModules(societyId)).includes(module);
}

/**
 * Apply an update from the settings screen.
 *
 * Anything hand-tuned moves the level to CUSTOM, because a screen that still
 * says "L2" after the society changed three of L2's switches is lying to the
 * next person who reads it.
 */
export async function updateOpsPolicy(
  societyId: string, body: any, actor: { userId: string; userName: string },
): Promise<ISocietyOpsPolicy> {
  const policy = await getOrCreateOpsPolicy(societyId, actor.userId, actor.userName);

  // A preset is a starting point, not an either/or. Sending "L3, but photos
  // required" in one call and having the second half silently dropped is the
  // kind of surprise that makes a settings screen untrustworthy — so the preset
  // lands first and anything else is applied on top of it.
  if (body.preset) applyPreset(policy, body.preset);

  {
    let touched = false;
    const set = (path: string, value: any) => {
      if (value === undefined) return;
      policy.set(path, value);
      touched = true;
    };

    set('gate.capture.photo', body.gate?.capture?.photo);
    set('gate.capture.phone', body.gate?.capture?.phone);
    set('gate.capture.idProof', body.gate?.capture?.idProof);
    // Which IDs the gate accepts. Without this line the field is in the model,
    // enforced by the register, and unreachable from the settings screen —
    // which is the same "declared but unchangeable" shape as the vacant-flat
    // handler two lines below, and it had it for the same reason: nobody wired
    // the setter when the field was added.
    set('gate.capture.allowedIdTypes', body.gate?.capture?.allowedIdTypes);
    set('gate.capture.categoriesEnabled', body.gate?.capture?.categoriesEnabled);
    set('gate.exit.trackExit', body.gate?.exit?.trackExit);
    // "Do you record people leaving?" is the one question the whole gate module
    // is shaped by, and `trackExit` defaulting to true made "never asked" and
    // "said yes" indistinguishable. This stamp is what the setup checklist reads
    // to know the society has actually answered rather than inherited a default.
    if (body.gate?.exit?.trackExit !== undefined) set('gate.exit.answeredAt', new Date());
    set('gate.exit.mode', body.gate?.exit?.mode);
    set('gate.exit.overstayAlertAfterMinutes', body.gate?.exit?.overstayAlertAfterMinutes);
    set('gate.exit.autoCloseAtHour', body.gate?.exit?.autoCloseAtHour);
    set('gate.exit.autoCloseNotifyCommittee', body.gate?.exit?.autoCloseNotifyCommittee);
    set('gate.vehicles.track', body.gate?.vehicles?.track);
    set('gate.vehicles.trackExit', body.gate?.vehicles?.trackExit);
    set('gate.vehicles.residentRegistry', body.gate?.vehicles?.residentRegistry);
    set('gate.residents.logMovement', body.gate?.residents?.logMovement);
    set('gate.residents.logVehicleOnly', body.gate?.residents?.logVehicleOnly);
    // Who answers for an empty flat. Without these two lines the field exists,
    // the gate reads it, and no screen can change it — which is exactly the
    // "declared but unreachable" shape this module already had ten of.
    set('gate.vacantFlat.handler', body.gate?.vacantFlat?.handler);
    set('gate.vacantFlat.namedUserIds', body.gate?.vacantFlat?.namedUserIds);
    set('privacy.retentionDays', body.privacy?.retentionDays);
    set('guardApp.language', body.guardApp?.language);
    set('guardApp.offlineQueueEnabled', body.guardApp?.offlineQueueEnabled);

    if (body.gate?.exit?.expectedStayMinutes) {
      for (const [k, v] of Object.entries(body.gate.exit.expectedStayMinutes)) {
        policy.gate.exit.expectedStayMinutes.set(k, Number(v));
      }
      touched = true;
    }
    if (body.gate?.approval) {
      for (const [cat, rule] of Object.entries<any>(body.gate.approval)) {
        const current = policy.gate.approval.get(cat) || approvalFor('NOTIFY_ONLY');
        policy.gate.approval.set(cat, { ...current, ...rule });
      }
      touched = true;
    }

    // Only hand-tuning moves it off the preset. Applying a preset alone leaves
    // the level naming that preset, which is what the screen should say.
    if (touched) policy.gate.level = 'CUSTOM';
  }

  if (body.modules !== undefined) {
    const wanted = (body.modules as string[]).filter(isModule);

    /**
     * Modules that own their own on/off decision cannot be changed from here.
     *
     * Parking is the case: switching it on creates a `ChargeHead`, and
     * switching it off deactivates one. Toggling it through this list would
     * hide the screens and leave the head **active** — every flat quietly
     * still billed for parking nobody can see or manage. Refused rather than
     * silently ignored, because a switch that appears to work and does half
     * the job is worse than one that says no.
     *
     * Its CURRENT state is carried through untouched, so a client that echoes
     * the whole list back (which every screen does) is not fighting this.
     */
    const current = new Set((policy.modules || []).filter(isModule));
    for (const info of OPS_MODULE_CATALOG) {
      if (!info.settingsHref) continue;
      const on = current.has(info.key);
      const asked = wanted.includes(info.key);
      if (on !== asked) {
        throw new OpsPolicyError(
          `${info.label} is switched on and off in its own screen, because that also decides what residents are charged.`,
        );
      }
    }

    policy.modules = wanted;
    // From here on this is a CHOICE, not a guess, and nothing may revisit it.
    policy.modulesInferredAt = undefined;
  }

  // Never settable from outside. A society does not get to let its residents
  // read each other's visitor logs.
  policy.privacy.residentSeesOwnFlatOnly = true;

  policy.updatedBy = oid(actor.userId);
  policy.updatedByName = actor.userName;
  await policy.save();
  logger.info(`Society ${societyId}: ops policy updated by ${actor.userName} (level ${policy.gate.level})`);
  return policy;
}

/** The approval rule for one category, with a safe fallback. */
export function approvalRuleFor(policy: ISocietyOpsPolicy, category: string): IApprovalRule {
  return policy.gate.approval.get(category) || approvalFor('NOTIFY_ONLY');
}

/** How long this category is expected to stay, in minutes. */
export function expectedStayFor(policy: ISocietyOpsPolicy, category: string): number {
  return policy.gate.exit.expectedStayMinutes.get(category) ?? 240;
}

// ------------------------------------------------------------- duty roster

/**
 * The rota behind `gate.vacantFlat.handler === 'DUTY_ROSTER'`.
 *
 * Kept here rather than in `gate-approval.service` on purpose. That file owns
 * ONE question — who gets asked — and every time a second file has grown its
 * own answer to a piece of it, the two have drifted and somebody has been
 * notified about a home that is not theirs. The gate calls `onDutyNow` and does
 * nothing else with these rows; the CRUD below is the settings screen's half
 * and never touches an audience.
 */

export interface DutyRosterInput {
  userId: string;
  blockId?: string | null;
  weekday: number;
  shift?: DutyShift;
  notes?: string;
}

/**
 * A rota entry must name somebody this society can actually reach.
 *
 * Checked rather than trusted, and checked against the MEMBERSHIP rather than
 * against the committee: a society that puts its manager on the rota is doing
 * something sensible, and refusing it would send them straight back to
 * "COMMITTEE_ALL". What is refused is a stranger — a user id from another
 * society stored here would resolve to a real, reachable person who has no idea
 * why they are being asked about a flat in a building they have never seen.
 */
async function resolveRosterPerson(societyId: string, userId: string) {
  const user = await User.findOne(
    { _id: oid(userId), 'memberships.tenantId': oid(societyId) },
    { name: 1 },
  ).lean();
  if (!user) throw new OpsPolicyError('That person is not a member of this society.');

  // The seat is a bonus, not a requirement — it is what lets the notification
  // say "Secretary — R. Nair" instead of a bare name.
  const term = await Committee.findOne({ societyId: oid(societyId), status: 'ACTIVE' }, { _id: 1 }).lean();
  const seat = term && await CommitteeMember.findOne(
    { societyId: oid(societyId), committeeId: term._id, userId: oid(userId), status: 'ACTIVE' },
    { designationLabel: 1 },
  ).lean();

  return {
    userId: oid(userId),
    memberName: user.name || 'Committee member',
    committeeMemberId: seat ? (seat._id as mongoose.Types.ObjectId) : undefined,
    designationLabel: seat?.designationLabel,
  };
}

/** A wing named on a rota row must be one of THIS society's wings. */
async function resolveRosterBlock(societyId: string, blockId?: string | null) {
  if (!blockId) return { blockId: undefined, blockName: undefined };
  const block = await Block.findOne({ _id: oid(blockId), societyId: oid(societyId) }, { name: 1 }).lean();
  if (!block) throw new OpsPolicyError('That wing does not belong to this society.');
  return { blockId: block._id as mongoose.Types.ObjectId, blockName: block.name };
}

export async function listDutyRoster(
  societyId: string, filters: { blockId?: string; weekday?: number; includeRetired?: boolean } = {},
): Promise<IOpsDutyRoster[]> {
  const filter: Record<string, unknown> = { societyId: oid(societyId) };
  if (!filters.includeRetired) filter.isActive = true;
  if (filters.blockId) filter.blockId = oid(filters.blockId);
  if (filters.weekday !== undefined) filter.weekday = filters.weekday;
  return OpsDutyRoster.find(filter).sort({ weekday: 1, shift: 1, blockName: 1, memberName: 1 }).limit(500).lean() as any;
}

export async function addDutyRosterEntry(
  societyId: string, input: DutyRosterInput, actor: { userId: string; userName: string },
): Promise<IOpsDutyRoster> {
  const person = await resolveRosterPerson(societyId, input.userId);
  const wing = await resolveRosterBlock(societyId, input.blockId);

  try {
    return await OpsDutyRoster.create({
      societyId: oid(societyId),
      ...wing, ...person,
      weekday: input.weekday,
      shift: input.shift || 'ALL_DAY',
      notes: input.notes?.trim(),
      isActive: true,
      createdBy: oid(actor.userId), createdByName: actor.userName,
      updatedBy: oid(actor.userId), updatedByName: actor.userName,
    });
  } catch (e: any) {
    // The partial unique index. Being on the rota twice for one slot means being
    // notified twice about one visitor, which is how people learn to mute us.
    if (e?.code === 11000 || e?.errorResponse?.code === 11000) {
      throw new OpsPolicyError(`${person.memberName} is already on duty for that day and shift.`);
    }
    throw e;
  }
}

export async function updateDutyRosterEntry(
  societyId: string, id: string, input: Partial<DutyRosterInput> & { isActive?: boolean },
  actor: { userId: string; userName: string },
): Promise<IOpsDutyRoster> {
  const row = await OpsDutyRoster.findOne({ _id: oid(id), societyId: oid(societyId) });
  if (!row) throw new OpsPolicyError('That duty entry could not be found.');

  if (input.userId !== undefined) {
    const person = await resolveRosterPerson(societyId, input.userId);
    row.userId = person.userId;
    row.memberName = person.memberName;
    row.committeeMemberId = person.committeeMemberId;
    row.designationLabel = person.designationLabel;
  }
  if (input.blockId !== undefined) {
    const wing = await resolveRosterBlock(societyId, input.blockId);
    row.blockId = wing.blockId;
    row.blockName = wing.blockName;
  }
  if (input.weekday !== undefined) row.weekday = input.weekday as any;
  if (input.shift !== undefined) row.shift = input.shift;
  if (input.notes !== undefined) row.notes = input.notes?.trim();
  if (input.isActive !== undefined) row.isActive = input.isActive;

  row.updatedBy = oid(actor.userId);
  row.updatedByName = actor.userName;
  try {
    await row.save();
  } catch (e: any) {
    if (e?.code === 11000 || e?.errorResponse?.code === 11000) {
      throw new OpsPolicyError(`${row.memberName} is already on duty for that day and shift.`);
    }
    throw e;
  }
  return row;
}

/**
 * Taking somebody off the rota deactivates the row; it does not delete it.
 *
 * Not for history — a rota is not a record of events — but because the unique
 * index is partial on `isActive`, so the seat can be filled again by the same
 * person next month without the database remembering that they once held it.
 */
export async function removeDutyRosterEntry(
  societyId: string, id: string, actor: { userId: string; userName: string },
): Promise<IOpsDutyRoster> {
  return updateDutyRosterEntry(societyId, id, { isActive: false }, actor);
}

/** Which shift a given moment falls in. `ALL_DAY` rows match either way. */
export function shiftAt(at: Date): Exclude<DutyShift, 'ALL_DAY'> {
  const hour = at.getHours();
  return hour >= DAY_SHIFT_FROM_HOUR && hour < DAY_SHIFT_TO_HOUR ? 'DAY' : 'NIGHT';
}

/**
 * Who is on duty right now for this wing — the answer the vacant-flat ladder
 * needs, and nothing else.
 *
 * Two rules do the work:
 *
 * **A wing-scoped row beats a society-wide one.** A society that names one duty
 * officer and then adds a specific person for D Wing means the second one for D
 * Wing; falling back to both would notify two people and teach neither that
 * they were the one accountable.
 *
 * **Only reachable people count.** A rota entry naming somebody whose login has
 * since left the society resolves to nobody, and nobody is what the caller must
 * be told — so the ladder falls through to the next rung rather than posting a
 * notification into the void. That fall-through is the whole safety property of
 * the ladder, and a roster that quietly consumed it would be worse than no
 * roster at all.
 *
 * Never throws, for the same reason as `householdOfFlat`: a visitor standing at
 * the gate must still be recorded when a lookup fails.
 */
export async function onDutyNow(
  societyId: string, blockId?: string | null, at = new Date(),
): Promise<{ userIds: string[]; names: string[] }> {
  try {
    const rows = await OpsDutyRoster.find({
      societyId: oid(societyId),
      isActive: true,
      weekday: at.getDay(),
      shift: { $in: ['ALL_DAY', shiftAt(at)] },
    }, { userId: 1, memberName: 1, blockId: 1 }).lean();
    if (!rows.length) return { userIds: [], names: [] };

    const forWing = blockId
      ? rows.filter(r => r.blockId && String(r.blockId) === String(blockId))
      : [];
    const chosen = forWing.length ? forWing : rows.filter(r => !r.blockId);
    if (!chosen.length) return { userIds: [], names: [] };

    // One query rather than one per row: this runs on every visitor to an empty
    // flat, which in a society that never set `Flat.status` is every visitor.
    const reachable = await User.find(
      { _id: { $in: chosen.map(r => r.userId) }, 'memberships.tenantId': oid(societyId) },
      { _id: 1 },
    ).lean();
    const live = new Set(reachable.map(u => String(u._id)));

    const kept = chosen.filter(r => live.has(String(r.userId)));
    return { userIds: kept.map(r => String(r.userId)), names: kept.map(r => r.memberName) };
  } catch (e: any) {
    logger.error(`Could not read the duty roster: ${e.message}`);
    return { userIds: [], names: [] };
  }
}
