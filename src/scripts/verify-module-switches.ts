/**
 * The module gate, and the switch it was missing.
 *
 * The reported bug was "parking system created but not reflected on society UI,
 * no parking option, no sidebar" — and the cause was not parking. Gate 2 has
 * filtered the menu by `SocietyOpsPolicy.modules` since Phase 4, and there was
 * no screen anywhere in the product that could change that list. Parking, which
 * is deliberately absent from `DEFAULT_MODULES`, was therefore correctly hidden
 * by code that worked, with no way to ask for it. The same was true in reverse:
 * a society could not switch Complaints off either.
 *
 * What has to be true, and every assertion below is one of them:
 *
 *   1. A module can be switched on and off over HTTP, by the admin, in one call.
 *   2. Switching PARKING on reaches `/me/entitlements.opsModules` — which is
 *      what the sidebar reads. A switch the menu never hears about is not a fix.
 *   3. `/parking/zones` 404s before and 200s after. The menu and the API have to
 *      agree, or somebody is told to use a screen that refuses them.
 *   4. Switching a module OFF keeps its data, and switching it back ON returns
 *      it untouched. This is the promise the confirm dialog makes in words.
 *   5. The PLAN still wins. A society on a plan with `max_parking_slots: 0` can
 *      flip every switch it likes and parking stays gone.
 *   6. The seeded Chairman role grants `PARKING_MANAGE`. Before this, no seeded
 *      role granted parking at all: a society admin saw the menu (admins bypass
 *      the grid) and a Chairman never did.
 *
 *   npx tsx src/scripts/verify-module-switches.ts
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
import { Plan } from '../models/plan.model';
import { Subscription } from '../models/subscription.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { SocietyStaff } from '../models/society-staff.model';
import { AccessRole } from '../models/access-role.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { Complaint } from '../models/complaint.model';
import { ComplaintCategory } from '../models/complaint-category.model';
import { ComplaintEvent } from '../models/complaint-event.model';
import { ParkingZone } from '../models/parking-zone.model';
import { ParkingSlot } from '../models/parking-slot.model';
import { ParkingAllocation } from '../models/parking-allocation.model';
import { ParkingRequest } from '../models/parking-request.model';
import { ChargeHead } from '../models/charge-head.model';
import { seedAccessRoles } from '../services/access-role.service';
import { resolveOpsModules } from '../services/entitlement.service';
import { generateAccessToken } from '../utils/jwt.util';
import { UserRole, TenantType } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();
const SID = societyId.toString();
const planIds: mongoose.Types.ObjectId[] = [];

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

/** Put the society on a plan with exactly these capabilities. */
async function putOnPlan(caps: Record<string, number>, admin: mongoose.Types.ObjectId) {
  const plan = await Plan.create({
    name: `Throwaway ${new mongoose.Types.ObjectId()}`, basePrice: 100,
    module: 'society', capabilities: caps, isSystem: true,
  } as any);
  planIds.push(plan._id as any);
  await Subscription.deleteMany({ tenantId: societyId });
  await Subscription.create({
    tenantType: 'SOCIETY', tenantId: societyId, planId: plan._id, tenure: 'yearly',
    status: 'active', startDate: new Date('2026-01-01'), endDate: new Date('2027-01-01'),
    capabilities: caps,
    createdBy: admin, createdByName: 'Setup', updatedBy: admin, updatedByName: 'Setup',
  } as any);
}

const GENEROUS = {
  max_flat_count: 50, max_member_count: 200, max_visitor_count: 5000,
  max_tickets_count: 500, max_staff_count: 20, max_finance_modules: 30,
  max_parking_slots: 100,
};

async function cleanup() {
  await Promise.all([
    Society.deleteMany({ _id: societyId }), Block.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Resident.deleteMany({ societyId }),
    SocietyOpsPolicy.deleteMany({ societyId }), SocietyStaff.deleteMany({ societyId }),
    AccessRole.deleteMany({ societyId }),
    Committee.deleteMany({ societyId }), CommitteeMember.deleteMany({ societyId }),
    Complaint.deleteMany({ societyId }), ComplaintCategory.deleteMany({ societyId }),
    ComplaintEvent.deleteMany({ societyId }),
    ParkingZone.deleteMany({ societyId }), ParkingSlot.deleteMany({ societyId }),
    ParkingAllocation.deleteMany({ societyId }), ParkingRequest.deleteMany({ societyId }),
    ChargeHead.deleteMany({ societyId }),
    Subscription.deleteMany({ tenantId: societyId }),
    Plan.deleteMany({ _id: { $in: planIds } }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    // ------------------------------------------------------------- fixtures
    const admin = await mkUser('Admin', UserRole.SOCIETY_ADMIN);
    const chairman = await mkUser('Chairman', UserRole.SOCIETY_COMMITTEE);
    const guard = await mkUser('Guard', UserRole.SOCIETY_EMPLOYEE);
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

    await putOnPlan(GENEROUS, admin);

    const adminTk = tokenFor(admin, UserRole.SOCIETY_ADMIN);
    const chairmanTk = tokenFor(chairman, UserRole.SOCIETY_COMMITTEE);
    const guardTk = tokenFor(guard, UserRole.SOCIETY_EMPLOYEE);
    const auth = (tk: string) => ({ Authorization: `Bearer ${tk}` });

    const modulesNow = async (): Promise<string[]> =>
      (await request(app).get('/api/v1/gate/modules').set(auth(adminTk))).body?.data?.modules || [];

    const entModules = async (tk = adminTk): Promise<string[]> =>
      (await request(app).get('/api/v1/me/entitlements').set(auth(tk))).body?.data?.opsModules || [];

    const setModules = (list: string[], tk = adminTk) =>
      request(app).put('/api/v1/gate/policy').set(auth(tk)).send({ modules: list });

    // ==================================================== where a society starts
    console.log('A society starts with the four modules every society already does on paper');
    const start = await modulesNow();
    ok('gate, complaints, staff and assets are on',
      ['GATE', 'COMPLAINTS', 'STAFF', 'ASSETS'].every(m => start.includes(m)), JSON.stringify(start));
    ok('...and parking is not', !start.includes('PARKING'), JSON.stringify(start));

    const zonesBefore = await request(app).get('/api/v1/parking/zones').set(auth(adminTk));
    ok('so every parking route says the module does not exist', zonesBefore.status === 404,
      `got ${zonesBefore.status}`);
    ok('...with a reason a screen can act on',
      zonesBefore.body?.code === 'MODULE_NOT_AVAILABLE', JSON.stringify(zonesBefore.body));

    // =============================================== 1 + 4  off, and back on again
    console.log('\nA module can be switched off over HTTP — and nothing is deleted');

    const complaint = await Complaint.create({
      ...audit, ticketCode: 'CMP/SW1', kind: 'SERVICE', title: 'Lift stuck on the third floor',
      category: 'Other', visibility: 'PERSONAL', scope: 'FLAT',
      flatId: flat._id, flatLabel: 'A Wing 101', blockId: wing._id,
      raisedByUserId: resident, raisedByName: 'Resident', status: 'NEW',
      firstResponseDueAt: new Date(Date.now() + 3600_000),
      resolutionDueAt: new Date(Date.now() + 86_400_000),
      totalPausedMs: 0, escalationLevel: 0, reopenCount: 0,
    } as any);

    ok('the complaints desk answers while the module is on',
      (await request(app).get('/api/v1/complaints').set(auth(adminTk))).status === 200);

    const off = await setModules(start.filter(m => m !== 'COMPLAINTS'));
    ok('the admin can switch complaints off in one call', off.status === 200, `got ${off.status}`);
    ok('...and the list of modules says so', !(await modulesNow()).includes('COMPLAINTS'));
    ok('...the sidebar is told the same thing', !(await entModules()).includes('COMPLAINTS'));

    const shut = await request(app).get('/api/v1/complaints').set(auth(adminTk));
    ok('...and the API behaves as though the module does not exist', shut.status === 404,
      `got ${shut.status}`);

    ok('the complaint itself is untouched',
      !!(await Complaint.findById(complaint._id)),
      'switching a module off must never delete anything');

    const backOn = await setModules([...start]);
    ok('switching it back on is one call too', backOn.status === 200, `got ${backOn.status}`);
    const reopened = await request(app).get('/api/v1/complaints').set(auth(adminTk));
    ok('...the desk answers again', reopened.status === 200, `got ${reopened.status}`);
    ok('...and the complaint comes back exactly as it was',
      JSON.stringify(reopened.body).includes('Lift stuck on the third floor'));

    // ================================================== 2 + 3  switching PARKING on
    console.log('\nParking — the switch that did not exist');

    /**
     * Parking is NOT switched from the modules list, and this assertion is the
     * inverse of what it first said.
     *
     * The original read "parking can be switched on like any other module",
     * and it passed — which was the bug. Parking's on/off decision also
     * creates and deactivates a real `ChargeHead`. Toggling it from the plain
     * modules array hid the screens and left the head **active**, so every
     * flat kept being billed for a module nobody could see or manage. The
     * shortcut is now refused server-side, and the wizard below owns the whole
     * decision end to end.
     */
    const parkShortcut = await setModules([...start, 'PARKING']);
    ok('the modules list refuses to switch parking on', parkShortcut.status === 400,
      `got ${parkShortcut.status}`);
    ok('...and says where it is actually done',
      /own screen/i.test(String(parkShortcut.body?.message)) && /charged/i.test(String(parkShortcut.body?.message)),
      String(parkShortcut.body?.message));
    ok('...so it is still off', !(await modulesNow()).includes('PARKING'));
    ok('...and the parking API still 404s',
      (await request(app).get('/api/v1/parking/zones').set(auth(adminTk))).status === 404);

    // ================================== 4  the wizard is the ONLY switch
    console.log('\nThe parking setup is the switch — and it keeps the bays');

    const firstOn = await request(app).put('/api/v1/parking/settings').set(auth(adminTk))
      .send({ manage: true, chargeable: false });
    ok('the setup screen switches it on', firstOn.status === 200, `got ${firstOn.status}`);
    ok('...and the sidebar hears about it', (await entModules()).includes('PARKING'));
    ok('...and the parking API answers',
      (await request(app).get('/api/v1/parking/zones').set(auth(adminTk))).status === 200);

    const zone = await request(app).post('/api/v1/parking/zones').set(auth(adminTk))
      .send({ name: 'Basement 1', kind: 'BASEMENT', rows: 4, cols: 4 });
    ok('an area can be drawn while parking is on', zone.status === 201, `got ${zone.status}`);

    const wizardOff = await request(app).put('/api/v1/parking/settings').set(auth(adminTk))
      .send({ manage: false });
    ok('answering "no, we do not manage parking" saves', wizardOff.status === 200,
      `got ${wizardOff.status}`);
    ok('...and says what happens to the money in plain words',
      /kept/i.test(String(wizardOff.body?.message)) && /bill/i.test(String(wizardOff.body?.message)),
      String(wizardOff.body?.message));
    ok('...the module is off', !(await entModules()).includes('PARKING'));
    ok('...the map 404s',
      (await request(app).get('/api/v1/parking/zones').set(auth(adminTk))).status === 404);
    ok('...but the area is still in the database',
      (await ParkingZone.countDocuments({ societyId })) === 1,
      'switching parking off must keep every slot and allocation');

    // The settings routes are exempt from the module gate on purpose — the
    // switch cannot be locked inside the room it opens.
    const settingsWhileOff = await request(app).get('/api/v1/parking/settings').set(auth(adminTk));
    ok('the setup page is still reachable while parking is off',
      settingsWhileOff.status === 200, `got ${settingsWhileOff.status}`);
    ok('...and reports itself as off', settingsWhileOff.body?.data?.managed === false);

    const wizardOn = await request(app).put('/api/v1/parking/settings').set(auth(adminTk))
      .send({ manage: true, chargeable: false });
    ok('answering "yes" switches the module back on', wizardOn.status === 200, `got ${wizardOn.status}`);
    ok('...which the sidebar hears about', (await entModules()).includes('PARKING'));

    const zonesReturned = await request(app).get('/api/v1/parking/zones').set(auth(adminTk));
    ok('...and the area comes back exactly as it was',
      zonesReturned.status === 200 && JSON.stringify(zonesReturned.body).includes('Basement 1'),
      `got ${zonesReturned.status}`);

    // ===================================================== 5  the plan still wins
    console.log('\nThe plan wins, whatever the switch says');

    await putOnPlan({ ...GENEROUS, max_parking_slots: 0 }, admin);

    const flipAnyway = await setModules([...start, 'PARKING']);
    ok('the society may still record that it wants parking', flipAnyway.status === 200,
      `got ${flipAnyway.status}`);
    ok('...but a plan that excludes it is not overruled',
      !(await entModules()).includes('PARKING'));
    ok('...the resolver agrees',
      !(await resolveOpsModules(SID, { max_parking_slots: 0 })).includes('PARKING'));
    ok('...and every parking route is gone again',
      (await request(app).get('/api/v1/parking/zones').set(auth(adminTk))).status === 404);
    ok('...even the wizard cannot buy it back',
      !(await (async () => {
        await request(app).put('/api/v1/parking/settings').set(auth(adminTk))
          .send({ manage: true, chargeable: false });
        return entModules();
      })()).includes('PARKING'));

    await putOnPlan(GENEROUS, admin);
    await setModules([...start, 'PARKING']);
    ok('restoring the plan restores the module', (await entModules()).includes('PARKING'));

    // ============================================ 6  the roles that grant parking
    console.log('\nA Chairman can reach parking — before this, only the admin could');

    const seeded = await seedAccessRoles(SID, String(admin), 'Setup');
    ok('the starter roles seed', seeded > 0, `${seeded} inserted`);

    const roleNamed = async (name: string) =>
      AccessRole.findOne({ societyId, name }).lean();
    const levelOf = (role: any, module: string) =>
      (role?.permissions || []).find((p: any) => p.module === module)?.level;

    const chairRole = await roleNamed('Chairman');
    ok('Chairman may manage parking', levelOf(chairRole, 'PARKING_MANAGE') === 'FULL',
      String(levelOf(chairRole, 'PARKING_MANAGE')));
    ok('Secretary may too',
      levelOf(await roleNamed('Secretary'), 'PARKING_MANAGE') === 'FULL');
    ok('so may the society manager',
      levelOf(await roleNamed('Society manager'), 'PARKING_MANAGE') === 'FULL');
    ok('a committee member may look, not allot',
      levelOf(await roleNamed('Committee member'), 'PARKING_VIEW') === 'READ'
      && levelOf(await roleNamed('Committee member'), 'PARKING_MANAGE') === 'NONE');
    ok('the treasurer may look',
      levelOf(await roleNamed('Treasurer'), 'PARKING_VIEW') === 'READ');
    ok('the auditor may look',
      levelOf(await roleNamed('Auditor (view only)'), 'PARKING_VIEW') === 'READ');
    ok('a security guard gets neither — the slot popover is a list of who owns which car',
      levelOf(await roleNamed('Security guard'), 'PARKING_VIEW') === 'NONE'
      && levelOf(await roleNamed('Security guard'), 'PARKING_MANAGE') === 'NONE');

    // The grid is not the point; being able to open the screen is.
    const term = await Committee.create({
      ...audit, name: 'Managing Committee', termStartDate: new Date('2026-01-01'), status: 'ACTIVE',
    });
    await CommitteeMember.create({
      ...audit, committeeId: term._id, userId: chairman,
      memberSnapshot: { name: 'Chairman' },
      designationKey: 'CHAIRMAN', designationLabel: 'Chairman',
      startDate: new Date('2026-01-01'), status: 'ACTIVE',
      accessRoleId: chairRole?._id,
    } as any);

    const chairSees = await request(app).get('/api/v1/parking/zones').set(auth(chairmanTk));
    ok('a real Chairman can open the parking map', chairSees.status === 200,
      `got ${chairSees.status}`);
    ok('...and may allot a slot',
      (await request(app).post('/api/v1/parking/zones').set(auth(chairmanTk))
        .send({ name: 'Open compound', kind: 'OPEN' })).status === 201);

    const guardRole = await roleNamed('Security guard');
    await SocietyStaff.create({
      ...audit, staffCode: 'SF/G1', person: { name: 'Guard', phone: '9876500055' },
      designation: 'SECURITY_GUARD', userId: guard, isActive: true,
      accessRoleId: guardRole?._id,
    } as any);
    const guardSees = await request(app).get('/api/v1/parking/slots').set(auth(guardTk));
    ok('a guard is still refused the slot list', guardSees.status === 403,
      `got ${guardSees.status}`);

    // ============================== the switch is not open to everybody who can read
    console.log('\nAnd the switch itself is a settings act');
    const guardFlips = await setModules(['GATE'], guardTk);
    ok('an employee with no settings permission cannot switch a module off',
      guardFlips.status === 403, `got ${guardFlips.status}`);
    ok('...and nothing moved', (await modulesNow()).includes('PARKING'));

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
