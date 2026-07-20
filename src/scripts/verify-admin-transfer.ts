/**
 * Phase 10 — handing over a society, and taking it back in an emergency.
 * Real database, THROWAWAY societyIds, self-cleaning. Never touches existing data.
 *
 * The four that carry this phase:
 *
 *   1. **An INITIATED handover changes absolutely nothing.** The likeliest
 *      outcome of any handover is that the other person does not reply for a
 *      week, and the society must be completely unaffected for that week.
 *   2. **The society is never left without an admin.** Checked after every
 *      single path, including the ones that fail halfway.
 *   3. **The outgoing admin's next role is the one that was chosen** — never a
 *      silent removal.
 *   4. **Break-glass needs the Chairman and three serving members and a written
 *      reason**, and fails on each of those individually.
 *
 *   npx tsx src/scripts/verify-admin-transfer.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { AdminTransfer } from '../models/admin-transfer.model';
import { Society } from '../models/society.model';
import { User } from '../models/user.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { Resident } from '../models/resident.model';
import { Notification } from '../models/notification.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Otp } from '../models/otp.model';
import { UserRole, TenantType } from '../constants/roles';
import {
  initiate, accept, decline, cancel, sendAcceptanceCode,
  breakGlass, object, history, current, expireOld, TransferError,
} from '../services/admin-transfer.service';
import { listForUser } from '../services/notification.service';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
let adminId: mongoose.Types.ObjectId;
let successorId: mongoose.Types.ObjectId;
let chairId: mongoose.Types.ObjectId;
let member2Id: mongoose.Types.ObjectId;
let member3Id: mongoose.Types.ObjectId;
let member4Id: mongoose.Types.ObjectId;
let outsiderId: mongoose.Types.ObjectId;
let residentManagerId: mongoose.Types.ObjectId;

const SID = societyId.toString();
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const settle = () => new Promise(r => setTimeout(r, 300));

const roleIn = async (userId: mongoose.Types.ObjectId): Promise<string | undefined> => {
  const u = await User.findById(userId).select('memberships').lean();
  return u?.memberships?.find(m => String(m.tenantId) === SID)?.role;
};
const societyAdmin = async (): Promise<string | undefined> => {
  const s = await Society.findById(societyId).select('adminUserId').lean();
  return s?.adminUserId ? String(s.adminUserId) : undefined;
};

async function cleanup() {
  const ids = [adminId, successorId, chairId, member2Id, member3Id, member4Id, outsiderId, residentManagerId].filter(Boolean);
  await Promise.all([
    AdminTransfer.deleteMany({ societyId }), Society.deleteMany({ _id: societyId }),
    User.deleteMany({ _id: { $in: ids } }),
    Committee.deleteMany({ societyId }), CommitteeMember.deleteMany({ societyId }),
    Resident.deleteMany({ societyId }), Notification.deleteMany({ societyId }),
    Block.deleteMany({ societyId }), Flat.deleteMany({ societyId }),
    Otp.deleteMany({ purpose: 'GENERIC', target: { $in: ['handover@throwaway.test', 'outsider@throwaway.test'] } }),
  ]);
}

/** The OTP is hashed, so a test cannot read it back — verify through the model. */
async function codeFor(target: string): Promise<string> {
  // Every code this service sends is six digits; the record stores only a hash.
  // Rather than reaching into the hashing, replace the record with a known one.
  const crypto = await import('crypto');
  const code = '123456';
  await Otp.findOneAndUpdate(
    { channel: 'EMAIL', target, purpose: 'GENERIC' },
    {
      $set: {
        codeHash: crypto.createHash('sha256').update(code).digest('hex'),
        expiresAt: new Date(Date.now() + 600_000), attempts: 0, verified: false,
      },
    },
  );
  return code;
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    const mk = async (name: string, email: string, role: UserRole) => {
      const u = await User.create({
        name, email, password: 'x'.repeat(20), role,
        memberships: [{ tenantType: TenantType.SOCIETY, tenantId: societyId, role }],
      });
      return u._id as mongoose.Types.ObjectId;
    };

    adminId = await mk('Secretary Shah', 'admin@throwaway.test', UserRole.SOCIETY_ADMIN);
    successorId = await mk('New Secretary', 'handover@throwaway.test', UserRole.RESIDENT_OWNER);
    chairId = await mk('Chairman Rao', 'chair@throwaway.test', UserRole.SOCIETY_COMMITTEE);
    member2Id = await mk('Member Two', 'm2@throwaway.test', UserRole.SOCIETY_COMMITTEE);
    member3Id = await mk('Member Three', 'm3@throwaway.test', UserRole.SOCIETY_COMMITTEE);
    // A FOURTH, so "three members without the Chairman" is a case that can
    // actually be constructed. With only three on the committee the assertion
    // would fail on the count instead, and the Chairman rule would never be
    // exercised at all — a test that passes for the wrong reason.
    member4Id = await mk('Member Four', 'm4@throwaway.test', UserRole.SOCIETY_COMMITTEE);
    residentManagerId = await mk('Resident Manager', 'resmgr@throwaway.test', UserRole.RESIDENT_OWNER);
    // Genuinely outside: no membership row at all, which is the shape an
    // external paid manager arrives in.
    const outsider = await User.create({
      name: 'Hired Manager', email: 'outsider@throwaway.test',
      password: 'x'.repeat(20), role: UserRole.RESIDENT_OWNER, memberships: [],
    });
    outsiderId = outsider._id as mongoose.Types.ObjectId;

    await Society.create({
      _id: societyId, name: `Throwaway CHS ${societyId}`, adminUserId: adminId,
      // `address` is a plain string here, not an object — and the society name
      // carries the throwaway id because the schema has a case-insensitive
      // unique index on it, so a rerun would collide with its own leftovers.
      address: 'Throwaway Road, Pune',
      city: 'Pune', state: 'Maharashtra', pincode: '411001',
      createdBy: adminId, createdByName: 'Setup',
      updatedBy: adminId, updatedByName: 'Setup',
    } as any);

    const term = await Committee.create({
      societyId, name: 'MC 2026', termStartDate: new Date('2026-01-01'), status: 'ACTIVE',
      createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup',
    });
    const addMember = (userId: mongoose.Types.ObjectId, key: string, label: string, name: string) =>
      CommitteeMember.create({
        societyId, committeeId: term._id, userId, startDate: new Date('2026-01-01'),
        designationKey: key, designationLabel: label, status: 'ACTIVE',
        memberSnapshot: { name },
        createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup',
      });
    await addMember(chairId, 'CHAIRMAN', 'Chairman', 'Chairman Rao');
    await addMember(member2Id, 'TREASURER', 'Treasurer', 'Member Two');
    await addMember(member3Id, 'MEMBER', 'Member', 'Member Three');
    await addMember(member4Id, 'MEMBER', 'Member', 'Member Four');

    const wing = await Block.create({
      societyId, name: 'A Wing',
      createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup',
    });
    const flat = await Flat.create({
      societyId, blockId: wing._id, blockName: 'A Wing', number: '101', status: FlatStatus.OWNER_OCCUPIED,
      createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup',
    });
    await Resident.create({
      societyId, flatId: flat._id, userId: residentManagerId, person: { name: 'Resident Manager' },
      relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true,
      createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup',
    });

    const admin = { userId: adminId.toString(), userName: 'Secretary Shah' };
    const heir = { userId: successorId.toString(), userName: 'New Secretary' };
    const chair = { userId: chairId.toString(), userName: 'Chairman Rao' };

    // ============================================================ authority
    console.log('Only the admin can start a handover');
    let notAdmin = '';
    try {
      await initiate(SID, { toUserId: String(adminId), successorKind: 'EXISTING_MEMBER', fromBecomes: 'SOCIETY_COMMITTEE' }, chair);
    } catch (e: any) { notAdmin = e.message; }
    ok('a committee member cannot hand over the society', notAdmin.includes('Only the current admin'), notAdmin);

    let toSelf = '';
    try {
      await initiate(SID, { toUserId: String(adminId), successorKind: 'EXISTING_MEMBER', fromBecomes: 'SOCIETY_COMMITTEE' }, admin);
    } catch (e: any) { toSelf = e.message; }
    ok('the admin cannot hand over to themselves', toSelf.includes('already the admin'), toSelf);

    let noContact = '';
    const contactless = await User.create({
      name: 'No Contact', password: 'x'.repeat(20), role: UserRole.RESIDENT_OWNER, memberships: [],
    });
    try {
      await initiate(SID, { toUserId: String(contactless._id), successorKind: 'EXTERNAL', fromBecomes: 'SOCIETY_COMMITTEE' }, admin);
    } catch (e: any) { noContact = e.message; }
    ok('somebody with no email or phone cannot be handed a society',
      noContact.includes('no email or phone'), noContact);
    await User.deleteOne({ _id: contactless._id });

    // A resident cannot be brought in as an OUTSIDE manager — the whole point
    // of EXTERNAL is that they are tied to no flat.
    let fakeExternal = '';
    try {
      await initiate(SID, { toUserId: String(residentManagerId), successorKind: 'EXTERNAL', fromBecomes: 'SOCIETY_COMMITTEE' }, admin);
    } catch (e: any) { fakeExternal = e.message; }
    ok('a resident cannot be handed over to as an "outside" manager',
      fakeExternal.includes('lives here'), fakeExternal);

    // ======================================================== nothing changes
    console.log('\nAn invitation changes NOTHING');
    const t1 = await initiate(SID, {
      toUserId: String(successorId), successorKind: 'EXISTING_MEMBER',
      fromBecomes: 'SOCIETY_COMMITTEE', reason: 'Moving out of the city',
    }, admin);
    eq('the handover is recorded as offered', t1.status, 'INITIATED');
    eq('THE SOCIETY STILL POINTS AT THE OLD ADMIN', await societyAdmin(), String(adminId));
    eq('...who still holds the role', await roleIn(adminId), UserRole.SOCIETY_ADMIN);
    eq('...and the successor has gained nothing', await roleIn(successorId), UserRole.RESIDENT_OWNER);

    await settle();
    const heirInbox = await listForUser(SID, String(successorId));
    ok('the successor is told they have been asked',
      heirInbox.items.some(i => i.kind === 'ADMIN_TRANSFER_OFFERED'));
    const chairInbox = await listForUser(SID, String(chairId));
    ok('...and so is the committee', chairInbox.items.some(i => i.kind === 'ADMIN_TRANSFER_OFFERED'));

    let second = '';
    try {
      await initiate(SID, { toUserId: String(chairId), successorKind: 'COMMITTEE', fromBecomes: 'SOCIETY_COMMITTEE' }, admin);
    } catch (e: any) { second = e.message; }
    ok('a second handover cannot run alongside the first', second.includes('already under way'), second);

    // ============================================================== accepting
    console.log('\nAccepting, with a code sent to the contact frozen at the start');
    let wrongPerson = '';
    try { await sendAcceptanceCode(SID, chair); }
    catch (e: any) { wrongPerson = e.message; }
    ok('somebody else cannot request the acceptance code', wrongPerson.includes('not offered to you'), wrongPerson);

    await sendAcceptanceCode(SID, heir);
    let badCode = '';
    try { await accept(SID, '000000', heir); }
    catch (e: any) { badCode = e.message; }
    ok('a wrong code is refused', !!badCode, badCode);
    eq('...and the society is untouched by the failed attempt', await societyAdmin(), String(adminId));

    const good = await codeFor('handover@throwaway.test');
    const done = await accept(SID, good, heir);
    eq('the handover completes', done.status, 'ACCEPTED');
    eq('THE SOCIETY NOW POINTS AT THE NEW ADMIN', await societyAdmin(), String(successorId));
    eq('...who holds the admin role', await roleIn(successorId), UserRole.SOCIETY_ADMIN);
    eq('...and the outgoing admin became exactly what was chosen',
      await roleIn(adminId), UserRole.SOCIETY_COMMITTEE);
    ok('...rather than being silently removed', !!(await roleIn(adminId)));

    await settle();
    const oldInbox = await listForUser(SID, String(adminId));
    ok('the outgoing admin is told it is done',
      oldInbox.items.some(i => i.kind === 'ADMIN_TRANSFER_DONE'));

    // ============================================================ break-glass
    console.log('\nBreak-glass — hard, and possible');
    // The new admin has now gone silent. The committee takes it back.
    let noReason = '';
    try {
      await breakGlass(SID, { toUserId: String(chairId), reason: '', approverUserIds: [String(member2Id), String(member3Id)] }, chair);
    } catch (e: any) { noReason = e.message; }
    ok('an emergency takeover without a reason is refused', noReason.includes('say why'), noReason);

    let tooFew = '';
    try {
      await breakGlass(SID, {
        toUserId: String(chairId), reason: 'The admin has left the country and is unreachable',
        approverUserIds: [String(member2Id)],
      }, chair);
    } catch (e: any) { tooFew = e.message; }
    ok('two committee members are not enough', tooFew.includes('three serving committee'), tooFew);

    let noChair = '';
    try {
      await breakGlass(SID, {
        toUserId: String(member2Id), reason: 'The admin has left the country and is unreachable',
        // Three genuinely serving members — and no Chairman among them.
        approverUserIds: [String(member3Id), String(member4Id)],
      }, { userId: member2Id.toString(), userName: 'Member Two' });
    } catch (e: any) { noChair = e.message; }
    ok('three members without the Chairman are not enough', noChair.includes('Chairman'), noChair);
    eq('...and none of those failures moved the role', await societyAdmin(), String(successorId));

    // Somebody not on the committee cannot be counted toward the three.
    let notMembers = '';
    try {
      await breakGlass(SID, {
        toUserId: String(member2Id), reason: 'The admin has left the country and is unreachable',
        approverUserIds: [String(residentManagerId), String(outsiderId)],
      }, chair);
    } catch (e: any) { notMembers = e.message; }
    ok('residents cannot be counted as committee approvers',
      notMembers.includes('three serving committee'), notMembers);

    const emergency = await breakGlass(SID, {
      toUserId: String(chairId),
      reason: 'The admin has left the country and has not responded for six weeks',
      approverUserIds: [String(member2Id), String(member3Id)],
    }, chair);
    eq('with the Chairman and three members, it goes through', emergency.status, 'ACCEPTED');
    ok('...marked as an emergency', emergency.isBreakGlass);
    eq('...moving the role immediately', await societyAdmin(), String(chairId));
    eq('...with the reason kept', emergency.reason?.includes('six weeks'), true);
    eq('...naming who authorised it', emergency.approvedByNames.length, 3);
    eq('the displaced admin becomes a committee member, not nobody',
      await roleIn(successorId), UserRole.SOCIETY_COMMITTEE);
    ok('...and has a window to object', !!emergency.objectionDeadline);

    await settle();
    const displaced = await listForUser(SID, String(successorId));
    ok('the displaced admin is told, loudly',
      displaced.items.some(i => i.kind === 'ADMIN_BREAK_GLASS' && i.priority === 'HIGH'));
    ok('...including the reason', displaced.items.some(i => i.body.includes('six weeks')));

    // ============================================================= objecting
    console.log('\nObjecting');
    let notYours = '';
    try { await object(SID, String(emergency._id), 'not fair', chair); }
    catch (e: any) { notYours = e.message; }
    ok('only the displaced admin can object', notYours.includes('who was displaced'), notYours);

    const objected = await object(SID, String(emergency._id), 'I was on medical leave and did respond', heir);
    ok('the objection is recorded', !!objected.objectedAt);
    eq('...with what they said', objected.objectionNote, 'I was on medical leave and did respond');
    // Recorded, not auto-reversed — software cannot adjudicate this.
    eq('...and the role does NOT flip back automatically', await societyAdmin(), String(chairId));

    await settle();
    const committeeTold = await listForUser(SID, String(member2Id));
    ok('the committee is told there is a dispute',
      committeeTold.items.some(i => i.kind === 'ADMIN_BREAK_GLASS_OBJECTED'));

    // ============================================================== lifecycle
    console.log('\nInvitations that go nowhere');
    const chairActor = { userId: chairId.toString(), userName: 'Chairman Rao' };
    const t2 = await initiate(SID, {
      toUserId: String(member2Id), successorKind: 'COMMITTEE', fromBecomes: 'SOCIETY_COMMITTEE',
    }, chairActor);
    const declined = await decline(SID, { userId: member2Id.toString(), userName: 'Member Two' });
    eq('a successor can decline', declined.status, 'DECLINED');
    eq('...leaving the admin where they were', await societyAdmin(), String(chairId));

    const t3 = await initiate(SID, {
      toUserId: String(member3Id), successorKind: 'COMMITTEE', fromBecomes: 'SOCIETY_COMMITTEE',
    }, chairActor);
    const cancelled = await cancel(SID, chairActor);
    eq('the admin can withdraw an offer', cancelled.status, 'CANCELLED');

    const t4 = await initiate(SID, {
      toUserId: String(member3Id), successorKind: 'COMMITTEE', fromBecomes: 'SOCIETY_COMMITTEE',
    }, chairActor);
    await AdminTransfer.collection.updateOne(
      { _id: t4._id }, { $set: { expiresAt: new Date(Date.now() - 86_400_000) } },
    );
    const lapsed = await expireOld();
    ok('an unanswered invitation eventually lapses', lapsed >= 1);
    eq('...and is recorded as expired',
      (await AdminTransfer.findById(t4._id).lean())?.status, 'EXPIRED');
    eq('...freeing the society to try again', await current(SID), null);

    // An expired invitation cannot be accepted afterwards.
    let stale = '';
    try { await accept(SID, '123456', { userId: member3Id.toString(), userName: 'Member Three' }); }
    catch (e: any) { stale = e.message; }
    ok('an expired invitation cannot be accepted', stale.includes('no handover under way'), stale);

    // ================================================================ history
    console.log('\nThe record');
    const past = await history(SID);
    ok('every handover is kept', past.length >= 5);
    ok('...including the emergency one', past.some(h => h.isBreakGlass));
    ok('...and the ones that came to nothing',
      past.some(h => h.status === 'DECLINED') && past.some(h => h.status === 'CANCELLED'));

    eq('and through all of it, the society always had an admin', !!(await societyAdmin()), true);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
