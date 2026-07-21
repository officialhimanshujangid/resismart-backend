/**
 * Complaints v2, the depth pass.
 *
 * Every assertion here FAILS against the code as it stood before this pass.
 * That is the bar: a test that passes either way proves nothing.
 *
 * What is covered, by the id used in OPERATIONS_V2.md:
 *   IV-1.2  photographs exist at all — upload, attach, presign, gallery
 *   IV-1.2  ...and a neighbour cannot fetch them
 *   IV-1.2  ...and a photo on an internal note never reaches the household
 *   IV-3    a resident can write on their own complaint, and only their own
 *   IV-3    staff have an internal channel, and residents never receive it
 *   IV-3    a 15-minute promise made at 02:00 is due in working hours
 *   IV-3    ...unless it is an emergency, which is why emergencies exist
 *   IV-3    the two "how long do we take" figures agree on paused time
 *   H-17    stats() is one aggregation and returns the OLD numbers exactly
 *
 *   npx tsx src/scripts/verify-complaints-depth.ts
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
import { ComplaintSettings } from '../models/complaint-settings.model';
import { SocietyStaff } from '../models/society-staff.model';
import { StaffAssignment } from '../models/staff-assignment.model';
import { AccessRole } from '../models/access-role.model';
import { Notification } from '../models/notification.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { createStaff, assign as assignTrade } from '../services/staff.service';
import {
  raise, respond, markWorkDone, comment, internalNote, photoUrls, detail, stats,
  resolve, close, pause, resume, COMPLAINT_PHOTO_PREFIX,
} from '../services/complaint.service';
import {
  dueAfter, calendarFor, DEFAULT_CALENDAR, ALWAYS_ON, describeCalendar, localDay,
} from '../services/complaint-calendar';
import { allowedVerbs, TRANSITIONS } from '../services/complaint-transitions';
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
    ComplaintSettings.deleteMany({ societyId }),
    Notification.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

/**
 * The statistics EXACTLY as they were computed before this pass — a full
 * `find()` and six JavaScript passes.
 *
 * Kept verbatim, deliberately, because "the aggregation is faster" is worthless
 * if it also quietly changes the number a committee has been reading for a
 * year. This is the oracle the new `$facet` is checked against, on the same
 * data, in the same process.
 */
async function referenceStats(sid: string, at = new Date()) {
  const rows = await Complaint.find({ societyId: new mongoose.Types.ObjectId(sid), kind: 'SERVICE' })
    .select('status resolutionDueAt createdAt resolvedAt reopenCount totalPausedMs assigneeStaffId assigneeVendorId')
    .lean();

  const openStatuses = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED', 'WORK_DONE'];
  const open = rows.filter(r => openStatuses.includes(r.status));
  const chaseable = open.filter(r => r.status !== 'WORK_DONE' && r.status !== 'ON_HOLD');
  const resolved = rows.filter(r => r.resolvedAt);
  const durations = resolved
    .map(r => (r.resolvedAt!.getTime() - r.createdAt.getTime() - (r.totalPausedMs || 0)) / 60_000)
    .filter(d => d >= 0)
    .sort((a, b) => a - b);

  return {
    open: open.length,
    overdue: chaseable.filter(r => r.resolutionDueAt && r.resolutionDueAt < at).length,
    awaitingConfirmation: rows.filter(r => r.status === 'WORK_DONE').length,
    unassigned: open.filter(r => !r.assigneeStaffId && !r.assigneeVendorId).length,
    reopenRate: rows.length ? Math.round((rows.filter(r => r.reopenCount > 0).length / rows.length) * 100) : 0,
    medianResolutionMinutes: durations.length ? Math.round(durations[Math.floor(durations.length / 2)]) : null,
  };
}

const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    // ------------------------------------------------------------- fixtures
    const admin = await mkUser('DepthAdmin', UserRole.SOCIETY_ADMIN);
    const ownerA = await mkUser('DepthOwnerA', UserRole.RESIDENT_OWNER);
    const ownerB = await mkUser('DepthOwnerB', UserRole.RESIDENT_OWNER);
    const techUser = await mkUser('DepthTech', UserRole.SOCIETY_EMPLOYEE);

    const audit = {
      societyId, createdBy: admin, createdByName: 'Setup',
      updatedBy: admin, updatedByName: 'Setup',
    };
    const actor = { userId: String(admin), userName: 'Manager' };
    const residentA = { userId: String(ownerA), userName: 'Owner A' };
    const residentB = { userId: String(ownerB), userName: 'Owner B' };
    const mgr = { canManage: true, userId: String(admin) };

    await Society.create({
      _id: societyId, name: `Throwaway ${SID}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: admin,
      createdBy: admin, createdByName: 'Setup', updatedBy: admin, updatedByName: 'Setup',
    } as any);

    const [wingA] = await Block.create([{ ...audit, name: 'A Wing' }]);
    const flatA = await Flat.create({
      ...audit, blockId: wingA._id, blockName: 'A Wing', number: '101',
      status: FlatStatus.OWNER_OCCUPIED, ownerUserId: ownerA,
    });
    const flatB = await Flat.create({
      ...audit, blockId: wingA._id, blockName: 'A Wing', number: '102',
      status: FlatStatus.OWNER_OCCUPIED, ownerUserId: ownerB,
    });
    await Resident.create([
      { ...audit, flatId: flatA._id, userId: ownerA, person: { name: 'Owner A' }, relationship: 'OWNER', householdType: 'OWNER', isActive: true },
      { ...audit, flatId: flatB._id, userId: ownerB, person: { name: 'Owner B' }, relationship: 'OWNER', householdType: 'OWNER', isActive: true },
    ]);

    // A fifteen-minute FIRST REPLY promise that is NOT an emergency. This is
    // the exact shape §IV-3 complains about.
    const quickCat = await ComplaintCategory.create({
      ...audit, category: 'Plumbing', subCategory: 'Water leakage', workCategory: 'PLUMBING',
      firstResponseMinutes: 15, resolutionMinutes: 240, isEmergency: false, sortOrder: 0, isActive: true,
    });
    const emergencyCat = await ComplaintCategory.create({
      ...audit, category: 'Lift', subCategory: 'Someone stuck', workCategory: 'LIFT',
      firstResponseMinutes: 15, resolutionMinutes: 60, isEmergency: true, sortOrder: 1, isActive: true,
    });

    const tech = await createStaff(SID, { name: 'Vijay', phone: '9822200001', designation: 'PLUMBER' }, actor);
    await SocietyStaff.updateOne({ _id: tech._id }, { $set: { userId: techUser } });
    await assignTrade(SID, { staffId: String(tech._id), scope: 'SOCIETY', categories: ['PLUMBING'] }, actor);
    const techScope = { canManage: false, ownStaffId: String(tech._id), userId: String(techUser) };
    const techRole = await AccessRole.create({
      ...audit, name: 'Technician', appliesTo: 'STAFF', isActive: true,
      permissions: [{ module: 'COMPLAINTS_OWN', level: 'FULL' }],
      scope: { allBlocks: true, blockIds: [] },
    } as any);
    await SocietyStaff.updateOne({ _id: tech._id }, { $set: { accessRoleId: techRole._id } });

    const scopeA = { residentFlatIds: [String(flatA._id)], userId: String(ownerA) };
    const scopeB = { residentFlatIds: [String(flatB._id)], userId: String(ownerB) };

    const auth = (tk: string) => ({ Authorization: `Bearer ${tk}` });
    const adminTk = tokenFor(admin, UserRole.SOCIETY_ADMIN);
    const ownerATk = tokenFor(ownerA, UserRole.RESIDENT_OWNER);
    const ownerBTk = tokenFor(ownerB, UserRole.RESIDENT_OWNER);
    const techTk = tokenFor(techUser, UserRole.SOCIETY_EMPLOYEE);

    // ============================================ IV-3  THE WORKING CALENDAR
    console.log('IV-3 — a promise is measured in hours the society actually works');

    // Mon–Sat, 9 to 6 — what a society office does, and the default.
    const at0200 = new Date(2026, 6, 20, 2, 0, 0); // Monday 20 July 2026, 02:00
    const due15 = dueAfter(at0200, 15, DEFAULT_CALENDAR);
    eq('A 15-MINUTE PROMISE MADE AT 02:00 IS DUE AT 09:15, NOT 02:15',
      `${due15.getHours()}:${String(due15.getMinutes()).padStart(2, '0')}`, '9:15');
    eq('...on the same day, not pushed into tomorrow', due15.getDate(), 20);
    ok('...and the old arithmetic would have said 02:15',
      new Date(at0200.getTime() + 15 * 60_000).getHours() === 2);

    // The reason emergencies are a separate thing.
    const dueEmergency = dueAfter(at0200, 15, ALWAYS_ON);
    eq('an EMERGENCY still breaches at 02:15 — somebody is stuck in a lift',
      `${dueEmergency.getHours()}:${String(dueEmergency.getMinutes()).padStart(2, '0')}`, '2:15');

    // Saturday evening, four hours of work owed: it lands on Monday morning,
    // because nobody works Sunday and the old clock ran through it anyway.
    const satEvening = new Date(2026, 6, 18, 17, 55, 0); // Saturday
    const dueMonday = dueAfter(satEvening, 240, DEFAULT_CALENDAR);
    eq('four hours owed from 17:55 on Saturday lands on Monday', dueMonday.getDay(), 1);
    // Five minutes of Saturday are left before the office shuts, Sunday counts
    // for nothing, and the remaining 3h55m runs from nine on Monday.
    eq('...at 12:55, not at 21:55 on Saturday night', minuteOfDay(dueMonday), 12 * 60 + 55);

    // A holiday is a day, and it is skipped.
    const holidayCal = { ...DEFAULT_CALENDAR, holidays: ['2026-08-14'] };
    const beforeHoliday = new Date(2026, 7, 13, 17, 30, 0); // Thu 13 Aug, 17:30
    const afterHoliday = dueAfter(beforeHoliday, 120, holidayCal); // 30 min left today
    eq('work owed over a declared holiday skips it', localDay(afterHoliday), '2026-08-15');
    eq('...and picks up when the office opens', minuteOfDay(afterHoliday), 10 * 60 + 30);

    ok('a zero-minute promise means "first thing", not midnight',
      minuteOfDay(dueAfter(at0200, 0, DEFAULT_CALENDAR)) === DEFAULT_CALENDAR.dayStartMinute);

    // A society that really is staffed at 3am says so, and gets the old clock.
    await ComplaintSettings.create({ societyId, roundTheClock: true });
    const alwaysOn = await calendarFor(SID);
    ok('a society that says it works round the clock gets elapsed time back', alwaysOn.roundTheClock);
    ok('...and the screen can say so in words',
      describeCalendar(alwaysOn).includes('around the clock'), describeCalendar(alwaysOn));
    await ComplaintSettings.deleteMany({ societyId });

    ok('...and the default calendar is described in words a resident can read',
      describeCalendar(DEFAULT_CALENDAR).includes('Monday to Saturday'), describeCalendar(DEFAULT_CALENDAR));

    // End to end: whenever this script runs, a raised complaint's deadlines sit
    // inside the working window rather than wherever the clock happened to be.
    const timed = await raise(SID, {
      title: 'Leak under the sink', categoryId: String(quickCat._id), flatId: String(flatA._id),
    }, residentA, { raiserFlatIds: [String(flatA._id)] });
    const reply = timed.firstResponseDueAt!;
    ok('a complaint raised right now has a first-reply time inside working hours',
      DEFAULT_CALENDAR.workingDays.includes(reply.getDay())
      && minuteOfDay(reply) >= DEFAULT_CALENDAR.dayStartMinute
      && minuteOfDay(reply) <= DEFAULT_CALENDAR.dayEndMinute,
      reply.toString());
    ok('...and a fix time too',
      minuteOfDay(timed.resolutionDueAt!) >= DEFAULT_CALENDAR.dayStartMinute
      && minuteOfDay(timed.resolutionDueAt!) <= DEFAULT_CALENDAR.dayEndMinute,
      timed.resolutionDueAt!.toString());

    const emergencyTicket = await raise(SID, {
      title: 'Someone is stuck in the lift', categoryId: String(emergencyCat._id), flatId: String(flatA._id),
    }, residentA, { raiserFlatIds: [String(flatA._id)] });
    ok('...while an emergency is still measured in plain elapsed minutes',
      Math.abs(emergencyTicket.firstResponseDueAt!.getTime()
        - (emergencyTicket.createdAt.getTime() + 15 * 60_000)) < 2000,
      emergencyTicket.firstResponseDueAt!.toISOString());

    // ==================================================== IV-1.2  PHOTOGRAPHS
    console.log('\nIV-1.2 — a photograph, end to end (there was no uploader and no viewer)');

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const uploaded = await request(app)
      .post('/api/v1/complaints/photos').set(auth(ownerATk))
      .attach('file', png, 'leak.png');
    eq('a resident can upload a photo', uploaded.status, 200);
    const photoKey: string = uploaded.body?.data?.key;
    ok('...and gets back an object key, never a public URL',
      typeof photoKey === 'string' && photoKey.startsWith(COMPLAINT_PHOTO_PREFIX), photoKey);
    ok('...that is not a fetchable link', !String(photoKey).startsWith('http'));

    const withPhoto = await request(app)
      .post('/api/v1/complaints').set(auth(ownerATk))
      .send({ title: 'Ceiling is dripping', categoryId: String(quickCat._id), photoKeys: [photoKey] });
    eq('the photo attaches to a complaint', withPhoto.status, 201);
    const photoTicketId = String(withPhoto.body?.data?._id);
    eq('...and is stored on it',
      (await Complaint.findById(photoTicketId).lean())?.photoKeys?.[0], photoKey);

    const gallery = await request(app)
      .get(`/api/v1/complaints/${photoTicketId}/photos`).set(auth(ownerATk));
    eq('the raiser can fetch the gallery', gallery.status, 200);
    const shot = (gallery.body?.data || [])[0];
    ok('THE PHOTO ROUND-TRIPS — upload, attach, and back as a signed link',
      !!shot?.url && String(shot.url).includes(encodeURI(photoKey).replace(/\//g, '/')),
      JSON.stringify(shot)?.slice(0, 160));
    ok('...signed, not public — the link carries an expiry',
      /X-Amz-Expires=/.test(String(shot?.url || '')), String(shot?.url || '').slice(0, 120));
    eq('...and is labelled with where it came from', shot?.source, 'RAISED');

    const nosy = await request(app)
      .get(`/api/v1/complaints/${photoTicketId}/photos`).set(auth(ownerBTk));
    eq('A RESIDENT OF ANOTHER FLAT CANNOT FETCH THE PHOTOS', nosy.status, 404);
    ok('...and is not even told the complaint exists',
      /could not be found/i.test(nosy.body?.message || ''), nosy.body?.message);

    // A key we did not mint cannot be attached — otherwise any object in the
    // bucket, including another society's papers, could be signed through here.
    let forged = '';
    try {
      await raise(SID, {
        title: 'Forged', category: 'Other', flatId: String(flatA._id),
        photoKeys: ['flat-documents/somebody-elses-sale-deed.pdf'],
      }, residentA, { raiserFlatIds: [String(flatA._id)] });
    } catch (e: any) { forged = e.message; }
    ok('a key this product did not mint is refused', /not uploaded through this form/i.test(forged), forged);

    // The technician's "after" photo, which the service has always written and
    // nothing has ever read.
    await markWorkDone(SID, photoTicketId, 'Sealed the joint',
      [`${COMPLAINT_PHOTO_PREFIX}after-shot.jpg`], { userId: String(techUser), userName: 'Vijay' },
      { canManage: true, userId: String(admin) });
    const afterGallery = await photoUrls(SID, photoTicketId, scopeA);
    ok('THE "AFTER" PHOTO REACHES THE RESIDENT — it was written and read by nobody',
      afterGallery.some(p => p.key.endsWith('after-shot.jpg')),
      afterGallery.map(p => p.key).join(','));
    ok('...captioned so the household knows what it is showing',
      afterGallery.find(p => p.key.endsWith('after-shot.jpg'))?.caption === 'After the work');

    // A photo on an INTERNAL note must not leak through the gallery.
    await internalNote(SID, photoTicketId, 'Owner is abroad — stop knocking',
      [`${COMPLAINT_PHOTO_PREFIX}internal-only.jpg`], actor, mgr);
    const residentSees = await photoUrls(SID, photoTicketId, scopeA);
    ok('A PHOTO ON AN INTERNAL NOTE IS NOT SIGNED FOR THE HOUSEHOLD',
      !residentSees.some(p => p.key.endsWith('internal-only.jpg')),
      residentSees.map(p => p.key).join(','));
    const managerSees = await photoUrls(SID, photoTicketId, mgr);
    ok('...but the staff who wrote it can still see it',
      managerSees.some(p => p.key.endsWith('internal-only.jpg')),
      managerSees.map(p => p.key).join(','));

    // ================================================ IV-3  THE THREE CHANNELS
    console.log('\nIV-3 — the household can finally say something, and staff have their own channel');

    ok('"add a message" is a verb the machine knows about',
      Object.values(TRANSITIONS).some(specs => specs.some(s => s.verb === 'comment')));
    const residentCan = allowedVerbs({ status: 'ASSIGNED', visibility: 'PERSONAL' },
      { canManage: false, isAssignee: false, isResident: true });
    ok('A RESIDENT IS OFFERED A MESSAGE BOX ON A TICKET BEING WORKED',
      residentCan.includes('comment'), residentCan.join(','));
    ok('...and still none of the four doomed buttons they used to be shown',
      !residentCan.includes('respond') && !residentCan.includes('pause')
      && !residentCan.includes('workDone') && !residentCan.includes('close'),
      residentCan.join(','));
    ok('...and cannot write an internal note', !residentCan.includes('note'));

    const staffCan = allowedVerbs({ status: 'ASSIGNED', visibility: 'PERSONAL' },
      { canManage: false, isAssignee: true, isResident: false });
    ok('the person doing the work gets the internal note channel', staffCan.includes('note'), staffCan.join(','));

    const own = await raise(SID, {
      title: 'Tap dripping again', categoryId: String(quickCat._id), flatId: String(flatA._id),
    }, residentA, { raiserFlatIds: [String(flatA._id)] });

    const said = await request(app)
      .post(`/api/v1/complaints/${own._id}/comment`).set(auth(ownerATk))
      .send({ note: 'Anybody home after six is fine' });
    eq('A RESIDENT CAN WRITE ON THEIR OWN COMPLAINT — this used to 403', said.status, 200);
    const events = await ComplaintEvent.find({ complaintId: own._id }).lean();
    const written = events.find(e => e.type === 'COMMENT');
    ok('...and it is recorded as a message, not as an internal note',
      !!written && written.isInternal === false, JSON.stringify(written)?.slice(0, 120));

    const fresh = await Complaint.findById(own._id).lean();
    ok('...and it does NOT count as the society replying',
      !fresh?.firstRespondedAt, String(fresh?.firstRespondedAt));
    eq('...nor does it move the complaint along', fresh?.status, own.status);

    const neighbour = await request(app)
      .post(`/api/v1/complaints/${own._id}/comment`).set(auth(ownerBTk))
      .send({ note: 'me too, sort of' });
    eq('A NEIGHBOUR CANNOT WRITE ON SOMEBODY ELSE\'S COMPLAINT', neighbour.status, 404);

    const residentNote = await request(app)
      .post(`/api/v1/complaints/${own._id}/note`).set(auth(ownerATk))
      .send({ note: 'let me into the staff channel' });
    eq('...and cannot reach the staff channel at all', residentNote.status, 403);

    await settle();
    const staffTold = await Notification.find({ societyId, kind: 'COMPLAINT_COMMENT' }).lean();
    ok('somebody is actually told the household said something', staffTold.length >= 1,
      String(staffTold.length));
    ok('...and never the person who wrote it',
      !staffTold.some(n => String(n.userId) === String(ownerA)));

    // The internal note, and the wall around it.
    await internalNote(SID, String(own._id), 'Owner disputes the last bill — go carefully', undefined, actor, mgr);
    const asResident = await detail(SID, String(own._id), scopeA);
    ok('A RESIDENT NEVER RECEIVES AN INTERNAL NOTE',
      !asResident.events.some(e => e.isInternal),
      asResident.events.filter(e => e.isInternal).map(e => e.note).join('|'));
    ok('...not even its text',
      !JSON.stringify(asResident.events).includes('disputes the last bill'));
    ok('...while their own message is still there',
      asResident.events.some(e => e.type === 'COMMENT'));

    const asManager = await detail(SID, String(own._id), mgr);
    ok('...and the staff can read it', asManager.events.some(e => e.isInternal
      && (e.note || '').includes('disputes the last bill')));

    const techWrote = await request(app)
      .post(`/api/v1/complaints/${own._id}/note`).set(auth(techTk))
      .send({ note: 'Parts ordered from the market' });
    eq('the technician on the job may write one too', techWrote.status, 200);

    // A reply from the staff is a different act with a different audience.
    await respond(SID, String(own._id), 'Coming this evening',
      { userId: String(techUser), userName: 'Vijay' }, techScope);
    const replied = await Complaint.findById(own._id).lean();
    ok('a staff REPLY does stop the first-reply clock — which is the difference',
      !!replied?.firstRespondedAt);

    // Rejected is where the conversation stops.
    const junk = await raise(SID, { title: 'Test entry', category: 'Other', flatId: String(flatA._id) }, actor, { onBehalf: true });
    await request(app).post(`/api/v1/complaints/${junk._id}/reject`).set(auth(adminTk))
      .send({ reason: 'Filed by mistake' });
    let onDead = '';
    try { await comment(SID, String(junk._id), 'hello?', undefined, residentA, scopeA); }
    catch (e: any) { onDead = e.message; }
    ok('writing into a rejected complaint is refused, and says where to go instead',
      /nobody is reading it/i.test(onDead), onDead);

    // ============================================== H-17  THE SAME NUMBERS
    console.log('\nH-17 — stats() is one aggregation, and the numbers did not move');

    // Build a spread that exercises every branch: open, on hold, work done,
    // resolved with a pause subtracted, closed, reopened and unassigned.
    const heldOne = await raise(SID, { title: 'On hold one', categoryId: String(quickCat._id), flatId: String(flatA._id) }, actor, { onBehalf: true });
    await pause(SID, String(heldOne._id), 'AWAITING_PARTS', actor, mgr);

    const pausedThenFixed = await raise(SID, { title: 'Paused then fixed', categoryId: String(quickCat._id), flatId: String(flatA._id) }, actor, { onBehalf: true });
    await pause(SID, String(pausedThenFixed._id), 'AWAITING_ACCESS', actor, mgr);
    // Reported three days ago and locked out for one of them, so there is a
    // real span to measure and a real hold to subtract from it. Without the
    // backdated `createdAt` the pause would outrun the elapsed time and the row
    // would be dropped as a negative span — which is exactly the branch the
    // aggregation and the old code both have to agree about.
    await Complaint.collection.updateOne(
      { _id: pausedThenFixed._id },
      {
        $set: {
          createdAt: new Date(Date.now() - 3 * 86_400_000),
          pausedAt: new Date(Date.now() - 86_400_000),
        },
      },
    );
    await resume(SID, String(pausedThenFixed._id), actor, mgr);
    await markWorkDone(SID, String(pausedThenFixed._id), 'Done', [], actor, mgr);
    await resolve(SID, String(pausedThenFixed._id), residentA, scopeA);

    const closedOne = await raise(SID, { title: 'Closed one', categoryId: String(quickCat._id), flatId: String(flatB._id) }, actor, { onBehalf: true });
    await markWorkDone(SID, String(closedOne._id), 'Done', [], actor, mgr);
    await resolve(SID, String(closedOne._id), residentB, scopeB);
    await close(SID, String(closedOne._id), actor, mgr);

    const orphan = await raise(SID, { title: 'Nobody covers this', category: 'Other', flatId: String(flatB._id) }, actor, { onBehalf: true });
    await Complaint.collection.updateOne({ _id: orphan._id }, { $set: { reopenCount: 2 } });
    await Complaint.collection.updateOne(
      { _id: heldOne._id }, { $set: { resolutionDueAt: new Date(Date.now() - 86_400_000) } },
    );

    const at = new Date();
    const fromAggregation = await stats(SID, at);
    const fromTheOldCode = await referenceStats(SID, at);

    for (const key of ['open', 'overdue', 'awaitingConfirmation', 'unassigned', 'reopenRate', 'medianResolutionMinutes'] as const) {
      eq(`stats().${key} matches the old full-scan implementation exactly`,
        fromAggregation[key], fromTheOldCode[key]);
    }
    ok('...on data that actually exercises the branches',
      fromTheOldCode.open > 0 && fromTheOldCode.medianResolutionMinutes !== null
      && fromTheOldCode.reopenRate > 0,
      JSON.stringify(fromTheOldCode));

    // ======================================== IV-3  ONE ANSWER TO "HOW LONG"
    console.log('\nIV-3 — the two "how long do we take" figures agree about paused time');
    ok('the complaints dashboard now publishes an AVERAGE as well as a median',
      typeof fromAggregation.avgResolutionMinutes === 'number',
      String(fromAggregation.avgResolutionMinutes));

    const resolvedRows = await Complaint.find({ societyId, resolvedAt: { $ne: null } })
      .select('createdAt resolvedAt totalPausedMs').lean();
    const rawAverage = Math.round(resolvedRows
      .map(r => (r.resolvedAt!.getTime() - r.createdAt.getTime()) / 60_000)
      .reduce((a, b) => a + b, 0) / resolvedRows.length);
    ok('...and it EXCLUDES the hold, so it disagrees with the raw createdAt→resolvedAt figure',
      (fromAggregation.avgResolutionMinutes || 0) < rawAverage,
      `ours ${fromAggregation.avgResolutionMinutes} vs raw ${rawAverage}`);
    ok('...by about the day the flat was locked and nobody could work',
      rawAverage - (fromAggregation.avgResolutionMinutes || 0) > 500,
      `difference ${rawAverage - (fromAggregation.avgResolutionMinutes || 0)} minutes`);

    // ====================================================== the routes exist
    console.log('\nThe new endpoints are wired, and gated');
    const residentStats = await request(app).get('/api/v1/complaints/stats').set(auth(ownerATk));
    eq('a resident cannot read the society\'s complaint statistics', residentStats.status, 403);
    const adminStats = await request(app).get('/api/v1/complaints/stats').set(auth(adminTk));
    eq('...and the committee can, without fetching the whole form with them', adminStats.status, 200);
    ok('...as the six numbers on their own',
      typeof adminStats.body?.data?.open === 'number' && !adminStats.body?.data?.categories);

    const opts = await request(app).get('/api/v1/complaints/options').set(auth(ownerATk));
    ok('the form tells everybody when the clocks actually run',
      typeof opts.body?.data?.workingHours === 'string' && opts.body.data.workingHours.length > 10,
      opts.body?.data?.workingHours);
    eq('...and how many photos it will take', opts.body?.data?.photoLimit, 6);

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
