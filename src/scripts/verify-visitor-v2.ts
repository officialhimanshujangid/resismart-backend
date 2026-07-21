/**
 * Phase 4 — Visitor v2.
 * Real Atlas, a THROWAWAY societyId, self-cleaning. Never touches existing data.
 *
 * Every assertion here FAILS against the code as it stood before this phase.
 * That is the bar: a test that passes either way proves nothing, and each of
 * these describes something a real resident, guard or guest could have hit.
 *
 * It speaks HTTP wherever the hole was in the route layer — the console could
 * only ever name a flat, the sync handler took the device's word for the time —
 * and calls the services directly where the rule itself lives.
 *
 * What is covered, by the id used in OPERATIONS_V2.md:
 *   III-1  a visitor for a committee member / the office / staff has a HOST:
 *          somebody is asked, somebody is told, and the host can see the visit
 *   III-3  an empty flat is answered for by its OWNER, not by the whole
 *          committee — and the ladder falls through when a rung is empty
 *   H-3    a pass is checked BEFORE it is burned, so a refused entry does not
 *          also destroy the invitation
 *   H-4    the device's own clock cannot revive a pass, and a retried sync
 *          records one visitor rather than two
 *   H-5    a visitor admitted while the gate was offline reaches the register
 *   H-6    an overstay is actually reported to the host
 *   H-7    the close-off settles a DAY, not everybody standing in the building
 *   M-1    a resident coming home does not notify their own flat
 *
 *   npx tsx src/scripts/verify-visitor-v2.ts
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
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { ApprovalRequest } from '../models/approval-request.model';
import { GatePass } from '../models/gate-pass.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Notification } from '../models/notification.model';
import { AccessRole } from '../models/access-role.model';
import { Gate } from '../models/gate.model';
import { updateOpsPolicy } from '../services/ops-policy.service';
import { createStaff } from '../services/staff.service';
import { issue as issuePass } from '../services/gate-pass.service';
import { resolveHostAudience, whoToAsk } from '../services/gate-approval.service';
import { autoCloseStragglers, sweepOverstays } from '../services/visitor.service';
import { listForUser } from '../services/notification.service';
import { generateAccessToken } from '../utils/jwt.util';
import { UserRole, TenantType } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

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
    Society.deleteMany({ societyId }), Society.deleteMany({ _id: societyId }),
    Block.deleteMany({ societyId }), Flat.deleteMany({ societyId }),
    Resident.deleteMany({ societyId }), SocietyStaff.deleteMany({ societyId }),
    Committee.deleteMany({ societyId }), CommitteeMember.deleteMany({ societyId }),
    VisitorEntry.deleteMany({ societyId }), ApprovalRequest.deleteMany({ societyId }),
    GatePass.deleteMany({ societyId }), SocietyOpsPolicy.deleteMany({ societyId }),
    Notification.deleteMany({ societyId }), AccessRole.deleteMany({ societyId }),
    Gate.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

const settle = () => new Promise(r => setTimeout(r, 400));
const gateKinds = ['GATE_ENTRY', 'GATE_ARRIVAL', 'GATE_APPROVAL', 'GATE_EXPECTED', 'GATE_VACANT_FLAT'];

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    // ------------------------------------------------------------- fixtures
    const adminId = await mkUser('Admin', UserRole.SOCIETY_ADMIN);
    const guardUser = await mkUser('Guard Ramesh', UserRole.SOCIETY_EMPLOYEE);
    // The secretary is BOTH a committee member and a resident of A-102. That
    // combination is the whole point: the visit to them as secretary must not
    // be filed against their home, and must still be visible to them.
    const secretaryId = await mkUser('R Nair', UserRole.RESIDENT_OWNER);
    const managerUser = await mkUser('Manager Pillai', UserRole.SOCIETY_EMPLOYEE);
    const residentAId = await mkUser('Asha Rao', UserRole.RESIDENT_OWNER);
    const ownerAwayId = await mkUser('Owner Abroad', UserRole.RESIDENT_OWNER);

    const audit = {
      societyId, createdBy: adminId, createdByName: 'Setup',
      updatedBy: adminId, updatedByName: 'Setup',
    };

    await Society.create({
      _id: societyId, name: `Throwaway ${SID}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: adminId,
      createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup',
    } as any);

    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const mkFlat = (number: string, status: FlatStatus, ownerUserId?: any) =>
      Flat.create({ ...audit, blockId: wing._id, blockName: 'A Wing', number, status, ownerUserId });

    const a101 = await mkFlat('101', FlatStatus.OWNER_OCCUPIED, residentAId);
    const a102 = await mkFlat('102', FlatStatus.OWNER_OCCUPIED, secretaryId);
    // Empty, but it still has an owner on record — the person this phase says
    // should be asked about their own property.
    const a201 = await mkFlat('201', FlatStatus.VACANT, ownerAwayId);
    // Empty AND ownerless: the fall-through case.
    const a202 = await mkFlat('202', FlatStatus.VACANT);

    await Resident.create([
      { ...audit, flatId: a101._id, userId: residentAId, person: { name: 'Asha Rao' }, relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true },
      { ...audit, flatId: a102._id, userId: secretaryId, person: { name: 'R Nair' }, relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true },
    ]);

    const term = await Committee.create({
      ...audit, name: 'MC 2026', termStartDate: new Date('2026-01-01'), status: 'ACTIVE',
    });
    await CommitteeMember.create({
      ...audit, committeeId: term._id, userId: secretaryId, startDate: new Date('2026-01-01'),
      designationKey: 'SECRETARY', designationLabel: 'Secretary', status: 'ACTIVE',
      memberSnapshot: { name: 'R Nair', flatLabel: 'A Wing 102' },
    });

    // The guard: on the roll, with a login and a console role.
    const guardStaff = await createStaff(String(societyId), {
      name: 'Guard Ramesh', phone: '9800000009', designation: 'SECURITY_GUARD',
    }, { userId: String(adminId), userName: 'Admin' });
    const role = await AccessRole.create({
      ...audit, name: 'Gatekeeper', isActive: true,
      permissions: [{ module: 'GATE_CONSOLE', level: 'FULL' }, { module: 'GATE_LOGS', level: 'FULL' }],
      scope: { allBlocks: true, blockIds: [] },
    });
    await SocietyStaff.updateOne({ _id: guardStaff._id }, { $set: { userId: guardUser, accessRoleId: role._id } });

    // The manager — a STAFF host with a login of their own.
    const managerStaff = await createStaff(String(societyId), {
      name: 'Manager Pillai', phone: '9800000010', designation: 'MANAGER',
    }, { userId: String(adminId), userName: 'Admin' });
    await SocietyStaff.updateOne({ _id: managerStaff._id }, { $set: { userId: managerUser } });

    await Gate.create({
      ...audit, code: 'G1', name: 'Main Gate', kind: 'MAIN',
      handlesEntry: true, handlesExit: true, isActive: true,
    });

    const guardT = tokenFor(guardUser, UserRole.SOCIETY_EMPLOYEE);
    const secretaryT = tokenFor(secretaryId, UserRole.RESIDENT_OWNER);
    const residentAT = tokenFor(residentAId, UserRole.RESIDENT_OWNER);
    const post = (path: string, token: string, body: any = {}) =>
      request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);
    const get = (path: string, token: string) =>
      request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

    const admin = { userId: String(adminId), userName: 'Admin' };
    await updateOpsPolicy(SID, { preset: 'L3' }, admin);

    // ================================================ III-1  the host model
    console.log('III-1 — a visitor for the secretary reaches the secretary');

    const forSecretary = await resolveHostAudience(SID, {
      hostKind: 'COMMITTEE', hostUserId: String(secretaryId),
    });
    eq('a committee host resolves to that ONE person', forSecretary.userIds.length, 1);
    ok('...and it is them', forSecretary.userIds.includes(String(secretaryId)));
    eq('...recorded as the reason', forSecretary.via, 'HOST_COMMITTEE_MEMBER');
    ok('...and named by their office, not by a flat',
      forSecretary.hostLabel.includes('Secretary') && forSecretary.hostLabel.includes('Nair'),
      forSecretary.hostLabel);

    const committeeVisit = await post('/gate/entries', guardT, {
      category: 'GUEST', visitorName: 'Auditor Mehta',
      hostKind: 'COMMITTEE', hostUserId: String(secretaryId),
    });
    ok('the console accepts a visit with no flat at all', committeeVisit.status === 201,
      `got ${committeeVisit.status} ${JSON.stringify(committeeVisit.body?.message)}`);
    eq('...and ASKS, rather than admitting into a void', committeeVisit.body?.data?._outcome, 'AWAITING');
    eq('...filed against the committee', committeeVisit.body?.data?.hostKind, 'COMMITTEE');
    ok('...with the host named on the entry itself',
      String(committeeVisit.body?.data?.hostLabel || '').includes('Secretary'),
      committeeVisit.body?.data?.hostLabel);

    const committeeEntryId = committeeVisit.body?.data?._id;
    const committeeReq = await ApprovalRequest.findOne({ societyId, visitorEntryId: committeeEntryId }).lean();
    ok('an approval request exists for a host who is not a flat', !!committeeReq);
    eq('...asking exactly one person', committeeReq?.askedUserIds.length, 1);
    ok('...and it is the secretary',
      committeeReq?.askedUserIds.map(String).includes(String(secretaryId)));
    eq('...carrying the host onto the request too', committeeReq?.hostKind, 'COMMITTEE');

    await settle();
    const secretaryInbox = await listForUser(SID, String(secretaryId));
    ok('THE SECRETARY IS TOLD SOMEBODY IS HERE FOR THEM',
      secretaryInbox.items.some(i => gateKinds.includes(i.kind)),
      JSON.stringify(secretaryInbox.items.map(i => i.kind)));
    ok('...and the message names them rather than "your flat"',
      secretaryInbox.items.some(i => i.body.includes('Secretary')),
      JSON.stringify(secretaryInbox.items.map(i => i.body)));

    // Attribution: the visit has to be readable BY the host, or the record is
    // a claim nobody can check.
    const secretaryLog = await get('/gate/entries', secretaryT);
    ok('THE HOST CAN SEE THEIR OWN VISIT',
      JSON.stringify(secretaryLog.body).includes('Auditor Mehta'),
      `status ${secretaryLog.status}`);
    const neighbourLog = await get('/gate/entries', residentAT);
    ok('...and a neighbour still cannot',
      !JSON.stringify(neighbourLog.body).includes('Auditor Mehta'));

    const answered = await post(`/gate/approvals/${committeeReq!._id}/decide`, secretaryT, { allow: true });
    eq('the host can answer their own door', answered.status, 200);
    await settle();
    eq('...and the waiting entry becomes INSIDE',
      (await VisitorEntry.findById(committeeEntryId).lean())?.status, 'INSIDE');

    // --------------------------------------------------------- a staff host
    const staffVisit = await post('/gate/entries', guardT, {
      category: 'GUEST', visitorName: 'Lift Vendor',
      hostKind: 'STAFF', hostStaffId: String(managerStaff._id),
    });
    eq('a visit for the manager is asked about', staffVisit.body?.data?._outcome, 'AWAITING');
    const staffReq = await ApprovalRequest.findOne({ societyId, visitorEntryId: staffVisit.body?.data?._id }).lean();
    ok('...and the MANAGER is the one asked',
      staffReq?.askedUserIds.map(String).includes(String(managerUser)));
    ok('...not the committee',
      !staffReq?.askedUserIds.map(String).includes(String(secretaryId)));

    // -------------------------------------------------------- the office
    const officeVisit = await post('/gate/entries', guardT, {
      category: 'GUEST', visitorName: 'AGM Speaker', hostKind: 'OFFICE',
    });
    eq('somebody here for the society office is recorded as such',
      officeVisit.body?.data?.hostKind, 'OFFICE');
    eq('...and labelled so a guard can read it',
      officeVisit.body?.data?.hostLabel, 'Society office');
    const officeReq = await ApprovalRequest.findOne({ societyId, visitorEntryId: officeVisit.body?.data?._id }).lean();
    ok('...with the serving committee asked, because the office IS them',
      officeReq?.askedUserIds.map(String).includes(String(secretaryId)));

    // Every entry can name its host, including the ones written before any of
    // this existed — the guarantee is on the collection, not on one code path.
    const everyEntry = await VisitorEntry.find({ societyId }).lean();
    ok('no entry anywhere has an empty host label',
      everyEntry.every(e => !!e.hostLabel),
      JSON.stringify(everyEntry.filter(e => !e.hostLabel).map(e => e.visitorName)));

    // ========================================== III-3  who answers for an empty flat
    console.log('\nIII-3 — an empty flat is its owner\'s business, not the committee\'s');

    const owned = await whoToAsk(SID, String(a201._id));
    eq('an empty flat with an owner on record asks the OWNER', owned.via, 'VACANT_OWNER_OF_RECORD');
    ok('...and that means them', owned.userIds.includes(String(ownerAwayId)));
    eq('...and nobody else', owned.userIds.length, 1);
    ok('THE WHOLE COMMITTEE IS NO LONGER PINGED',
      !owned.userIds.includes(String(secretaryId)));

    const ownerless = await whoToAsk(SID, String(a202._id));
    eq('an empty flat with no owner falls through to the committee', ownerless.via, 'VACANT_COMMITTEE');
    ok('...which is the last resort, and it still works',
      ownerless.userIds.includes(String(secretaryId)));

    await SocietyOpsPolicy.updateOne({ societyId }, {
      $set: {
        'gate.vacantFlat.handler': 'NAMED_MEMBERS',
        'gate.vacantFlat.namedUserIds': [residentAId],
      },
    });
    const named = await whoToAsk(SID, String(a202._id));
    eq('a society can name who handles its empty flats', named.via, 'VACANT_NAMED_MEMBERS');
    ok('...and only they are asked',
      named.userIds.length === 1 && named.userIds.includes(String(residentAId)));

    // An empty NAMED_MEMBERS list must not silently switch every alert off.
    await SocietyOpsPolicy.updateOne({ societyId }, { $set: { 'gate.vacantFlat.namedUserIds': [] } });
    eq('...and naming nobody falls through rather than telling nobody',
      (await whoToAsk(SID, String(a202._id))).via, 'VACANT_COMMITTEE');

    // The old behaviour stays reachable — as a decision, not as the only branch.
    await SocietyOpsPolicy.updateOne({ societyId }, { $set: { 'gate.vacantFlat.handler': 'COMMITTEE_ALL' } });
    const explicit = await whoToAsk(SID, String(a201._id));
    eq('a society that deliberately wants the whole committee gets it', explicit.via, 'VACANT_COMMITTEE');
    ok('...even though that flat has an owner', explicit.userIds.includes(String(secretaryId)));
    await SocietyOpsPolicy.updateOne({ societyId }, { $set: { 'gate.vacantFlat.handler': 'OWNER_OF_RECORD' } });

    // ==================================== M-1  a resident coming home
    console.log('\nM-1 — nobody is told that they came home');
    await updateOpsPolicy(SID, { preset: 'L2', gate: { residents: { logMovement: true } } }, admin);

    const beforeHome = (await listForUser(SID, String(residentAId))).items.length;
    const cameHome = await post('/gate/entries', guardT, {
      category: 'RESIDENT', visitorName: 'Asha Rao', flatId: String(a101._id),
    });
    eq('a resident movement is recorded', cameHome.status, 201);
    eq('...as a plain guard entry', cameHome.body?.data?.admittedVia, 'GUARD');
    await settle();
    eq('THEIR OWN FLAT IS NOT TOLD SOMEBODY ARRIVED',
      (await listForUser(SID, String(residentAId))).items.length, beforeHome);

    // ======================================= H-3  check before you burn
    console.log('\nH-3 — a refused entry must not also destroy the invitation');
    await updateOpsPolicy(SID, { gate: { capture: { photo: 'REQUIRED' } } }, admin);

    const invite = await issuePass(SID, {
      flatId: String(a101._id), visitorName: 'Invited Vikram', category: 'GUEST',
    }, { userId: String(residentAId), userName: 'Asha Rao' });

    const noPhoto = await post('/gate/passes/redeem', guardT, { code: invite.code });
    ok('a society that requires a photo refuses the scan', noPhoto.status >= 400, `got ${noPhoto.status}`);
    const survived = await GatePass.findById(invite._id).lean();
    eq('THE INVITATION SURVIVES THE REFUSAL', survived?.usedCount, 0);
    eq('...and is still usable', survived?.status, 'ACTIVE');

    const withPhoto = await post('/gate/passes/redeem', guardT, {
      code: invite.code, photoKey: 'gate/throwaway-face.jpg',
    });
    eq('...so the guard can take the photo and try again', withPhoto.status, 201);
    const burned = await GatePass.findById(invite._id).lean();
    eq('...and only THEN is the pass spent', burned?.usedCount, 1);
    eq('...with an entry to show for it', (await VisitorEntry.findById(withPhoto.body?.data?._id).lean())?.admittedVia, 'PASS');

    await updateOpsPolicy(SID, { gate: { capture: { photo: 'OPTIONAL' } } }, admin);

    // ============================ H-4 / H-5  what the device did while offline
    console.log('\nH-4 / H-5 — reconciling an outage, once, and only within the window');
    const queued = await issuePass(SID, {
      flatId: String(a101._id), visitorName: 'Offline Guest', category: 'GUEST',
    }, { userId: String(residentAId), userName: 'Asha Rao' });

    const twentyAgo = new Date(Date.now() - 20 * 60_000);
    const firstSync = await post('/gate/passes/sync', guardT, {
      items: [{ clientId: 'queue-1', code: queued.code, scannedAt: twentyAgo.toISOString() }],
    });
    eq('the sync is accepted', firstSync.status, 200);
    ok('...and the item settles', firstSync.body?.data?.results?.[0]?.ok === true,
      JSON.stringify(firstSync.body?.data?.results));

    const offlineEntries = await VisitorEntry.find({ societyId, offlineClientId: 'queue-1' }).lean();
    eq('AN OFFLINE ARRIVAL REACHES THE REGISTER', offlineEntries.length, 1);
    eq('...as an admitted visitor', offlineEntries[0]?.status, 'INSIDE');
    eq('...tagged PASS, like any other scan', offlineEntries[0]?.admittedVia, 'PASS');
    ok('...recorded at the time they actually walked in, not at sync time',
      Math.abs(offlineEntries[0].enteredAt.getTime() - twentyAgo.getTime()) < 5_000,
      `${offlineEntries[0]?.enteredAt.toISOString()} vs ${twentyAgo.toISOString()}`);

    // The device retries because it never saw the response.
    const retry = await post('/gate/passes/sync', guardT, {
      items: [{ clientId: 'queue-1', code: queued.code, scannedAt: twentyAgo.toISOString() }],
    });
    ok('a retried sync is accepted rather than erroring', retry.body?.data?.results?.[0]?.ok === true);
    ok('...and says it was a duplicate', retry.body?.data?.results?.[0]?.duplicate === true);
    eq('ONE VISITOR, NOT TWO',
      await VisitorEntry.countDocuments({ societyId, offlineClientId: 'queue-1' }), 1);

    // The replay. A pass whose window closed yesterday, presented with a
    // client-chosen timestamp from inside that window.
    const yesterday = await issuePass(SID, {
      flatId: String(a101._id), visitorName: 'Yesterday Guest', category: 'GUEST',
    }, { userId: String(residentAId), userName: 'Asha Rao' });
    await GatePass.collection.updateOne(
      { _id: yesterday._id },
      {
        $set: {
          validFrom: new Date(Date.now() - 30 * 3_600_000),
          validTo: new Date(Date.now() - 26 * 3_600_000),
        },
      },
    );
    const replay = await post('/gate/passes/sync', guardT, {
      items: [{
        clientId: 'queue-replay', code: yesterday.code,
        scannedAt: new Date(Date.now() - 27 * 3_600_000).toISOString(),
      }],
    });
    ok('A CLIENT CANNOT NAME A TIME OUTSIDE THE OFFLINE WINDOW',
      replay.body?.data?.results?.[0]?.ok === false,
      JSON.stringify(replay.body?.data?.results));
    ok('...and is told why', String(replay.body?.data?.results?.[0]?.message || '').includes('hours'),
      replay.body?.data?.results?.[0]?.message);
    eq('...leaving the old pass untouched', (await GatePass.findById(yesterday._id).lean())?.usedCount, 0);
    eq('...and nothing in the register', await VisitorEntry.countDocuments({ societyId, offlineClientId: 'queue-replay' }), 0);

    // A clock that is merely fast is clamped, not refused — that is a real
    // device, not an attack, and losing the entry would be the worse outcome.
    const fastClock = await issuePass(SID, {
      flatId: String(a101._id), visitorName: 'Fast Clock Guest', category: 'GUEST',
    }, { userId: String(residentAId), userName: 'Asha Rao' });
    await post('/gate/passes/sync', guardT, {
      items: [{
        clientId: 'queue-fast', code: fastClock.code,
        scannedAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      }],
    });
    const clamped = await VisitorEntry.findOne({ societyId, offlineClientId: 'queue-fast' }).lean();
    ok('a device whose clock is ahead is still recorded', !!clamped);
    ok('...at a time that has actually happened',
      !!clamped && clamped.enteredAt.getTime() <= Date.now() + 1000,
      clamped?.enteredAt.toISOString());

    // ============================================== H-6  overstays are reported
    console.log('\nH-6 — an overstay actually tells somebody');
    await updateOpsPolicy(SID, { gate: { exit: { overstayAlertAfterMinutes: 5 } } }, admin);

    const slow = await post('/gate/entries', guardT, {
      category: 'DELIVERY', visitorName: 'Very Slow', flatId: String(a101._id),
    });
    await VisitorEntry.updateOne(
      { _id: slow.body?.data?._id },
      { $set: { expectedOutAt: new Date(Date.now() - 2 * 3_600_000) } },
    );

    const beforeAlert = (await listForUser(SID, String(residentAId))).items.length;
    const flagged = await sweepOverstays(SID);
    ok('the sweep finds them', flagged >= 1, String(flagged));
    await settle();
    const alerted = await listForUser(SID, String(residentAId));
    ok('THE FLAT IS TOLD THEIR VISITOR IS STILL INSIDE',
      alerted.items.some(i => i.kind === 'GATE_OVERSTAY'),
      JSON.stringify(alerted.items.map(i => i.kind)));
    ok('...and told how far over', alerted.items.some(i => /minute/.test(i.body)));
    ok('...which is more than they were told before', alerted.items.length > beforeAlert);

    eq('...and it is not repeated on the next sweep', await sweepOverstays(SID), 0);
    ok('...because the entry remembers being flagged',
      !!(await VisitorEntry.findById(slow.body?.data?._id).lean())?.overstayNotifiedAt);

    // ================================= H-7  the close-off settles a DAY
    console.log('\nH-7 — closing off the day does not close off the building');
    const today = await post('/gate/entries', guardT, {
      category: 'GUEST', visitorName: 'Arrived Just Now', flatId: String(a101._id),
    });
    const stale = await post('/gate/entries', guardT, {
      category: 'GUEST', visitorName: 'Three Days Ago', flatId: String(a101._id),
    });
    // Straight to the driver: an entry that belongs to a day already reconciled.
    await VisitorEntry.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(stale.body?.data?._id)) },
      { $set: { enteredAt: new Date(Date.now() - 3 * 86_400_000) } },
    );

    await autoCloseStragglers(SID);
    eq('today\'s straggler is closed off', (await VisitorEntry.findById(today.body?.data?._id).lean())?.status, 'LEFT');
    eq('...and marked as the guess it is',
      (await VisitorEntry.findById(today.body?.data?._id).lean())?.isEstimated, true);
    eq('AN EARLIER DAY IS NOT SWEPT INTO TONIGHT\'S NUMBERS',
      (await VisitorEntry.findById(stale.body?.data?._id).lean())?.status, 'INSIDE');
    ok('...so a reconciliation the committee already read is not rewritten',
      !(await VisitorEntry.findById(stale.body?.data?._id).lean())?.exitedAt);

    // ============================== the invariant this phase must not break
    console.log('\nThe boundary — no gate news about a flat reaches somebody who does not live there');
    const strayed = await Notification.find({
      societyId, userId: residentAId, kind: { $in: gateKinds },
    }).lean();
    ok('the neighbour was never told about the secretary\'s visitor',
      !strayed.some(n => n.body.includes('Auditor Mehta') || n.title.includes('Auditor Mehta')),
      JSON.stringify(strayed.map(n => n.title)));
    const secretaryNotices = await Notification.find({
      societyId, userId: secretaryId, kind: { $in: gateKinds },
    }).lean();
    ok('...and the secretary was never told about A-101\'s',
      !secretaryNotices.some(n => n.body.includes('Very Slow') || n.title.includes('Very Slow')),
      JSON.stringify(secretaryNotices.map(n => n.title)));

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
