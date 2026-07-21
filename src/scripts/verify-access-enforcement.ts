/**
 * Phase 1 — the permissions that were decoration.
 *
 * Every assertion here FAILS against the code as it stood before this phase.
 *
 * It speaks HTTP throughout, because that is the only layer where the bug
 * existed. `FINANCE_MANAGE`, `FINANCE_VIEW` and `RESIDENTS_VIEW` were real
 * fields, editable in a real screen, stored on a real document — and no route
 * ever read them. A service-level test would have passed every day of it.
 *
 * The persona that matters most here is the committee member holding a seat
 * with **no role assigned at all** (`awaitingRole`). They are the honest test
 * of "does silence mean no?", and before this phase silence meant full write
 * access to the society's books.
 *
 *   npx tsx src/scripts/verify-access-enforcement.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import request from 'supertest';
import { appConfig } from '../config/appConfig';
import app from '../app';
import { User } from '../models/user.model';
import { Society } from '../models/society.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { CommitteeDesignation } from '../models/committee-designation.model';
import { AccessRole } from '../models/access-role.model';
import { SocietyStaff } from '../models/society-staff.model';
import { SocietyFinanceSettings } from '../models/society-finance-settings.model';
import { seedAccessRoles } from '../services/access-role.service';
import { createStaff } from '../services/staff.service';
import { generateAccessToken } from '../utils/jwt.util';
import { UserRole, TenantType } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};

const tokenFor = (userId: mongoose.Types.ObjectId, role: UserRole) =>
  generateAccessToken({
    userId: String(userId), activeTenantId: SID,
    activeTenantType: TenantType.SOCIETY, activeRole: role,
  });

const ids: mongoose.Types.ObjectId[] = [];
const mkUser = async (name: string, role: UserRole) => {
  const u = await User.create({
    name,
    email: `${name.replace(/\W/g, '').toLowerCase()}.${Date.now()}${Math.random().toString(36).slice(2, 6)}@throwaway.test`,
    password: 'x'.repeat(20), role,
    memberships: [{ tenantType: TenantType.SOCIETY, tenantId: societyId, role }],
  });
  ids.push(u._id as any);
  return u._id as mongoose.Types.ObjectId;
};

async function cleanup() {
  await Promise.all([
    Society.deleteMany({ _id: societyId }), Block.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Resident.deleteMany({ societyId }),
    Committee.deleteMany({ societyId }), CommitteeMember.deleteMany({ societyId }),
    CommitteeDesignation.deleteMany({ societyId }), AccessRole.deleteMany({ societyId }),
    SocietyStaff.deleteMany({ societyId }), SocietyFinanceSettings.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    // -------------------------------------------------------------- fixtures
    const admin = await mkUser('Admin', UserRole.SOCIETY_ADMIN);
    const bareSeat = await mkUser('Bare Seat', UserRole.SOCIETY_COMMITTEE);
    const treasurer = await mkUser('Treasurer', UserRole.SOCIETY_COMMITTEE);
    const manager = await mkUser('Manager', UserRole.SOCIETY_EMPLOYEE);
    const resident = await mkUser('Resident', UserRole.RESIDENT_OWNER);

    const audit = {
      societyId, createdBy: admin, createdByName: 'Setup',
      updatedBy: admin, updatedByName: 'Setup',
    };

    await Society.create({
      _id: societyId, name: `Throwaway ${SID}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: admin,
      createdBy: admin, createdByName: 'Setup', updatedBy: admin, updatedByName: 'Setup',
    } as any);

    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const flat = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '101', status: FlatStatus.OWNER_OCCUPIED, ownerUserId: resident,
    });
    await Resident.create({
      ...audit, flatId: flat._id, userId: resident, person: { name: 'Resident' },
      relationship: 'OWNER', householdType: 'OWNER', isActive: true,
    });

    await seedAccessRoles(SID, String(admin), 'Setup');
    const roles = await AccessRole.find({ societyId }).lean();
    const roleNamed = (n: string) => roles.find(r => r.name === n)!;

    // A committee term, so committee members resolve to a real seat.
    const term = await Committee.create({
      ...audit, name: 'MC 2026', termStartDate: new Date('2026-01-01'), status: 'ACTIVE',
    });
    await CommitteeDesignation.create({
      ...audit, key: 'MEMBER', label: 'Member', rank: 6, active: true,
    });
    await CommitteeMember.create([
      // No accessRoleId at all — the `awaitingRole` persona.
      { ...audit, committeeId: term._id, userId: bareSeat,
        memberSnapshot: { name: 'Bare Seat' }, designationKey: 'MEMBER', designationLabel: 'Member',
        startDate: new Date('2026-01-01'), status: 'ACTIVE', appointment: 'ELECTED' },
      { ...audit, committeeId: term._id, userId: treasurer,
        memberSnapshot: { name: 'Treasurer' }, designationKey: 'MEMBER', designationLabel: 'Member',
        startDate: new Date('2026-01-01'), status: 'ACTIVE', appointment: 'ELECTED',
        accessRoleId: roleNamed('Treasurer')._id },
    ]);

    const adminTk = tokenFor(admin, UserRole.SOCIETY_ADMIN);
    const bareTk = tokenFor(bareSeat, UserRole.SOCIETY_COMMITTEE);
    const treasurerTk = tokenFor(treasurer, UserRole.SOCIETY_COMMITTEE);
    const residentTk = tokenFor(resident, UserRole.RESIDENT_OWNER);
    const auth = (tk: string) => ({ Authorization: `Bearer ${tk}` });

    // ==================================================== finance permissions
    console.log('C-6 — the money needs a permission, not just a seat');

    const bareReads = await request(app)
      .get('/api/v1/finance/society/bills').set(auth(bareTk));
    ok('a committee seat with no role assigned cannot read the books',
      bareReads.status === 403, `got ${bareReads.status}`);
    ok('...and is told why, rather than just refused',
      bareReads.body?.code === 'ACCESS_NOT_ASSIGNED', JSON.stringify(bareReads.body));

    const bareWrites = await request(app)
      .post('/api/v1/finance/society/funds').set(auth(bareTk))
      .send({ name: 'Sinking', kind: 'SINKING' });
    ok('...and certainly cannot create a fund', bareWrites.status === 403,
      `got ${bareWrites.status}`);

    // The Treasurer holds FINANCE_VIEW FULL + FINANCE_MANAGE FULL.
    const treasurerReads = await request(app)
      .get('/api/v1/finance/society/bills').set(auth(treasurerTk));
    ok('a treasurer still reads the books', treasurerReads.status !== 403,
      `got ${treasurerReads.status}`);

    // A "Committee member" role is FINANCE_VIEW READ, FINANCE_MANAGE NONE.
    await CommitteeMember.updateOne(
      { userId: treasurer },
      { $set: { accessRoleId: roleNamed('Committee member')._id } },
    );
    const viewOnlyReads = await request(app)
      .get('/api/v1/finance/society/bills').set(auth(treasurerTk));
    ok('a view-only member may still look', viewOnlyReads.status !== 403,
      `got ${viewOnlyReads.status}`);
    const viewOnlyWrites = await request(app)
      .post('/api/v1/finance/society/funds').set(auth(treasurerTk))
      .send({ name: 'Sinking', kind: 'SINKING' });
    ok('...but not record anything', viewOnlyWrites.status === 403,
      `got ${viewOnlyWrites.status}`);
    ok('...and is told it is a permission problem',
      viewOnlyWrites.body?.code === 'ACCESS_DENIED', JSON.stringify(viewOnlyWrites.body));

    ok('the admin is never locked out of their own society',
      (await request(app).get('/api/v1/finance/society/bills').set(auth(adminTk))).status !== 403);

    // ================================================== resident directory
    console.log('\nC-7 — the resident directory needs RESIDENTS_VIEW');

    // Back to a bare seat: no role at all.
    const dir = await request(app)
      .get(`/api/v1/societies/flats/${flat._id}/household`).set(auth(bareTk));
    ok('a committee seat with no role cannot read a household',
      dir.status === 403, `got ${dir.status}`);

    const timeline = await request(app)
      .get(`/api/v1/societies/flats/${flat._id}/timeline`).set(auth(bareTk));
    ok('...nor the flat timeline, which carries sale prices',
      timeline.status === 403, `got ${timeline.status}`);

    const eligible = await request(app)
      .get('/api/v1/committee/eligible-members').set(auth(residentTk));
    ok('a resident cannot enumerate every other resident',
      eligible.status === 403, `got ${eligible.status}`);

    ok('a resident still reaches their OWN household',
      (await request(app).get(`/api/v1/societies/flats/${flat._id}/household`)
        .set(auth(residentTk))).status === 200);

    // Give the bare seat a role that includes the directory.
    await CommitteeMember.updateOne(
      { userId: bareSeat },
      { $set: { accessRoleId: roleNamed('Chairman')._id } },
    );
    ok('a chairman, who was given the directory, reads it',
      (await request(app).get(`/api/v1/societies/flats/${flat._id}/household`)
        .set(auth(bareTk))).status === 200);

    // ============================================ H-18 privilege escalation
    console.log('\nH-18 — nobody hands out access they do not hold');

    const managerStaff = await createStaff(SID, {
      name: 'Manager', phone: '9876500011', designation: 'MANAGER',
      employmentType: 'DIRECT', accessRoleId: String(roleNamed('Society manager')._id),
    } as any, { userId: String(admin), userName: 'Admin' });
    await SocietyStaff.updateOne({ _id: managerStaff._id }, { $set: { userId: manager } });
    const managerTk = tokenFor(manager, UserRole.SOCIETY_EMPLOYEE);

    // "Society manager" holds STAFF_MANAGE FULL and NOT ACCESS_MANAGE. Before
    // this phase they could mint a peer with the very same role — an equality
    // check would have waved that through, which is why the rule is that
    // attaching a role at all is admin work.
    const clone = await request(app).post('/api/v1/staff').set(auth(managerTk)).send({
      name: 'Planted Peer', phone: '9876500022', designation: 'MANAGER',
      employmentType: 'DIRECT', accessRoleId: String(roleNamed('Society manager')._id),
    });
    ok('a manager cannot mint another manager', clone.status === 403,
      `got ${clone.status} ${JSON.stringify(clone.body)}`);

    // Not even a lesser role: what somebody may do is the admin's call.
    const guardWithRole = await request(app).post('/api/v1/staff').set(auth(managerTk)).send({
      name: 'Guard With Role', phone: '9876500033', designation: 'SECURITY_GUARD',
      employmentType: 'DIRECT', accessRoleId: String(roleNamed('Security guard')._id),
    });
    ok('...nor hand out any other role', guardWithRole.status === 403,
      `got ${guardWithRole.status}`);

    // ...but hiring itself is still their job.
    const hired = await request(app).post('/api/v1/staff').set(auth(managerTk)).send({
      name: 'New Guard', phone: '9876500033', designation: 'SECURITY_GUARD',
      employmentType: 'DIRECT',
    });
    ok('a manager may still hire somebody', hired.status === 201,
      `got ${hired.status} ${JSON.stringify(hired.body)}`);

    const login = await request(app)
      .post(`/api/v1/staff/${hired.body?.data?._id}/login`).set(auth(managerTk));
    ok('...but cannot mint them a login and read the password',
      login.status === 403, `got ${login.status}`);

    ok('the admin may assign anything',
      (await request(app).post('/api/v1/staff').set(auth(adminTk)).send({
        name: 'Second Manager', phone: '9876500044', designation: 'MANAGER',
        employmentType: 'DIRECT', accessRoleId: String(roleNamed('Society manager')._id),
      })).status === 201);

    ok('...and may create the login',
      (await request(app).post(`/api/v1/staff/${hired.body?.data?._id}/login`)
        .set(auth(adminTk))).status === 200);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  await mongoose.disconnect();
  process.exit(1);
});
