/**
 * H-12 — the read half of the household boundary — and the last three policy
 * fields that promised behaviour the code did not have.
 *
 * Real Atlas, a THROWAWAY societyId, self-cleaning. Never touches existing data.
 *
 * The complaint half speaks HTTP, because the scope it is testing is resolved
 * in the CONTROLLER: a service-level test builds its own `residentFlatIds` and
 * would therefore pass whatever the controller decided. The policy half calls
 * the services directly — those rules live in the service, and the gate routes
 * are being renamed under a separate change.
 *
 * What is covered:
 *   H-12  a landlord does not read their tenant's complaints; a new tenant does
 *         not read the previous tenant's; and a person always reads their own
 *   I-E   `gate.capture.allowedIdTypes` — enforced, and settable at last
 *   I-E   `guardApp.shiftBoundSession` — deleted; it read as a control that did
 *         not exist
 *   I-E   `gate.exit.mode: AUTO_EXPIRE` — implemented; it was a word in a
 *         dropdown with nothing behind it
 *
 * Assertions marked "(guard)" pass both before and after this change ON PURPOSE
 * — they are the cases the fix must not break: the owner living in their own
 * home, the owner of several flats, the office, and the landlord's own right to
 * report a problem with the property they own. Every other assertion here fails
 * against the code as it stood before.
 *
 *   npx tsx src/scripts/verify-h12-and-policy.ts
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
import { VisitorEntry } from '../models/visitor-entry.model';
import { Notification } from '../models/notification.model';
import { SocietyOpsPolicy, ID_PROOF_TYPES } from '../models/society-ops-policy.model';
import { updateOpsPolicy } from '../services/ops-policy.service';
import { recordEntry, sweepOverstays, reconcileDay } from '../services/visitor.service';
import { listForUser } from '../services/notification.service';
import { updateOpsPolicySchema } from '../validators/visitor.validator';
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
    ComplaintEvent.deleteMany({ societyId }), VisitorEntry.deleteMany({ societyId }),
    SocietyOpsPolicy.deleteMany({ societyId }), Notification.deleteMany({ societyId }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

const DAY = 86_400_000;
const settle = () => new Promise(r => setTimeout(r, 400));
/** Does this list payload carry that ticket? The list is what a resident sees. */
const listHas = (body: any, ticket: string) =>
  Array.isArray(body?.rows) && body.rows.some((r: any) => String(r.ticketCode) === ticket);

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    // ------------------------------------------------------------- fixtures
    const admin = await mkUser('Admin', UserRole.SOCIETY_ADMIN);
    const landlord = await mkUser('Landlord', UserRole.RESIDENT_OWNER);
    const tenant = await mkUser('Tenant Now', UserRole.RESIDENT_TENANT);
    const exTenant = await mkUser('Tenant Before', UserRole.RESIDENT_TENANT);
    // Owns two flats and lives in one of them: the multi-flat case, which the
    // household clamp must not touch.
    const homeowner = await mkUser('Home Owner', UserRole.RESIDENT_OWNER);

    const audit = {
      societyId, createdBy: admin, createdByName: 'Setup',
      updatedBy: admin, updatedByName: 'Setup',
    };
    const actor = { userId: String(admin), userName: 'Setup' };

    await Society.create({
      _id: societyId, name: `Throwaway ${SID}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: admin,
      createdBy: admin, createdByName: 'Setup', updatedBy: admin, updatedByName: 'Setup',
    } as any);

    const wing = await Block.create({ ...audit, name: 'A Wing' });
    // 101 is LET: the landlord owns it, somebody else lives in it, and a tenant
    // before them lived in it too.
    const flat101 = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '101', status: FlatStatus.RENTED, ownerUserId: landlord,
    });
    const flat102 = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '102', status: FlatStatus.OWNER_OCCUPIED, ownerUserId: homeowner,
    });
    const flat103 = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '103', status: FlatStatus.OWNER_OCCUPIED, ownerUserId: homeowner,
    });

    await ComplaintCategory.create({
      ...audit, category: 'Plumbing', workCategory: 'PLUMBING',
      firstResponseMinutes: 60, resolutionMinutes: 720, sortOrder: 0, isActive: true,
    } as any);

    /**
     * The landlord's row stays ACTIVE through the tenancy — that is not a bug
     * in the fixture, it is what `flat-lifecycle.service` deliberately does,
     * and it is the reason H-12 exists at all.
     */
    await Resident.create({
      ...audit, flatId: flat101._id, userId: landlord, person: { name: 'Landlord' },
      relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true,
    } as any);
    // The previous tenant, still living there for the moment so they can file
    // the complaint that the NEXT tenant must never see.
    const exRow = await Resident.create({
      ...audit, flatId: flat101._id, userId: exTenant, person: { name: 'Tenant Before' },
      relationship: 'TENANT', householdType: 'TENANT', isActive: true,
      moveInDate: new Date(Date.now() - 400 * DAY),
    } as any);
    await Resident.create([
      {
        ...audit, flatId: flat102._id, userId: homeowner, person: { name: 'Home Owner' },
        relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true,
      },
      {
        ...audit, flatId: flat103._id, userId: homeowner, person: { name: 'Home Owner' },
        relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true,
      },
    ] as any);

    const T = {
      admin: tokenFor(admin, UserRole.SOCIETY_ADMIN),
      landlord: tokenFor(landlord, UserRole.RESIDENT_OWNER),
      tenant: tokenFor(tenant, UserRole.RESIDENT_TENANT),
      exTenant: tokenFor(exTenant, UserRole.RESIDENT_TENANT),
      homeowner: tokenFor(homeowner, UserRole.RESIDENT_OWNER),
    };
    const get = (path: string, token: string) =>
      request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    const post = (path: string, token: string, body: any = {}) =>
      request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

    // The previous tenant reports a leak, while they still live there.
    const oldRaise = await post('/complaints', T.exTenant, {
      title: 'Kitchen tap dripping', description: 'Since last week', category: 'Plumbing',
    });
    ok('the previous tenant could report a problem (guard)', oldRaise.status === 201, `got ${oldRaise.status}`);
    const oldId = String(oldRaise.body?.data?._id || '');
    const oldTicket = String(oldRaise.body?.data?.ticketCode || '');

    // ...then they move out, and the tenancy is dated. Straight to the driver
    // for `createdAt`: it is a timestamp Mongoose owns, and the whole point of
    // this row is that it belongs to a tenancy that has ended.
    await Complaint.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(oldId) },
      { $set: { createdAt: new Date(Date.now() - 60 * DAY) } },
    );
    await Resident.updateOne(
      { _id: exRow._id },
      { $set: { isActive: false, moveOutDate: new Date(Date.now() - 31 * DAY) } },
    );

    // The new tenant moves in a month ago.
    await Resident.create({
      ...audit, flatId: flat101._id, userId: tenant, person: { name: 'Tenant Now' },
      relationship: 'TENANT', householdType: 'TENANT', isActive: true, isHead: true,
      moveInDate: new Date(Date.now() - 30 * DAY),
    } as any);

    // ============================ H-12a  the landlord and the sitting tenant
    console.log('H-12 — a landlord does not read their tenant\'s complaints');

    const mine = await post('/complaints', T.tenant, {
      title: 'Bathroom leak', description: 'Under the basin', category: 'Plumbing',
    });
    ok('the tenant can report a problem (guard)', mine.status === 201, `got ${mine.status}`);
    const mineId = String(mine.body?.data?._id || '');
    const mineTicket = String(mine.body?.data?.ticketCode || '');
    eq('...against their own flat (guard)',
      String((await Complaint.findById(mineId).lean())?.flatId || ''), String(flat101._id));

    const tenantList = await get('/complaints', T.tenant);
    ok('the tenant reads it back (guard)', listHas(tenantList.body, mineTicket));

    const landlordList = await get('/complaints', T.landlord);
    ok('THE LANDLORD DOES NOT SEE THEIR TENANT\'S COMPLAINT',
      !listHas(landlordList.body, mineTicket),
      JSON.stringify(landlordList.body?.rows?.map((r: any) => r.ticketCode)));

    const landlordPeek = await get(`/complaints/${mineId}`, T.landlord);
    eq('...nor open it by id', landlordPeek.status, 404);

    const landlordPhotos = await get(`/complaints/${mineId}/photos`, T.landlord);
    eq('...nor its photographs', landlordPhotos.status, 404);

    // Acting on it is the same scope object, so it must close at the same time.
    // WORK_DONE, because that is the state where "resolve" is a real verb: the
    // landlord signing off a repair inside a home they do not live in.
    await Complaint.updateOne({ _id: mineId }, { $set: { status: 'WORK_DONE' } });
    const landlordSignOff = await post(`/complaints/${mineId}/resolve`, T.landlord);
    eq('...nor sign off the work done in it', landlordSignOff.status, 404);
    eq('...and the ticket is untouched',
      (await Complaint.findById(mineId).lean())?.status, 'WORK_DONE');

    const tenantSignOff = await post(`/complaints/${mineId}/resolve`, T.tenant);
    ok('the person who lives there still can (guard)',
      ![403, 404].includes(tenantSignOff.status), `got ${tenantSignOff.status}`);

    // ================================== H-12b  the flat's history is not sold
    console.log('\nH-12 — a new tenant does not inherit the last one\'s complaints');

    ok('THE NEW TENANT DOES NOT SEE THE PREVIOUS TENANT\'S COMPLAINT',
      !listHas(tenantList.body, oldTicket),
      JSON.stringify(tenantList.body?.rows?.map((r: any) => r.ticketCode)));
    eq('...nor open it by id', (await get(`/complaints/${oldId}`, T.tenant)).status, 404);
    ok('...and cannot say "me too" on it either',
      [403, 404].includes((await post(`/complaints/${oldId}/me-too`, T.tenant)).status));

    // ============================== H-12c  what survives every clamp: your own
    console.log('\nH-12 — a person always keeps what they raised themselves');

    const exList = await get('/complaints', T.exTenant);
    ok('AN EX-TENANT STILL READS THE COMPLAINT THEY FILED',
      listHas(exList.body, oldTicket),
      JSON.stringify(exList.body?.rows?.map((r: any) => r.ticketCode)));
    // `detail` already had the raiser hatch; `list` did not, which is why the
    // ex-tenant above was shown nothing and could still open a ticket they had
    // no way to find. Both halves are asserted so they cannot part company again.
    eq('...and can still open it (guard)', (await get(`/complaints/${oldId}`, T.exTenant)).status, 200);

    // The landlord may still report a problem with the property they own —
    // this is the line between "reading your tenant's post" and "owning a flat".
    const landlordRaise = await post('/complaints', T.landlord, {
      title: 'Seepage on the outer wall', description: 'Owner reporting', category: 'Plumbing',
      flatId: String(flat101._id),
    });
    eq('a landlord can still report a problem with their own property (guard)',
      landlordRaise.status, 201);
    const landlordTicket = String(landlordRaise.body?.data?.ticketCode || '');
    ok('...and reads back the one they filed, though the flat is not theirs to read (guard)',
      listHas((await get('/complaints', T.landlord)).body, landlordTicket));
    ok('...and the household it is about sees it too (guard)',
      listHas((await get('/complaints', T.tenant)).body, landlordTicket));

    // ==================================== H-12d  everything that must not move
    console.log('\nH-12 — the cases the clamp must not touch');

    const own102 = await post('/complaints', T.homeowner, {
      title: 'Lift button stuck', category: 'Plumbing', flatId: String(flat102._id),
    });
    const own103 = await post('/complaints', T.homeowner, {
      title: 'Balcony grill loose', category: 'Plumbing', flatId: String(flat103._id),
    });
    eq('an owner-occupier can report a problem (guard)', own102.status, 201);
    const ownerList = await get('/complaints', T.homeowner);
    ok('an owner living in their own home reads it back (guard)',
      listHas(ownerList.body, String(own102.body?.data?.ticketCode)));
    ok('AN OWNER OF SEVERAL FLATS STILL SEES ALL OF THEM (guard)',
      listHas(ownerList.body, String(own103.body?.data?.ticketCode)),
      JSON.stringify(ownerList.body?.rows?.map((r: any) => r.ticketCode)));
    ok('...and still nothing belonging to another flat (guard)',
      !listHas(ownerList.body, mineTicket));
    eq('...nor by id (guard)', (await get(`/complaints/${mineId}`, T.homeowner)).status, 404);

    const officeList = await get('/complaints', T.admin);
    ok('the office still sees the whole society (guard)',
      listHas(officeList.body, mineTicket) && listHas(officeList.body, oldTicket));

    // ======================================== I-E  allowedIdTypes is enforced
    console.log('\nI-E — the gate accepts the IDs the society named, and no others');

    await updateOpsPolicy(SID, { gate: { capture: { idProof: 'OPTIONAL' } } }, actor);

    let refusedAadhaar = '';
    try {
      await recordEntry(SID, {
        category: 'GUEST', visitorName: 'Aadhaar Guest', flatId: String(flat102._id),
        idType: 'AADHAAR', idLast4: '1234',
      }, actor);
    } catch (e: any) { refusedAadhaar = e.message; }
    ok('AN ID THE SOCIETY NEVER LISTED IS REFUSED', !!refusedAadhaar, refusedAadhaar);
    eq('...and nothing was written to the register',
      await VisitorEntry.countDocuments({ societyId, visitorName: 'Aadhaar Guest' }), 0);
    ok('...and the message says what IS accepted', /driving licence|passport/i.test(refusedAadhaar),
      refusedAadhaar);

    const accepted = await recordEntry(SID, {
      category: 'GUEST', visitorName: 'Passport Guest', flatId: String(flat102._id),
      idType: 'PASSPORT', idLast4: '7788',
    }, actor);
    eq('a listed ID is admitted and recorded (guard)', accepted.idType, 'PASSPORT');

    // Narrowing the list is a real change, not decoration.
    await updateOpsPolicy(SID, { gate: { capture: { allowedIdTypes: ['PASSPORT'] } } }, actor);
    eq('THE LIST IS SETTABLE AT ALL',
      JSON.stringify((await SocietyOpsPolicy.findOne({ societyId }).lean())?.gate?.capture?.allowedIdTypes),
      JSON.stringify(['PASSPORT']));

    let refusedVoter = '';
    try {
      await recordEntry(SID, {
        category: 'GUEST', visitorName: 'Voter Guest', flatId: String(flat102._id),
        idType: 'VOTER_ID', idLast4: '4321',
      }, actor);
    } catch (e: any) { refusedVoter = e.message; }
    ok('...so narrowing it turns an ID away that was accepted a moment ago', !!refusedVoter, refusedVoter);

    ok('Aadhaar cannot be configured in, whatever anybody types',
      !updateOpsPolicySchema.safeParse({ gate: { capture: { allowedIdTypes: ['AADHAAR'] } } }).success);
    ok('...nor an empty list, which no gate could ever satisfy',
      !updateOpsPolicySchema.safeParse({ gate: { capture: { allowedIdTypes: [] } } }).success);
    ok('...and the four honest ones are all accepted (guard)',
      updateOpsPolicySchema.safeParse({ gate: { capture: { allowedIdTypes: [...ID_PROOF_TYPES] } } }).success);

    // REQUIRED now means required.
    await updateOpsPolicy(SID, {
      gate: { capture: { idProof: 'REQUIRED', allowedIdTypes: [...ID_PROOF_TYPES] } },
    }, actor);
    let refusedMissing = '';
    try {
      await recordEntry(SID, {
        category: 'GUEST', visitorName: 'No Papers', flatId: String(flat102._id),
      }, actor);
    } catch (e: any) { refusedMissing = e.message; }
    ok('"ID required" turns away a visitor with no ID', !!refusedMissing, refusedMissing);

    // ...and OFF still means the gate never asks.
    await updateOpsPolicy(SID, { gate: { capture: { idProof: 'OFF' } } }, actor);
    const noneAsked = await recordEntry(SID, {
      category: 'GUEST', visitorName: 'Nothing Asked', flatId: String(flat102._id),
      idType: 'ANYTHING AT ALL',
    }, actor);
    eq('with ID collection off the gate asks nothing and stores nothing (guard)',
      noneAsked.idType, undefined);

    // ==================================== I-E  shiftBoundSession is gone
    console.log('\nI-E — a switch that changed nothing has been removed, not left lying');

    ok('THE `shiftBoundSession` SWITCH NO LONGER EXISTS',
      SocietyOpsPolicy.schema.path('guardApp.shiftBoundSession') === undefined);
    const raw = await SocietyOpsPolicy.collection.findOne({ societyId });
    ok('...so a policy created today carries no such promise',
      !(raw?.guardApp && 'shiftBoundSession' in raw.guardApp),
      JSON.stringify(raw?.guardApp));
    ok('...while the switch beside it, which IS read, still saves',
      (await updateOpsPolicy(SID, { guardApp: { offlineQueueEnabled: false } }, actor))
        .guardApp.offlineQueueEnabled === false);

    // ==================================== I-E  AUTO_EXPIRE actually expires
    console.log('\nI-E — AUTO_EXPIRE closes the visit it always promised to close');

    await updateOpsPolicy(SID, { gate: { exit: { trackExit: true, mode: 'MANUAL' } } }, actor);
    const manual = await recordEntry(SID, {
      category: 'GUEST', visitorName: 'Manual Mode Guest', flatId: String(flat102._id),
    }, actor);
    const due = new Date(Date.now() - 2 * 3_600_000);
    await VisitorEntry.updateOne({ _id: manual._id }, { $set: { expectedOutAt: due } });

    await sweepOverstays(SID);
    await settle();
    eq('under MANUAL an overstaying visitor stays inside (guard)',
      (await VisitorEntry.findById(manual._id).lean())?.status, 'INSIDE');
    const alerts = await listForUser(SID, String(homeowner));
    ok('...and the host is told about them instead (guard)',
      alerts.items.some(i => i.kind === 'GATE_OVERSTAY'));

    await updateOpsPolicy(SID, { gate: { exit: { mode: 'AUTO_EXPIRE' } } }, actor);
    const expiring = await recordEntry(SID, {
      category: 'GUEST', visitorName: 'Auto Expire Guest', flatId: String(flat103._id),
    }, actor);
    const notDue = await recordEntry(SID, {
      category: 'GUEST', visitorName: 'Still Here Guest', flatId: String(flat103._id),
    }, actor);
    await VisitorEntry.updateOne({ _id: expiring._id }, { $set: { expectedOutAt: due } });
    await VisitorEntry.updateOne(
      { _id: notDue._id }, { $set: { expectedOutAt: new Date(Date.now() + 3_600_000) } },
    );

    const before = (await listForUser(SID, String(homeowner))).items.length;
    await sweepOverstays(SID);
    await settle();
    eq('the sweep leaves nobody inside past their expected departure',
      await VisitorEntry.countDocuments({
        societyId, status: 'INSIDE', expectedOutAt: { $lte: new Date() },
      }), 0);

    const closed = await VisitorEntry.findById(expiring._id).lean();
    eq('A VISIT PAST ITS EXPECTED DEPARTURE IS CLOSED', closed?.status, 'LEFT');
    eq('...at the time it was expected to end, not when the sweep ran',
      closed?.exitedAt?.getTime(), due.getTime());
    eq('...marked as the guess it is, so the accuracy figure stays honest',
      closed?.isEstimated, true);
    eq('...and recorded as an automatic close, not a guard\'s tap',
      closed?.exitSource, 'AUTO_CLOSE');

    eq('a visitor who is not due yet is left alone',
      (await VisitorEntry.findById(notDue._id).lean())?.status, 'INSIDE');
    eq('...and nobody is nagged about a visit the society chose not to chase',
      (await listForUser(SID, String(homeowner))).items.length, before);

    const day = await reconcileDay(SID);
    ok('the day\'s reconciliation counts it as estimated, never as recorded',
      day.estimated >= 1 && day.exitsRecorded === 0,
      JSON.stringify(day));

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
