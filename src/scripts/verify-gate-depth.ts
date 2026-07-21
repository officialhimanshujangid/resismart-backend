/**
 * Phase 11 — vehicles, the blocklist, and the report that ties it together.
 * Real database, THROWAWAY societyIds, self-cleaning. Never touches existing data.
 *
 * The assertion this phase exists for:
 *
 *   **Nothing can be blocked on a name, and nothing can be blocked on an
 *   identifier that has never actually been seen at this gate.** MyGate
 *   abandoned blocklists because guard-typed data is unreliable; the answer is
 *   not better guards, it is refusing to build the list on guesses. A phone
 *   number typed into the block form and never recorded at the gate is
 *   rejected, and the enum has no NAME option at all.
 *
 * Plus: a plate is one car however it is punctuated, a resident's vehicle is
 * recognised at the gate, and an entry that matched the list carries that fact
 * on the record rather than only in a banner nobody can produce later.
 *
 *   npx tsx src/scripts/verify-gate-depth.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { ResidentVehicle } from '../models/resident-vehicle.model';
import { GateBlocklist } from '../models/gate-blocklist.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Complaint } from '../models/complaint.model';
import { ComplaintCategory } from '../models/complaint-category.model';
import { ComplaintEvent } from '../models/complaint-event.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { Notification } from '../models/notification.model';
import {
  addVehicle, removeVehicle, listVehicles, suggestVehicles, whoseVehicle,
  block, unblock, listBlocked, checkBlocked, opsReport,
  normalisePlate, normalisePhone, DepthError,
} from '../services/gate-depth.service';
import { recordEntry } from '../services/visitor.service';
import { getOrCreateOpsPolicy, updateOpsPolicy } from '../services/ops-policy.service';
import { raise, respond, markWorkDone, resolve } from '../services/complaint.service';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const chairId = new mongoose.Types.ObjectId();
const member2Id = new mongoose.Types.ObjectId();
const residentId = new mongoose.Types.ObjectId();

const guard = { userId: adminId.toString(), userName: 'Guard Ramesh' };
const chair = { userId: chairId.toString(), userName: 'Chairman Rao' };
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const audit = { societyId, createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup' };

async function cleanup() {
  await Promise.all([
    ResidentVehicle.deleteMany({ societyId }), GateBlocklist.deleteMany({ societyId }),
    VisitorEntry.deleteMany({ societyId }), SocietyOpsPolicy.deleteMany({ societyId }),
    Complaint.deleteMany({ societyId }), ComplaintCategory.deleteMany({ societyId }),
    ComplaintEvent.deleteMany({ societyId }), Committee.deleteMany({ societyId }),
    CommitteeMember.deleteMany({ societyId }), Block.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Resident.deleteMany({ societyId }),
    Notification.deleteMany({ societyId }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const flat = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing', number: '101',
      status: FlatStatus.OWNER_OCCUPIED,
    });
    const other = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing', number: '102',
      status: FlatStatus.OWNER_OCCUPIED,
    });
    await Resident.create({
      ...audit, flatId: flat._id, userId: residentId, person: { name: 'Asha Rao' },
      relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true,
    });

    const term = await Committee.create({ ...audit, name: 'MC 2026', termStartDate: new Date('2026-01-01'), status: 'ACTIVE' });
    for (const [uid, key, name] of [[chairId, 'CHAIRMAN', 'Chairman Rao'], [member2Id, 'TREASURER', 'Member Two']] as const) {
      await CommitteeMember.create({
        ...audit, committeeId: term._id, userId: uid, startDate: new Date('2026-01-01'),
        designationKey: key, designationLabel: key, status: 'ACTIVE', memberSnapshot: { name },
      });
    }

    await getOrCreateOpsPolicy(SID, guard.userId, guard.userName);
    // L5 so vehicles are actually tracked at the gate.
    await updateOpsPolicy(SID, { preset: 'L5' }, guard);

    // ========================================================= normalisation
    console.log('One car, however it is written');
    eq('spaces are ignored', normalisePlate('MH 12 AB 1234'), 'MH12AB1234');
    eq('hyphens are ignored', normalisePlate('mh-12-ab-1234'), 'MH12AB1234');
    eq('case is ignored', normalisePlate('mh12ab1234'), 'MH12AB1234');
    eq('a phone matches on its last ten digits', normalisePhone('+91 98765 43210'), '9876543210');
    eq('...however it was typed', normalisePhone('098765-43210'), '9876543210');

    // =============================================================== vehicles
    console.log('\nResident vehicles');
    const car = await addVehicle(SID, {
      flatId: String(flat._id), number: 'MH 12 AB 1234', kind: 'CAR', make: 'Maruti', colour: 'White',
    }, guard);
    eq('a vehicle is stored normalised', car.number, 'MH12AB1234');
    eq('...and as the resident typed it, for display', car.displayNumber, 'MH 12 AB 1234');
    eq('...attached to the flat', car.flatLabel, 'A Wing 101');

    let dupe = '';
    try { await addVehicle(SID, { flatId: String(other._id), number: 'mh-12-ab-1234' }, guard); }
    catch (e: any) { dupe = e.message; }
    ok('the same car cannot be on two flats at once', dupe.includes('already registered'), dupe);

    let sameFlat = '';
    try { await addVehicle(SID, { flatId: String(flat._id), number: 'MH12AB1234' }, guard); }
    catch (e: any) { sameFlat = e.message; }
    ok('...nor twice on one flat', sameFlat.includes('already on this flat'), sameFlat);

    let nonsense = '';
    try { await addVehicle(SID, { flatId: String(flat._id), number: 'X!' }, guard); }
    catch (e: any) { nonsense = e.message; }
    ok('nonsense is refused', nonsense.includes('registration number'), nonsense);

    const found = await whoseVehicle(SID, 'mh 12 ab 1234');
    eq('a plate typed any way finds its flat', found?.flatLabel, 'A Wing 101');
    eq('a stranger\'s car belongs to nobody', await whoseVehicle(SID, 'KA01XX9999'), null);

    const hints = await suggestVehicles(SID, 'MH12');
    ok('the guard gets suggestions as they type', hints.length === 1);
    eq('two characters is the floor', (await suggestVehicles(SID, 'M')).length, 0);
    // A stray bracket from a fat-fingered gate keyboard is stripped rather
    // than reaching the regex engine — so it neither throws nor stops the
    // guard finding the car they are looking at.
    eq('punctuation typed by mistake still finds the car', (await suggestVehicles(SID, 'MH(1')).length, 1);

    await addVehicle(SID, { flatId: String(other._id), number: 'MH12CD5678', kind: 'BIKE' }, guard);
    eq('both are listed', (await listVehicles(SID)).length, 2);
    eq('...and one flat sees only its own', (await listVehicles(SID, String(flat._id))).length, 1);

    // Deactivated, not deleted — the register still refers to it.
    ok('a vehicle can be taken off', await removeVehicle(SID, String(car._id), guard));
    eq('...and disappears from the list', (await listVehicles(SID)).length, 1);
    ok('...but the row survives as history',
      !!(await ResidentVehicle.findById(car._id).lean()));
    // Which means the plate is free again for whoever bought the car.
    const resold = await addVehicle(SID, { flatId: String(other._id), number: 'MH12AB1234' }, guard);
    eq('a sold car can be registered by its new owner', String(resold.flatId), String(other._id));

    // ============================================================== blocklist
    console.log('\nThe blocklist — built only on things actually seen');
    // Somebody who has genuinely been here.
    const seen = await recordEntry(SID, {
      category: 'DELIVERY', visitorName: 'Rude Courier',
      visitorPhone: '9000011111', vehicleNumber: 'MH14ZZ0001',
    }, guard);
    ok('an entry was recorded', !!seen._id);
    ok('...and was not flagged, since the list is empty', !seen.flaggedReason);

    let neverSeen = '';
    try {
      await block(SID, {
        basis: 'PHONE', value: '9999900000', reason: 'Somebody told us about him',
        approverUserIds: [String(member2Id)],
      }, chair);
    } catch (e: any) { neverSeen = e.message; }
    ok('A NUMBER NEVER SEEN HERE CANNOT BE BLOCKED', neverSeen.includes('never been recorded'), neverSeen);

    let alone = '';
    try {
      await block(SID, {
        basis: 'PHONE', value: '9000011111', reason: 'Was rude to a resident',
        approverUserIds: [],
      }, chair);
    } catch (e: any) { alone = e.message; }
    ok('one committee member cannot block somebody alone',
      alone.includes('two serving committee'), alone);

    let noWhy = '';
    try {
      await block(SID, {
        basis: 'PHONE', value: '9000011111', reason: '  ',
        approverUserIds: [String(member2Id)],
      }, chair);
    } catch (e: any) { noWhy = e.message; }
    ok('blocking without a reason is refused', noWhy.includes('why'), noWhy);

    const blocked = await block(SID, {
      basis: 'PHONE', value: '+91 90000 11111', label: 'Rude Courier',
      reason: 'Abusive to a resident at the gate on the 3rd',
      approverUserIds: [String(member2Id)],
    }, chair);
    eq('a number that HAS been seen here can be blocked', blocked.value, '9000011111');
    eq('...naming who agreed', blocked.approvedByNames.length, 2);
    ok('...with the name kept only as a label', blocked.label === 'Rude Courier');

    let twice = '';
    try {
      await block(SID, {
        basis: 'PHONE', value: '9000011111', reason: 'again',
        approverUserIds: [String(member2Id)],
      }, chair);
    } catch (e: any) { twice = e.message; }
    ok('the same number cannot be listed twice', twice.includes('already on the list'), twice);

    // ============================================================== matching
    console.log('\nWhat the gate does with it');
    const hit = await checkBlocked(SID, { phone: '090000-11111' });
    ok('a blocked number is recognised however it is typed', hit.blocked);
    eq('...saying what it matched on', hit.matchedOn, 'PHONE');
    ok('...and why', hit.reason?.includes('Abusive'));

    const miss = await checkBlocked(SID, { phone: '9111122222' });
    ok('somebody else is not', !miss.blocked);
    // The whole design: names are never matched, so the wrong Ramesh is safe.
    const byName = await checkBlocked(SID, {});
    ok('with no phone and no plate there is nothing to match on', !byName.blocked);

    const flaggedEntry = await recordEntry(SID, {
      category: 'DELIVERY', visitorName: 'Rude Courier', visitorPhone: '9000011111',
    }, guard);
    ok('THE GUARD IS NOT BLOCKED FROM RECORDING THE ENTRY', !!flaggedEntry._id);
    ok('...but the entry carries the warning permanently',
      flaggedEntry.flaggedReason?.includes('Abusive'));
    eq('...saying what matched', flaggedEntry.flaggedReason?.includes('phone'), true);

    // Vehicles too.
    const vehicleBlock = await block(SID, {
      basis: 'VEHICLE', value: 'mh-14-zz-0001', reason: 'Parked across the ramp repeatedly',
      approverUserIds: [String(member2Id)],
    }, chair);
    eq('a plate seen at the gate can be blocked', vehicleBlock.value, 'MH14ZZ0001');
    const byPlate = await checkBlocked(SID, { vehicleNumber: 'MH 14 ZZ 0001' });
    ok('...and is recognised however it is punctuated', byPlate.blocked);

    eq('both are on the list', (await listBlocked(SID)).length, 2);
    ok('a listing can be lifted', await unblock(SID, String(blocked._id), 'Apologised', chair));
    eq('...leaving one active', (await listBlocked(SID)).length, 1);
    eq('...while the history is kept', (await listBlocked(SID, true)).length, 2);
    ok('a lifted number stops matching', !(await checkBlocked(SID, { phone: '9000011111' })).blocked);

    // ================================================================ report
    console.log('\nThe report');
    const c1 = await raise(SID, { title: 'Lift stuck', category: 'Lift', flatId: String(flat._id) }, guard);
    await respond(SID, String(c1._id), "Technician on the way", guard, { canManage: true });
    await markWorkDone(SID, String(c1._id), "Fixed", [], guard, { canManage: true });
    await resolve(SID, String(c1._id), guard, { canManage: true });
    await raise(SID, { title: 'Tap leaking', category: 'Plumbing', flatId: String(flat._id) }, guard);

    const report = await opsReport(SID, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    eq('every entry is counted', report.gate.entries, 2);
    ok('...broken down by kind', report.gate.byCategory.some(c => c.category === 'DELIVERY'));
    eq('complaints are counted', report.complaints.raised, 2);
    eq('...with the resolved ones separated', report.complaints.resolved, 1);
    eq('...and the ones still open', report.complaints.stillOpen, 1);
    ok('first response is measured', report.complaints.avgFirstResponseMinutes !== null);
    ok('...separately from resolution', report.complaints.avgResolutionMinutes !== null);
    ok('per-category figures are there', report.complaints.byCategory.length >= 2);
    ok('...and the SLA is measured against the promise made, with its denominator',
      report.complaints.slaMeasuredOn !== undefined);

    // The honesty figure: how much of "who is inside" is a guess.
    ok('exit accuracy is reported, or honestly null when nothing has exited',
      report.gate.exitAccuracy === null || typeof report.gate.exitAccuracy === 'number');

    const empty = await opsReport(SID, new Date('2020-01-01'), new Date('2020-01-02'));
    eq('a period with nothing in it reports zero rather than breaking', empty.complaints.raised, 0);
    eq('...and says so honestly rather than claiming 100%', empty.complaints.slaMet, null);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
