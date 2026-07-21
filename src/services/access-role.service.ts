import mongoose from 'mongoose';
import { AccessRole, ACCESS_MODULES, AccessModule, PermissionLevel, IModuleGrant } from '../models/access-role.model';
import { CommitteeMember } from '../models/committee-member.model';
import { SocietyStaff } from '../models/society-staff.model';
import { Block } from '../models/block.model';
import { UserRole } from '../constants/roles';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class AccessError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface ModuleInfo {
  key: AccessModule;
  label: string;
  blurb: string;
}

/** What the permission editor renders. Ordered as an admin thinks, not alphabetically. */
export const MODULE_CATALOG: ModuleInfo[] = [
  { key: 'GATE_CONSOLE', label: 'Gate console', blurb: 'Record who comes in and goes out.' },
  { key: 'GATE_LOGS', label: 'Gate records & reports', blurb: 'Past entries, overstays, overrides.' },
  { key: 'COMPLAINTS_OWN', label: 'My assigned work', blurb: 'Only the complaints given to this person.' },
  { key: 'COMPLAINTS_MANAGE', label: 'All complaints', blurb: 'See everything, assign it, close it.' },
  { key: 'COMPLAINTS_CONDUCT', label: 'Conduct complaints', blurb: 'Complaints about a person’s behaviour. Give this to as few people as possible.' },
  { key: 'STAFF_VIEW', label: 'Staff list', blurb: 'Who works here.' },
  { key: 'STAFF_MANAGE', label: 'Manage staff', blurb: 'Hire, change, end, and assign duties.' },
  // Two rows, because seeing the map and changing it are genuinely different
  // jobs — and the view half is not merely "read-only": a slot's popover names
  // the flat, the resident and the number plate, which is a directory of who
  // owns what car. A resident sees free or taken and nothing else.
  { key: 'PARKING_VIEW', label: 'Parking map', blurb: 'The map, and who holds each slot.' },
  { key: 'PARKING_MANAGE', label: 'Manage parking', blurb: 'Create slots, allot, release, decide the waiting list.' },
  { key: 'RESIDENTS_VIEW', label: 'Resident directory', blurb: 'Names and contact details. A gatekeeper does not need this.' },
  { key: 'COMMITTEE_MANAGE', label: 'Committee', blurb: 'Start a term, add and remove members.' },
  { key: 'ACCESS_MANAGE', label: 'Who can do what', blurb: 'Create roles and hand out access. Admin work.' },
  { key: 'OPS_SETTINGS', label: 'Gate & complaint settings', blurb: 'The rules everything else follows.' },
  { key: 'FINANCE_VIEW', label: 'Finance — view', blurb: 'Reports and registers, read only.' },
  { key: 'FINANCE_MANAGE', label: 'Finance — record', blurb: 'Bills, receipts, expenses.' },
];

const isModule = (m: string): m is AccessModule => (ACCESS_MODULES as readonly string[]).includes(m);

const grants = (spec: Partial<Record<AccessModule, PermissionLevel>>): IModuleGrant[] =>
  ACCESS_MODULES.map(m => ({ module: m, level: spec[m] ?? 'NONE' }));

/**
 * The roles every society starts with.
 *
 * Nobody should meet an empty permissions screen and a blank grid on their
 * first day. These are editable and can be added to; they simply cannot be
 * deleted, so there is always something to assign.
 *
 * Note what is NOT here: `ACCESS_MANAGE` appears in none of them, not even the
 * Chairman's. Handing out access is the society admin's job, and a role that
 * can grant itself more is not a permission system. MyGate lets any master-
 * access admin mint another master-access admin with no gate at all; that is
 * the door this keeps shut.
 *
 * **Parking.** These roles predate the parking module, so for a while not one of
 * them granted `PARKING_VIEW` or `PARKING_MANAGE` — a society admin saw the
 * parking menu because `isAdmin` bypasses the grid entirely, and a Chairman or
 * an employed manager never did, in a society that had switched parking on and
 * drawn its bays. The split below follows the split everywhere else in this
 * list: the three people who run the society day to day may allot and release,
 * the ones who oversee may look, and a guard gets neither. A guard's job is the
 * gate, and the slot popover names the flat, the resident and their number
 * plate — a directory of who owns which car, handed to the person with the most
 * turnover in the building.
 *
 * These grants only reach a society that has never been seeded — see the note on
 * `seedAccessRoles`, which inserts missing ROLES and never edits existing ones.
 */
const SEEDED_ROLES: { name: string; description: string; appliesTo: 'COMMITTEE' | 'STAFF' | 'BOTH'; spec: Partial<Record<AccessModule, PermissionLevel>> }[] = [
  {
    name: 'Chairman', appliesTo: 'COMMITTEE',
    description: 'Oversight of everything except handing out access.',
    spec: {
      GATE_CONSOLE: 'READ', GATE_LOGS: 'FULL', COMPLAINTS_MANAGE: 'FULL', COMPLAINTS_CONDUCT: 'FULL',
      STAFF_VIEW: 'FULL', STAFF_MANAGE: 'FULL', RESIDENTS_VIEW: 'READ', COMMITTEE_MANAGE: 'FULL',
      PARKING_VIEW: 'FULL', PARKING_MANAGE: 'FULL',
      OPS_SETTINGS: 'FULL', FINANCE_VIEW: 'FULL', FINANCE_MANAGE: 'FULL',
    },
  },
  {
    name: 'Secretary', appliesTo: 'COMMITTEE',
    description: 'Runs the society day to day; holds the records.',
    spec: {
      GATE_LOGS: 'FULL', COMPLAINTS_MANAGE: 'FULL', COMPLAINTS_CONDUCT: 'FULL',
      STAFF_VIEW: 'FULL', STAFF_MANAGE: 'FULL', RESIDENTS_VIEW: 'READ', COMMITTEE_MANAGE: 'FULL',
      PARKING_VIEW: 'FULL', PARKING_MANAGE: 'FULL',
      OPS_SETTINGS: 'FULL', FINANCE_VIEW: 'FULL',
    },
  },
  {
    name: 'Treasurer', appliesTo: 'COMMITTEE',
    description: 'The money, and enough context to make sense of it.',
    spec: {
      GATE_LOGS: 'READ', COMPLAINTS_MANAGE: 'READ', STAFF_VIEW: 'READ',
      // Read, not manage: parking is money, and the treasurer needs to see which
      // flat holds how many slots to make sense of the parking line on a bill.
      // Who gets a slot is the committee's decision, not the treasurer's.
      PARKING_VIEW: 'READ',
      FINANCE_VIEW: 'FULL', FINANCE_MANAGE: 'FULL',
    },
  },
  {
    name: 'Committee member', appliesTo: 'COMMITTEE',
    description: 'Sees what the committee sees, changes little.',
    spec: {
      GATE_LOGS: 'READ', COMPLAINTS_MANAGE: 'READ', STAFF_VIEW: 'READ',
      PARKING_VIEW: 'READ', FINANCE_VIEW: 'READ',
    },
  },
  {
    name: 'Society manager', appliesTo: 'STAFF',
    description: 'Everything day to day. Suits an employed or outsourced manager.',
    spec: {
      GATE_CONSOLE: 'FULL', GATE_LOGS: 'FULL', COMPLAINTS_MANAGE: 'FULL',
      STAFF_VIEW: 'FULL', STAFF_MANAGE: 'FULL', RESIDENTS_VIEW: 'READ',
      // The person who actually walks the basement and knows which bay is empty.
      PARKING_VIEW: 'FULL', PARKING_MANAGE: 'FULL',
      OPS_SETTINGS: 'FULL', FINANCE_VIEW: 'READ',
    },
  },
  {
    name: 'Security guard', appliesTo: 'STAFF',
    description: 'The gate, and nothing else.',
    // No RESIDENTS_VIEW on purpose. A guard needs a flat number to log a
    // visitor against — not every resident's name and phone number.
    spec: { GATE_CONSOLE: 'FULL' },
  },
  {
    name: 'Head guard', appliesTo: 'STAFF',
    description: 'The gate, plus the shift’s records.',
    spec: { GATE_CONSOLE: 'FULL', GATE_LOGS: 'READ' },
  },
  {
    name: 'Technical staff', appliesTo: 'STAFF',
    description: 'Plumber, electrician, gardener — their own work queue.',
    spec: { COMPLAINTS_OWN: 'FULL' },
  },
  {
    name: 'Accountant', appliesTo: 'STAFF',
    description: 'Books only.',
    spec: { FINANCE_VIEW: 'FULL', FINANCE_MANAGE: 'FULL', GATE_LOGS: 'READ' },
  },
  {
    name: 'Auditor (view only)', appliesTo: 'BOTH',
    description: 'Can see everything, can change nothing.',
    spec: {
      GATE_LOGS: 'READ', COMPLAINTS_MANAGE: 'READ', STAFF_VIEW: 'READ',
      RESIDENTS_VIEW: 'READ', PARKING_VIEW: 'READ', FINANCE_VIEW: 'READ',
    },
  },
];

/**
 * Idempotent. Safe to call on every read; only ever inserts what is missing.
 *
 * "Missing" means a role NAME that does not exist yet. It does NOT mean a
 * permission that has since been added to `SEEDED_ROLES` — a society whose
 * Chairman row already exists keeps the grid it was created with, so the parking
 * grants added above reach new societies only.
 *
 * That is deliberate rather than an oversight, and the reason is that
 * `cleanPermissions` stores the FULL grid with `NONE` for anything ungranted:
 * "never offered this" and "the admin deliberately took this away" are the same
 * row in the database. A back-fill would therefore hand parking back to a role
 * an admin had just removed it from, every time this function ran — which is on
 * every read of the roles list.
 *
 * Giving existing societies the new grants needs a one-time, recorded migration
 * (a `seedVersion` on `AccessRole`, raised once and never re-applied), not a
 * widening hidden inside an idempotent seeder. Until that exists, an admin on a
 * live society grants parking to their Chairman by hand on the roles screen.
 */
export async function seedAccessRoles(societyId: string, userId: string, userName: string): Promise<number> {
  const existing = await AccessRole.find({ societyId: oid(societyId) }).select('name').lean();
  const have = new Set(existing.map(r => r.name));
  const missing = SEEDED_ROLES.filter(r => !have.has(r.name));
  if (!missing.length) return 0;

  await AccessRole.insertMany(missing.map(r => ({
    societyId: oid(societyId),
    name: r.name,
    description: r.description,
    appliesTo: r.appliesTo,
    permissions: grants(r.spec),
    scope: { allBlocks: true, blockIds: [] },
    isSystem: true,
    isActive: true,
    createdBy: oid(userId), createdByName: userName,
    updatedBy: oid(userId), updatedByName: userName,
  })), { ordered: false }).catch((e: any) => {
    // A concurrent request may have seeded the same names; the unique index is
    // doing its job and there is nothing to fix.
    if (e?.code !== 11000) throw e;
  });
  return missing.length;
}

export async function listRoles(societyId: string, userId: string, userName: string) {
  await seedAccessRoles(societyId, userId, userName);
  return AccessRole.find({ societyId: oid(societyId) }).sort({ isSystem: -1, name: 1 }).lean();
}

/** Blocks must belong to this society, or a role could scope itself to a stranger's wing. */
async function assertBlocks(societyId: string, blockIds: string[]) {
  if (!blockIds.length) return;
  const mine = await Block.countDocuments({ _id: { $in: blockIds.map(oid) }, societyId: oid(societyId) });
  if (mine !== new Set(blockIds).size) throw new AccessError('One or more wings do not belong to this society.');
}

function cleanPermissions(input: any[]): IModuleGrant[] {
  const byModule = new Map<AccessModule, PermissionLevel>();
  for (const p of input || []) {
    if (!isModule(p?.module)) continue;
    if (!['NONE', 'READ', 'FULL'].includes(p?.level)) continue;
    byModule.set(p.module, p.level);
  }
  // Always store the full grid. A module missing from the array would be
  // indistinguishable from one set to NONE, and the editor needs to show both.
  return ACCESS_MODULES.map(m => ({ module: m, level: byModule.get(m) ?? 'NONE' }));
}

export async function createRole(societyId: string, body: any, actor: { userId: string; userName: string }) {
  await assertBlocks(societyId, body.scope?.blockIds || []);
  try {
    return await AccessRole.create({
      societyId: oid(societyId),
      name: String(body.name).trim(),
      description: body.description,
      appliesTo: body.appliesTo || 'BOTH',
      permissions: cleanPermissions(body.permissions),
      scope: {
        allBlocks: body.scope?.allBlocks !== false,
        blockIds: body.scope?.allBlocks === false ? (body.scope?.blockIds || []).map(oid) : [],
      },
      isSystem: false,
      isActive: true,
      createdBy: oid(actor.userId), createdByName: actor.userName,
      updatedBy: oid(actor.userId), updatedByName: actor.userName,
    });
  } catch (e: any) {
    if (e?.code === 11000) throw new AccessError('A role with that name already exists in this society.', 409);
    throw e;
  }
}

export async function updateRole(societyId: string, id: string, body: any, actor: { userId: string; userName: string }) {
  const role = await AccessRole.findOne({ _id: id, societyId: oid(societyId) });
  if (!role) throw new AccessError('Role not found.', 404);

  if (body.scope) await assertBlocks(societyId, body.scope.blockIds || []);

  // A seeded role may be re-tuned — societies genuinely differ on what a
  // Treasurer should see — but not renamed, so the name stays a stable thing
  // to point at, and not deleted, so there is always something to assign.
  if (!role.isSystem && body.name !== undefined) role.name = String(body.name).trim();
  if (body.description !== undefined) role.description = body.description;
  if (body.appliesTo !== undefined) role.appliesTo = body.appliesTo;
  if (body.permissions !== undefined) role.permissions = cleanPermissions(body.permissions);
  if (body.scope !== undefined) {
    role.scope = {
      allBlocks: body.scope.allBlocks !== false,
      blockIds: body.scope.allBlocks === false ? (body.scope.blockIds || []).map(oid) : [],
    };
  }
  if (body.isActive !== undefined && !role.isSystem) role.isActive = body.isActive;

  role.updatedBy = oid(actor.userId);
  role.updatedByName = actor.userName;
  try {
    await role.save();
  } catch (e: any) {
    if (e?.code === 11000) throw new AccessError('A role with that name already exists in this society.', 409);
    throw e;
  }
  return role;
}

export async function deleteRole(societyId: string, id: string) {
  const role = await AccessRole.findOne({ _id: id, societyId: oid(societyId) });
  if (!role) throw new AccessError('Role not found.', 404);
  if (role.isSystem) throw new AccessError('This is a standard role and cannot be deleted. Switch it off instead.', 409);

  // Both populations, not just committee. A role held only by staff would
  // otherwise delete cleanly and silently strip a guard of the gate console.
  const [seats, posts] = await Promise.all([
    CommitteeMember.countDocuments({ societyId: oid(societyId), accessRoleId: role._id, status: 'ACTIVE' }),
    SocietyStaff.countDocuments({ societyId: oid(societyId), accessRoleId: role._id, isActive: true }),
  ]);
  if (seats + posts > 0) {
    const who = [
      seats ? `${seats} committee member${seats > 1 ? 's' : ''}` : '',
      posts ? `${posts} staff member${posts > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' and ');
    throw new AccessError(`${who} still hold this role. Move them first.`, 409);
  }
  await role.deleteOne();
}

// ---------------------------------------------------------------- resolution

export interface EffectiveAccess {
  role: UserRole;
  /** Empty for an admin — see `isAdmin`, which short-circuits every check. */
  permissions: Record<string, PermissionLevel>;
  isAdmin: boolean;
  scope: { allBlocks: boolean; blockIds: string[] };
  /** Set when the person holds a seat but nobody has said what they may do. */
  awaitingRole?: boolean;
}

const ALL_FULL = (): Record<string, PermissionLevel> =>
  Object.fromEntries(ACCESS_MODULES.map(m => [m, 'FULL' as PermissionLevel]));

const ALL_NONE = (): Record<string, PermissionLevel> =>
  Object.fromEntries(ACCESS_MODULES.map(m => [m, 'NONE' as PermissionLevel]));

/**
 * What can this particular person actually do in this society, right now?
 *
 * The single door every permission question goes through — the middleware, the
 * sidebar and any screen that wants to grey a button out all read this, so
 * there is no second answer to drift out of step with the first.
 */
export async function resolveAccess(
  societyId: string,
  userId: string,
  role: UserRole,
): Promise<EffectiveAccess> {
  // The society admin is not governed by roles. Somebody has to be able to fix
  // a society that has locked itself out, and that person is the admin.
  if (role === UserRole.SOCIETY_ADMIN) {
    return { role, permissions: ALL_FULL(), isAdmin: true, scope: { allBlocks: true, blockIds: [] } };
  }

  if (role === UserRole.SOCIETY_COMMITTEE) {
    const seat = await CommitteeMember.findOne({
      societyId: oid(societyId), userId: oid(userId), status: 'ACTIVE',
    }).populate('accessRoleId').lean();

    const assigned: any = seat?.accessRoleId;
    if (!assigned || assigned.isActive === false) {
      // Holding a seat is not the same as having been given access. Read-only
      // until the admin says otherwise — the safe reading of silence.
      return {
        role, isAdmin: false, awaitingRole: true,
        permissions: ALL_NONE(),
        scope: { allBlocks: true, blockIds: [] },
      };
    }
    return {
      role, isAdmin: false,
      permissions: Object.fromEntries((assigned.permissions || []).map((p: IModuleGrant) => [p.module, p.level])),
      scope: {
        allBlocks: assigned.scope?.allBlocks !== false,
        blockIds: (assigned.scope?.blockIds || []).map(String),
      },
    };
  }

  if (role === UserRole.SOCIETY_EMPLOYEE) {
    const post = await SocietyStaff.findOne({
      societyId: oid(societyId), userId: oid(userId), isActive: true,
    }).populate('accessRoleId').lean();

    const assigned: any = post?.accessRoleId;
    if (!assigned || assigned.isActive === false) {
      // Same reading of silence as a committee seat: employed is not the same
      // as authorised, and until somebody says what they may do, they may not.
      return {
        role, isAdmin: false, awaitingRole: true,
        permissions: ALL_NONE(),
        scope: { allBlocks: true, blockIds: [] },
      };
    }
    return {
      role, isAdmin: false,
      permissions: Object.fromEntries((assigned.permissions || []).map((p: IModuleGrant) => [p.module, p.level])),
      scope: {
        allBlocks: assigned.scope?.allBlocks !== false,
        blockIds: (assigned.scope?.blockIds || []).map(String),
      },
    };
  }

  // Residents and anyone else: no society-level permissions at all. They reach
  // their own screens through their own routes, not through these.
  return { role, isAdmin: false, permissions: ALL_NONE(), scope: { allBlocks: true, blockIds: [] } };
}

/** Does this access allow `module` at `level` or better? */
export function allows(access: EffectiveAccess, module: AccessModule, needed: 'READ' | 'FULL'): boolean {
  if (access.isAdmin) return true;
  const have = access.permissions[module] ?? 'NONE';
  if (have === 'NONE') return false;
  return needed === 'READ' ? true : have === 'FULL';
}

/** May this access touch data belonging to `blockId`? */
export function allowsBlock(access: EffectiveAccess, blockId?: string | null): boolean {
  if (access.isAdmin || access.scope.allBlocks) return true;
  // Society-wide data carries no wing. Refusing it would leave a wing-scoped
  // member unable to see anything at all, which is not what "A and B wing"
  // means to the person who set it.
  if (!blockId) return true;
  return access.scope.blockIds.includes(String(blockId));
}

/** Assign (or clear) a committee member's role. */
export async function setCommitteeMemberRole(
  societyId: string,
  memberId: string,
  accessRoleId: string | null,
  actor: { userId: string; userName: string },
) {
  const member = await CommitteeMember.findOne({ _id: memberId, societyId: oid(societyId) });
  if (!member) throw new AccessError('Committee member not found.', 404);

  if (accessRoleId) {
    const role = await AccessRole.findOne({ _id: accessRoleId, societyId: oid(societyId), isActive: true }).lean();
    if (!role) throw new AccessError('That role does not belong to this society.', 400);
    if (role.appliesTo === 'STAFF') throw new AccessError('That role is for staff, not committee seats.', 400);
    member.accessRoleId = oid(accessRoleId);
  } else {
    member.accessRoleId = undefined;
  }
  member.updatedBy = oid(actor.userId);
  member.updatedByName = actor.userName;
  await member.save();
  logger.info(`Society ${societyId}: committee member ${memberId} access role → ${accessRoleId || 'none'}`);
  return member;
}
