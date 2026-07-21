/**
 * Phase 0 — the leaks.
 *
 * Every assertion here FAILS against the code as it stood before this phase.
 * That is the bar: a test that passes either way proves nothing, and each of
 * these describes something a real resident could have seen.
 *
 * It speaks HTTP wherever the hole was in the route layer — a missing
 * permission, a service that never asked who was calling — because a
 * service-level test builds its own arguments and would have passed throughout.
 * The audience rules are checked directly, because that is where they live.
 *
 * What is covered, by the id used in OPERATIONS_V2.md:
 *   C-1  a complaint filed by a resident is theirs, not the whole society's
 *   C-2  ...and cannot be filed against somebody else's flat
 *   C-3  a rented flat's visitor notice reaches the tenant, never the landlord
 *   C-4  the visitor log needs GATE_LOGS unless you are a resident of that flat
 *   C-5  there is no society-wide realtime channel left to leak on
 *   C-9  the technician who did the work cannot declare it fixed
 *   C-10 pausing is scoped — you cannot bury another wing's complaint
 *   H-1  only the flat may cancel its own gate pass
 *   H-2  only the flat may register or remove its own vehicle
 *   H-22 only you may forget your own push device
 *   Cause-2  a flat can no longer be born silently vacant
 *
 *   npx tsx src/scripts/verify-privacy-v2.ts
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
import { Complaint } from '../models/complaint.model';
import { ComplaintCategory } from '../models/complaint-category.model';
import { ComplaintEvent } from '../models/complaint-event.model';
import { SocietyStaff } from '../models/society-staff.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { GatePass } from '../models/gate-pass.model';
import { ResidentVehicle } from '../models/resident-vehicle.model';
import { PushToken } from '../models/push-token.model';
import { AccessRole } from '../models/access-role.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Notification } from '../models/notification.model';
import { householdOfFlat } from '../services/notify-recipients';
import { registerToken, forgetToken } from '../services/push.service';
import * as sse from '../services/sse.service';
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
    userId: String(userId),
    activeTenantId: SID,
    activeTenantType: TenantType.SOCIETY,
    activeRole: role,
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
    Complaint.deleteMany({ societyId }), ComplaintCategory.deleteMany({ societyId }),
    ComplaintEvent.deleteMany({ societyId }), SocietyStaff.deleteMany({ societyId }),
    VisitorEntry.deleteMany({ societyId }), GatePass.deleteMany({ societyId }),
    ResidentVehicle.deleteMany({ societyId }), PushToken.deleteMany({ societyId }),
    AccessRole.deleteMany({ societyId }), SocietyOpsPolicy.deleteMany({ societyId }),
    Notification.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    // ------------------------------------------------------------- fixtures
    const admin = await mkUser('Admin', UserRole.SOCIETY_ADMIN);
    const landlord = await mkUser('Landlord', UserRole.RESIDENT_OWNER);
    const tenant = await mkUser('Tenant', UserRole.RESIDENT_TENANT);
    const neighbour = await mkUser('Neighbour', UserRole.RESIDENT_OWNER);
    const technician = await mkUser('Technician', UserRole.SOCIETY_EMPLOYEE);

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
    // 101 is RENTED — the landlord lives elsewhere, the tenant lives here.
    const flat101 = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '101', status: FlatStatus.RENTED, ownerUserId: landlord,
    });
    // 102 is the neighbour's own home.
    const flat102 = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '102', status: FlatStatus.OWNER_OCCUPIED, ownerUserId: neighbour,
    });

    await Resident.create([
      { ...audit, flatId: flat101._id, userId: landlord, person: { name: 'Landlord' }, relationship: 'OWNER', householdType: 'OWNER', isActive: true },
      { ...audit, flatId: flat101._id, userId: tenant, person: { name: 'Tenant' }, relationship: 'TENANT', householdType: 'TENANT', isActive: true },
      { ...audit, flatId: flat102._id, userId: neighbour, person: { name: 'Neighbour' }, relationship: 'OWNER', householdType: 'OWNER', isActive: true },
    ]);

    const adminTk = tokenFor(admin, UserRole.SOCIETY_ADMIN);
    const tenantTk = tokenFor(tenant, UserRole.RESIDENT_TENANT);
    const landlordTk = tokenFor(landlord, UserRole.RESIDENT_OWNER);
    const neighbourTk = tokenFor(neighbour, UserRole.RESIDENT_OWNER);
    const techTk = tokenFor(technician, UserRole.SOCIETY_EMPLOYEE);
    const auth = (tk: string) => ({ Authorization: `Bearer ${tk}` });

    // ============================================ C-3  who a flat's news reaches
    console.log('C-3 — a rented flat reaches its tenant, not its landlord');
    const rented = await householdOfFlat(SID, String(flat101._id));
    ok('the tenant is told', rented.userIds.includes(String(tenant)));
    ok('the landlord is NOT told', !rented.userIds.includes(String(landlord)));
    ok('and nobody else is', rented.userIds.length === 1);
    ok('the reason is recorded', rented.via === 'RENTED_TENANT_ONLY');

    await Flat.updateOne({ _id: flat101._id }, { $set: { status: FlatStatus.VACANT } });
    const empty = await householdOfFlat(SID, String(flat101._id));
    ok('an empty flat has no household to tell', empty.userIds.length === 0);
    ok('...and does not quietly widen to the committee', empty.via === 'VACANT_NO_HOUSEHOLD');
    await Flat.updateOne({ _id: flat101._id }, { $set: { status: FlatStatus.RENTED } });

    // =========================================== C-5  no society-wide channel
    console.log('\nC-5 — there is no broadcast channel to leak on');
    ok('publishToSociety no longer exists',
      typeof (sse as any).publishToSociety === 'undefined');

    // ================================================ C-4  the visitor log
    console.log('\nC-4 — the visitor register is not open to everyone signed in');
    await VisitorEntry.create({
      ...audit, entryCode: 'V-TEST-1', visitorName: 'Courier',
      visitorPhone: '9876500001', category: 'DELIVERY', status: 'INSIDE',
      flatId: flat101._id, flatLabel: 'A Wing 101', blockId: wing._id,
      enteredAt: new Date(), guardName: 'Guard',
    } as any);

    // A staff member with NO access role at all: the old route asked only for a
    // society role, so this request returned every entry in the building.
    const asTech = await request(app).get('/api/v1/gate/entries').set(auth(techTk));
    ok('an employee with no granted access is refused', asTech.status === 403,
      `got ${asTech.status}`);

    // The resident of another flat is allowed in, and clamped to their own.
    const asNeighbour = await request(app).get('/api/v1/gate/entries').set(auth(neighbourTk));
    ok('a resident may still read their own log', asNeighbour.status === 200,
      `got ${asNeighbour.status}`);
    ok('...and sees nothing belonging to flat 101',
      !JSON.stringify(asNeighbour.body).includes('Courier'));

    ok('an admin still sees the register',
      (await request(app).get('/api/v1/gate/entries').set(auth(adminTk))).status === 200);

    // ============================================== H-1  cancelling a pass
    console.log('\nH-1 — only the flat may cancel its own pass');
    const passDoc = await GatePass.create({
      ...audit, flatId: flat101._id, flatLabel: 'A Wing 101', blockId: wing._id,
      visitorName: 'Guest of 101', category: 'GUEST',
      code: '654321', qrPayload: 'x',
      validFrom: new Date(), validTo: new Date(Date.now() + 86_400_000),
      maxUses: 1, status: 'ACTIVE',
    } as any);

    const steal = await request(app)
      .post(`/api/v1/gate/passes/${passDoc._id}/revoke`)
      .set(auth(neighbourTk)).send({ reason: 'mischief' });
    ok('a neighbour cannot cancel it', steal.status === 403, `got ${steal.status}`);
    ok('...and it is still live',
      (await GatePass.findById(passDoc._id))?.status === 'ACTIVE');

    const own = await request(app)
      .post(`/api/v1/gate/passes/${passDoc._id}/revoke`)
      .set(auth(tenantTk)).send({ reason: 'plans changed' });
    ok('the flat itself can', own.status === 200, `got ${own.status}`);

    // ================================================= H-2  vehicles
    console.log('\nH-2 — a vehicle belongs to the flat that registered it');
    const plant = await request(app).post('/api/v1/gate/vehicles')
      .set(auth(neighbourTk))
      .send({ flatId: String(flat101._id), number: 'MH12AB1234', kind: 'CAR' });
    ok('a resident cannot register a car to another flat', plant.status === 403,
      `got ${plant.status}`);

    const mine = await request(app).post('/api/v1/gate/vehicles')
      .set(auth(tenantTk))
      .send({ flatId: String(flat101._id), number: 'MH12AB1234', kind: 'CAR' });
    ok('...but can to their own', mine.status === 201, `got ${mine.status}`);

    const vehicleId = mine.body?.data?._id;
    const wipe = await request(app).delete(`/api/v1/gate/vehicles/${vehicleId}`)
      .set(auth(neighbourTk));
    ok('a neighbour cannot remove it', wipe.status === 403, `got ${wipe.status}`);
    ok('...and it is still registered',
      (await ResidentVehicle.findById(vehicleId))?.isActive === true);

    // The duplicate-plate message must not name the flat to a resident: that
    // turns this endpoint into "whose car is this?" for anybody who can guess.
    const dupe = await request(app).post('/api/v1/gate/vehicles')
      .set(auth(neighbourTk))
      .send({ flatId: String(flat102._id), number: 'MH12AB1234', kind: 'CAR' });
    ok('a clash does not disclose which flat owns the plate',
      !String(dupe.body?.message || '').includes('101'), dupe.body?.message);

    ok('the office may still register for a flat',
      (await request(app).post('/api/v1/gate/vehicles').set(auth(adminTk))
        .send({ flatId: String(flat102._id), number: 'MH14XY9999', kind: 'BIKE' })).status === 201);

    // ================================================== C-1 / C-2  complaints
    console.log('\nC-1 / C-2 — a complaint belongs to the flat that raised it');
    const raised = await request(app).post('/api/v1/complaints')
      .set(auth(tenantTk))
      .send({ title: 'Leak in the bathroom', description: 'Under the basin' });
    ok('a resident can report a problem', raised.status === 201, `got ${raised.status}`);

    const filed = await Complaint.findById(raised.body?.data?._id).lean();
    ok('their own flat is filled in without being asked',
      String(filed?.flatId || '') === String(flat101._id));
    ok('...so it is PERSONAL, not broadcast to the society',
      filed?.visibility === 'PERSONAL', `visibility=${filed?.visibility}`);
    ok('...and carries a wing, so it can route to somebody',
      String(filed?.blockId || '') === String(wing._id));

    const nosy = await request(app).get('/api/v1/complaints').set(auth(neighbourTk));
    ok('a neighbour cannot read it',
      !JSON.stringify(nosy.body).includes('Leak in the bathroom'));

    const forged = await request(app).post('/api/v1/complaints')
      .set(auth(neighbourTk))
      .send({ title: 'Forged', flatId: String(flat101._id) });
    ok('nobody can file a complaint against another flat', forged.status === 403,
      `got ${forged.status}`);

    ok('the office may still file for a flat',
      (await request(app).post('/api/v1/complaints').set(auth(adminTk))
        .send({ title: 'Reported at the desk', flatId: String(flat101._id) })).status === 201);

    // ====================================== C-9  the doer does not sign it off
    console.log('\nC-9 — the technician cannot declare their own work fixed');
    const staff = await SocietyStaff.create({
      ...audit, staffCode: 'SF/T1', person: { name: 'Technician', phone: '9876500099' },
      designation: 'Plumber', userId: technician, isActive: true,
    } as any);
    // Give them a queue-level role, which is all a technician ever holds.
    const role = await AccessRole.create({
      ...audit, name: 'Technician', appliesTo: 'STAFF', isActive: true,
      permissions: [{ module: 'COMPLAINTS_OWN', level: 'FULL' }],
      scope: { allBlocks: true, blockIds: [] },
    } as any);
    await SocietyStaff.updateOne({ _id: staff._id }, { $set: { accessRoleId: role._id } });

    const job = await Complaint.findByIdAndUpdate(
      raised.body?.data?._id,
      { $set: { assigneeStaffId: staff._id, assigneeName: 'Technician', status: 'WORK_DONE' } },
      { new: true },
    );

    const selfSignOff = await request(app)
      .post(`/api/v1/complaints/${job!._id}/resolve`).set(auth(techTk));
    ok('the assignee is refused', selfSignOff.status === 403, `got ${selfSignOff.status}`);
    ok('...and the clock is still running',
      !(await Complaint.findById(job!._id))?.resolvedAt);

    const byFlat = await request(app)
      .post(`/api/v1/complaints/${job!._id}/resolve`).set(auth(tenantTk));
    ok('the flat that raised it can', byFlat.status === 200, `got ${byFlat.status}`);
    ok('...and that is when the clock stops',
      !!(await Complaint.findById(job!._id))?.resolvedAt);

    // ================================== C-10  pausing somebody else's complaint
    console.log('\nC-10 — pausing is scoped, because pausing buries');
    const neighbourComplaint = await Complaint.create({
      ...audit, ticketCode: 'CMP/T2', kind: 'SERVICE', title: 'Neighbour lift issue',
      category: 'Other', visibility: 'PERSONAL', scope: 'FLAT',
      flatId: flat102._id, flatLabel: 'A Wing 102', blockId: wing._id,
      raisedByUserId: neighbour, raisedByName: 'Neighbour', status: 'NEW',
      firstResponseDueAt: new Date(Date.now() + 3600_000),
      resolutionDueAt: new Date(Date.now() + 86_400_000),
      totalPausedMs: 0, escalationLevel: 0, reopenCount: 0,
    } as any);

    const bury = await request(app)
      .post(`/api/v1/complaints/${neighbourComplaint._id}/pause`)
      .set(auth(techTk)).send({ reason: 'AWAITING_PARTS' });
    ok('a technician cannot pause a complaint that is not theirs',
      bury.status === 404 || bury.status === 403, `got ${bury.status}`);
    ok('...and both clocks are still running',
      !(await Complaint.findById(neighbourComplaint._id))?.pausedAt);

    // ==================================================== H-22  push devices
    console.log('\nH-22 — only you may forget your own device');
    const device = await registerToken({
      societyId: SID, userId: String(tenant), platform: 'ANDROID',
      token: `fcm-${new mongoose.Types.ObjectId()}`,
    });
    ok('somebody else cannot unsubscribe you',
      !(await forgetToken(device.token, String(neighbour))));
    ok('...and the device is still registered',
      (await PushToken.countDocuments({ token: device.token })) === 1);
    ok('you can unsubscribe yourself',
      await forgetToken(device.token, String(tenant)));

    // ============================================ Cause-2  no silent vacancy
    console.log('\nCause 2 — a flat cannot be born silently vacant');
    let refused = false;
    try {
      await Flat.create({
        ...audit, blockId: wing._id, blockName: 'A Wing', number: '999',
      } as any);
    } catch { refused = true; }
    ok('a flat with no status is rejected', refused);

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
