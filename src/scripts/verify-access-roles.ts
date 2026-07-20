/**
 * Phase 3 — who can do what, and enforced where it counts.
 * Real database, THROWAWAY societyIds, self-cleaning. Never touches existing data.
 *
 * The load-bearing assertions are the ones driven through the MIDDLEWARE, not
 * the service. The bug this phase exists to avoid is already in this codebase:
 * `PermissionRole` is stored, edited and rendered, and checked on exactly zero
 * requests. A permission that only the sidebar respects is not a permission.
 *
 *   npx ts-node src/scripts/verify-access-roles.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { AccessRole, ACCESS_MODULES } from '../models/access-role.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { Block } from '../models/block.model';
import { UserRole } from '../constants/roles';
import {
  seedAccessRoles, listRoles, createRole, updateRole, deleteRole,
  resolveAccess, setCommitteeMemberRole, AccessError,
} from '../services/access-role.service';
import { requirePermission } from '../middlewares/access.middleware';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const chairmanId = new mongoose.Types.ObjectId();
const wingMemberId = new mongoose.Types.ObjectId();
const unassignedId = new mongoose.Types.ObjectId();
const actor = { userId: adminId.toString(), userName: 'Verifier' };
const SID = societyId.toString();
const OTHER = otherId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/**
 * Drive the real middleware — no HTTP server, but the same code path a request
 * takes. Asserting against the service would prove the service works and say
 * nothing about whether anything calls it.
 */
const call = async (
  who: { userId: mongoose.Types.ObjectId; role: UserRole; tenant?: string },
  module: any, needed: 'READ' | 'FULL',
  opts: any = {},
  bag: any = {},
) => {
  let allowed = false, status = 0, code = '';
  const req: any = {
    user: { activeTenantId: who.tenant || SID, userId: who.userId.toString(), activeRole: who.role },
    body: bag.body || {}, query: bag.query || {}, params: bag.params || {},
  };
  const res: any = {
    status(c: number) { status = c; return res; },
    json(b: any) { code = b?.code || ''; return res; },
  };
  await requirePermission(module, needed, opts)(req, res, () => { allowed = true; });
  return { allowed, status, code, access: req.access };
};

const mkMember = async (userId: mongoose.Types.ObjectId, name: string, committeeId: mongoose.Types.ObjectId) =>
  CommitteeMember.create({
    committeeId, societyId, userId,
    memberSnapshot: { name },
    designationKey: 'MEMBER', designationLabel: 'Member',
    startDate: new Date(), status: 'ACTIVE',
    createdBy: adminId, createdByName: actor.userName,
    updatedBy: adminId, updatedByName: actor.userName,
  });

async function cleanup() {
  for (const s of [societyId, otherId]) {
    await Promise.all([
      AccessRole.deleteMany({ societyId: s }),
      CommitteeMember.deleteMany({ societyId: s }),
      Committee.deleteMany({ societyId: s }),
      Block.deleteMany({ societyId: s }),
    ]);
  }
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    const [wingA, wingB, wingC] = await Block.create([
      { name: 'A Wing', societyId, createdBy: adminId, createdByName: actor.userName, updatedBy: adminId, updatedByName: actor.userName },
      { name: 'B Wing', societyId, createdBy: adminId, createdByName: actor.userName, updatedBy: adminId, updatedByName: actor.userName },
      { name: 'C Wing', societyId, createdBy: adminId, createdByName: actor.userName, updatedBy: adminId, updatedByName: actor.userName },
    ]);
    const committee = await Committee.create({
      societyId, name: 'Term 2026', termStartDate: new Date(), status: 'ACTIVE',
      createdBy: adminId, createdByName: actor.userName, updatedBy: adminId, updatedByName: actor.userName,
    });

    // =================================================================== seeding
    console.log('Every society starts with roles it can actually use');
    const roles = await listRoles(SID, actor.userId, actor.userName);
    ok('roles are seeded on first read', roles.length >= 10, `${roles.length}`);
    ok('...and they are marked as standard', roles.every(r => r.isSystem));
    ok('a Chairman role exists', roles.some(r => r.name === 'Chairman'));
    ok('...and a Security guard role', roles.some(r => r.name === 'Security guard'));

    const again = await seedAccessRoles(SID, actor.userId, actor.userName);
    eq('seeding twice inserts nothing the second time', again, 0);

    // The door this deliberately keeps shut.
    const anyCanManage = roles.filter(r =>
      r.permissions.some(p => p.module === 'ACCESS_MANAGE' && p.level !== 'NONE'));
    eq('NO seeded role can hand out access — not even the Chairman', anyCanManage.length, 0);

    const guard = roles.find(r => r.name === 'Security guard')!;
    const guardResidents = guard.permissions.find(p => p.module === 'RESIDENTS_VIEW')!;
    eq('a guard cannot read the resident directory', guardResidents.level, 'NONE');
    eq('...but runs the gate', guard.permissions.find(p => p.module === 'GATE_CONSOLE')!.level, 'FULL');

    // Every module is stored, including the ones set to NONE — "deliberately
    // withheld" and "never considered" must stay distinguishable.
    eq('the full grid is stored, not just the granted ones', guard.permissions.length, ACCESS_MODULES.length);

    // ============================================================ the admin
    console.log('\nThe society admin is not governed by roles');
    const adminAccess = await resolveAccess(SID, adminId.toString(), UserRole.SOCIETY_ADMIN);
    ok('the admin is flagged as such', adminAccess.isAdmin);
    ok('...and passes every check', (await call({ userId: adminId, role: UserRole.SOCIETY_ADMIN }, 'ACCESS_MANAGE', 'FULL')).allowed);
    ok('...including wing-scoped ones', (await call(
      { userId: adminId, role: UserRole.SOCIETY_ADMIN }, 'COMPLAINTS_MANAGE', 'FULL',
      { block: { from: 'body' } }, { body: { blockId: String(wingC._id) } },
    )).allowed);

    // ================================================ a seat is not an access grant
    console.log('\nHolding a seat is not the same as being given access');
    await mkMember(unassignedId, 'Unassigned Member', committee._id as mongoose.Types.ObjectId);
    const noRole = await call({ userId: unassignedId, role: UserRole.SOCIETY_COMMITTEE }, 'GATE_LOGS', 'READ');
    ok('a member with no role is refused', !noRole.allowed);
    eq('...with 403', noRole.status, 403);
    eq('...and a code the screen can explain', noRole.code, 'ACCESS_NOT_ASSIGNED');

    // =========================================================== level enforcement
    console.log('\nLevels are enforced on the server, not just in the sidebar');
    const treasurer = roles.find(r => r.name === 'Treasurer')!;
    const chair = await mkMember(chairmanId, 'Chair Person', committee._id as mongoose.Types.ObjectId);
    await setCommitteeMemberRole(SID, String(chair._id), String(treasurer._id), actor);

    const who = { userId: chairmanId, role: UserRole.SOCIETY_COMMITTEE };
    ok('READ passes where the role says READ', (await call(who, 'GATE_LOGS', 'READ')).allowed);
    const writeDenied = await call(who, 'GATE_LOGS', 'FULL');
    ok('...but FULL does not', !writeDenied.allowed);
    eq('...with 403', writeDenied.status, 403);
    eq('...and the plain denial code', writeDenied.code, 'ACCESS_DENIED');
    ok('FULL passes where the role says FULL', (await call(who, 'FINANCE_MANAGE', 'FULL')).allowed);
    ok('a NONE module is refused outright', !(await call(who, 'COMPLAINTS_CONDUCT', 'READ')).allowed);

    // ============================================== the wing scope, the real gap
    console.log('\nWing scope is enforced on the API — no competitor does this at all');
    const wingRole = await createRole(SID, {
      name: 'A & B wing member',
      appliesTo: 'COMMITTEE',
      permissions: [{ module: 'COMPLAINTS_MANAGE', level: 'FULL' }],
      scope: { allBlocks: false, blockIds: [String(wingA._id), String(wingB._id)] },
    }, actor);
    const wingSeat = await mkMember(wingMemberId, 'Wing Member', committee._id as mongoose.Types.ObjectId);
    await setCommitteeMemberRole(SID, String(wingSeat._id), String(wingRole._id), actor);

    const wingWho = { userId: wingMemberId, role: UserRole.SOCIETY_COMMITTEE };
    const inScope = await call(wingWho, 'COMPLAINTS_MANAGE', 'FULL',
      { block: { from: 'body' } }, { body: { blockId: String(wingA._id) } });
    ok('their own wing passes', inScope.allowed);

    const outOfScope = await call(wingWho, 'COMPLAINTS_MANAGE', 'FULL',
      { block: { from: 'body' } }, { body: { blockId: String(wingC._id) } });
    ok('another wing is refused — from the API, not just hidden in the menu', !outOfScope.allowed);
    eq('...with 403', outOfScope.status, 403);
    eq('...saying why', outOfScope.code, 'ACCESS_WRONG_WING');

    const viaQuery = await call(wingWho, 'COMPLAINTS_MANAGE', 'FULL',
      { block: { from: 'query' } }, { query: { blockId: String(wingC._id) } });
    ok('...and the query string is no way round it', !viaQuery.allowed);
    const viaParams = await call(wingWho, 'COMPLAINTS_MANAGE', 'FULL',
      { block: { from: 'params', key: 'id' } }, { params: { id: String(wingC._id) } });
    ok('...nor the URL', !viaParams.allowed);

    // Society-wide data has no wing. Refusing it would leave a wing-scoped
    // member unable to see anything at all.
    ok('data belonging to no wing is still visible', (await call(
      wingWho, 'COMPLAINTS_MANAGE', 'FULL', { block: { from: 'body' } }, { body: {} },
    )).allowed);

    // ======================================================= cross-society
    console.log('\nOne society cannot reach into another');
    const strangerRole = await createRole(OTHER, {
      name: 'Manager', permissions: [{ module: 'GATE_CONSOLE', level: 'FULL' }],
    }, actor);

    let crossAssign = '';
    try { await setCommitteeMemberRole(SID, String(chair._id), String(strangerRole._id), actor); }
    catch (e: any) { crossAssign = e.message; }
    ok('a role from another society cannot be assigned', crossAssign.includes('does not belong'), crossAssign);

    // The name collision that the platform-wide PermissionRole would have caused.
    const sameName = await createRole(SID, {
      name: 'Manager', permissions: [{ module: 'GATE_CONSOLE', level: 'FULL' }],
    }, actor);
    eq('...but both societies may have a role called "Manager"', sameName.name, 'Manager');

    let dupName = '';
    try { await createRole(SID, { name: 'Manager', permissions: [] }, actor); }
    catch (e: any) { dupName = e.message; }
    ok('a duplicate name inside ONE society is refused', dupName.includes('already exists'), dupName);

    let strangerWing = '';
    try {
      await createRole(SID, {
        name: 'Bad scope', permissions: [],
        scope: { allBlocks: false, blockIds: [String((await Block.create({
          name: 'Their Wing', societyId: otherId,
          createdBy: adminId, createdByName: actor.userName, updatedBy: adminId, updatedByName: actor.userName,
        }))._id)] },
      }, actor);
    } catch (e: any) { strangerWing = e.message; }
    ok('a wing from another society cannot be scoped to', strangerWing.includes('do not belong'), strangerWing);

    // ==================================================== seeded roles are protected
    console.log('\nStandard roles can be tuned but not removed');
    let delSystem = '';
    try { await deleteRole(SID, String(treasurer._id)); }
    catch (e: any) { delSystem = e.message; }
    ok('a standard role cannot be deleted', delSystem.includes('cannot be deleted'), delSystem);

    const tuned = await updateRole(SID, String(treasurer._id), {
      name: 'Renamed Treasurer',
      permissions: [{ module: 'FINANCE_VIEW', level: 'READ' }],
    }, actor);
    eq('...but its permissions can be changed', tuned.permissions.find(p => p.module === 'FINANCE_VIEW')!.level, 'READ');
    eq('...while the name stays put, so it remains a stable thing to point at', tuned.name, 'Treasurer');

    // A role in use cannot vanish under the person holding it.
    let inUse = '';
    try { await deleteRole(SID, String(wingRole._id)); }
    catch (e: any) { inUse = e.message; }
    ok('a role still held by someone cannot be deleted', inUse.includes('still hold'), inUse);

    // ============================================ tuning a role takes effect at once
    console.log('\nChanging a role changes what its holder can do, immediately');
    ok('the wing member could manage complaints a moment ago',
      (await call(wingWho, 'COMPLAINTS_MANAGE', 'FULL')).allowed);
    await updateRole(SID, String(wingRole._id), {
      permissions: [{ module: 'COMPLAINTS_MANAGE', level: 'READ' }],
    }, actor);
    ok('...and now cannot, without signing out and in',
      !(await call(wingWho, 'COMPLAINTS_MANAGE', 'FULL')).allowed);

    // Switching the ROLE off must bite the people holding it, not just stop
    // new assignments — otherwise "disable" is a label with no effect on
    // anyone who already has it, which is the worst kind of safety control.
    await setCommitteeMemberRole(SID, String(chair._id), String(sameName._id), actor);
    ok('the Manager role works while it is on',
      (await call(who, 'GATE_CONSOLE', 'FULL')).allowed);

    await updateRole(SID, String(sameName._id), { isActive: false }, actor);
    const afterDisable = await call(who, 'GATE_CONSOLE', 'FULL');
    ok('...and stops working the moment it is switched off', !afterDisable.allowed);
    eq('...treating the holder as unassigned, not as denied', afterDisable.code, 'ACCESS_NOT_ASSIGNED');

    // And a role already switched off cannot be handed out in the first place.
    let assignDisabled = '';
    try { await setCommitteeMemberRole(SID, String(chair._id), String(sameName._id), actor); }
    catch (e: any) { assignDisabled = e.message; }
    ok('a switched-off role cannot be assigned to anyone new',
      assignDisabled.includes('does not belong'), assignDisabled);

    // ================================================= an ended seat ends the access
    console.log('\nLeaving the committee ends the access with it');
    await CommitteeMember.updateOne({ _id: wingSeat._id }, { $set: { status: 'INACTIVE', endDate: new Date() } });
    const gone = await call(wingWho, 'COMPLAINTS_MANAGE', 'READ');
    ok('a former member is refused', !gone.allowed);
    eq('...as somebody with no role at all', gone.code, 'ACCESS_NOT_ASSIGNED');

    // ============================================================== fails closed
    console.log('\nWhen it cannot check, it refuses');
    const noTenant: any = { user: { userId: adminId.toString(), activeRole: UserRole.SOCIETY_ADMIN }, body: {}, query: {}, params: {} };
    let unauthStatus = 0;
    const noTenantRes: any = { status(c: number) { unauthStatus = c; return noTenantRes; }, json() { return noTenantRes; } };
    let nexted = false;
    await requirePermission('GATE_CONSOLE', 'READ')(noTenant, noTenantRes, () => { nexted = true; });
    ok('a request with no society is refused', !nexted);
    eq('...as unauthenticated', unauthStatus, 401);

    // A role nothing can create yet resolves to nothing — not to everything.
    const employee = await resolveAccess(SID, unassignedId.toString(), UserRole.SOCIETY_EMPLOYEE);
    ok('SOCIETY_EMPLOYEE has a context but no permissions until staff exists',
      Object.values(employee.permissions).every(l => l === 'NONE'));
    ok('...and is definitely not an admin', !employee.isAdmin);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
