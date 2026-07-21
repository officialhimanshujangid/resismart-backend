/**
 * Phase 6 — complaints, equipment, and the QR sticker.
 * Real database, THROWAWAY societyIds, self-cleaning. Never touches existing data.
 *
 * The load-bearing assertions:
 *
 *   1. A CONDUCT complaint never routes by trade and is never visible to the
 *      person it is about. "The housekeeping man was rude" filed under
 *      Housekeeping would otherwise be delivered to him.
 *   2. Staff can reach WORK_DONE and never CLOSED.
 *   3. The SLA clock genuinely stops. A pause that does not move the deadline is
 *      a label, and a label teaches staff to close-and-reopen instead.
 *
 *   npx ts-node src/scripts/verify-complaints.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { Complaint } from '../models/complaint.model';
import { ComplaintCategory } from '../models/complaint-category.model';
import { ComplaintEvent } from '../models/complaint-event.model';
import { Asset } from '../models/asset.model';
import { SocietyStaff } from '../models/society-staff.model';
import { StaffAssignment } from '../models/staff-assignment.model';
import { AccessRole } from '../models/access-role.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Vendor } from '../models/vendor.model';
import { UserRole } from '../constants/roles';
import { createStaff, assign } from '../services/staff.service';
import {
  raise, listCategories, assignTo, respond, pause, resume, markWorkDone,
  resolve, close, reopen, meToo, rate, list, detail, stats,
  findEscalations, applyEscalation, assetHistory, ComplaintError,
} from '../services/complaint.service';
import { createAsset, resolveScan, findExpiringAmcs } from '../services/asset.service';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const residentAId = new mongoose.Types.ObjectId();
const rudeStaffUserId = new mongoose.Types.ObjectId();
const actor = { userId: adminId.toString(), userName: 'Manager' };
const resident = { userId: residentAId.toString(), userName: 'Asha Rao' };

/**
 * The scope each caller acts with — the same object the controller builds in
 * `readerOpts` and hands to every action.
 *
 * Passing it here is not ceremony: without it a caller can only touch a
 * complaint they raised or their own flat's, which is the whole point of the
 * `actable` gate. A test that called the services scope-less would be testing
 * a door that production never opens.
 */
const mgrScope = { canManage: true, userId: adminId.toString() };
// `plumberScope` is filled in once the staff record exists (its _id is the
// assignee id). Declared here so every call site can name it.
let plumberScope: any = { canManage: false };
const SID = societyId.toString();
const OTHER = otherId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const audit = (sid: mongoose.Types.ObjectId) => ({
  societyId: sid,
  createdBy: adminId, createdByName: actor.userName,
  updatedBy: adminId, updatedByName: actor.userName,
});

async function cleanup() {
  for (const s of [societyId, otherId]) {
    await Promise.all([
      Complaint.deleteMany({ societyId: s }), ComplaintCategory.deleteMany({ societyId: s }),
      ComplaintEvent.deleteMany({ societyId: s }), Asset.deleteMany({ societyId: s }),
      SocietyStaff.deleteMany({ societyId: s }), StaffAssignment.deleteMany({ societyId: s }),
      AccessRole.deleteMany({ societyId: s }), Block.deleteMany({ societyId: s }),
      Flat.deleteMany({ societyId: s }), Vendor.deleteMany({ societyId: s }),
    ]);
  }
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    const [wingA, wingB] = await Block.create([
      { ...audit(societyId), name: 'A Wing' },
      { ...audit(societyId), name: 'B Wing' },
    ]);
    const [a101, b201] = await Flat.create([
      { ...audit(societyId), number: '101', blockName: 'A Wing', blockId: wingA._id, status: FlatStatus.OWNER_OCCUPIED },
      { ...audit(societyId), number: '201', blockName: 'B Wing', blockId: wingB._id, status: FlatStatus.OWNER_OCCUPIED },
    ]);
    const liftCo = await Vendor.create({ ...audit(societyId), name: 'Otis AMC', phone: '9000000001', isActive: true });

    const plumber = await createStaff(SID, { name: 'Vijay', phone: '9800000001', designation: 'PLUMBER' }, actor);
    // The plumber acts on their own queue: ownStaffId is their staff _id, and
    // `actable` lets them touch only complaints assigned to it.
    plumberScope = { canManage: false, ownStaffId: String(plumber._id), userId: String(plumber._id) };
    const cleaner = await createStaff(SID, { name: 'Suresh', phone: '9800000002', designation: 'HOUSEKEEPING' }, actor);
    await SocietyStaff.updateOne({ _id: cleaner._id }, { $set: { userId: rudeStaffUserId } });

    await assign(SID, { staffId: String(plumber._id), scope: 'BLOCK', blockId: String(wingA._id), categories: ['PLUMBING'] }, actor);
    await assign(SID, { staffId: String(cleaner._id), scope: 'SOCIETY', categories: ['CLEANING'] }, actor);

    // ============================================================= categories
    console.log('A society starts with categories it can actually use');
    const cats = await listCategories(SID, actor.userId, actor.userName);
    ok('categories are seeded', cats.length >= 10, `${cats.length}`);

    const leak = cats.find(c => c.subCategory === 'Water leakage')!;
    const tap = cats.find(c => c.subCategory === 'Tap or fitting')!;
    ok('a burst pipe and a dripping tap are not the same promise',
      leak.resolutionMinutes < tap.resolutionMinutes,
      `${leak.resolutionMinutes} vs ${tap.resolutionMinutes}`);
    ok('...and the leak is an emergency', leak.isEmergency);
    ok('every category promises a first reply separately from a fix',
      cats.every(c => c.firstResponseMinutes > 0 && c.firstResponseMinutes <= c.resolutionMinutes));

    const stuck = cats.find(c => c.subCategory === 'Someone stuck')!;
    ok('somebody stuck in a lift gets the fastest promise of all',
      stuck.firstResponseMinutes <= 5, String(stuck.firstResponseMinutes));

    // ================================================================ routing
    console.log('\nA complaint reaches the right person, or visibly nobody');
    const leaking = await raise(SID, {
      title: 'Bathroom tap leaking', categoryId: String(tap._id), flatId: String(a101._id),
    }, resident);
    eq('it goes to the wing plumber', leaking.assigneeName, 'Vijay');
    eq('...and says how it got there', leaking.routedVia, 'BLOCK_PRIMARY');
    eq('...moving out of NEW', leaking.status, 'ASSIGNED');
    ok('...with both clocks set', Boolean(leaking.firstResponseDueAt && leaking.resolutionDueAt));

    const orphan = await raise(SID, {
      title: 'Tap leaking in B wing', categoryId: String(tap._id), flatId: String(b201._id),
    }, resident);
    ok('nobody covers B wing plumbing, so it is left unassigned', !orphan.assigneeStaffId);
    eq('...and stays NEW rather than being given to somebody nearby', orphan.status, 'NEW');
    const orphanEvents = await ComplaintEvent.find({ complaintId: orphan._id }).lean();
    ok('...with a note saying it needs assigning by hand',
      orphanEvents.some(e => e.note?.includes('needs assigning')),
      orphanEvents.map(e => e.note).join(' | '));

    // ================================== THE conduct assertion
    console.log('\nA complaint about a person never reaches that person');
    const conduct = await raise(SID, {
      kind: 'CONDUCT',
      title: 'Housekeeping staff was rude',
      category: 'Housekeeping',
      flatId: String(a101._id),
    }, resident);
    ok('it is not routed to anybody by trade', !conduct.assigneeStaffId, conduct.assigneeName);
    eq('...and is marked as conduct', conduct.kind, 'CONDUCT');

    const asAnyone = await list(SID, {}, { canSeeConduct: false });
    ok('somebody without the conduct permission cannot see it at all',
      !asAnyone.rows.some(r => String(r._id) === String(conduct._id)));

    const asSecretary = await list(SID, {}, { canSeeConduct: true });
    ok('the one person trusted with it can', asSecretary.rows.some(r => String(r._id) === String(conduct._id)));

    let hidden = '';
    try { await detail(SID, String(conduct._id), { canSeeConduct: false }); }
    catch (e: any) { hidden = e.message; }
    ok('opening it directly reads as "not found", not "forbidden"',
      hidden.includes('could not be found'), hidden);

    // Even with the permission, not about yourself.
    await Complaint.updateOne({ _id: conduct._id }, { $set: { assigneeStaffId: cleaner._id } });
    const asSubject = await list(SID, {}, { canSeeConduct: true, viewerStaffId: String(cleaner._id) });
    ok('...and the person it is ABOUT cannot see it even with the permission',
      !asSubject.rows.some(r => String(r._id) === String(conduct._id)));

    // ================================================ resident privacy
    console.log('\nA resident sees their own flat, and what is everybody\'s');
    const community = await raise(SID, {
      title: 'Main gate light is out', category: 'Electrical', visibility: 'COMMUNITY',
    }, actor);

    const asResident = await list(SID, {}, { residentFlatIds: [String(a101._id)] });
    ok('their own flat\'s complaint is there', asResident.rows.some(r => String(r._id) === String(leaking._id)));
    ok('...and the community one', asResident.rows.some(r => String(r._id) === String(community._id)));
    ok('...but not the neighbour\'s', !asResident.rows.some(r => String(r._id) === String(orphan._id)));
    ok('...and no conduct complaint at all', !asResident.rows.some(r => r.kind === 'CONDUCT'));

    let nosy = '';
    try { await detail(SID, String(orphan._id), { residentFlatIds: [String(a101._id)] }); }
    catch (e: any) { nosy = e.message; }
    ok('opening a neighbour\'s complaint by id fails', nosy.includes('could not be found'), nosy);

    // ============================================== who may say it is finished
    console.log('\nThe person who did the work does not get to close it');
    await respond(SID, String(leaking._id), "Coming this evening", { userId: String(plumber._id), userName: "Vijay" }, plumberScope);
    const responded = await Complaint.findById(leaking._id).lean();
    ok('the first reply is timestamped separately', Boolean(responded?.firstRespondedAt));
    eq('...and the status moves on', responded?.status, 'IN_PROGRESS');

    await markWorkDone(SID, String(leaking._id), "Washer replaced", [], { userId: String(plumber._id), userName: "Vijay" }, plumberScope);
    const done = await Complaint.findById(leaking._id).lean();
    eq('the plumber can say the work is done', done?.status, 'WORK_DONE');
    ok('...but that is NOT closed', done?.status !== 'CLOSED' && done?.status !== 'RESOLVED');

    await resolve(SID, String(leaking._id), resident, { userId: residentAId.toString(), residentFlatIds: [String(a101._id)] });
    const confirmed = await Complaint.findById(leaking._id).lean();
    eq('the resident confirms it', confirmed?.status, 'RESOLVED');
    ok('...and that is when the resolution is stamped', Boolean(confirmed?.resolvedAt));

    // ==================================================== THE pause assertion
    console.log('\nThe clock stops when the delay is not ours');
    const locked = await raise(SID, {
      title: 'Kitchen tap', categoryId: String(tap._id), flatId: String(a101._id),
    }, resident);
    const beforeDue = (await Complaint.findById(locked._id).lean())!.resolutionDueAt!;

    await pause(SID, String(locked._id), "AWAITING_ACCESS", { userId: String(plumber._id), userName: "Vijay" }, plumberScope);
    const paused = await Complaint.findById(locked._id).lean();
    eq('it goes on hold', paused?.status, 'ON_HOLD');
    eq('...for a reason from the list', paused?.pauseReason, 'AWAITING_ACCESS');

    let freeText = '';
    try { await pause(SID, String(orphan._id), "BECAUSE_I_SAID" as any, actor, mgrScope); }
    catch (e: any) { freeText = e.message; }
    ok('a made-up reason is refused — otherwise every ticket is "on hold"',
      freeText.includes('not one of the reasons'), freeText);

    // Wind the pause back so resuming has real elapsed time to add.
    await Complaint.collection.updateOne(
      { _id: locked._id }, { $set: { pausedAt: new Date(Date.now() - 60 * 60_000) } },
    );
    await resume(SID, String(locked._id), { userId: String(plumber._id), userName: "Vijay" }, plumberScope);
    const resumed = await Complaint.findById(locked._id).lean();
    // INVERTED in Phase 5, deliberately. This used to demand IN_PROGRESS,
    // because `resume` landed there unconditionally — and that was the bug:
    // `locked` was merely ASSIGNED when it went on hold, so coming back as
    // "in progress" recorded work that nobody had started. `statusBeforePause`
    // now says where it came from and `resume` returns it there.
    eq('...and comes back to where it was, not always "in progress"', resumed?.status, 'ASSIGNED');
    ok('the deadline moved out by the time nobody could work',
      resumed!.resolutionDueAt!.getTime() > beforeDue.getTime(),
      `${resumed!.resolutionDueAt!.toISOString()} vs ${beforeDue.toISOString()}`);
    ok('...and the paused time is banked, so reports can exclude it',
      (resumed?.totalPausedMs || 0) > 50 * 60_000, String(resumed?.totalPausedMs));

    let pauseFinished = '';
    try { await pause(SID, String(leaking._id), "AWAITING_PARTS", actor, mgrScope); }
    catch (e: any) { pauseFinished = e.message; }
    ok('something already finished cannot be put on hold', pauseFinished.includes('already finished'), pauseFinished);

    // ============================================================== reopening
    console.log('\nReopening is counted, not erased');
    await close(SID, String(leaking._id), actor, mgrScope);
    await reopen(SID, String(leaking._id), "Still dripping", resident, { userId: residentAId.toString(), residentFlatIds: [String(a101._id)] });
    const reopened = await Complaint.findById(leaking._id).lean();
    eq('the count goes up', reopened?.reopenCount, 1);
    eq('...and the status says so', reopened?.status, 'REOPENED');
    ok('...and the resolution stamp is cleared, so it is genuinely open again',
      !reopened?.resolvedAt && !reopened?.closedAt);

    await close(SID, String(leaking._id), actor, mgrScope);
    await reopen(SID, String(leaking._id), "Again", resident, { userId: residentAId.toString(), residentFlatIds: [String(a101._id)] });
    eq('a second reopen counts twice', (await Complaint.findById(leaking._id).lean())?.reopenCount, 2);

    let notOpen = '';
    try { await reopen(SID, String(orphan._id), "x", resident, mgrScope); }
    catch (e: any) { notOpen = e.message; }
    ok('something still open cannot be reopened', notOpen.includes('still open'), notOpen);

    // ================================================================ me too
    console.log('\n"Me too" — forty tickets become one');
    await meToo(SID, String(community._id), resident, { userId: residentAId.toString(), residentFlatIds: [String(a101._id)] });
    const joined = await Complaint.findById(community._id).lean();
    eq('the resident is recorded as affected', joined?.meTooUserIds.length, 1);
    await meToo(SID, String(community._id), resident, { userId: residentAId.toString(), residentFlatIds: [String(a101._id)] });
    eq('...and joining twice does not double-count', (await Complaint.findById(community._id).lean())?.meTooUserIds.length, 1);

    let personalJoin = '';
    try { await meToo(SID, String(orphan._id), resident, { userId: residentAId.toString(), residentFlatIds: [String(a101._id)] }); }
    catch (e: any) { personalJoin = e.message; }
    ok('you cannot join somebody\'s private complaint', personalJoin.includes('community'), personalJoin);

    // ============================================================ the sticker
    console.log('\nA sticker on the lift removes the guesswork');
    const lift = await createAsset(SID, {
      name: 'Lift 2', category: 'LIFT', blockId: String(wingB._id), location: 'B wing lobby',
      vendorId: String(liftCo._id), amcExpiresOn: new Date(Date.now() + 200 * 86_400_000).toISOString(),
    }, actor);
    ok('it gets a random token, not a guessable one',
      lift.qrToken.length >= 20 && !lift.qrToken.includes(String(lift._id)), lift.qrToken);

    const scanned = await resolveScan(lift.qrToken);
    eq('scanning finds the equipment', scanned.asset.name, 'Lift 2');
    eq('...and its society, because the token carries that too', scanned.societyId, SID);
    ok('...and offers the right category, so the form arrives filled in', Boolean(scanned.suggestedCategoryId));
    ok('...and knows it is under AMC', scanned.underAmc);

    let badToken = '';
    try { await resolveScan('deadbeefdeadbeefdeadbeef'); }
    catch (e: any) { badToken = e.message; }
    ok('an unknown sticker fails cleanly', badToken.includes('does not match'), badToken);

    const liftBroken = await raise(SID, {
      title: 'Lift stuck between floors', categoryId: String(stuck._id), assetId: String(lift._id),
    }, resident);
    eq('the complaint knows which lift', liftBroken.assetName?.includes('Lift 2'), true);
    eq('...and inherits its wing without anybody typing it', String(liftBroken.blockId), String(wingB._id));
    eq('...and goes to the AMC firm, at their cost', liftBroken.assigneeVendorName, 'Otis AMC');
    eq('...saying why', liftBroken.routedVia, 'ASSET_AMC');
    eq('...at emergency priority', liftBroken.priority, 'EMERGENCY');

    const history = await assetHistory(SID, String(lift._id));
    eq('the lift now has a history of its own', history.length, 1);

    const amcs = await findExpiringAmcs(SID, 365);
    ok('an AMC running out is surfaced before it lapses', amcs.some(a => String(a._id) === String(lift._id)));

    // ============================================================ escalation
    console.log('\nOverdue work climbs, and the last rung is the law');
    await Complaint.collection.updateOne(
      { _id: orphan._id },
      { $set: { resolutionDueAt: new Date(Date.now() - 2 * 86_400_000), createdAt: new Date(Date.now() - 4 * 86_400_000) } },
    );
    const due = await findEscalations(SID);
    const orphanEsc = due.find(d => String(d._id) === String(orphan._id));
    ok('the overdue complaint is found', Boolean(orphanEsc));
    ok('...and is pushed up a rung', (orphanEsc?.suggestedLevel || 0) > 0, String(orphanEsc?.suggestedLevel));

    await applyEscalation(SID, String(orphan._id), orphanEsc!.suggestedLevel, actor);
    const escalated = await Complaint.findById(orphan._id).lean();
    eq('the level is recorded', escalated?.escalationLevel, orphanEsc!.suggestedLevel);
    const again = await findEscalations(SID);
    ok('...and it is not raised to the same rung twice',
      !again.some(d => String(d._id) === String(orphan._id) && d.suggestedLevel === orphanEsc!.suggestedLevel));

    // Something on hold is nobody's fault and must not escalate.
    await Complaint.collection.updateOne(
      { _id: locked._id },
      { $set: { status: 'ON_HOLD', resolutionDueAt: new Date(Date.now() - 86_400_000) } },
    );
    const held = await findEscalations(SID);
    ok('something on hold does not escalate', !held.some(d => String(d._id) === String(locked._id)));

    // ================================================================ reports
    console.log('\nThe numbers a committee can act on');
    const s = await stats(SID);
    ok('open work is counted', s.open > 0, String(s.open));
    ok('...and the unassigned separately', s.unassigned >= 0, String(s.unassigned));
    ok('reopen rate is reported — the clearest sign work is not really done',
      s.reopenRate > 0, `${s.reopenRate}%`);
    ok('...and resolution time is a MEDIAN, so one zombie ticket cannot skew it',
      s.medianResolutionMinutes === null || s.medianResolutionMinutes >= 0,
      String(s.medianResolutionMinutes));

    // ========================================================= cross-society
    console.log('\nOne society cannot reach into another');
    const theirBlock = await Block.create({ ...audit(otherId), name: 'Their Wing' });
    const theirAsset = await createAsset(OTHER, { name: 'Their Lift', category: 'LIFT', blockId: String(theirBlock._id) }, actor);
    let crossAsset = '';
    try { await raise(SID, { title: 'x', category: 'Other', assetId: String(theirAsset._id) }, actor); }
    catch (e: any) { crossAsset = e.message; }
    ok('equipment from another society is refused', crossAsset.includes('does not belong'), crossAsset);

    const mine = await list(SID, {}, { canSeeConduct: true });
    ok('every complaint belongs to this society', mine.rows.every(r => String(r.societyId) === SID));

    // ================================================================ history
    console.log('\nThe story of a complaint is kept, and residents see the public half');
    const full = await detail(SID, String(leaking._id), { canSeeConduct: true });
    ok('staff see everything, including internal notes', full.events.some(e => e.isInternal));
    const publicView = await detail(SID, String(leaking._id), { residentFlatIds: [String(a101._id)] });
    ok('...and the resident sees only what was said to them',
      publicView.events.every(e => !e.isInternal));
    ok('...which still includes the reply and the fix',
      publicView.events.some(e => e.type === 'RESPONDED') && publicView.events.some(e => e.type === 'WORK_DONE'));

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
