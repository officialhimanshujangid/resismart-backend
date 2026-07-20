/**
 * Phase 4 — the gate as a digital register.
 * Real database, THROWAWAY societyIds, self-cleaning. Never touches existing data.
 *
 * Two assertions carry this phase:
 *
 *   1. A resident sees their own flat and NOTHING else — proved through the
 *      service with a deliberately hostile query, because the real-world
 *      failure of these systems was a resident reading a neighbour's log.
 *   2. An auto-closed entry always admits it was a guess. Every competitor's
 *      "who is inside" list is quietly wrong; this one states its error rate.
 *
 *   npx ts-node src/scripts/verify-gate-register.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { VisitorEntry } from '../models/visitor-entry.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Block } from '../models/block.model';
import { Resident } from '../models/resident.model';
import { AccessRole } from '../models/access-role.model';
import { UserRole } from '../constants/roles';
import {
  getOrCreateOpsPolicy, updateOpsPolicy, resolveOpsModules, presetFor,
  approvalRuleFor, expectedStayFor,
} from '../services/ops-policy.service';
import {
  recordEntry, recordExit, whoIsInside, listEntries,
  autoCloseStragglers, reconcileDay, findOverstays, markOverstayNotified,
  purgeOldEntries, VisitorError,
} from '../services/visitor.service';
import { resolveAccess } from '../services/access-role.service';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const residentAId = new mongoose.Types.ObjectId();
const userId = adminId;
const actor = { userId: adminId.toString(), userName: 'Guard Ramesh' };
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
  createdBy: userId, createdByName: actor.userName,
  updatedBy: userId, updatedByName: actor.userName,
});

async function cleanup() {
  for (const s of [societyId, otherId]) {
    await Promise.all([
      VisitorEntry.deleteMany({ societyId: s }), SocietyOpsPolicy.deleteMany({ societyId: s }),
      Flat.deleteMany({ societyId: s }), Block.deleteMany({ societyId: s }),
      Resident.deleteMany({ societyId: s }), AccessRole.deleteMany({ societyId: s }),
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
    const mkFlat = (n: string, block: any) => ({
      ...audit(societyId), number: n, blockName: block.name, blockId: block._id,
      status: FlatStatus.OWNER_OCCUPIED,
    });
    const [a101, a102, b201] = await Flat.create([
      mkFlat('101', wingA), mkFlat('102', wingA), mkFlat('201', wingB),
    ]);

    // Resident of A-101 only. The whole privacy story hangs off this row.
    await Resident.create({
      ...audit(societyId), flatId: a101._id, userId: residentAId,
      person: { name: 'Asha Rao' }, relationship: 'OWNER', isOwner: true, isActive: true,
    });

    await getOrCreateOpsPolicy(SID, actor.userId, actor.userName);

    // ================================================================ presets
    console.log('The five levels are switches, not a straitjacket');
    const l1 = presetFor('L1');
    ok('L1 does not track exits — a paper register does not either', !l1.exit.trackExit);
    eq('...and asks nobody for approval', l1.approval.get('GUEST')!.mode, 'NONE');

    const l3 = presetFor('L3');
    ok('L3 tracks exits', l3.exit.trackExit);
    eq('...and asks the flat about a guest', l3.approval.get('GUEST')!.mode, 'REQUIRED');
    eq('...but not about the daily help, who is expected', l3.approval.get('HOUSEHOLD_STAFF')!.mode, 'NONE');

    eq('L5 tracks vehicles', presetFor('L5').vehicles.track, true);
    eq('...and L3 does not', presetFor('L3').vehicles.track, false);

    // Hand-tuning must move the level off the preset, or the screen lies.
    await updateOpsPolicy(SID, { preset: 'L2' }, actor);
    eq('applying a preset records it', (await getOrCreateOpsPolicy(SID, actor.userId, actor.userName)).gate.level, 'L2');
    await updateOpsPolicy(SID, { gate: { capture: { photo: 'REQUIRED' } } }, actor);
    const tuned = await getOrCreateOpsPolicy(SID, actor.userId, actor.userName);
    eq('...and changing one switch moves it to CUSTOM', tuned.gate.level, 'CUSTOM');
    eq('...keeping the change', tuned.gate.capture.photo, 'REQUIRED');

    // The one setting a society does not get to have.
    await updateOpsPolicy(SID, { privacy: { retentionDays: 60 } } as any, actor);
    const priv = await getOrCreateOpsPolicy(SID, actor.userId, actor.userName);
    eq('retention is settable', priv.privacy.retentionDays, 60);
    ok('...but "residents see only their own flat" is not', priv.privacy.residentSeesOwnFlatOnly === true);

    // `modules` must keep "never chosen" and "chose nothing" apart.
    const rawPolicy = await SocietyOpsPolicy.findOne({ societyId }).lean();
    ok('modules has no schema default — undefined is not []', rawPolicy?.modules === undefined,
      JSON.stringify(rawPolicy?.modules));
    const inferred = await resolveOpsModules(SID);
    ok('...and resolves to something usable anyway', inferred.includes('GATE'), inferred.join(','));

    /**
     * A NEW SOCIETY SEES EVERY MODULE.
     *
     * This is the assertion that would have caught the real fault: an admin
     * signed in, found no Staff screen anywhere, and concluded it had never
     * been built. It had — the module was off, and an admin cannot switch on
     * something they have never seen. Off is for a society that looked at a
     * feature and declined it.
     */
    ok('a new society sees Staff', inferred.includes('STAFF'), inferred.join(','));
    ok('...and Complaints', inferred.includes('COMPLAINTS'), inferred.join(','));
    ok('...and Equipment', inferred.includes('ASSETS'), inferred.join(','));

    // The guess is MARKED as a guess. Without this it hardens into a choice
    // nobody made, and no later improvement can ever reach this society.
    const afterInfer = await SocietyOpsPolicy.findOne({ societyId }).lean();
    ok('the guess is recorded as a guess', !!afterInfer?.modulesInferredAt);

    // An explicit choice is final, and re-reading must not undo it.
    await updateOpsPolicy(SID, { modules: ['GATE'] }, actor);
    const chosen = await resolveOpsModules(SID);
    eq('an admin who switches everything else off gets exactly that', chosen.join(','), 'GATE');
    const afterChoice = await SocietyOpsPolicy.findOne({ societyId }).lean();
    ok('...and the guess mark is cleared, so nothing revisits it',
      !afterChoice?.modulesInferredAt);
    eq('...on a second read too', (await resolveOpsModules(SID)).join(','), 'GATE');

    // Put it back, since the rest of this script exercises the gate.
    await updateOpsPolicy(SID, { modules: ['GATE', 'COMPLAINTS', 'STAFF', 'ASSETS'] }, actor);

    // =============================================================== entry
    console.log('\nLogging an arrival');
    await updateOpsPolicy(SID, { preset: 'L2', gate: { capture: { photo: 'OPTIONAL' } } }, actor);

    const swiggy = await recordEntry(SID, {
      category: 'DELIVERY', visitorName: 'Swiggy — Imran', visitorPhone: '9800000001', flatId: String(a101._id),
    }, actor);
    ok('the entry gets a short code a guard can call out', /^\d{4}-\d{3}$/.test(swiggy.entryCode), swiggy.entryCode);
    eq('...is inside', swiggy.status, 'INSIDE');
    eq('...knows which flat', swiggy.flatLabel, 'A Wing 101');
    ok('...and carries the wing, for scoped roles later', String(swiggy.blockId) === String(wingA._id));
    ok('...with an expected departure, which is what makes exit chaseable', Boolean(swiggy.expectedOutAt));

    const stay = expectedStayFor(await getOrCreateOpsPolicy(SID, actor.userId, actor.userName), 'DELIVERY');
    eq('a delivery is expected to be quick', stay, 15);

    const guest = await recordEntry(SID, { category: 'GUEST', visitorName: 'Uncle', flatId: String(b201._id) }, actor);
    ok('a guest gets longer', (guest.expectedOutAt!.getTime() - guest.enteredAt.getTime()) > (swiggy.expectedOutAt!.getTime() - swiggy.enteredAt.getTime()));

    // Validation that actually matters at a gate.
    let noName = '';
    try { await recordEntry(SID, { category: 'GUEST', visitorName: '  ' }, actor); }
    catch (e: any) { noName = e.message; }
    ok('a nameless visitor is refused', noName.includes('Who is at the gate'), noName);

    let strangerFlat = '';
    const theirBlock = await Block.create({ ...audit(otherId), name: 'X Wing' });
    const theirFlat = await Flat.create({
      ...audit(otherId), number: '999', blockName: 'X Wing', blockId: theirBlock._id, status: FlatStatus.VACANT,
    });
    try { await recordEntry(SID, { category: 'GUEST', visitorName: 'X', flatId: String(theirFlat._id) }, actor); }
    catch (e: any) { strangerFlat = e.message; }
    ok('a flat from another society is refused', strangerFlat.includes('does not belong'), strangerFlat);

    // A society that switched a category off should not be able to log it.
    await updateOpsPolicy(SID, { gate: { capture: { categoriesEnabled: ['GUEST', 'DELIVERY'] } } }, actor);
    let offCategory = '';
    try { await recordEntry(SID, { category: 'CONTRACTOR', visitorName: 'Painter' }, actor); }
    catch (e: any) { offCategory = e.message; }
    ok('a switched-off category is refused', offCategory.includes('does not record'), offCategory);
    await updateOpsPolicy(SID, { gate: { capture: { categoriesEnabled: ['GUEST', 'DELIVERY', 'CAB', 'HOUSEHOLD_STAFF', 'CONTRACTOR', 'OTHER'] } } }, actor);

    // A REQUIRED capture rule must actually be enforced, not just displayed.
    await updateOpsPolicy(SID, { gate: { capture: { phone: 'REQUIRED' } } }, actor);
    let noPhone = '';
    try { await recordEntry(SID, { category: 'GUEST', visitorName: 'No Phone' }, actor); }
    catch (e: any) { noPhone = e.message; }
    ok('a required phone number is enforced', noPhone.includes('phone number is required'), noPhone);

    // ...and OFF must mean the data is not kept, not merely not asked for.
    await updateOpsPolicy(SID, { gate: { capture: { phone: 'OFF' } } }, actor);
    const noKeep = await recordEntry(SID, { category: 'GUEST', visitorName: 'Anon', visitorPhone: '9999999999' }, actor);
    ok('with phone capture OFF the number is discarded, not just hidden', !noKeep.visitorPhone, noKeep.visitorPhone);
    await updateOpsPolicy(SID, { gate: { capture: { phone: 'OPTIONAL' } } }, actor);

    // ================================================================== inside
    console.log('\nWho is inside right now');
    const insideNow = await whoIsInside(SID);
    eq('everyone still in is listed', insideNow.length, 3);
    ok('...newest first', insideNow[0].visitorName === 'Anon');

    await recordExit(SID, String(swiggy._id), { userId: adminId.toString(), userName: 'Guard Suresh' });
    const afterExit = await whoIsInside(SID);
    eq('...and one who left drops off', afterExit.length, 2);

    const left = await VisitorEntry.findById(swiggy._id).lean();
    eq('the departure is recorded as seen by a person', left?.exitSource, 'GUARD');
    ok('...not as a guess', left?.isEstimated === false);
    eq('...and names who saw it', left?.exitGuardName, 'Guard Suresh');

    let twice = '';
    try { await recordExit(SID, String(swiggy._id), actor); }
    catch (e: any) { twice = e.message; }
    ok('marking the same visitor gone twice is refused', twice.includes('already marked'), twice);

    // ================================================ THE privacy assertion
    console.log('\nA resident sees their own flat and nothing else');
    const asResident = await listEntries(SID, {}, { residentFlatIds: [String(a101._id)] });
    ok('they see their own visitors', asResident.rows.length > 0, `${asResident.rows.length}`);
    ok('...and ONLY their own', asResident.rows.every(r => String(r.flatId) === String(a101._id)),
      asResident.rows.map(r => r.flatLabel).join(','));

    // The hostile case: asking for someone else's flat explicitly. The clamp
    // wins and quietly returns their OWN rows — which is the safe answer. What
    // matters is that not one row of the neighbour's comes back.
    const nosy = await listEntries(SID, { flatId: String(b201._id) }, { residentFlatIds: [String(a101._id)] });
    ok('asking for a neighbour\'s flat by id leaks nothing',
      nosy.rows.every(r => String(r.flatId) === String(a101._id)),
      `leaked: ${nosy.rows.filter(r => String(r.flatId) !== String(a101._id)).map(r => r.flatLabel).join(',')}`);
    ok('...and B-201 in particular never appears',
      !nosy.rows.some(r => String(r.flatId) === String(b201._id)));

    // And a resident with no flats must get nothing, not everything.
    const orphan = await listEntries(SID, {}, { residentFlatIds: [] });
    eq('a resident with no flats sees nothing, not everything', orphan.rows.length, 0);

    // Staff are not clamped.
    const asStaff = await listEntries(SID, {});
    ok('a guard sees the whole log', asStaff.rows.length > asResident.rows.length);

    // ========================================================== wing scoping
    console.log('\nA wing-scoped role is filtered, not refused');
    const wingRole = await AccessRole.create({
      ...audit(societyId), name: 'A wing only', appliesTo: 'COMMITTEE',
      permissions: [{ module: 'GATE_LOGS', level: 'FULL' }],
      scope: { allBlocks: false, blockIds: [wingA._id] },
      isSystem: false, isActive: true,
    });
    const scoped: any = {
      role: UserRole.SOCIETY_COMMITTEE, isAdmin: false,
      permissions: { GATE_LOGS: 'FULL' },
      scope: { allBlocks: false, blockIds: [String(wingA._id)] },
    };
    const scopedLog = await listEntries(SID, {}, { access: scoped });
    ok('they see A wing', scopedLog.rows.some(r => String(r.blockId) === String(wingA._id)));
    ok('...not B wing', !scopedLog.rows.some(r => String(r.blockId) === String(wingB._id)));
    ok('...but society-wide visitors stay visible — they belong to no wing',
      scopedLog.rows.some(r => !r.blockId));

    // =========================================== auto-close: the honest guess
    console.log('\nWhat nobody saw leave is closed off, and says so');
    const before = await whoIsInside(SID);
    ok('there are stragglers to close', before.length > 0, `${before.length}`);

    const closed = await autoCloseStragglers(SID);
    eq('all of them are closed', closed, before.length);
    eq('...leaving nobody inside', (await whoIsInside(SID)).length, 0);

    const guessed = await VisitorEntry.find({ societyId, exitSource: 'AUTO_CLOSE' }).lean();
    ok('every auto-closed entry admits it is a guess', guessed.every(g => g.isEstimated === true));
    ok('...and is marked as left, so the list is usable', guessed.every(g => g.status === 'LEFT'));

    const day = await reconcileDay(SID);
    eq('the morning report counts what was really seen', day.exitsRecorded, 1);
    eq('...and what was assumed', day.estimated, guessed.length);
    ok('...and states an accuracy the committee can act on', (day.accuracy ?? -1) < 100 && (day.accuracy ?? -1) > 0, `${day.accuracy}%`);

    // A society that does not track exits must not have entries closed off.
    await updateOpsPolicy(OTHER, { preset: 'L1' }, actor);
    await recordEntry(OTHER, { category: 'GUEST', visitorName: 'Register only' }, actor);
    eq('a register-only society is left alone', await autoCloseStragglers(OTHER), 0);
    // Not 0%. A society that never promised to record departures is not "0%
    // accurate" at recording them — the number simply does not apply, and
    // printing one would be an accusation about a switched-off feature.
    eq('...and is not scored on an exit log it never kept',
      (await reconcileDay(OTHER)).accuracy, null);

    // ================================================================ overstay
    console.log('\nOverstays are flagged once, not nightly');
    await updateOpsPolicy(SID, { preset: 'L2', gate: { exit: { overstayAlertAfterMinutes: 5 } } }, actor);
    const late = await recordEntry(SID, { category: 'DELIVERY', visitorName: 'Very Slow', flatId: String(a102._id) }, actor);
    await VisitorEntry.updateOne({ _id: late._id }, {
      $set: { expectedOutAt: new Date(Date.now() - 60 * 60_000) },
    });

    const over = await findOverstays(SID);
    eq('the overdue visitor is found', over.length, 1);
    eq('...by name', over[0].visitorName, 'Very Slow');

    await markOverstayNotified(over.map(o => String(o._id)));
    eq('...and is not reported a second time', (await findOverstays(SID)).length, 0);

    const stillInside = await whoIsInside(SID);
    ok('the console shows how far overdue they are', (stillInside[0]?.overdueMinutes ?? 0) > 0,
      String(stillInside[0]?.overdueMinutes));

    // ============================================================ cross-society
    console.log('\nOne society cannot see another\'s gate');
    const mine = await listEntries(SID, {});
    ok('every row belongs to this society', mine.rows.every(r => String(r.societyId) === SID));
    const theirs = await listEntries(OTHER, {});
    ok('...and the other society sees only its own', theirs.rows.every(r => String(r.societyId) === OTHER));
    eq('...which is exactly one entry', theirs.rows.length, 1);

    // ================================================================= purge
    console.log('\nOld entries are deleted, not merely hidden');
    await updateOpsPolicy(SID, { privacy: { retentionDays: 30 } } as any, actor);
    const ancient = await recordEntry(SID, { category: 'GUEST', visitorName: 'Long Ago' }, actor);
    // Straight to the driver. Mongoose marks `createdAt` immutable, so a normal
    // `$set` on it is silently dropped — and a silently-dropped setup step makes
    // a retention test pass for the wrong reason.
    await VisitorEntry.collection.updateOne(
      { _id: ancient._id },
      { $set: { createdAt: new Date(Date.now() - 100 * 86_400_000) } },
    );

    const purged = await purgeOldEntries(SID);
    eq('the ancient entry is purged', purged, 1);
    ok('...and is genuinely gone', !(await VisitorEntry.findById(ancient._id).lean()));
    ok('...while recent ones survive', (await VisitorEntry.countDocuments({ societyId })) > 0);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
