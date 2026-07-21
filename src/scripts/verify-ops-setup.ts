/**
 * चरण 8 + चरण 9 — the operations checklist, the report, and the expense↔work link.
 *
 * Three things this is protecting, all of the same shape as every other fault
 * this module has had: a thing that was built, and a thing that nothing reads.
 *
 *   चरण 9 — a brand-new society could log visitors against no gate at all, and
 *           the register was then unable to say which door anybody used. The
 *           block must fire for a fresh society and MUST NOT fire for one that
 *           is already using the gate — a checklist shipped after the fact
 *           taking away a working console is worse than the gap it closes.
 *
 *   चरण 8 — `opsReport` returned bare asset ids nobody could resolve, and the
 *           expense line had no way to say what the money was actually spent on.
 *
 *   npx tsx src/scripts/verify-ops-setup.ts
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
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Notification } from '../models/notification.model';
import { AccessRole } from '../models/access-role.model';
import { Gate } from '../models/gate.model';
import { Asset } from '../models/asset.model';
import { Complaint } from '../models/complaint.model';
import { ComplaintCategory } from '../models/complaint-category.model';
import { Expense } from '../models/expense.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { createStaff } from '../services/staff.service';
import { resolveOpsSetup } from '../services/ops-setup.service';
import { opsReport } from '../services/gate-depth.service';
import { createAsset } from '../services/asset.service';
import { createExpense } from '../services/expenses.service';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
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
  const q = { societyId };
  await Promise.all([
    Society.deleteMany({ _id: societyId }), Block.deleteMany(q), Flat.deleteMany(q),
    Resident.deleteMany(q), SocietyStaff.deleteMany(q), VisitorEntry.deleteMany(q),
    SocietyOpsPolicy.deleteMany(q), Notification.deleteMany(q), AccessRole.deleteMany(q),
    Gate.deleteMany(q), Asset.deleteMany(q), Complaint.deleteMany(q),
    ComplaintCategory.deleteMany(q), Expense.deleteMany(q), LedgerAccount.deleteMany(q),
    FinancePolicy.deleteMany(q), SequenceCounter.deleteMany(q),
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
    const actor = { userId: String(adminId), userName: 'Admin' };

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
    }, actor);
    await SocietyStaff.updateOne({ _id: guardStaff._id }, { $set: { userId: guardUser } });
    const role = await AccessRole.create({
      ...audit, name: 'Gatekeeper', isActive: true,
      permissions: [
        { module: 'GATE_CONSOLE', level: 'FULL' }, { module: 'GATE_LOGS', level: 'FULL' },
        { module: 'OPS_SETTINGS', level: 'FULL' }, { module: 'COMPLAINTS_MANAGE', level: 'FULL' },
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

    // ============================================ चरण 9 — the setup gate
    console.log('चरण 9 — a society with no gate cannot start logging');

    const before = await resolveOpsSetup(String(societyId));
    ok('the checklist says it is not ready', !before.ready);
    ok('...and that it is blocking, because nothing has been logged yet', before.blocking);
    ok('...naming the gate step as unanswered',
      before.steps.some(s => s.key === 'GATES' && !s.done));
    ok('...and the exit question as unanswered',
      before.steps.some(s => s.key === 'EXIT' && !s.done),
      JSON.stringify(before.steps.map(s => `${s.key}:${s.done}`)));

    const refused = await post('/gate/entries', guardT, {
      category: 'GUEST', visitorName: 'Courier Anil', flatId: String(flat._id),
    });
    eq('THE CONSOLE REFUSES THE FIRST ENTRY', refused.status, 403);
    eq('...with a code the screen can act on', refused.body?.code, 'OPS_SETUP_INCOMPLETE');
    eq('...and nothing was written', await VisitorEntry.countDocuments({ societyId }), 0);

    const seen = await get('/gate/setup', guardT);
    ok('the guard can read the checklist to find out why', seen.status === 200,
      `got ${seen.status}`);

    // ------------------------------------------------ answer the questions
    console.log('\n...and once a gate exists, it works');
    const gate = await post('/gate/gates', adminT, {
      code: 'G1', name: 'Main Gate', kind: 'MAIN', handlesEntry: true, handlesExit: true,
    });
    eq('a gate is added', gate.status, 201);

    const admitted = await post('/gate/entries', guardT, {
      category: 'GUEST', visitorName: 'Courier Anil', flatId: String(flat._id),
    });
    eq('the same entry is now accepted', admitted.status, 201);
    eq('...and recorded against the gate', admitted.body?.data?.entryGateName, 'Main Gate');

    // The exit question is still unanswered — and that must NOT block.
    const mid = await resolveOpsSetup(String(societyId));
    ok('the exit question is still open', mid.steps.some(s => s.key === 'EXIT' && !s.done));
    ok('...but nothing is blocking any more — the gate is in use', !mid.blocking);

    await put('/gate/policy', adminT, { gate: { exit: { trackExit: false } } });
    const answered = await resolveOpsSetup(String(societyId));
    ok('answering it ticks the step', answered.steps.some(s => s.key === 'EXIT' && s.done));

    /**
     * The one that matters most here. `trackExit` DEFAULTS to true, so a
     * checklist reading its value would call every brand-new society "answered"
     * — the exact declared-but-never-read shape this project keeps hitting. The
     * stamp is what makes the difference real, so prove it survives being set
     * back to the default value.
     */
    await put('/gate/policy', adminT, { gate: { exit: { trackExit: true } } });
    const stillAnswered = await resolveOpsSetup(String(societyId));
    ok('...and it STAYS ticked when they change their mind back to the default',
      stillAnswered.steps.some(s => s.key === 'EXIT' && s.done));

    // ================================================ चरण 8 — the ops report
    console.log('\nचरण 8 — the report names the equipment, rather than its id');

    const lift = await createAsset(String(societyId), {
      name: 'Lift 2', category: 'LIFT', blockId: String(wing._id), location: 'A Wing lobby',
    } as any, actor);
    const category = await ComplaintCategory.create({
      ...audit, category: 'LIFT', workCategory: 'LIFT',
      firstResponseMinutes: 60, resolutionMinutes: 1440, isActive: true,
    });

    await Complaint.create({
      ...audit, ticketCode: 'C-0001', kind: 'SERVICE', title: 'Lift stuck',
      category: 'LIFT', categoryId: category._id, status: 'NEW', priority: 'NORMAL',
      assetId: lift._id, flatId: flat._id, raisedByName: 'Owner Rao', raisedByUserId: ownerId,
      visibility: 'COMMUNITY', reopenCount: 0, meTooUserIds: [], escalationLevel: 0,
    } as any);

    const from = new Date(Date.now() - 86_400_000);
    const report = await opsReport(String(societyId), from, new Date());
    const worst = report.complaints.worstAssets[0];
    ok('the worst-equipment list has an entry', !!worst);
    eq('...and it is NAMED, not an id', worst?.name, 'Lift 2');
    ok('...with where it is', worst?.where?.includes('A Wing'), JSON.stringify(worst?.where));
    eq('the gate count is right', report.gate.entries, 1);
    eq('...and the staff count reads the right field', report.staffOnBooks, 1);

    const viaHttp = await get(`/gate/report?from=${from.toISOString()}&to=${new Date().toISOString()}`, guardT);
    eq('and the report is reachable over HTTP', viaHttp.status, 200);
    eq('...returning the same named equipment', viaHttp.body?.data?.complaints?.worstAssets?.[0]?.name, 'Lift 2');

    // ======================================= चरण 8 — expense ↔ complaint/asset
    console.log('\nचरण 8 — an expense can say what it was spent on');

    await seedChartOfAccounts(String(societyId), actor.userId, actor.userName);
    await getOrCreatePolicy(String(societyId), actor.userId, actor.userName);
    const complaint = await Complaint.findOne({ societyId }).lean();

    const voucher = await createExpense(String(societyId), {
      expenseDate: new Date(),
      description: 'Lift cable replaced',
      lineItems: [{
        expenseAccountCode: '5100', amountPaise: 1_800_000,
        complaintId: String(complaint!._id), assetId: String(lift._id),
      }],
    } as any, actor);

    const line = voucher.lineItems[0];
    eq('the line remembers the complaint', String(line.complaintId), String(complaint!._id));
    eq('...by its ticket code, snapshotted', line.complaintCode, 'C-0001');
    eq('...and the equipment', String(line.assetId), String(lift._id));
    eq('...by name, so the voucher still reads years later', line.assetName, 'Lift 2');

    // Scoped to this society — a voucher must not be taggable with somebody
    // else's lift, which is the whole reason these are resolved rather than trusted.
    let refusedForeign = false;
    try {
      await createExpense(String(societyId), {
        expenseDate: new Date(), description: 'Someone else\'s lift',
        lineItems: [{
          expenseAccountCode: '5100', amountPaise: 100,
          assetId: String(new mongoose.Types.ObjectId()),
        }],
      } as any, actor);
    } catch { refusedForeign = true; }
    ok('a line cannot be tagged with equipment from another society', refusedForeign);
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
