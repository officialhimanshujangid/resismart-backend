/**
 * चरण 2 — the one door a visitor comes through.
 *
 * **This is the assertion चरण 1 said to write first, and it FAILED on the code
 * as it stood: approval was switched on and the console admitted anyway.**
 *
 * Speaks HTTP, like verify-security — the gap was never in the services, it was
 * that the console called `recordEntry` and jumped to INSIDE while
 * `requestApproval` sat unreachable. So this drives the real endpoints a guard
 * and a resident hit, and checks the register agrees with itself throughout.
 *
 * The load-bearing checks:
 *   1. approval REQUIRED → the visitor is AWAITING, not INSIDE, and the flat is asked
 *   2. the resident approves → the SAME entry becomes INSIDE
 *   3. a scanned pass writes an entry (before: the visitor was nowhere)
 *   4. every admission records HOW — admittedVia is never empty for an INSIDE
 *
 *   npx tsx src/scripts/verify-arrival.ts
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
import { GatePass } from '../models/gate-pass.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Notification } from '../models/notification.model';
import { AccessRole } from '../models/access-role.model';
import { Gate } from '../models/gate.model';
import { updateOpsPolicy } from '../services/ops-policy.service';
import { createStaff } from '../services/staff.service';
import { issue as issuePass } from '../services/gate-pass.service';
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
    ApprovalRequest.deleteMany({ societyId }), GatePass.deleteMany({ societyId }),
    SocietyOpsPolicy.deleteMany({ societyId }), Notification.deleteMany({ societyId }),
    AccessRole.deleteMany({ societyId }), Gate.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

const settle = () => new Promise(r => setTimeout(r, 300));

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

    // The guard is on the staff roll AND has a login — so guardStaffId can be
    // stamped, and resolveAccess grants the gate console.
    const guardStaff = await createStaff(String(societyId), {
      name: 'Guard Ramesh', phone: '9800000009', designation: 'SECURITY_GUARD',
    }, { userId: String(adminId), userName: 'Admin' });
    // Give the guard a login so guardStaffId resolves and the console permission works.
    await SocietyStaff.updateOne({ _id: guardStaff._id }, { $set: { userId: guardUser } });
    // A full-access role for the guard so requirePermission('GATE_CONSOLE') passes.
    const role = await AccessRole.create({
      ...audit, name: 'Gatekeeper', isActive: true,
      permissions: [{ module: 'GATE_CONSOLE', level: 'FULL' }, { module: 'GATE_LOGS', level: 'FULL' }],
      scope: { allBlocks: true, blockIds: [] },
    });
    await SocietyStaff.updateOne({ _id: guardStaff._id }, { $set: { accessRoleId: role._id } });

    // A gate, because the console now refuses a society's very first entry
    // until one is named — see ops-setup.middleware. This mirrors what a real
    // society has to do before the console will take anything.
    await Gate.create({
      ...audit, code: 'G1', name: 'Main Gate', kind: 'MAIN',
      handlesEntry: true, handlesExit: true, isActive: true,
    });

    const guardT = tokenFor(guardUser, UserRole.SOCIETY_EMPLOYEE);
    const ownerT = tokenFor(ownerId, UserRole.RESIDENT_OWNER);
    const post = (path: string, token: string, body: any = {}) =>
      request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);
    const get = (path: string, token: string) =>
      request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

    // L3 turns approval REQUIRED on for guests.
    await updateOpsPolicy(String(societyId), { preset: 'L3' }, { userId: String(adminId), userName: 'Admin' });

    // ==================================================== approval → AWAITING
    console.log('Approval is on — the guard asks, and does NOT admit');
    const asked = await post('/gate/entries', guardT, {
      category: 'GUEST', visitorName: 'Courier Anil', flatId: String(flat._id),
    });
    ok('the console accepts the arrival', asked.status === 201, `got ${asked.status} ${JSON.stringify(asked.body?.message)}`);
    eq('...and reports it is WAITING, not admitted', asked.body?.data?._outcome, 'AWAITING');
    eq('THE VISITOR IS AWAITING, NOT INSIDE', asked.body?.data?.status, 'AWAITING');
    const entryId = asked.body?.data?._id;

    // The whole point: not counted as present.
    const insideNow = await get('/gate/inside', guardT);
    ok('...and does not appear in "who is inside"',
      !(insideNow.body?.data || []).some((r: any) => String(r._id) === String(entryId)),
      JSON.stringify(insideNow.body?.data?.map((r: any) => r.visitorName)));

    // A request was raised and linked both ways.
    const req = await ApprovalRequest.findOne({ societyId, visitorEntryId: entryId }).lean();
    ok('an approval request exists, linked to the entry', !!req);
    const entryDoc = await VisitorEntry.findById(entryId).lean();
    eq('...and the entry points back at it', String(entryDoc?.approvalRequestId), String(req?._id));

    await settle();
    const ownerInbox = await get('/notifications', ownerT);
    ok('the flat was asked', (ownerInbox.body?.data?.items || []).some((n: any) => n.kind === 'GATE_APPROVAL'));

    // ==================================================== resident approves
    console.log('\nThe resident approves — the SAME entry becomes INSIDE');
    const decided = await post(`/gate/approvals/${req!._id}/decide`, ownerT, { allow: true });
    ok('the resident can allow', decided.status === 200, `got ${decided.status} ${JSON.stringify(decided.body?.message)}`);
    await settle();

    const admitted = await VisitorEntry.findById(entryId).lean();
    eq('THE WAITING ENTRY IS NOW INSIDE', admitted?.status, 'INSIDE');
    eq('...and records it was the resident who let them in', admitted?.admittedVia, 'RESIDENT_APPROVAL');
    ok('...with a stamped decision time', !!admitted?.decidedAt);

    const insideAfter = await get('/gate/inside', guardT);
    ok('...and now appears in "who is inside"',
      (insideAfter.body?.data || []).some((r: any) => String(r._id) === String(entryId)));

    // ==================================================== a refusal
    console.log('\nA refusal turns them away, and they are never "inside"');
    const asked2 = await post('/gate/entries', guardT, {
      category: 'GUEST', visitorName: 'Unwanted', flatId: String(flat._id),
    });
    const req2 = await ApprovalRequest.findOne({ societyId, visitorEntryId: asked2.body?.data?._id }).lean();
    await post(`/gate/approvals/${req2!._id}/decide`, ownerT, { allow: false });
    await settle();
    const denied = await VisitorEntry.findById(asked2.body?.data?._id).lean();
    eq('a refused visitor is DENIED', denied?.status, 'DENIED');
    ok('...and never counted inside', denied?.admittedVia == null);

    // ==================================================== no approval needed
    console.log('\nWhere no approval is needed, the guard admits straight away');
    // Household staff are NONE under L3 — straight in.
    const direct = await post('/gate/entries', guardT, {
      category: 'HOUSEHOLD_STAFF', visitorName: 'Maid Lakshmi', flatId: String(flat._id),
    });
    eq('a no-approval visitor is admitted at once', direct.body?.data?._outcome, 'ADMITTED');
    eq('...as INSIDE', direct.body?.data?.status, 'INSIDE');
    ok('...tagged as the guard\'s own call', ['GUARD', 'NOTIFY', 'EXPECTED'].includes(direct.body?.data?.admittedVia));

    // guardStaffId — "who was on the gate at 11pm" is finally answerable.
    ok('the guard on duty is recorded on the entry',
      String((await VisitorEntry.findById(direct.body?.data?._id).lean())?.guardStaffId) === String(guardStaff._id));

    // ==================================================== a scanned pass
    console.log('\nA scanned pass writes an entry — before, the visitor was nowhere');
    const gp = await issuePass(String(societyId), {
      flatId: String(flat._id), visitorName: 'Invited Vikram', category: 'GUEST',
    }, { userId: String(ownerId), userName: 'Owner Rao' });

    const scanned = await post('/gate/passes/redeem', guardT, { code: gp.code });
    ok('the scan is accepted', scanned.status === 201, `got ${scanned.status} ${JSON.stringify(scanned.body?.message)}`);
    const scanEntry = await VisitorEntry.findById(scanned.body?.data?._id).lean();
    ok('A REDEEMED PASS PRODUCES AN ENTRY', !!scanEntry);
    eq('...admitted INSIDE', scanEntry?.status, 'INSIDE');
    eq('...tagged PASS', scanEntry?.admittedVia, 'PASS');
    eq('...linked to the pass', String(scanEntry?.gatePassId), String(gp._id));

    const burned = await GatePass.findById(gp._id).lean();
    eq('...and the pass is spent', burned?.status, 'USED');
    ok('...remembering which entry it produced',
      (burned?.usedEntryIds || []).some((e: any) => String(e) === String(scanEntry?._id)));
    ok('...and the scanned visitor is now inside',
      (await get('/gate/inside', guardT)).body?.data?.some((r: any) => r.visitorName === 'Invited Vikram'));

    // ==================================================== the invariant
    console.log('\nEvery admitted visitor records HOW');
    const allInside = await VisitorEntry.find({ societyId, status: 'INSIDE' }).lean();
    ok('no INSIDE entry has an empty admittedVia',
      allInside.every(e => !!e.admittedVia),
      JSON.stringify(allInside.filter(e => !e.admittedVia).map(e => e.visitorName)));

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
