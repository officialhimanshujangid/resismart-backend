import mongoose from 'mongoose';
import {
  SocietyOpsPolicy, ISocietyOpsPolicy, OPS_MODULES, OpsModule,
  GateLevel, VISITOR_CATEGORIES, IApprovalRule,
} from '../models/society-ops-policy.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { SocietyStaff } from '../models/society-staff.model';
import { Complaint } from '../models/complaint.model';
import { Asset } from '../models/asset.model';
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
 */
export const DEFAULT_MODULES: OpsModule[] = ['GATE', 'COMPLAINTS', 'STAFF', 'ASSETS'];

export interface OpsModuleInfo {
  key: OpsModule;
  label: string;
  blurb: string;
  pages: string[];
}

export const OPS_MODULE_CATALOG: OpsModuleInfo[] = [
  { key: 'GATE', label: 'Gate & visitors', blurb: 'Who comes in and who goes out.', pages: ['Gate Console', 'Gate Records'] },
  { key: 'COMPLAINTS', label: 'Complaints', blurb: 'Residents report a problem; somebody is made responsible for fixing it.', pages: ['Complaints'] },
  { key: 'STAFF', label: 'Staff', blurb: 'The people the society employs, and which wing each looks after.', pages: ['Staff'] },
  { key: 'ASSETS', label: 'Assets', blurb: 'Lifts, pumps and tanks — with a QR sticker that raises a complaint against the right one.', pages: ['Assets'] },
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
    policy.modules = (body.modules as string[]).filter(isModule);
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
