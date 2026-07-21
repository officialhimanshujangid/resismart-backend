import mongoose from 'mongoose';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { OPS_MODULES, OpsModule } from '../models/society-ops-policy.model';
import { AccessModule } from '../models/access-role.model';
import { Flat } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { SocietyStaff } from '../models/society-staff.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { Complaint } from '../models/complaint.model';
import { ParkingSlot } from '../models/parking-slot.model';
import { getEffectiveLimits } from './subscription-lifecycle.service';
import { resolveModules as resolveFinanceModules, FINANCE_MODULES, FinanceModule } from './finance-modules.service';
import { DEFAULT_MODULES } from './ops-policy.service';
import { resolveAccess, EffectiveAccess, MODULE_CATALOG } from './access-role.service';
import { UserRole } from '../constants/roles';
import { logger } from '../utils/logger.util';

/**
 * The one place that answers "may this person see this?".
 *
 * Four gates, applied in order, and none of them is the menu:
 *
 *   1. PLAN      what the society bought          — set by ResiSmart
 *   2. SOCIETY   what it switched on              — set by the society admin
 *   3. ROLE      what the office may touch        — AccessRole
 *   4. RESIDENTS what residents are offered       — SocietyOpsPolicy.residentFeatures
 *
 * Before this file there were three separate calls doing part of this job —
 * `/finance/society/modules`, `/gate/modules` and `/access-roles/me` — and all
 * three **failed open**: on any error the client applied no filtering at all,
 * so one slow moment showed a resident the full society-admin menu. Worse, the
 * plan was not consulted anywhere: a society whose plan excluded Complaints
 * still saw the Complaints menu, opened the page, filled in the form, and only
 * then met a 402.
 *
 * This resolver fails CLOSED. If it cannot work out what somebody may do, they
 * get Overview and nothing else. Showing too little is a support call; showing
 * too much is a leak.
 */

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * A plan capability is a number, and `0` is the load-bearing value.
 *
 *   0            not in this plan — the module does not exist for this society
 *   -1 / absent  unlimited
 *   N            included, capped at N
 *
 * Storing entitlement and limit in one number rather than a boolean plus a
 * number keeps `Plan.capabilities` exactly as it already is — a `Map<string,
 * any>` that is already snapshotted onto the subscription at purchase, so a
 * plan edited later cannot silently change what somebody paid for.
 */
export const UNLIMITED = -1;

export interface CapabilitySpec {
  key: string;
  /** The ops or finance module this capability turns on, if any. */
  opsModule?: OpsModule;
  isFinance?: boolean;
  /** Human sentence for the "you have reached your plan limit" message. */
  noun: string;
  count: (societyId: string) => Promise<number>;
}

/** Every sellable capability, and how to count what a society is using. */
export const CAPABILITIES: CapabilitySpec[] = [
  {
    key: 'max_flat_count', noun: 'flats',
    count: (s) => Flat.countDocuments({ societyId: oid(s) }),
  },
  {
    key: 'max_member_count', noun: 'residents',
    count: (s) => Resident.countDocuments({ societyId: oid(s), isActive: true }),
  },
  {
    key: 'max_visitor_count', opsModule: 'GATE', noun: 'visitor entries this month',
    count: (s) => VisitorEntry.countDocuments({ societyId: oid(s), createdAt: { $gte: startOfMonth() } }),
  },
  {
    key: 'max_tickets_count', opsModule: 'COMPLAINTS', noun: 'complaints this month',
    count: (s) => Complaint.countDocuments({ societyId: oid(s), createdAt: { $gte: startOfMonth() } }),
  },
  {
    key: 'max_staff_count', opsModule: 'STAFF', noun: 'staff',
    count: (s) => SocietyStaff.countDocuments({ societyId: oid(s), isActive: true }),
  },
  {
    key: 'max_finance_modules', isFinance: true, noun: 'finance modules',
    count: async (s) => (await resolveFinanceModules(s)).length,
  },
  {
    key: 'max_parking_slots', opsModule: 'PARKING', noun: 'parking slots',
    count: (s) => ParkingSlot.countDocuments({ societyId: oid(s), isActive: true }),
  },
];

function startOfMonth(at = new Date()): Date {
  return new Date(at.getFullYear(), at.getMonth(), 1);
}

/** `0` means "not sold". Anything else — including absent — means available. */
export function planAllows(limits: Record<string, any>, key: string): boolean {
  const raw = limits?.[key];
  if (raw === undefined || raw === null) return true;
  return Number(raw) !== 0;
}

/** `null` when unlimited. */
export function planLimit(limits: Record<string, any>, key: string): number | null {
  const raw = limits?.[key];
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  return n === UNLIMITED ? null : n;
}

export interface Entitlements {
  plan: { name: string; isFreeTier: boolean; status: string; limits: Record<string, any> };
  /** Ops modules that passed BOTH gate 1 and gate 2. */
  opsModules: OpsModule[];
  financeModules: FinanceModule[];
  /** True when the plan sold finance at all. */
  hasFinance: boolean;
  permissions: Partial<Record<AccessModule, string>>;
  isAdmin: boolean;
  awaitingRole: boolean;
  residentFeatures: Record<string, boolean>;
  /** Which permission rows the role editor should offer for this society. */
  offeredPermissions: AccessModule[];
}

/** Everything switched off. What a caller gets when nothing could be resolved. */
function closed(role?: UserRole): Entitlements {
  return {
    plan: { name: 'Unknown', isFreeTier: true, status: 'unknown', limits: {} },
    opsModules: [], financeModules: [], hasFinance: false,
    permissions: {}, isAdmin: false, awaitingRole: true,
    residentFeatures: {}, offeredPermissions: [],
  };
}

/**
 * Which ops modules this society genuinely has: switched on AND paid for.
 *
 * Gate 2 can only ever narrow gate 1. An admin cannot switch on a module their
 * plan excludes, and a plan downgrade takes it away without anybody having to
 * remember to edit the society's own settings.
 */
/**
 * What a society that has never chosen gets — `DEFAULT_MODULES`, imported.
 *
 * Deliberately NOT recomputed here. This file briefly had its own copy
 * (`OPS_MODULES.filter(m => m !== 'PARKING')`) which agreed with the real one
 * by coincidence and would have drifted the first time a fifth module was
 * added — the exact two-answers-to-one-question shape that produced the gate's
 * original privacy bug. `ops-policy.service` owns the question of what a new
 * society starts with; this file only intersects that with the plan.
 *
 * Parking is absent from it on purpose: the other modules describe things
 * every society already does on paper, while a parking map with no bays drawn
 * in it teaches a new admin only that the screen looks broken.
 */
export async function resolveOpsModules(societyId: string, limits: Record<string, any>): Promise<OpsModule[]> {
  const policy = await SocietyOpsPolicy.findOne({ societyId: oid(societyId) }).select('modules').lean();
  // Same reasoning as FinancePolicy: no saved list means the society has never
  // chosen, and the honest default is everything their plan includes.
  const chosen: OpsModule[] = policy?.modules?.length
    ? (policy.modules as OpsModule[]).filter(m => (OPS_MODULES as readonly string[]).includes(m))
    : [...DEFAULT_MODULES];

  return chosen.filter(m => {
    const spec = CAPABILITIES.find(c => c.opsModule === m);
    return !spec || planAllows(limits, spec.key);
  });
}

/**
 * Resolve all four gates for one person in one society.
 *
 * Never throws. A failure returns everything switched off, because the only
 * safe reading of "we could not tell" is "no".
 */
export async function resolveEntitlements(
  societyId: string, userId: string, role: UserRole,
): Promise<Entitlements> {
  try {
    const { limits, planName, status, isFreeTier } = await getEffectiveLimits(societyId);

    const hasFinance = planAllows(limits, 'max_finance_modules');
    const [opsModules, financeAll, access, policy] = await Promise.all([
      resolveOpsModules(societyId, limits),
      hasFinance ? resolveFinanceModules(societyId) : Promise.resolve([] as FinanceModule[]),
      safeAccess(societyId, userId, role),
      SocietyOpsPolicy.findOne({ societyId: oid(societyId) }).select('residentFeatures').lean(),
    ]);

    // A plan may cap HOW MANY finance modules a society runs, not which ones.
    const cap = planLimit(limits, 'max_finance_modules');
    const financeModules = cap === null ? financeAll : financeAll.slice(0, Math.max(0, cap));

    return {
      plan: { name: planName, isFreeTier, status, limits },
      opsModules,
      financeModules,
      hasFinance,
      permissions: access.permissions,
      isAdmin: access.isAdmin,
      awaitingRole: Boolean(access.awaitingRole),
      residentFeatures: (policy?.residentFeatures as any) || defaultResidentFeatures(),
      offeredPermissions: offeredPermissionsFor(opsModules, hasFinance),
    };
  } catch (e: any) {
    logger.error(`Could not resolve entitlements for ${userId} in ${societyId}: ${e.message}`);
    return closed(role);
  }
}

async function safeAccess(societyId: string, userId: string, role: UserRole): Promise<EffectiveAccess> {
  try {
    return await resolveAccess(societyId, userId, role);
  } catch {
    return {
      role, isAdmin: false, awaitingRole: true,
      permissions: {} as any, scope: { allBlocks: false, blockIds: [] },
    };
  }
}

/**
 * The permission rows the role editor should show.
 *
 * Offering "Gate console" in a society that does not use the gate is how an
 * admin ends up granting access to a screen nobody can open, then filing a
 * support ticket about it. The catalog is static; what a given society is
 * asked about should not be.
 */
export function offeredPermissionsFor(opsModules: OpsModule[], hasFinance: boolean): AccessModule[] {
  const needs: Partial<Record<AccessModule, OpsModule>> = {
    GATE_CONSOLE: 'GATE', GATE_LOGS: 'GATE',
    COMPLAINTS_OWN: 'COMPLAINTS', COMPLAINTS_MANAGE: 'COMPLAINTS', COMPLAINTS_CONDUCT: 'COMPLAINTS',
    STAFF_VIEW: 'STAFF', STAFF_MANAGE: 'STAFF',
    PARKING_VIEW: 'PARKING', PARKING_MANAGE: 'PARKING',
  };
  return MODULE_CATALOG.map(m => m.key).filter(key => {
    if (key === 'FINANCE_VIEW' || key === 'FINANCE_MANAGE') return hasFinance;
    const needed = needs[key];
    return !needed || opsModules.includes(needed);
  });
}

export function defaultResidentFeatures(): Record<string, boolean> {
  return {
    visitorApprove: true, visitorInvite: true, visitorHistory: true, visitorPreferences: true,
    complaintRaise: true, complaintCommunity: true, vehicleSelfRegister: true,
    parkingViewOwn: true, parkingRequest: false,
  };
}

/** Live usage next to the ceiling, for the "you are at 63 of 50" banner. */
export async function planUsage(societyId: string, limits: Record<string, any>) {
  const rows = await Promise.all(CAPABILITIES.map(async (c) => ({
    key: c.key,
    noun: c.noun,
    limit: planLimit(limits, c.key),
    included: planAllows(limits, c.key),
    used: planAllows(limits, c.key) ? await c.count(societyId).catch(() => 0) : 0,
  })));
  return rows;
}
