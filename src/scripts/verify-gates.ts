/**
 * चरण 4 + चरण 5 — the society's physical gates, and residents' own movement.
 *
 * Speaks HTTP, for the reason this project learned the hard way: three complete
 * systems once shipped green because every assertion called a service directly
 * while the controller never called it. So this drives the real routes with
 * real tokens and the exact body the browser sends.
 *
 * What it is actually protecting:
 *
 *   चरण 4 — a gate is named, so the register can say which door somebody used;
 *           an entry-only gate cannot be used for an exit; a gate that people
 *           are still standing behind cannot be retired; a retired code can be
 *           reused, because the unique index is partial.
 *
 *   चरण 5 — `gate.residents.logMovement` was stored, validated and drawn as a
 *           switch, and READ BY NOTHING. A society that left it off (the
 *           default) had exactly the same behaviour as one that turned it on.
 *           These assertions fail on the code as it stood before today.
 *
 *   npx tsx src/scripts/verify-gates.ts
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
import { SocietyStaff } from '../models/society-staff.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { ApprovalRequest } from '../models/approval-request.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Notification } from '../models/notification.model';
import { AccessRole } from '../models/access-role.model';
import { Gate } from '../models/gate.model';
import { createStaff } from '../services/staff.service';
import { generateAccessToken } from '../utils/jwt.util';
import { UserRole, TenantType } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const tokenFor = (userId: mongoose.Types.ObjectId, role: UserRole) =>
  generateAccessToken({
    userId: String(userId), activeTenantId: String(societyId),
    activeTenantType: TenantType.SOCIETY, activeRole: role,
  });

const ids: mongoose.Types.ObjectId[] = [];
const mkUser = async (name: string, role: UserRole) => {
  const u = await User.create({
    name, email: `${name.replace(/\W/g, '').toLowerCase()}.${Date.now()}${Math.random().toString(36).slice(2, 6)}@throwaway.test`,
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
    SocietyStaff.deleteMany({ societyId }), VisitorEntry.deleteMany({ societyId }),
    ApprovalRequest.deleteMany({ societyId }), SocietyOpsPolicy.deleteMany({ societyId }),
    Notification.deleteMany({ societyId }), AccessRole.deleteMany({ societyId }),
    Gate.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway society ${societyId}\n`);

  try {
    const adminId = await mkUser('Admin', UserRole.SOCIETY_ADMIN);
    const guardUser = await mkUser('Guard Ramesh', UserRole.SOCIETY_EMPLOYEE);
    const ownerId = await mkUser('Owner Rao', UserRole.RESIDENT_OWNER);

    const audit = { societyId, createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup' };
    await Society.create({
      _id: societyId, name: `Throwaway ${societyId}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: adminId,
      createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup',
    } as any);
    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const flat = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing', number: '101',
      status: FlatStatus.OWNER_OCCUPIED, ownerUserId: ownerId,
    });
    await Resident.create({
      ...audit, flatId: flat._id, userId: ownerId, person: { name: 'Owner Rao' },
      relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true,
    });

    const guardStaff = await createStaff(String(societyId), {
      name: 'Guard Ramesh', phone: '9800000009', designation: 'SECURITY_GUARD',
    }, { userId: String(adminId), userName: 'Admin' });
    await SocietyStaff.updateOne({ _id: guardStaff._id }, { $set: { userId: guardUser } });
    const role = await AccessRole.create({
      ...audit, name: 'Gatekeeper', isActive: true,
      permissions: [
        { module: 'GATE_CONSOLE', level: 'FULL' },
        { module: 'GATE_LOGS', level: 'FULL' },
        { module: 'OPS_SETTINGS', level: 'FULL' },
      ],
      scope: { allBlocks: true, blockIds: [] },
    });
    await SocietyStaff.updateOne({ _id: guardStaff._id }, { $set: { accessRoleId: role._id } });

    const adminT = tokenFor(adminId, UserRole.SOCIETY_ADMIN);
    const guardT = tokenFor(guardUser, UserRole.SOCIETY_EMPLOYEE);

    const post = (path: string, token: string, body: any = {}) =>
      request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);
    const put = (path: string, token: string, body: any = {}) =>
      request(app).put(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);
    const get = (path: string, token: string) =>
      request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

    // ==================================================== चरण 4 — gate CRUD
    console.log('चरण 4 — the society names its gates');

    const empty = await get('/gate/gates', guardT);
    eq('a new society has no gates', (empty.body?.data || []).length, 0);

    const main1 = await post('/gate/gates', adminT, {
      code: 'G1', name: 'Main Gate', kind: 'MAIN', handlesEntry: true, handlesExit: true,
    });
    ok('an admin can add one', main1.status === 201, `got ${main1.status} ${JSON.stringify(main1.body?.message)}`);
    const mainGateId = main1.body?.data?._id;

    const dupe = await post('/gate/gates', adminT, { code: 'G1', name: 'Another', kind: 'MAIN' });
    ok('the same code twice is refused', dupe.status >= 400, `got ${dupe.status}`);

    // A service gate that lets people IN but never out — the delivery door.
    const service = await post('/gate/gates', adminT, {
      code: 'G2', name: 'Service Gate', kind: 'SERVICE', handlesEntry: true, handlesExit: false,
    });
    ok('a second gate is fine', service.status === 201, JSON.stringify(service.body?.message));
    const serviceGateId = service.body?.data?._id;

    const guardTries = await post('/gate/gates', guardT, { code: 'G9', name: 'Sneaky' });
    // The guard DOES hold OPS_SETTINGS here, so this must be refused by the role
    // check rather than the permission — a gatekeeper is not a committee.
    ok('a guard cannot add a gate', guardTries.status === 403, `got ${guardTries.status}`);

    // --------------------------------------------- the gate lands on the entry
    console.log('\n...and the register records which door was used');
    const in1 = await post('/gate/entries', guardT, {
      category: 'DELIVERY', visitorName: 'Courier Anil', flatId: String(flat._id),
      entryGateId: serviceGateId,
    });
    ok('a visitor can be logged against a gate', in1.status === 201, JSON.stringify(in1.body?.message));
    const entryId = in1.body?.data?._id;
    const entryDoc = await VisitorEntry.findById(entryId).lean();
    eq('the entry names the gate', entryDoc?.entryGateName, 'Service Gate');
    eq('...and holds its id', String(entryDoc?.entryGateId), String(serviceGateId));

    // The load-bearing one: a door that does not do exits cannot be used for one.
    const wrongWay = await post(`/gate/entries/${entryId}/exit`, guardT, { exitGateId: serviceGateId });
    ok('an entry-only gate is refused for an exit', wrongWay.status >= 400,
      `got ${wrongWay.status} ${JSON.stringify(wrongWay.body?.message)}`);

    const outOk = await post(`/gate/entries/${entryId}/exit`, guardT, { exitGateId: mainGateId });
    ok('...and the main gate is accepted', outOk.status === 200, JSON.stringify(outOk.body?.message));
    const leftDoc = await VisitorEntry.findById(entryId).lean();
    eq('the exit gate is stamped too', leftDoc?.exitGateName, 'Main Gate');
    eq('...and they are marked gone', leftDoc?.status, 'LEFT');

    // ------------------------------------------------------------- retiring
    console.log('\n...and retiring one is refused while people are behind it');
    const stillIn = await post('/gate/entries', guardT, {
      category: 'GUEST', visitorName: 'Visitor Meena', flatId: String(flat._id),
      entryGateId: mainGateId,
    });
    eq('somebody is inside via the main gate', stillIn.body?.data?.status, 'INSIDE');

    const cannotRetire = await post(`/gate/gates/${mainGateId}/retire`, adminT);
    ok('the gate cannot be retired while they are in', cannotRetire.status >= 400,
      `got ${cannotRetire.status} ${JSON.stringify(cannotRetire.body?.message)}`);

    await post(`/gate/entries/${stillIn.body.data._id}/exit`, guardT, { exitGateId: mainGateId });
    const canRetire = await post(`/gate/gates/${mainGateId}/retire`, adminT);
    ok('...and can be once they have left', canRetire.status === 200, JSON.stringify(canRetire.body?.message));

    const afterRetire = await get('/gate/gates', guardT);
    ok('a retired gate drops off the console list',
      !(afterRetire.body?.data || []).some((g: any) => String(g._id) === String(mainGateId)),
      JSON.stringify((afterRetire.body?.data || []).map((g: any) => g.name)));

    // The partial unique index earns its keep here: 'G1' is free again.
    const reuse = await post('/gate/gates', adminT, { code: 'G1', name: 'Main Gate (rebuilt)', kind: 'MAIN' });
    ok('a retired code can be used again', reuse.status === 201, JSON.stringify(reuse.body?.message));

    // Old entries keep pointing at the retired gate — history must not be rewritten.
    const historic = await VisitorEntry.findById(entryId).lean();
    eq('...and old entries still name the gate they used', historic?.exitGateName, 'Main Gate');

    const renamed = await put(`/gate/gates/${serviceGateId}`, adminT, { name: 'Delivery Gate' });
    eq('a gate can be renamed', renamed.body?.data?.name, 'Delivery Gate');

    // ================================= a neighbour is never asked about a flat
    //
    // The reported fault: signed in as the owner of A-102, an approval request
    // for A-103 appeared in their own list. It was not a leak — A-103 was empty
    // and they sit on the committee — but asking a committee member to admit a
    // stranger to an empty flat manufactures authority out of nothing, and it
    // is indistinguishable on screen from a question about their own home.
    console.log('\nA neighbour is never asked to answer for somebody else\'s flat');

    const other = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing', number: '103',
      status: FlatStatus.VACANT,
    });
    // L3 makes approval REQUIRED, so this is the case that used to raise one.
    await put('/gate/policy', adminT, { preset: 'L3' });

    const toEmpty = await post('/gate/entries', guardT, {
      category: 'GUEST', visitorName: 'Stranger Vikram', flatId: String(other._id),
    });
    eq('the visitor is admitted on the guard\'s call', toEmpty.body?.data?._outcome, 'ADMITTED');
    ok('...and the reason says the flat is empty',
      /empty/i.test(String(toEmpty.body?.message)), JSON.stringify(toEmpty.body?.message));

    eq('NO APPROVAL REQUEST WAS RAISED FOR AN EMPTY FLAT',
      await ApprovalRequest.countDocuments({ societyId, flatId: other._id }), 0);

    // The heart of it: the A-102 owner's own list must be untouched.
    const neighbourInbox = await request(app)
      .get('/api/v1/gate/approvals/mine')
      .set('Authorization', `Bearer ${tokenFor(ownerId, UserRole.RESIDENT_OWNER)}`);
    eq('...and no neighbour has it sitting in their approvals',
      (neighbourInbox.body?.data || []).length, 0);

    // Put the policy back before the resident-movement section.
    await put('/gate/policy', adminT, { preset: 'L2' });

    // ============================================ चरण 5 — resident movement
    console.log('\nचरण 5 — residents are NOT recorded unless the society says so');

    const policyNow = await SocietyOpsPolicy.findOne({ societyId }).lean();
    eq('logging residents is off by default', policyNow?.gate?.residents?.logMovement, false);

    const refused = await post('/gate/entries', guardT, {
      category: 'RESIDENT', visitorName: 'Owner Rao', flatId: String(flat._id),
    });
    ok('THE GATE REFUSES A RESIDENT MOVEMENT WHILE IT IS OFF', refused.status === 403,
      `got ${refused.status} ${JSON.stringify(refused.body?.message)}`);
    eq('...and nothing was written', await VisitorEntry.countDocuments({ societyId, category: 'RESIDENT' }), 0);

    // Now the committee switches it on, deliberately.
    const switchOn = await put('/gate/policy', adminT, { gate: { residents: { logMovement: true } } });
    ok('a committee can switch it on', switchOn.status === 200, JSON.stringify(switchOn.body?.message));

    const allowed = await post('/gate/entries', guardT, {
      category: 'RESIDENT', visitorName: 'Owner Rao', flatId: String(flat._id),
    });
    ok('...and then a resident movement is accepted', allowed.status === 201,
      `got ${allowed.status} ${JSON.stringify(allowed.body?.message)}`);
    const resDoc = await VisitorEntry.findById(allowed.body?.data?._id).lean();
    eq('the resident is INSIDE, never AWAITING', resDoc?.status, 'INSIDE');
    ok('...with no expected-out time — they live here', !resDoc?.expectedOutAt, String(resDoc?.expectedOutAt));
    eq('...and no approval was ever raised',
      await ApprovalRequest.countDocuments({ societyId, visitorEntryId: resDoc?._id }), 0);

    // ------------------------------------------------- the vehicle-only mode
    console.log('\n...and "only the vehicle" really does drop the name');
    await put('/gate/policy', adminT, { gate: { residents: { logVehicleOnly: true } } });

    const noPlate = await post('/gate/entries', guardT, {
      category: 'RESIDENT', visitorName: 'Owner Rao', flatId: String(flat._id),
    });
    ok('a resident with no plate is refused in vehicle-only mode', noPlate.status >= 400,
      `got ${noPlate.status} ${JSON.stringify(noPlate.body?.message)}`);

    const withPlate = await post('/gate/entries', guardT, {
      category: 'RESIDENT', visitorName: 'Owner Rao', flatId: String(flat._id),
      vehicleNumber: 'MH12AB1234',
    });
    ok('...and accepted with one', withPlate.status === 201, JSON.stringify(withPlate.body?.message));
    const plateDoc = await VisitorEntry.findById(withPlate.body?.data?._id).lean();
    ok('THE RESIDENT NAME IS NOT STORED', !/Owner Rao/.test(String(plateDoc?.visitorName)),
      String(plateDoc?.visitorName));
    eq('...but the plate is', plateDoc?.vehicleNumber, 'MH12AB1234');
    ok('...and no phone or photo was kept', !plateDoc?.visitorPhone && !plateDoc?.photoKey);

    // ----------------------------------------------- switching it back off
    console.log('\n...and switching it off closes the door again');
    await put('/gate/policy', adminT, { gate: { residents: { logMovement: false } } });
    const refusedAgain = await post('/gate/entries', guardT, {
      category: 'RESIDENT', visitorName: 'Owner Rao', flatId: String(flat._id),
      vehicleNumber: 'MH12AB1234',
    });
    eq('the gate refuses residents once more', refusedAgain.status, 403);
    // What was already recorded stays. Switching a setting off is not a purge.
    ok('...and what was already recorded is untouched',
      (await VisitorEntry.countDocuments({ societyId, category: 'RESIDENT' })) === 2);
  } catch (e: any) {
    fail++;
    console.log(`\n  ERROR  ${e.message}\n${e.stack}`);
  } finally {
    await cleanup();
    console.log('\nThrowaway data removed.');
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  process.exit(fail ? 1 : 0);
}

main();
