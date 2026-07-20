/**
 * Phase 8 — asking the flat before letting somebody in.
 * Real database, THROWAWAY societyIds, self-cleaning. Never touches existing data.
 *
 * The assertion this whole phase exists for:
 *
 *   **A visitor to a RENTED flat is never mentioned to the owner.** Not asked,
 *   not notified, not listed. The owner does not live there, and a log of who
 *   visits their tenant is surveillance of somebody's private life. This is a
 *   documented failure in ADDA's own FAQ, and it is the first thing checked
 *   below.
 *
 * And four more that carry real weight:
 *
 *   - a flat with no reachable resident falls through to the guard IMMEDIATELY
 *     rather than making a visitor wait for a queue nobody is watching;
 *   - a resident preference can only ever ask for LESS interruption, never
 *     more authority;
 *   - the first answer wins, and the second person is told what happened
 *     instead of silently overwriting it;
 *   - an override without a reason is refused, and the flat is told anyway.
 *
 *   npx tsx src/scripts/verify-gate-approval.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { ApprovalRequest } from '../models/approval-request.model';
import { ResidentGatePreference } from '../models/resident-gate-preference.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Notification } from '../models/notification.model';
import { Resident } from '../models/resident.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import {
  effectivePolicy, whoToAsk, requestApproval, decide, override,
  sweepExpired, pending, myRequests, overrideReport, isExpected, ApprovalError,
} from '../services/gate-approval.service';
import { getOrCreateOpsPolicy, updateOpsPolicy } from '../services/ops-policy.service';
import { listForUser } from '../services/notification.service';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const landlordId = new mongoose.Types.ObjectId();   // owns the rented flat, lives elsewhere
const tenantId = new mongoose.Types.ObjectId();
const tenantSpouseId = new mongoose.Types.ObjectId();
const ownerOccupierId = new mongoose.Types.ObjectId();

const guard = { userId: adminId.toString(), userName: 'Guard Ramesh' };
const tenant = { userId: tenantId.toString(), userName: 'Tenant Iyer' };
const spouse = { userId: tenantSpouseId.toString(), userName: 'Mrs Iyer' };
const landlord = { userId: landlordId.toString(), userName: 'Landlord Shah' };
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
    ApprovalRequest.deleteMany({ societyId }), ResidentGatePreference.deleteMany({ societyId }),
    SocietyOpsPolicy.deleteMany({ societyId }), Notification.deleteMany({ societyId }),
    Resident.deleteMany({ societyId }), Block.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Committee.deleteMany({ societyId }),
    CommitteeMember.deleteMany({ societyId }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const mk = (number: string, status: FlatStatus) =>
      Flat.create({ ...audit, blockId: wing._id, blockName: 'A Wing', number, status });

    const rented = await mk('101', FlatStatus.RENTED);
    const owned = await mk('102', FlatStatus.OWNER_OCCUPIED);
    const vacant = await mk('103', FlatStatus.VACANT);
    const rentedNoTenant = await mk('104', FlatStatus.RENTED);
    const dataOnly = await mk('105', FlatStatus.OWNER_OCCUPIED);

    await Resident.create([
      // The landlord is on the register for 101 — as the OWNER household — and
      // must still never be asked. Being recorded is not the same as living there.
      { ...audit, flatId: rented._id, userId: landlordId, person: { name: 'Landlord Shah' }, relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isHead: true, isActive: true },
      { ...audit, flatId: rented._id, userId: tenantId, person: { name: 'Tenant Iyer' }, relationship: 'TENANT', householdType: 'TENANT', isHead: true, isActive: true },
      { ...audit, flatId: rented._id, userId: tenantSpouseId, person: { name: 'Mrs Iyer' }, relationship: 'SPOUSE', householdType: 'TENANT', isActive: true },
      { ...audit, flatId: owned._id, userId: ownerOccupierId, person: { name: 'Owner Rao' }, relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isHead: true, isActive: true },
      // 104 is marked rented but the tenant was never onboarded.
      { ...audit, flatId: rentedNoTenant._id, userId: landlordId, person: { name: 'Landlord Shah' }, relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true },
      // 105's resident exists on paper only — no userId, so nobody to ask.
      { ...audit, flatId: dataOnly._id, person: { name: 'Uncle Menon' }, relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true },
    ]);

    const term = await Committee.create({ ...audit, name: 'MC 2026', termStartDate: new Date('2026-01-01'), status: 'ACTIVE' });
    await CommitteeMember.create({
      ...audit, committeeId: term._id, userId: adminId, startDate: new Date('2026-01-01'),
      designationKey: 'CHAIRMAN', designationLabel: 'Chairman', status: 'ACTIVE',
      memberSnapshot: { name: 'Guard Ramesh' },
    });

    // L3 turns approval on for guests.
    await getOrCreateOpsPolicy(SID, guard.userId, guard.userName);
    // `preset`, not `gate.level` — the level is an OUTPUT of applying a preset,
    // and setting it directly would relabel the policy without changing a
    // single switch behind it.
    await updateOpsPolicy(SID, { preset: 'L3' }, guard);

    // ======================================================== who gets asked
    console.log('THE privacy boundary — who is asked');
    const forRented = await whoToAsk(SID, String(rented._id));
    ok('a tenant is asked about their own visitor', forRented.userIds.includes(String(tenantId)));
    ok('...and so is their spouse', forRented.userIds.includes(String(tenantSpouseId)));
    ok('...and the LANDLORD IS NOT', !forRented.userIds.includes(String(landlordId)));
    eq('...which is recorded as the reason', forRented.via, 'RENTED_TENANT_ONLY');

    const forOwned = await whoToAsk(SID, String(owned._id));
    ok('an owner-occupier is asked about theirs', forOwned.userIds.includes(String(ownerOccupierId)));
    eq('...for the stated reason', forOwned.via, 'OWNER_OCCUPIED');

    const forVacant = await whoToAsk(SID, String(vacant._id));
    eq('an empty flat falls to the committee', forVacant.via, 'VACANT_COMMITTEE');
    ok('...and that means the serving committee', forVacant.userIds.includes(String(adminId)));

    const forOrphan = await whoToAsk(SID, String(rentedNoTenant._id));
    eq('a rented flat with no tenant on file asks NOBODY', forOrphan.userIds.length, 0);
    ok('...and specifically does not fall back to the owner',
      !forOrphan.userIds.includes(String(landlordId)));
    eq('...with the gap visible in the record', forOrphan.via, 'RENTED_NO_TENANT_REACHABLE');

    const forDataOnly = await whoToAsk(SID, String(dataOnly._id));
    eq('a resident with no login cannot be asked', forDataOnly.userIds.length, 0);

    // ================================================================ asking
    console.log('\nAsking, and the verdict the guard acts on');
    const asked = await requestApproval(SID, {
      flatId: String(rented._id), visitorName: 'Courier Anil', category: 'GUEST',
    }, guard);
    eq('a guest at a rented flat is asked about', asked.verdict, 'ASK');
    ok('...and a request exists', !!asked.request);
    ok('...naming exactly who was asked',
      asked.request!.askedUserIds.length === 2
      && !asked.request!.askedUserIds.map(String).includes(String(landlordId)));

    await settle();
    const landlordInbox = await listForUser(SID, String(landlordId));
    eq('THE OWNER OF A RENTED FLAT IS TOLD NOTHING', landlordInbox.items.length, 0);
    const tenantInbox = await listForUser(SID, String(tenantId));
    ok('...while the tenant is asked', tenantInbox.items.some(i => i.kind === 'GATE_APPROVAL'));
    ok('...loudly, because somebody is standing at the gate',
      tenantInbox.items.find(i => i.kind === 'GATE_APPROVAL')?.priority === 'HIGH');

    const orphanAsk = await requestApproval(SID, {
      flatId: String(rentedNoTenant._id), visitorName: 'Somebody', category: 'GUEST',
    }, guard);
    eq('nobody reachable means the guard decides NOW', orphanAsk.verdict, 'LET_IN');
    eq('...without creating a request nobody can answer', orphanAsk.request, null);
    ok('...and says why', orphanAsk.reason.includes('No tenant on file'));

    const householdStaff = await requestApproval(SID, {
      flatId: String(owned._id), visitorName: 'Maid Lakshmi', category: 'HOUSEHOLD_STAFF',
    }, guard);
    eq('household staff are not asked about every morning', householdStaff.verdict, 'LET_IN');

    // =========================================================== preferences
    console.log('\nA resident can ask for less, never for more');
    await ResidentGatePreference.create({
      societyId, flatId: owned._id, userId: ownerOccupierId,
      categoryMode: { GUEST: 'LEAVE_AT_GATE' },
      createdBy: ownerOccupierId, updatedBy: ownerOccupierId,
    });
    const relaxed = await effectivePolicy(SID, 'GUEST', { flatId: String(owned._id) });
    eq('a flat can say "leave it at the gate"', relaxed.effectiveMode, 'LEAVE_AT_GATE');
    ok('...and the guard is told why', !!relaxed.because);

    const leaveIt = await requestApproval(SID, {
      flatId: String(owned._id), visitorName: 'Delivery Ravi', category: 'GUEST',
    }, guard);
    eq('...and the console acts on it', leaveIt.verdict, 'LEAVE_AT_GATE');

    // The society says HOUSEHOLD_STAFF needs no approval. A resident asking to
    // be ASKED cannot manufacture an approval requirement the society declined.
    await ResidentGatePreference.findOneAndUpdate(
      { societyId, flatId: owned._id, userId: ownerOccupierId },
      { $set: { categoryMode: { GUEST: 'LEAVE_AT_GATE', HOUSEHOLD_STAFF: 'ASK' } } },
    );
    const cannotEscalate = await effectivePolicy(SID, 'HOUSEHOLD_STAFF', { flatId: String(owned._id) });
    eq('a preference cannot create authority the society withheld', cannotEscalate.effectiveMode, 'NONE');

    // Quiet hours: 22:00 to 07:00, asked at 2am.
    await ResidentGatePreference.findOneAndUpdate(
      { societyId, flatId: rented._id, userId: tenantId },
      {
        $set: { quietHours: { fromMinute: 22 * 60, toMinute: 7 * 60 } },
        $setOnInsert: { createdBy: tenantId, updatedBy: tenantId },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    const night = new Date(); night.setHours(2, 0, 0, 0);
    const asleep = await effectivePolicy(SID, 'GUEST', { flatId: String(rented._id), at: night });
    eq('nobody is woken at 2am to answer the gate', asleep.effectiveMode, 'NOTIFY_ONLY');
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    const awake = await effectivePolicy(SID, 'GUEST', { flatId: String(rented._id), at: noon });
    eq('...but at noon they are asked as normal', awake.effectiveMode, 'REQUIRED');

    // Expected visitors.
    await ResidentGatePreference.findOneAndUpdate(
      { societyId, flatId: rented._id, userId: tenantId },
      { $set: { expectedVisitors: [{ name: 'Physio Sunil', phone: '9876543210', addedAt: new Date() }] } },
    );
    ok('an expected visitor is recognised by phone',
      await isExpected(SID, String(rented._id), 'Sunil S', '+91 98765 43210'));
    ok('...and a stranger is not',
      !(await isExpected(SID, String(rented._id), 'Stranger', '9000000000')));

    // Clear the quiet hours before going on. Everything below asks for a real
    // approval, and leaving 22:00–07:00 in place would make the rest of this
    // script pass or fail depending on what time it was run — which is exactly
    // the kind of test that is trusted right up until the night it lies.
    await ResidentGatePreference.updateMany(
      { societyId, flatId: rented._id },
      { $unset: { quietHours: '' } },
    );

    // ============================================================= deciding
    console.log('\nDeciding — first answer wins');
    const req2 = (await requestApproval(SID, {
      flatId: String(rented._id), visitorName: 'Guest Priya', category: 'GUEST',
    }, guard)).request!;

    let notAsked = '';
    try { await decide(SID, String(req2._id), true, landlord); }
    catch (e: any) { notAsked = e.message; }
    ok('somebody who was not asked cannot answer', notAsked.includes('not asked'), notAsked);

    const decided = await decide(SID, String(req2._id), true, tenant);
    eq('the tenant can allow their own visitor', decided.outcome, 'APPROVED');
    eq('...recorded against them by name', decided.decidedByName, tenant.userName);

    let second = '';
    try { await decide(SID, String(req2._id), false, spouse); }
    catch (e: any) { second = e.message; }
    ok('a second answer does not overwrite the first', second.includes('already'), second);
    ok('...and says who decided', second.includes(tenant.userName), second);

    const stillApproved = await ApprovalRequest.findById(req2._id).lean();
    eq('...leaving the original decision intact', stillApproved?.outcome, 'APPROVED');

    // ============================================================= overrides
    console.log('\nThe guard overrides — loudly, or not at all');
    const req3 = (await requestApproval(SID, {
      flatId: String(rented._id), visitorName: 'Plumber Vikas', category: 'GUEST',
    }, guard)).request!;

    let noReason = '';
    try { await override(SID, String(req3._id), true, '   ', guard); }
    catch (e: any) { noReason = e.message; }
    ok('an override without a reason is refused', noReason.includes('why'), noReason);

    const forced = await override(SID, String(req3._id), true, 'Resident phoned the gate directly', guard);
    eq('...and with one, it is allowed', forced.outcome, 'GUARD_OVERRIDE');
    eq('...with the reason kept', forced.reason, 'Resident phoned the gate directly');

    await settle();
    const toldAfter = await listForUser(SID, String(tenantId));
    ok('the flat is TOLD it was overridden',
      toldAfter.items.some(i => i.kind === 'GATE_OVERRIDE'));
    ok('...including the reason given',
      toldAfter.items.some(i => i.body.includes('phoned the gate')));
    // Still the tenant only. An override must not widen the audience either.
    const landlordAfter = await listForUser(SID, String(landlordId));
    eq('...and the owner still hears nothing', landlordAfter.items.length, 0);

    // =============================================================== timeout
    console.log('\nNobody answers');
    const req4 = (await requestApproval(SID, {
      flatId: String(rented._id), visitorName: 'Late Caller', category: 'GUEST',
    }, guard)).request!;
    eq('it starts out waiting', req4.outcome, 'PENDING');

    // expiresAt is set from policy; drag it into the past rather than sleeping.
    await ApprovalRequest.collection.updateOne(
      { _id: req4._id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } },
    );
    const swept = await sweepExpired();
    ok('the sweep resolves it', swept.resolved >= 1);
    const timedOut = await ApprovalRequest.findById(req4._id).lean();
    eq('...as timed out', timedOut?.outcome, 'TIMED_OUT');
    eq('...decided by the system, not a person', timedOut?.decidedBy, 'SYSTEM');

    const sweptAgain = await sweepExpired();
    eq('sweeping twice does not touch it again', sweptAgain.resolved, 0);

    let tooLate = '';
    try { await decide(SID, String(req4._id), true, tenant); }
    catch (e: any) { tooLate = e.message; }
    ok('a resident answering after the timeout is told what happened', tooLate.includes('already'), tooLate);

    // ================================================================ lists
    console.log('\nLists, and whose they are');
    const queue = await pending(SID);
    ok('the guard sees only what is still waiting', queue.every(r => r.outcome === 'PENDING'));

    const tenantQueue = await myRequests(SID, String(tenantId), true);
    ok('a resident sees what they were asked', tenantQueue.length > 0);
    const landlordQueue = await myRequests(SID, String(landlordId), true);
    eq('...and the owner of a rented flat sees nothing', landlordQueue.length, 0);

    // =============================================================== report
    console.log('\nOverrides are counted, not merely allowed');
    const report = await overrideReport(SID, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    eq('the override is counted', report.total, 1);
    ok('...against the total decided, so the rate means something', report.outOf >= 3);
    ok('...and attributed to the guard', report.byGuard.some(g => g.name === guard.userName));
    ok('...as a percentage', report.rate > 0 && report.rate <= 100);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
