/**
 * Phase 5 — Complaints v2.
 *
 * Every assertion here FAILS against the code as it stood before this phase.
 * That is the bar: a test that passes either way proves nothing. Each one below
 * describes something a real resident, technician or committee member could
 * have hit.
 *
 * What is covered, by the id used in OPERATIONS_V2.md:
 *   IV-2  one transition table, and the UI is told what it says
 *   IV-2  REJECTED and DUPLICATE exist, so junk costs one click, not four
 *   IV-2  close from NEW is refused — that path corrupted resolvedAt
 *   IV-2  pause records where it came from, is capped, and TELLS the resident
 *   IV-2  reopen resets the clocks, keeps the assignee and notifies
 *   C-11  two concurrent raises cannot share a ticket number
 *   H-8   the first-response clock is actually swept
 *   H-9   a WORK_DONE ticket does not escalate as "the staff are late"
 *   H-10  detail() applies wing scope and staff scope, like list() does
 *   H-11  /options does not hand the staff directory to every resident
 *   H-13  a conduct complaint records who it is ABOUT, and hides from them
 *   H-14  ...and its raiser can still see it, and somebody is actually told
 *   H-15  the escalation queue respects conduct and wing scope
 *   H-16  ?status[$ne]=CLOSED does not return the society's complaints
 *   Ladder — level 1 is reachable at all
 *
 *   npx tsx src/scripts/verify-complaints-v2.ts
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
import { StaffAssignment } from '../models/staff-assignment.model';
import { AccessRole } from '../models/access-role.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { Notification } from '../models/notification.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { createStaff, assign as assignTrade } from '../services/staff.service';
import {
  raise, respond, pause, resume, markWorkDone, resolve, close, reopen, reject,
  markDuplicate, assignTo, list, detail, stats, findEscalations, sweepEscalations,
} from '../services/complaint.service';
import { canTransition, allowedVerbs, TRANSITIONS, PAUSE_LIMITS } from '../services/complaint-transitions';
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

/** Notifications are fire-and-forget by design, so give them a beat to land. */
const settle = () => new Promise(r => setTimeout(r, 400));

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
    Complaint.deleteMany({ societyId }), ComplaintCategory.deleteMany({ societyId }),
    ComplaintEvent.deleteMany({ societyId }), SocietyStaff.deleteMany({ societyId }),
    StaffAssignment.deleteMany({ societyId }), AccessRole.deleteMany({ societyId }),
    Committee.deleteMany({ societyId }), CommitteeMember.deleteMany({ societyId }),
    Notification.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    // ------------------------------------------------------------- fixtures
    const admin = await mkUser('Admin', UserRole.SOCIETY_ADMIN);
    const ownerA = await mkUser('OwnerA', UserRole.RESIDENT_OWNER);
    const ownerB = await mkUser('OwnerB', UserRole.RESIDENT_OWNER);
    const techUser = await mkUser('Tech', UserRole.SOCIETY_EMPLOYEE);
    const rudeUser = await mkUser('Rude', UserRole.SOCIETY_EMPLOYEE);
    const chair = await mkUser('Chair', UserRole.SOCIETY_COMMITTEE);

    const audit = {
      societyId, createdBy: admin, createdByName: 'Setup',
      updatedBy: admin, updatedByName: 'Setup',
    };
    const actor = { userId: String(admin), userName: 'Manager' };
    const residentA = { userId: String(ownerA), userName: 'Owner A' };
    const mgr = { canManage: true, userId: String(admin) };

    await Society.create({
      _id: societyId, name: `Throwaway ${SID}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: admin,
      createdBy: admin, createdByName: 'Setup', updatedBy: admin, updatedByName: 'Setup',
    } as any);

    const [wingA, wingB] = await Block.create([
      { ...audit, name: 'A Wing' }, { ...audit, name: 'B Wing' },
    ]);
    const flatA = await Flat.create({
      ...audit, blockId: wingA._id, blockName: 'A Wing', number: '101',
      status: FlatStatus.OWNER_OCCUPIED, ownerUserId: ownerA,
    });
    const flatB = await Flat.create({
      ...audit, blockId: wingB._id, blockName: 'B Wing', number: '201',
      status: FlatStatus.OWNER_OCCUPIED, ownerUserId: ownerB,
    });
    await Resident.create([
      { ...audit, flatId: flatA._id, userId: ownerA, person: { name: 'Owner A' }, relationship: 'OWNER', householdType: 'OWNER', isActive: true },
      { ...audit, flatId: flatB._id, userId: ownerB, person: { name: 'Owner B' }, relationship: 'OWNER', householdType: 'OWNER', isActive: true },
    ]);

    const plumbCat = await ComplaintCategory.create({
      ...audit, category: 'Plumbing', subCategory: 'Leak', workCategory: 'PLUMBING',
      firstResponseMinutes: 30, resolutionMinutes: 240, sortOrder: 0, isActive: true,
    });

    const tech = await createStaff(SID, { name: 'Vijay', phone: '9811100001', designation: 'PLUMBER' }, actor);
    await SocietyStaff.updateOne({ _id: tech._id }, { $set: { userId: techUser } });
    await assignTrade(SID, { staffId: String(tech._id), scope: 'SOCIETY', categories: ['PLUMBING'] }, actor);
    const techScope = { canManage: false, ownStaffId: String(tech._id), userId: String(techUser) };

    const rude = await createStaff(SID, { name: 'Suresh', phone: '9811100002', designation: 'HOUSEKEEPING' }, actor);
    await SocietyStaff.updateOne({ _id: rude._id }, { $set: { userId: rudeUser } });

    // A serving committee, so conduct and escalation have somewhere to go.
    const term = await Committee.create({ ...audit, name: 'MC', termStartDate: new Date('2026-01-01'), status: 'ACTIVE' });
    await CommitteeMember.create({
      ...audit, committeeId: term._id, userId: chair, startDate: new Date('2026-01-01'),
      designationKey: 'CHAIRMAN', designationLabel: 'Chairman', status: 'ACTIVE',
      memberSnapshot: { name: 'Chair' },
    });

    const techRole = await AccessRole.create({
      ...audit, name: 'Technician', appliesTo: 'STAFF', isActive: true,
      permissions: [{ module: 'COMPLAINTS_OWN', level: 'FULL' }],
      scope: { allBlocks: true, blockIds: [] },
    } as any);
    await SocietyStaff.updateOne({ _id: tech._id }, { $set: { accessRoleId: techRole._id } });

    const auth = (tk: string) => ({ Authorization: `Bearer ${tk}` });
    const adminTk = tokenFor(admin, UserRole.SOCIETY_ADMIN);
    const ownerATk = tokenFor(ownerA, UserRole.RESIDENT_OWNER);
    const techTk = tokenFor(techUser, UserRole.SOCIETY_EMPLOYEE);

    // ================================================ IV-2  ONE TRANSITION TABLE
    console.log('IV-2 — transition legality lives in exactly one place');
    ok('the table exists and covers every status',
      Object.keys(TRANSITIONS).length === 9, String(Object.keys(TRANSITIONS).length));

    const asResident = { canManage: false, isAssignee: false, isResident: true };
    const asDoer = { canManage: false, isAssignee: true, isResident: false };
    const asManager = { canManage: true, isAssignee: false, isResident: false };

    ok('a resident cannot mark work done — the button was offered to them for months',
      !canTransition('ASSIGNED', 'WORK_DONE', asResident, 'workDone').ok);
    ok('...and is told it is not theirs to press (403, not 400)',
      canTransition('ASSIGNED', 'WORK_DONE', asResident, 'workDone').status === 403);
    ok('the person who did the work cannot confirm their own fix (C-9, in the table now)',
      !canTransition('WORK_DONE', 'RESOLVED', asDoer, 'resolve').ok);
    ok('...but the flat can', canTransition('WORK_DONE', 'RESOLVED', asResident, 'resolve').ok);
    ok('...and so can a manager acting for a flat that has gone quiet',
      canTransition('WORK_DONE', 'RESOLVED', asManager, 'resolve').ok);

    /**
     * INVERTED by the depth pass, and this is why.
     *
     * This asserted `residentVerbs.length === 0`: at the time, the honest
     * answer for a resident watching a ticket being worked WAS nothing at all,
     * because every control the old screen offered them — Reply, Put on hold,
     * Work is done, the manage panel — was guaranteed to 403.
     *
     * They now have exactly one, and it is the one that was missing rather than
     * one of the four that were wrong: `comment`, the household's own message
     * box. `POST /:id/respond` is a staff route, so before this a resident who
     * wanted to say "nobody was home, try after six" had no way to say it and
     * filed a second complaint instead.
     *
     * The original claim is not weakened — it is stated more precisely below:
     * none of the four doomed buttons, and nothing that changes a status.
     */
    const residentVerbs = allowedVerbs({ status: 'ASSIGNED', visibility: 'PERSONAL' }, asResident);
    eq('a resident is offered exactly ONE thing on a ticket being worked — a message box',
      residentVerbs.join(','), 'comment');
    ok('...and still none of the four doomed buttons they used to be shown',
      !['respond', 'pause', 'workDone', 'close', 'assign', 'reject'].some(v => residentVerbs.includes(v as any)),
      residentVerbs.join(','));
    const doerVerbs = allowedVerbs({ status: 'ASSIGNED', visibility: 'PERSONAL' }, asDoer);
    ok('the technician is offered reply, hold and work-done',
      ['respond', 'pause', 'workDone'].every(v => doerVerbs.includes(v as any)), doerVerbs.join(','));
    ok('...and never "close"', !doerVerbs.includes('close' as any));

    // ============================================ the ladder's unreachable rung
    console.log('\nThe escalation ladder — level 1 was unreachable');
    const fresh = await raise(SID, {
      title: 'Ladder probe', categoryId: String(plumbCat._id), flatId: String(flatA._id),
    }, actor, { onBehalf: true });
    await Complaint.collection.updateOne(
      { _id: fresh._id },
      { $set: { resolutionDueAt: new Date(Date.now() - 30 * 60_000), status: 'ASSIGNED' } },
    );
    const rung = (await findEscalations(SID)).find(r => String(r._id) === String(fresh._id));
    eq('a freshly overdue complaint sits at rung 1, with the person doing the work',
      rung?.suggestedLevel, 1);

    // ================================================= H-8  first response
    console.log('\nH-8 — the first-response clock is swept, not just written');
    const silent = await raise(SID, {
      title: 'Nobody has replied to this', categoryId: String(plumbCat._id), flatId: String(flatA._id),
    }, actor, { onBehalf: true });
    // The reply clock is blown; the FIX clock is still comfortably in the future.
    await Complaint.collection.updateOne(
      { _id: silent._id },
      {
        $set: {
          firstResponseDueAt: new Date(Date.now() - 90 * 60_000),
          resolutionDueAt: new Date(Date.now() + 10 * 86_400_000),
          status: 'ASSIGNED',
        },
        $unset: { firstRespondedAt: '' },
      },
    );
    const breaches = await findEscalations(SID);
    const late = breaches.find(r => String(r._id) === String(silent._id));
    ok('a missed FIRST REPLY is now found — before, only the fix clock was swept', !!late);
    eq('...and is named as a reply breach', late?.breach, 'FIRST_RESPONSE');
    ok('...with the overdue minutes measured against the reply clock',
      (late?.overdueMinutes || 0) >= 80 && (late?.overdueMinutes || 0) <= 100,
      String(late?.overdueMinutes));

    // Answering it takes it straight back out of the queue.
    await respond(SID, String(silent._id), 'On my way', { userId: String(techUser), userName: 'Vijay' }, techScope);
    ok('...and replying removes it again',
      !(await findEscalations(SID)).some(r => String(r._id) === String(silent._id)));

    // ================================================== H-9  WORK_DONE
    console.log('\nH-9 — a finished job is not escalated as "the staff are late"');
    const waiting = await raise(SID, {
      title: 'Fixed, waiting on the flat', categoryId: String(plumbCat._id), flatId: String(flatA._id),
    }, actor, { onBehalf: true });
    await markWorkDone(SID, String(waiting._id), 'Washer replaced', [], actor, mgr);
    // Measured as a DELTA: the society has other overdue work by now, and the
    // question is whether dragging this one's deadline into the past moves the
    // committee's overdue count. It must not.
    const beforeOverdue = (await stats(SID)).overdue;
    await Complaint.collection.updateOne(
      { _id: waiting._id },
      { $set: { resolutionDueAt: new Date(Date.now() - 3 * 86_400_000) } },
    );
    ok('a WORK_DONE ticket three days past its deadline does NOT escalate',
      !(await findEscalations(SID)).some(r => String(r._id) === String(waiting._id)));

    const withWaiting = await stats(SID);
    ok('...and is not counted as overdue on the committee dashboard either',
      withWaiting.awaitingConfirmation >= 1 && withWaiting.overdue === beforeOverdue,
      `awaiting=${withWaiting.awaitingConfirmation} overdue=${withWaiting.overdue} (was ${beforeOverdue})`);

    // ============================================== IV-2  REJECTED / DUPLICATE
    console.log('\nIV-2 — junk is disposed of in one act, not four');
    const junk = await raise(SID, { title: 'Test entry, ignore', category: 'Other', flatId: String(flatA._id) }, actor, { onBehalf: true });

    let closeFromNew = '';
    try { await close(SID, String(junk._id), actor, mgr); }
    catch (e: any) { closeFromNew = e.message; }
    ok('CLOSING A NEW COMPLAINT IS REFUSED — that path stamped a fake resolvedAt',
      closeFromNew.includes('reject it'), closeFromNew);

    const rejected = await reject(SID, String(junk._id), 'Filed by mistake', actor, mgr);
    eq('rejecting reaches REJECTED — a status nothing could set before', rejected.status, 'REJECTED');
    eq('...and records why', rejected.rejectionReason, 'Filed by mistake');
    ok('...and does NOT invent a resolution time', !rejected.resolvedAt, String(rejected.resolvedAt));

    let noReason = '';
    try { await reject(SID, String(silent._id), '  ', actor, mgr); }
    catch (e: any) { noReason = e.message; }
    ok('...and a rejection with no reason is refused', noReason.includes('Say why'), noReason);

    // The duplicate, carrying its "me too" crowd across.
    const outage = await raise(SID, { title: 'No water in A wing', category: 'Water supply', visibility: 'COMMUNITY' }, actor, { onBehalf: true });
    const copy = await raise(SID, { title: 'No water again', category: 'Water supply', visibility: 'COMMUNITY' }, residentA, { raiserFlatIds: [String(flatA._id)] });
    await Complaint.updateOne({ _id: copy._id }, { $set: { meTooUserIds: [ownerB] } });

    const merged = await markDuplicate(SID, String(copy._id), String(outage._id), actor, mgr);
    eq('a duplicate is disposed of as REJECTED', merged.status, 'REJECTED');
    eq('...pointing at the ticket it duplicates — mergedIntoId had NO writer before',
      String(merged.mergedIntoId), String(outage._id));

    const parent = await Complaint.findById(outage._id).lean();
    const carried = (parent?.meTooUserIds || []).map(u => String(u));
    ok('...and everybody waiting on the copy is carried to the parent',
      carried.includes(String(ownerA)) && carried.includes(String(ownerB)), carried.join(','));

    let selfMerge = '';
    try { await markDuplicate(SID, String(outage._id), String(outage._id), actor, mgr); }
    catch (e: any) { selfMerge = e.message; }
    ok('...and nothing is a duplicate of itself', selfMerge.includes('duplicate of itself'), selfMerge);

    // ================================================== IV-2  pause governance
    console.log('\nIV-2 — pausing is governed, and the resident is told');
    const held = await raise(SID, {
      title: 'Kitchen tap', categoryId: String(plumbCat._id), flatId: String(flatA._id),
    }, actor, { onBehalf: true });

    // It routes to the plumber, so it is ASSIGNED — not IN_PROGRESS.
    eq('it starts assigned, not in progress', (await Complaint.findById(held._id).lean())?.status, 'ASSIGNED');
    await pause(SID, String(held._id), 'AWAITING_ACCESS', actor, mgr);
    const paused = await Complaint.findById(held._id).lean();
    eq('the status it was in is recorded', paused?.statusBeforePause, 'ASSIGNED');
    eq('...and the hold is counted', paused?.pauseCount, 1);

    await settle();
    const heldNotes = await Notification.find({ societyId, userId: ownerA, kind: 'COMPLAINT_PAUSED' }).lean();
    ok('THE RESIDENT IS TOLD THEIR CLOCK STOPPED — pause told nobody at all before',
      heldNotes.length >= 1);
    ok('...in words, not a constant', heldNotes[0]?.body?.includes('could not get into the flat'),
      heldNotes[0]?.body);

    await resume(SID, String(held._id), actor, mgr);
    const resumed = await Complaint.findById(held._id).lean();
    eq('RESUMING RETURNS IT TO WHERE IT WAS — not always IN_PROGRESS', resumed?.status, 'ASSIGNED');
    ok('...and clears the remembered status', !resumed?.statusBeforePause);

    // Pausing something nobody has started, and something already finished.
    const untouched = await raise(SID, { title: 'Nobody has looked at this', category: 'Other', flatId: String(flatB._id) }, actor, { onBehalf: true });
    let pauseNew = '';
    try { await pause(SID, String(untouched._id), 'AWAITING_PARTS', actor, mgr); }
    catch (e: any) { pauseNew = e.message; }
    ok('a NEW complaint cannot be put on hold — there is no delay to stop yet',
      pauseNew.includes('Nothing has started'), pauseNew);

    let pauseDone = '';
    try { await pause(SID, String(waiting._id), 'AWAITING_PARTS', actor, mgr); }
    catch (e: any) { pauseDone = e.message; }
    ok('...nor a WORK_DONE one — that wait belongs to the resident',
      pauseDone.includes('not ours to pause'), pauseDone);

    // The cap.
    await Complaint.updateOne({ _id: held._id }, { $set: { pauseCount: PAUSE_LIMITS.maxCount } });
    let capped = '';
    try { await pause(SID, String(held._id), 'AWAITING_PARTS', actor, mgr); }
    catch (e: any) { capped = e.message; }
    ok(`...and a ticket held ${PAUSE_LIMITS.maxCount} times cannot be held again`,
      capped.includes('needs a decision'), capped);
    await Complaint.updateOne({ _id: held._id }, { $set: { pauseCount: 0 } });

    // A hold that outlives the cap comes back into the overdue queue.
    await Complaint.collection.updateOne(
      { _id: held._id },
      {
        $set: {
          status: 'ON_HOLD',
          pausedAt: new Date(Date.now() - (PAUSE_LIMITS.maxHours + 24) * 3_600_000),
          resolutionDueAt: new Date(Date.now() + 10 * 86_400_000),
        },
      },
    );
    const stale = (await findEscalations(SID)).find(r => String(r._id) === String(held._id));
    ok('a hold that has run past its cap is surfaced rather than hidden forever', !!stale);
    eq('...and named as such', stale?.breach, 'HELD_TOO_LONG');
    await Complaint.collection.updateOne({ _id: held._id }, { $set: { status: 'ASSIGNED' }, $unset: { pausedAt: '' } });

    // ======================================================== IV-2  reopen
    console.log('\nIV-2 — a reopened ticket is not born overdue');
    const bad = await raise(SID, {
      title: 'Still dripping', categoryId: String(plumbCat._id), flatId: String(flatA._id),
    }, actor, { onBehalf: true });
    await markWorkDone(SID, String(bad._id), 'Done', [], actor, mgr);
    await resolve(SID, String(bad._id), residentA, { userId: String(ownerA), residentFlatIds: [String(flatA._id)] });
    await close(SID, String(bad._id), actor, mgr);
    // Age it: closed a fortnight ago, so its old deadline is a fortnight stale.
    await Complaint.collection.updateOne(
      { _id: bad._id },
      { $set: { resolutionDueAt: new Date(Date.now() - 14 * 86_400_000), escalationLevel: 3 } },
    );

    await reopen(SID, String(bad._id), 'It is dripping again', residentA,
      { userId: String(ownerA), residentFlatIds: [String(flatA._id)] });
    const back = await Complaint.findById(bad._id).lean();
    eq('it reopens', back?.status, 'REOPENED');
    ok('THE FIX CLOCK IS RESET — before, it reopened already a fortnight overdue',
      !!back?.resolutionDueAt && back.resolutionDueAt > new Date(),
      String(back?.resolutionDueAt));
    ok('...and the reply clock with it',
      !!back?.firstResponseDueAt && back.firstResponseDueAt > new Date());
    eq('...and the rung it climbed as a closed ticket is dropped', back?.escalationLevel, 0);
    ok('...so the next sweep does not escalate it at all',
      !(await findEscalations(SID)).some(r => String(r._id) === String(bad._id)));
    ok('...and the assignee is kept, not lost', String(back?.assigneeStaffId) === String(tech._id));

    await settle();
    const techInbox = await Notification.find({ societyId, userId: techUser, kind: 'COMPLAINT_REOPENED' }).lean();
    ok('...and the person who has to redo it is TOLD — reopen notified nobody before',
      techInbox.length >= 1);

    // ============================================ H-13 / H-14  conduct
    console.log('\nH-13 / H-14 — a conduct complaint knows who it is about');
    const conduct = await raise(SID, {
      kind: 'CONDUCT', title: 'Suresh was rude at the gate', category: 'Housekeeping',
      flatId: String(flatA._id), aboutStaffId: String(rude._id),
    }, residentA, { raiserFlatIds: [String(flatA._id)] });
    eq('the subject is recorded — there was NO such field before', String(conduct.aboutStaffId), String(rude._id));
    eq('...by name, so the handler can read the queue', conduct.aboutName, 'Suresh');
    ok('...and it is still never routed by trade', !conduct.assigneeStaffId);

    let aboutSelf = '';
    try {
      await raise(SID, { kind: 'CONDUCT', title: 'About me', aboutUserId: String(ownerA) }, residentA, { raiserFlatIds: [String(flatA._id)] });
    } catch (e: any) { aboutSelf = e.message; }
    ok('a conduct complaint cannot be about the person making it', aboutSelf.includes('cannot be about'), aboutSelf);

    await settle();
    const chairConduct = await Notification.find({ societyId, userId: chair, kind: 'COMPLAINT_CONDUCT_RAISED' }).lean();
    ok('SOMEBODY IS ACTUALLY TOLD — the conduct path notified nobody at all',
      chairConduct.length >= 1);
    ok('...without putting the accused\'s name in a lock-screen push',
      !chairConduct[0]?.body?.includes('Suresh'), chairConduct[0]?.body);
    const accusedInbox = await Notification.find({ societyId, userId: rudeUser }).lean();
    ok('...and the accused is told nothing whatsoever', accusedInbox.length === 0,
      accusedInbox.map(n => n.kind).join(','));

    // The raiser can still find it.
    const raiserList = await list(SID, {}, {
      residentFlatIds: [String(flatA._id)], userId: String(ownerA), canSeeConduct: false,
    });
    ok('THE RAISER CAN SEE THEIR OWN CONDUCT COMPLAINT — it used to vanish on send',
      raiserList.rows.some(r => String(r._id) === String(conduct._id)));
    const raiserDetail = await detail(SID, String(conduct._id), {
      residentFlatIds: [String(flatA._id)], userId: String(ownerA), canSeeConduct: false,
    });
    ok('...and open it', String(raiserDetail.complaint._id) === String(conduct._id));

    // A neighbour still cannot.
    const nosyList = await list(SID, {}, {
      residentFlatIds: [String(flatB._id)], userId: String(ownerB), canSeeConduct: false,
    });
    ok('...but a neighbour still cannot', !nosyList.rows.some(r => String(r._id) === String(conduct._id)));

    // The accused cannot, permission or no permission.
    const accusedList = await list(SID, {}, {
      canSeeConduct: true, viewerStaffId: String(rude._id), userId: String(rudeUser),
    });
    ok('THE ACCUSED CANNOT SEE IT even holding the conduct permission',
      !accusedList.rows.some(r => String(r._id) === String(conduct._id)));
    let accusedDetail = '';
    try {
      await detail(SID, String(conduct._id), { canSeeConduct: true, viewerStaffId: String(rude._id), userId: String(rudeUser) });
    } catch (e: any) { accusedDetail = e.message; }
    ok('...nor open it by id', accusedDetail.includes('could not be found'), accusedDetail);

    let handItOver = '';
    try { await assignTo(SID, String(conduct._id), String(rude._id), actor, mgr); }
    catch (e: any) { handItOver = e.message; }
    ok('...and a manager CANNOT hand the complaint to the person it is about',
      handItOver.includes('about that person'), handItOver);

    // A committee member has no staff row at all — the case the old guard missed.
    const aboutChair = await raise(SID, {
      kind: 'CONDUCT', title: 'The chairman shouted at me', category: 'Other',
      flatId: String(flatA._id), aboutUserId: String(chair),
    }, residentA, { raiserFlatIds: [String(flatA._id)] });
    const chairSees = await list(SID, {}, { canSeeConduct: true, userId: String(chair) });
    ok('A CONDUCT COMPLAINT ABOUT A COMMITTEE MEMBER IS HIDDEN FROM THEM',
      !chairSees.rows.some(r => String(r._id) === String(aboutChair._id)));

    // ================================================= H-15  escalation queue
    console.log('\nH-15 — the overdue queue respects conduct and wing scope');
    await Complaint.collection.updateOne(
      { _id: conduct._id },
      { $set: { resolutionDueAt: new Date(Date.now() - 2 * 86_400_000), status: 'NEW' } },
    );
    const plainQueue = await findEscalations(SID, new Date(), { canSeeConduct: false, userId: String(admin) });
    ok('somebody without the conduct permission does not read overdue conduct titles',
      !plainQueue.some(r => String(r._id) === String(conduct._id)));
    const conductQueue = await findEscalations(SID, new Date(), { canSeeConduct: true, userId: String(admin) });
    ok('...and somebody with it does', conductQueue.some(r => String(r._id) === String(conduct._id)));

    const wingQueue = await findEscalations(SID, new Date(), {
      canSeeConduct: true, userId: String(admin), blockIds: [String(wingB._id)],
    });
    ok('a wing-scoped member sees only their own wing\'s overdue work',
      wingQueue.every(r => !r.blockName || r.blockName === 'B Wing'),
      wingQueue.map(r => r.blockName).join(','));

    // The escalation notification does not carry a conduct title.
    await Notification.deleteMany({ societyId, kind: 'COMPLAINT_ESCALATED' });
    await sweepEscalations(SID);
    await settle();
    const escNotes = await Notification.find({ societyId, kind: 'COMPLAINT_ESCALATED' }).lean();
    ok('an escalated conduct complaint does not push the accused\'s name to the committee',
      !escNotes.some(n => n.body?.includes('Suresh was rude')),
      escNotes.map(n => n.body).join(' | '));

    // ==================================================== H-10  detail scope
    console.log('\nH-10 — detail() is scoped exactly like list()');
    const wingBTicket = await raise(SID, {
      title: 'B wing lobby light', categoryId: String(plumbCat._id), flatId: String(flatB._id),
    }, actor, { onBehalf: true });

    let wingBlocked = '';
    try {
      await detail(SID, String(wingBTicket._id), { canManage: true, userId: String(admin), blockIds: [String(wingA._id)] });
    } catch (e: any) { wingBlocked = e.message; }
    ok('A WING-SCOPED MEMBER CANNOT OPEN ANOTHER WING\'S COMPLAINT BY ID',
      wingBlocked.includes('could not be found'), wingBlocked);

    const otherJob = await raise(SID, { title: 'Not the technician\'s job', category: 'Other', flatId: String(flatB._id) }, actor, { onBehalf: true });
    await Complaint.updateOne({ _id: otherJob._id }, { $unset: { assigneeStaffId: '' } });
    let queueBlocked = '';
    try { await detail(SID, String(otherJob._id), { ownStaffId: String(tech._id), userId: String(techUser) }); }
    catch (e: any) { queueBlocked = e.message; }
    ok('...and an employee cannot read a ticket outside their own queue — internal notes and all',
      queueBlocked.includes('could not be found'), queueBlocked);

    const ownJob = await detail(SID, String(silent._id), { ownStaffId: String(tech._id), userId: String(techUser) });
    ok('...but their own queue still opens', String(ownJob.complaint._id) === String(silent._id));

    // ============================================== detail publishes the verbs
    console.log('\nIV-2 — the server says which buttons it will accept');
    ok('the detail payload carries the allowed verbs', Array.isArray(ownJob.can));
    ok('...and they match what the machine would allow',
      ownJob.can.includes('workDone') && !ownJob.can.includes('close'), ownJob.can.join(','));

    const residentView = await detail(SID, String(silent._id), {
      residentFlatIds: [String(flatA._id)], userId: String(ownerA),
    });
    ok('a resident is offered no doomed buttons on a ticket being worked',
      !residentView.can.includes('close') && !residentView.can.includes('workDone')
      && !residentView.can.includes('pause'), residentView.can.join(','));

    // ==================================================== H-16  NoSQL injection
    console.log('\nH-16 — the status filter is not a Mongo operator');
    const injected = await request(app)
      .get('/api/v1/complaints').query({ 'status[$ne]': 'CLOSED' }).set(auth(ownerATk));
    ok('?status[$ne]=CLOSED is refused outright', injected.status === 400, `got ${injected.status}`);

    const honest = await request(app).get('/api/v1/complaints').query({ status: 'NEW' }).set(auth(ownerATk));
    ok('...while an honest filter still works', honest.status === 200, `got ${honest.status}`);

    // ======================================================== H-11  /options
    console.log('\nH-11 — /options does not hand the staff list to every resident');
    const residentOptions = await request(app).get('/api/v1/complaints/options').set(auth(ownerATk));
    eq('a resident may still load the form', residentOptions.status, 200);
    ok('...WITHOUT the staff directory', (residentOptions.body?.data?.staff || []).length === 0,
      JSON.stringify(residentOptions.body?.data?.staff || []).slice(0, 120));
    ok('...and without the society\'s complaint statistics', !residentOptions.body?.data?.stats,
      JSON.stringify(residentOptions.body?.data?.stats));
    ok('...but WITH the state machine, so it can render the right buttons',
      !!residentOptions.body?.data?.transitions?.NEW);

    const adminOptions = await request(app).get('/api/v1/complaints/options').set(auth(adminTk));
    ok('an admin still gets the staff list', (adminOptions.body?.data?.staff || []).length >= 2,
      String((adminOptions.body?.data?.staff || []).length));
    ok('...and the numbers', !!adminOptions.body?.data?.stats);

    // ====================================================== C-11  ticket codes
    console.log('\nC-11 — two people pressing "report" at once get two numbers');
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      raise(SID, { title: `Concurrent ${i}`, category: 'Other', flatId: String(flatA._id) }, actor, { onBehalf: true })));
    const codes = burst.map(c => c.ticketCode);
    eq('eight concurrent raises produce eight distinct ticket numbers', new Set(codes).size, 8);

    const allCodes = (await Complaint.find({ societyId }).select('ticketCode').lean()).map(c => c.ticketCode);
    eq('...and no two complaints in the society share one', new Set(allCodes).size, allCodes.length);

    let dupeRefused = false;
    try {
      await Complaint.create({
        ...audit, ticketCode: codes[0], kind: 'SERVICE', title: 'Forged duplicate',
        category: 'Other', raisedByName: 'X', status: 'NEW', totalPausedMs: 0,
        escalationLevel: 0, reopenCount: 0, pauseCount: 0,
      } as any);
    } catch { dupeRefused = true; }
    ok('...and the database itself refuses a repeat, index and all', dupeRefused);

    // ==================================================== the routes are wired
    console.log('\nThe new verbs are reachable, and only by the right people');
    const disposable = await raise(SID, { title: 'Reject me over HTTP', category: 'Other', flatId: String(flatA._id) }, actor, { onBehalf: true });
    const residentReject = await request(app)
      .post(`/api/v1/complaints/${disposable._id}/reject`).set(auth(ownerATk)).send({ reason: 'no' });
    ok('a resident cannot reject a complaint', residentReject.status === 403, `got ${residentReject.status}`);
    const techReject = await request(app)
      .post(`/api/v1/complaints/${disposable._id}/reject`).set(auth(techTk)).send({ reason: 'no' });
    ok('...nor can the technician', techReject.status === 403, `got ${techReject.status}`);
    const adminReject = await request(app)
      .post(`/api/v1/complaints/${disposable._id}/reject`).set(auth(adminTk)).send({ reason: 'Not a society matter' });
    ok('...the office can', adminReject.status === 200, `got ${adminReject.status}`);
    eq('...and it lands as REJECTED', (await Complaint.findById(disposable._id).lean())?.status, 'REJECTED');

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
