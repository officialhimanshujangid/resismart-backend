/**
 * Complaints — the bugs चरण उठाया, and the two dead features now wired.
 *
 * Each check corresponds to something that was concretely wrong:
 *   1. escalation actually runs (sweepEscalations) — before, nothing called it
 *   2. a category's SLA can be edited (saveCategory) — before, no writer existed
 *   3. close() no longer backfills resolvedAt — it was flattering the stats
 *   4. resolve() refuses a NEW complaint — the WORK_DONE step was skippable
 *   5. unassigning IN_PROGRESS work does not rewind it to NEW
 *
 *   npx tsx src/scripts/verify-complaint-fixes.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { Complaint } from '../models/complaint.model';
import { ComplaintCategory } from '../models/complaint-category.model';
import { ComplaintEvent } from '../models/complaint-event.model';
import { SocietyStaff } from '../models/society-staff.model';
import { StaffAssignment } from '../models/staff-assignment.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { Notification } from '../models/notification.model';
import { createStaff, assign } from '../services/staff.service';
import {
  raise, respond, markWorkDone, resolve, close, assignTo,
  saveCategory, listAllCategories, sweepEscalations, ComplaintError,
} from '../services/complaint.service';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const chairId = new mongoose.Types.ObjectId();
const member2Id = new mongoose.Types.ObjectId();
const residentId = new mongoose.Types.ObjectId();
const actor = { userId: adminId.toString(), userName: 'Manager' };
const resident = { userId: residentId.toString(), userName: 'Asha' };
const mgr = { canManage: true, userId: adminId.toString() };
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const audit = { societyId, createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup' };
const settle = () => new Promise(r => setTimeout(r, 300));

async function cleanup() {
  await Promise.all([
    Complaint.deleteMany({ societyId }), ComplaintCategory.deleteMany({ societyId }),
    ComplaintEvent.deleteMany({ societyId }), SocietyStaff.deleteMany({ societyId }),
    StaffAssignment.deleteMany({ societyId }), Block.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Committee.deleteMany({ societyId }),
    CommitteeMember.deleteMany({ societyId }), Notification.deleteMany({ societyId }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const flat = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing', number: '101', status: FlatStatus.OWNER_OCCUPIED,
    });
    const plumber = await createStaff(SID, { name: 'Vijay', phone: '9811111111', designation: 'PLUMBER' }, actor);
    const plumberScope = { canManage: false, ownStaffId: String(plumber._id), userId: String(plumber._id) };
    await assign(SID, { staffId: String(plumber._id), scope: 'BLOCK', blockId: String(wing._id), categories: ['PLUMBING'] }, actor);

    const term = await Committee.create({ ...audit, name: 'MC', termStartDate: new Date('2026-01-01'), status: 'ACTIVE' });
    await CommitteeMember.create({
      ...audit, committeeId: term._id, userId: chairId, startDate: new Date('2026-01-01'),
      designationKey: 'CHAIRMAN', designationLabel: 'Chairman', status: 'ACTIVE', memberSnapshot: { name: 'Chair' },
    });

    // ============================================================ categories
    console.log('A society can now shape its own categories and SLAs');
    const created = await saveCategory(SID, {
      category: 'Pest control', workCategory: 'OTHER',
      firstResponseMinutes: 120, resolutionMinutes: 1440,
    }, actor);
    ok('a new category can be created', !!created._id);

    let badTrade = '';
    try { await saveCategory(SID, { category: 'X', workCategory: 'NONSENSE' }, actor); }
    catch (e: any) { badTrade = e.message; }
    ok('...but not routing to a trade no staff can cover', badTrade.includes('trade staff'), badTrade);

    let backwards = '';
    try { await saveCategory(SID, { category: 'Y', workCategory: 'OTHER', firstResponseMinutes: 500, resolutionMinutes: 100 }, actor); }
    catch (e: any) { backwards = e.message; }
    ok('...nor a first-reply slower than the fix', backwards.includes('cannot be slower'), backwards);

    const edited = await saveCategory(SID, { category: 'Pest control', workCategory: 'OTHER', resolutionMinutes: 720 }, actor, String(created._id));
    eq('AN EXISTING CATEGORY\'S SLA CAN BE CHANGED — before, no writer existed', edited.resolutionMinutes, 720);

    const all = await listAllCategories(SID);
    ok('the manage list includes it', all.some(c => c.category === 'Pest control'));

    // A plumbing category to route real complaints.
    const plumbCat = await saveCategory(SID, {
      category: 'Plumbing', subCategory: 'Leak', workCategory: 'PLUMBING',
      firstResponseMinutes: 30, resolutionMinutes: 60,
    }, actor);

    // ========================================================= close/resolve
    console.log('\nThe status bugs');
    const c1 = await raise(SID, { title: 'Leak', categoryId: String(plumbCat._id), flatId: String(flat._id) }, actor);
    eq('routed to the plumber', c1.assigneeName, 'Vijay');

    // A genuinely NEW complaint — a category no staff cover, so it stays
    // unassigned. resolve() must refuse it.
    const other = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing', number: '999', status: FlatStatus.OWNER_OCCUPIED,
    });
    const orphan = await raise(SID, { title: 'Pests', categoryId: String(created._id), flatId: String(other._id) }, actor);
    eq('the pest complaint is unassigned and NEW', orphan.status, 'NEW');
    let earlyResolve = '';
    try { await resolve(SID, String(orphan._id), actor, mgr); }
    catch (e: any) { earlyResolve = e.message; }
    ok('a complaint nobody worked on cannot be RESOLVED', earlyResolve.includes('Nobody has worked'), earlyResolve);

    // Close a fresh one — must NOT backfill resolvedAt.
    const c2 = await raise(SID, { title: 'Spurious', categoryId: String(plumbCat._id), flatId: String(flat._id) }, actor);
    await close(SID, String(c2._id), actor, mgr);
    const closed = await Complaint.findById(c2._id).lean();
    eq('closing a NEW complaint sets CLOSED', closed?.status, 'CLOSED');
    ok('...and does NOT invent a resolution time (the stats-flattering bug)', !closed?.resolvedAt,
      `resolvedAt=${closed?.resolvedAt}`);

    // ============================================================== unassign
    console.log('\nUnassigning does not erase work that has begun');
    await respond(SID, String(c1._id), 'On my way', { userId: String(plumber._id), userName: 'Vijay' }, plumberScope);
    eq('the complaint is now in progress', (await Complaint.findById(c1._id).lean())?.status, 'IN_PROGRESS');
    await assignTo(SID, String(c1._id), null, actor);
    const unassigned = await Complaint.findById(c1._id).lean();
    ok('...and unassigning leaves it IN_PROGRESS, not rewound to NEW',
      unassigned?.status === 'IN_PROGRESS', `status=${unassigned?.status}`);
    ok('...just without a name on it', !unassigned?.assigneeStaffId);

    // ============================================================ escalation
    console.log('\nEscalation actually runs now');
    // Drag the resolution deadline into the past so it is overdue.
    await Complaint.collection.updateOne(
      { _id: c1._id },
      { $set: { resolutionDueAt: new Date(Date.now() - 3 * 60 * 60_000), assigneeStaffId: plumber._id, assigneeName: 'Vijay', status: 'ASSIGNED' } },
    );
    const before = await Complaint.findById(c1._id).lean();
    eq('it starts at escalation level 0', before?.escalationLevel, 0);

    const escalated = await sweepEscalations(SID);
    ok('THE SWEEP ESCALATES IT — before, nothing ever called applyEscalation', escalated >= 1);
    const after = await Complaint.findById(c1._id).lean();
    ok('...the level moved up', (after?.escalationLevel || 0) > 0, `level=${after?.escalationLevel}`);
    ok('...and lastEscalatedAt is stamped', !!after?.lastEscalatedAt);

    await settle();
    const chairInbox = await Notification.find({ societyId, userId: chairId }).lean();
    ok('...and the committee was told', chairInbox.some(n => n.kind === 'COMPLAINT_ESCALATED'));

    // Running the sweep again does not re-escalate the same level.
    const again = await sweepEscalations(SID);
    const afterAgain = await Complaint.findById(c1._id).lean();
    eq('a second sweep does not double-escalate the same rung',
      afterAgain?.escalationLevel, after?.escalationLevel);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
