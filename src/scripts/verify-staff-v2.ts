/**
 * Phase 8 — Staff v2. The dead fields, and the routing that had no clock.
 *
 * Every assertion here FAILS against the code as it stood before this phase.
 * That is the bar: a test that passes either way proves nothing.
 *
 * What was actually broken, in the order it is checked below:
 *
 *   1. **KYC was declared and never written.** `documents[]`,
 *      `verification.documentKey` and `person.photoKey` existed on the model
 *      with NO create path, NO upload endpoint and NO download route. So a
 *      "police verified on 12/03/2024" was a bare date with nothing behind it —
 *      worse than an empty field, because it reads as an answer.
 *   2. **The expiry reminder never fired.** `findExpiringVerifications` had one
 *      caller: a passive banner somebody must already be looking at. The one
 *      thing this model claims over every competitor did nothing.
 *   3. **No re-hire.** A guard who came back after two months had to be entered
 *      as a fresh `SF/xxxx`, splitting his history and counting him twice in
 *      `agencyHeadcount` — the single number the module exists to get right.
 *   4. **No way to take a login away** short of falsely recording that somebody
 *      had left, and no password reset at all: the one-time password from
 *      `provisionLogin` was the only credential the office ever saw.
 *   5. **Coverage had no time dimension.** `findAssignee` fell to BACKUP only
 *      when no PRIMARY row existed — never when the primary was on leave — and
 *      always picked `.sort({ createdAt: 1 })`, so the first-ever assignee got
 *      every ticket forever.
 *
 * Real database, THROWAWAY societyId, self-cleaning. Never touches live data.
 *
 *   npx tsx src/scripts/verify-staff-v2.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { Society } from '../models/society.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Vendor } from '../models/vendor.model';
import { SocietyStaff } from '../models/society-staff.model';
import { StaffAssignment } from '../models/staff-assignment.model';
import { StaffShift } from '../models/staff-shift.model';
import { StaffLeave } from '../models/staff-leave.model';
import { Complaint } from '../models/complaint.model';
import { Committee } from '../models/committee.model';
import { CommitteeMember } from '../models/committee-member.model';
import { Notification } from '../models/notification.model';
import { PushToken } from '../models/push-token.model';
import { User } from '../models/user.model';
import {
  createStaff, endEmployment, reinstate, provisionLogin, revokeLogin, resetPassword,
  addDocument, listDocuments, removeDocument, documentDownloadUrl,
  verificationDownloadUrl, photoDownloadUrl, updateStaff,
  setShift, addLeave, cancelLeave, findAssignee, sweepExpiringVerifications,
  agencyHeadcount, myWork, shiftCovers, isAvailable, getStaff,
  STAFF_DOC_PREFIX, STAFF_PHOTO_PREFIX,
} from '../services/staff.service';
import { resolveUserContexts } from '../services/context.service';
import { comparePassword } from '../utils/hash.util';
import { TenantType, UserRole } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const actor = { userId: adminId.toString(), userName: 'Verifier' };
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ids: mongoose.Types.ObjectId[] = [];
const audit = {
  societyId, createdBy: adminId, createdByName: 'Setup',
  updatedBy: adminId, updatedByName: 'Setup',
};

/** A staff row whose complaints can be counted, without going through routing. */
let ticket = 0;
const mkComplaint = async (opts: {
  staffId?: mongoose.Types.ObjectId; status?: string; blockId?: mongoose.Types.ObjectId;
  flatId?: mongoose.Types.ObjectId;
}) => Complaint.create({
  ...audit, ticketCode: `CMP/V${++ticket}`, kind: 'SERVICE', title: `Job V${ticket}`,
  category: 'Plumbing', visibility: 'PERSONAL', scope: 'FLAT',
  flatId: opts.flatId, flatLabel: 'A Wing 101', blockId: opts.blockId,
  raisedByUserId: adminId, raisedByName: 'Resident',
  assigneeStaffId: opts.staffId, assigneeName: 'Someone',
  status: opts.status || 'ASSIGNED',
  firstResponseDueAt: new Date(Date.now() + 3600_000),
  resolutionDueAt: new Date(Date.now() + 86_400_000),
  totalPausedMs: 0, escalationLevel: 0, reopenCount: 0,
} as any);

async function cleanup() {
  await Promise.all([
    Society.deleteMany({ _id: societyId }), Block.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Vendor.deleteMany({ societyId }),
    SocietyStaff.deleteMany({ societyId }), StaffAssignment.deleteMany({ societyId }),
    StaffShift.deleteMany({ societyId }), StaffLeave.deleteMany({ societyId }),
    Complaint.deleteMany({ societyId }), Notification.deleteMany({ societyId }),
    Committee.deleteMany({ societyId }), CommitteeMember.deleteMany({ societyId }),
    PushToken.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
  await User.deleteMany({ phone: { $in: ['9811100001', '9811100002', '9811100003'] } });
  await User.deleteMany({ email: { $regex: /@staffv2\.test$/ } });
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await Society.create({
      _id: societyId, name: `Throwaway ${SID}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: adminId,
      createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup',
    } as any);
    const [wingA, wingB] = await Block.create([
      { ...audit, name: 'A Wing' }, { ...audit, name: 'B Wing' },
    ]);
    const flat = await Flat.create({
      ...audit, blockId: wingA._id, blockName: 'A Wing',
      number: '101', status: FlatStatus.OWNER_OCCUPIED,
    });
    const agency = await Vendor.create({ ...audit, name: 'SecureCo', phone: '9000000001', isActive: true });

    // A serving committee, so the expiry sweep has somebody to tell. Two hops:
    // Committee is the TERM, CommitteeMember is the people.
    const chairUser = await User.create({
      name: 'Chairman', email: `chair.${Date.now()}@staffv2.test`,
      password: 'x'.repeat(20), role: UserRole.SOCIETY_COMMITTEE,
      memberships: [{ tenantType: TenantType.SOCIETY, tenantId: societyId, role: UserRole.SOCIETY_COMMITTEE }],
    });
    ids.push(chairUser._id as any);
    const term = await Committee.create({
      ...audit, name: 'Managing Committee 2026', status: 'ACTIVE', termStartDate: new Date(),
    } as any);
    await CommitteeMember.create({
      ...audit, committeeId: term._id, userId: chairUser._id,
      memberSnapshot: { name: 'Chairman' },
      designationKey: 'CHAIRMAN', designationLabel: 'Chairman',
      startDate: new Date(), status: 'ACTIVE',
    } as any);

    // ================================================================== 1. KYC
    console.log('1 — the papers behind the police verification');
    const guard = await createStaff(SID, {
      name: 'Ramesh Guard', phone: '9811100001', designation: 'SECURITY_GUARD',
      employmentType: 'AGENCY', vendorId: String(agency._id),
    } as any, actor);

    // A key our own uploader would have minted. The service must not accept any
    // other prefix — without the check, a caller could attach ANY object in the
    // bucket and read it straight back through the download route.
    const docKey = `${STAFF_DOC_PREFIX}deadbeefdeadbeefdeadbeefdeadbeef.pdf`;
    const filed = await addDocument(SID, String(guard._id), { name: 'Police verification', key: docKey }, actor);
    ok('a document can be filed against a staff member at all', !!filed._id);
    eq('...under the name the office gave it', filed.name, 'Police verification');

    const listed = await listDocuments(SID, String(guard._id));
    eq('...and it comes back on the list', listed.length, 1);
    ok('...WITHOUT the S3 key, which never leaves the server',
      !('key' in (listed[0] as any)), JSON.stringify(listed[0]));

    // THE round trip: upload → download. A presigned URL for the object we
    // filed, signed for this bucket, and short-lived.
    const dl = await documentDownloadUrl(SID, String(guard._id), filed._id);
    ok('THE ROUND TRIP — the filed document comes back as a signed link',
      dl.includes(encodeURIComponent(docKey).replace(/%2F/g, '/')) || dl.includes(docKey), dl.slice(0, 120));
    ok('...that is signed, not a bare public URL', dl.includes('X-Amz-Signature'), dl.slice(0, 120));
    ok('...and expires', dl.includes('X-Amz-Expires'));

    let strayKey = '';
    try { await addDocument(SID, String(guard._id), { name: 'Someone else\'s deed', key: 'flat-documents/abc.pdf' }, actor); }
    catch (e: any) { strayKey = e.message; }
    ok('a key from another module\'s uploader is refused', strayKey.includes('staff document uploader'), strayKey);

    let noName = '';
    try { await addDocument(SID, String(guard._id), { name: '  ', key: docKey }, actor); }
    catch (e: any) { noName = e.message; }
    ok('...and a document with no name is refused', noName.includes('name'), noName);

    // The verification scan and the photograph — the other two dead fields.
    const verKey = `${STAFF_DOC_PREFIX}cafecafecafecafecafecafecafecafe.pdf`;
    const photoKey = `${STAFF_PHOTO_PREFIX}f00df00df00df00df00df00df00df00d.jpg`;
    await updateStaff(SID, String(guard._id), {
      verification: { documentKey: verKey, policeVerifiedOn: new Date().toISOString() },
      photoKey,
    }, actor);
    const verUrl = await verificationDownloadUrl(SID, String(guard._id));
    ok('the police verification SCAN can be opened, so the date means something',
      verUrl.includes('X-Amz-Signature'));
    const photoUrl = await photoDownloadUrl(SID, String(guard._id));
    ok('a guard\'s photograph can be shown, not merely stored', photoUrl.includes('X-Amz-Signature'));

    let badPhoto = '';
    try { await updateStaff(SID, String(guard._id), { photoKey: 'profile-images/x.jpg' }, actor); }
    catch (e: any) { badPhoto = e.message; }
    ok('a photo key from outside the staff uploader is refused',
      badPhoto.includes('staff photo uploader'), badPhoto);

    const detail = await getStaff(SID, String(guard._id));
    ok('the detail screen is told a photo EXISTS without being handed the key',
      (detail.staff as any).person.hasPhoto === true && !(detail.staff as any).person.photoKey);
    ok('...same for the verification scan',
      (detail.staff as any).verification.hasDocument === true && !(detail.staff as any).verification.documentKey);

    await removeDocument(SID, String(guard._id), filed._id, actor);
    eq('a document can be taken off the record', (await listDocuments(SID, String(guard._id))).length, 0);

    // ====================================================== 2. the expiry sweep
    console.log('\n2 — a lapsing police verification actually reaches somebody');
    const lapsing = await createStaff(SID, {
      name: 'Lapsing Guard', phone: '9811100002', designation: 'SECURITY_GUARD',
      employmentType: 'AGENCY', vendorId: String(agency._id),
      verification: {
        policeVerifiedOn: new Date(Date.now() - 700 * 86_400_000).toISOString(),
        expiresOn: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      },
    } as any, actor);

    const swept = await sweepExpiringVerifications(SID);
    ok('the sweep finds it', swept >= 1, `swept ${swept}`);

    const told = await Notification.find({ societyId, kind: 'STAFF_VERIFICATION_EXPIRING' }).lean();
    ok('THE COMMITTEE IS ACTUALLY TOLD — before, nothing ever called this',
      told.length >= 1, `${told.length} notification(s)`);
    ok('...by name, so it can be acted on',
      told.some(n => n.title.includes('Lapsing Guard')), JSON.stringify(told.map(n => n.title)));
    ok('...and it reaches the serving committee',
      told.some(n => String(n.userId) === String(chairUser._id)));

    const again = await sweepExpiringVerifications(SID);
    eq('running it a second night says nothing again — one warning per lapse', again, 0);

    // Renewing must re-arm the reminder, or the NEXT lapse is silent forever.
    await updateStaff(SID, String(lapsing._id), {
      verification: { expiresOn: new Date(Date.now() + 20 * 86_400_000).toISOString() },
    }, actor);
    const afterRenewal = await sweepExpiringVerifications(SID);
    ok('renewing re-arms it, so the next lapse is not silenced for good',
      afterRenewal >= 1, `swept ${afterRenewal}`);

    const untracked = await sweepExpiringVerifications(SID);
    eq('...and then settles again', untracked, 0);
    ok('somebody with no verification date is never chased for one',
      !(await Notification.find({ societyId, kind: 'STAFF_VERIFICATION_EXPIRING' }).lean())
        .some(n => n.title.includes('Ramesh Guard')));

    // =========================================================== 3. the re-hire
    console.log('\n3 — somebody comes back, and stays one person');
    const returner = await createStaff(SID, {
      name: 'Returning Mali', phone: '9811100003', designation: 'GARDENER',
      employmentType: 'AGENCY', vendorId: String(agency._id),
    } as any, actor);
    const originalCode = returner.staffCode;
    await addDocument(SID, String(returner._id), { name: 'ID proof', key: docKey }, actor);
    const firstJoined = returner.joinedOn;

    await endEmployment(SID, String(returner._id), new Date(), actor);
    let head = await agencyHeadcount(SID);
    const beforeRehire = head.find(h => h.vendorName === 'SecureCo')?.active ?? 0;

    const back = await reinstate(SID, String(returner._id), actor);
    eq('THEY KEEP THEIR ORIGINAL STAFF NUMBER', back.staffCode, originalCode);
    eq('...and are on the roll again', back.isActive, true);
    ok('...with the day they left cleared', !back.leftOn);
    eq('...their papers still filed against them',
      (await listDocuments(SID, String(returner._id))).length, 1);
    eq('...and the stretch they already served is kept, not overwritten', back.spells.length, 1);
    eq('...starting on the day they first joined',
      new Date(back.spells[0].joinedOn).toDateString(), new Date(firstJoined).toDateString());

    head = await agencyHeadcount(SID);
    const afterRehire = head.find(h => h.vendorName === 'SecureCo')?.active ?? 0;
    eq('THE AGENCY ROLL COUNTS THEM ONCE, not twice', afterRehire, beforeRehire + 1);
    eq('...and there is still only one record for them',
      await SocietyStaff.countDocuments({ societyId, 'person.name': 'Returning Mali' }), 1);

    let alreadyHere = '';
    try { await reinstate(SID, String(returner._id), actor); }
    catch (e: any) { alreadyHere = e.message; }
    ok('reinstating somebody who never left is refused', alreadyHere.includes('already on the roll'), alreadyHere);

    let backwards = '';
    try {
      await endEmployment(SID, String(returner._id), new Date(), actor);
      await reinstate(SID, String(returner._id), actor, { joinedOn: new Date(Date.now() - 400 * 86_400_000) });
    } catch (e: any) { backwards = e.message; }
    ok('...and rejoining before the day they left is refused', backwards.includes('before the day they left'), backwards);
    await reinstate(SID, String(returner._id), actor); // put them back for later checks

    // ==================================================== 4. login lifecycle
    console.log('\n4 — a login can be taken away without ending employment');
    const withLogin = await createStaff(SID, {
      name: 'Manager Under Review', phone: '9811100004',
      email: `manager.${Date.now()}@staffv2.test`, designation: 'MANAGER',
    } as any, actor);
    const { staff: provisioned } = await provisionLogin(SID, String(withLogin._id), actor);
    const accountId = provisioned.userId!;
    ids.push(accountId as any);
    ok('they have a login', !!accountId);

    // Before revoking: the society is one of the places they can sign in to.
    const before = await resolveUserContexts((await User.findById(accountId))!);
    ok('...and the society appears among the places they can sign in to',
      before.some(c => c.tenantId === SID && c.role === UserRole.SOCIETY_EMPLOYEE),
      JSON.stringify(before.map(c => `${c.tenantId}:${c.role}`)));

    await PushToken.create({
      societyId, userId: accountId, platform: 'ANDROID',
      token: `fcm-${new mongoose.Types.ObjectId()}`, createdBy: adminId, updatedBy: adminId,
    } as any);

    const revoked = await revokeLogin(SID, String(withLogin._id), actor);
    const after = await resolveUserContexts((await User.findById(accountId))!);
    ok('A REVOKED LOGIN CANNOT SIGN IN — the society is gone from their contexts',
      !after.some(c => c.tenantId === SID && c.role === UserRole.SOCIETY_EMPLOYEE),
      JSON.stringify(after.map(c => `${c.tenantId}:${c.role}`)));
    eq('...while their employment continues', revoked.isActive, true);
    ok('...and they are still on the roll with their staff number',
      !!(await SocietyStaff.findOne({ _id: withLogin._id, isActive: true })));
    eq('...their devices stop receiving this society\'s alerts',
      await PushToken.countDocuments({ societyId, userId: accountId }), 0);
    ok('...and the record no longer points at an account that cannot be used',
      !(await SocietyStaff.findById(withLogin._id))!.userId);

    let noLogin = '';
    try { await revokeLogin(SID, String(withLogin._id), actor); }
    catch (e: any) { noLogin = e.message; }
    ok('revoking twice is refused', noLogin.includes('do not have a login'), noLogin);

    // A login can be given back — the whole point of not ending employment.
    const { staff: reprovisioned } = await provisionLogin(SID, String(withLogin._id), actor);
    ok('a login can be given back afterwards', !!reprovisioned.userId);
    ids.push(reprovisioned.userId as any);

    console.log('\n   ...and a forgotten password does not require a new staff record');
    const beforeHash = (await User.findById(reprovisioned.userId))!.passwordHash;
    const { password } = await resetPassword(SID, String(withLogin._id), actor);
    const afterUser = await User.findById(reprovisioned.userId);
    ok('a new password is issued', !!password && password.length >= 8, password);
    ok('...it is the one now stored', await comparePassword(password, afterUser!.passwordHash!));
    ok('...and the old one no longer works', beforeHash !== afterUser!.passwordHash);
    ok('...while nothing about their employment changed',
      (await SocietyStaff.findById(withLogin._id))!.isActive === true);

    // Both are ACCESS_MANAGE work, exactly like provisioning. A STAFF_MANAGE
    // holder minting or destroying credentials is the escalation path a
    // previous phase closed; revoking and resetting are the same job.
    const staffManagerOnly = {
      ...actor,
      access: {
        isAdmin: false,
        permissions: { STAFF_MANAGE: 'FULL', STAFF_VIEW: 'FULL' },
        blockIds: [], allBlocks: true, awaitingRole: false,
      } as any,
    };
    let revokeRefused = '';
    try { await revokeLogin(SID, String(withLogin._id), staffManagerOnly); }
    catch (e: any) { revokeRefused = e.message; }
    ok('a STAFF_MANAGE holder cannot take a login away', revokeRefused.includes('society admin'), revokeRefused);
    let resetRefused = '';
    try { await resetPassword(SID, String(withLogin._id), staffManagerOnly); }
    catch (e: any) { resetRefused = e.message; }
    ok('...nor mint a fresh password for somebody else\'s account',
      resetRefused.includes('society admin'), resetRefused);

    // ================================================ 5. routing has a clock
    console.log('\n5 — the rota, and work that stops following one person');
    const primary = await createStaff(SID, {
      name: 'Primary Plumber', phone: '9811100011', designation: 'PLUMBER',
    } as any, actor);
    const backup = await createStaff(SID, {
      name: 'Backup Plumber', phone: '9811100012', designation: 'PLUMBER',
    } as any, actor);

    const { assign } = await import('../services/staff.service');
    await assign(SID, {
      staffId: String(primary._id), scope: 'BLOCK', blockId: String(wingA._id),
      categories: ['PLUMBING'], rank: 'PRIMARY',
    }, actor);
    await assign(SID, {
      staffId: String(backup._id), scope: 'BLOCK', blockId: String(wingA._id),
      categories: ['PLUMBING'], rank: 'BACKUP',
    }, actor);

    const normal = await findAssignee(SID, 'PLUMBING', String(wingA._id));
    eq('with nobody away, the primary takes it', normal?.staffName, 'Primary Plumber');
    eq('...as the primary', normal?.via, 'BLOCK_PRIMARY');

    // THE assertion: the primary is on leave today.
    const away = await addLeave(SID, {
      staffId: String(primary._id),
      from: new Date().toISOString(), to: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      kind: 'LEAVE', reason: 'At his village',
    }, actor);
    const covered = await findAssignee(SID, 'PLUMBING', String(wingA._id));
    eq('THE PRIMARY IS ON LEAVE, SO IT GOES TO THE BACKUP', covered?.staffName, 'Backup Plumber');
    eq('...and says so', covered?.via, 'BLOCK_BACKUP');
    eq('...and the person on leave is not on duty', await isAvailable(SID, String(primary._id)), false);

    await cancelLeave(SID, String(away._id), actor);
    eq('cancelling the leave hands it straight back',
      (await findAssignee(SID, 'PLUMBING', String(wingA._id)))?.staffName, 'Primary Plumber');

    // Off shift, rather than away. A rota that says "not this hour" must move
    // the work; a society with NO rota at all must be left exactly as it was.
    const yesterday = (new Date().getDay() + 6) % 7;
    await setShift(SID, { staffId: String(primary._id), weekday: yesterday, from: '09:00', to: '10:00' }, actor);
    const offShift = await findAssignee(SID, 'PLUMBING', String(wingA._id));
    eq('a primary who is not down for today hands over to the backup',
      offShift?.staffName, 'Backup Plumber');

    // An overnight shift is the ordinary guard case and the one a naive
    // comparison gets wrong for every hour of it.
    // Monday 22:00 → Tuesday 06:00. Fixed calendar dates, not "today": Mon 20
    // July 2026 is weekday 1, Tue 21 July is weekday 2.
    const night = { weekday: 1, from: '22:00', to: '06:00' };
    ok('an overnight shift covers 23:30 on its own night',
      shiftCovers(night as any, new Date(2026, 6, 20, 23, 30)));
    ok('...and 02:00 the NEXT morning', shiftCovers(night as any, new Date(2026, 6, 21, 2, 0)));
    ok('...but not midday, which a naive from<=now<to test gets wrong both ways',
      !shiftCovers(night as any, new Date(2026, 6, 20, 12, 0)));

    console.log('\n   ...and two equal people share the work instead of one taking it all');
    const twinA = await createStaff(SID, { name: 'Twin A', phone: '9811100021', designation: 'ELECTRICIAN' } as any, actor);
    const twinB = await createStaff(SID, { name: 'Twin B', phone: '9811100022', designation: 'ELECTRICIAN' } as any, actor);
    await assign(SID, {
      staffId: String(twinA._id), scope: 'BLOCK', blockId: String(wingB._id),
      categories: ['ELECTRICAL'], rank: 'PRIMARY',
    }, actor);
    await assign(SID, {
      staffId: String(twinB._id), scope: 'BLOCK', blockId: String(wingB._id),
      categories: ['ELECTRICAL'], rank: 'PRIMARY',
    }, actor);

    // Both idle: the oldest assignment wins, so the answer is stable.
    const first = await findAssignee(SID, 'ELECTRICAL', String(wingB._id));
    eq('the first job goes to the one assigned first', first?.staffName, 'Twin A');
    await mkComplaint({ staffId: twinA._id as any, blockId: wingB._id as any, flatId: flat._id as any });

    const second = await findAssignee(SID, 'ELECTRICAL', String(wingB._id));
    eq('THE SECOND JOB GOES TO THE OTHER ONE — not the same person twice',
      second?.staffName, 'Twin B', );
    await mkComplaint({ staffId: twinB._id as any, blockId: wingB._id as any, flatId: flat._id as any });

    const third = await findAssignee(SID, 'ELECTRICAL', String(wingB._id));
    eq('...and with one each it goes back round', third?.staffName, 'Twin A');

    // Finished work must not count against somebody forever.
    await mkComplaint({ staffId: twinA._id as any, status: 'CLOSED', blockId: wingB._id as any, flatId: flat._id as any });
    await mkComplaint({ staffId: twinA._id as any, status: 'RESOLVED', blockId: wingB._id as any, flatId: flat._id as any });
    eq('finished jobs do not count against them', (await findAssignee(SID, 'ELECTRICAL', String(wingB._id)))?.staffName, 'Twin A');

    // Everybody away: visibly nobody, never a plausible guess.
    const awayA = await addLeave(SID, { staffId: String(twinA._id), from: new Date().toISOString(), to: new Date().toISOString() }, actor);
    const awayB = await addLeave(SID, { staffId: String(twinB._id), from: new Date().toISOString(), to: new Date().toISOString() }, actor);
    ok('with everybody away it reaches NOBODY rather than somebody absent',
      (await findAssignee(SID, 'ELECTRICAL', String(wingB._id))) === null);
    await cancelLeave(SID, String(awayA._id), actor);
    await cancelLeave(SID, String(awayB._id), actor);

    // The last resort: everybody off shift, nobody away. Somebody whose shift
    // ended at six is a better recipient at seven than nobody at all.
    for (const t of [twinA, twinB]) {
      // A one-minute window on a day that is not today.
      await setShift(SID, { staffId: String(t._id), weekday: (new Date().getDay() + 3) % 7, from: '03:00', to: '03:01' }, actor);
    }
    const lastResort = await findAssignee(SID, 'ELECTRICAL', String(wingB._id));
    ok('everybody off shift still reaches the least-loaded person, not nobody',
      lastResort !== null, JSON.stringify(lastResort));
    eq('...and says that is why', lastResort?.via, 'LEAST_LOADED');

    // ==================================================== 6. the staff home
    console.log('\n6 — a staff member has a screen of their own');
    const ownScreen = await SocietyStaff.findById(withLogin._id).lean();
    await mkComplaint({ staffId: ownScreen!._id as any, status: 'IN_PROGRESS', flatId: flat._id as any });
    await setShift(SID, { staffId: String(withLogin._id), weekday: new Date().getDay(), from: '00:00', to: '23:59' }, actor);
    await updateStaff(SID, String(withLogin._id), {
      verification: { expiresOn: new Date(Date.now() - 5 * 86_400_000).toISOString() },
    }, actor);

    const mine = await myWork(SID, String(reprovisioned.userId));
    eq('they see their own name', mine.staff.name, 'Manager Under Review');
    eq('...their own open job', mine.complaints.length, 1);
    eq('...their hours for today', mine.shifts.filter(s => s.weekday === new Date().getDay()).length, 1);
    eq('...that they are on duty', mine.onDutyNow, true);
    eq('...and that their police check has LAPSED, in one word', mine.verification.state, 'LAPSED');

    let notStaff = '';
    try { await myWork(SID, String(chairUser._id)); }
    catch (e: any) { notStaff = e.message; }
    ok('somebody who is not on the roll is told so, plainly',
      notStaff.includes('not on this society\'s staff roll'), notStaff);

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
  await mongoose.disconnect();
  process.exit(1);
});
