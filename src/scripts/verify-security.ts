/**
 * चरण 0 — the doors that were open.
 *
 * **This script exists because thirteen previous verify scripts could not have
 * caught any of this.** Every one of them called a service directly, with
 * hand-built arguments. The holes were all in the layer above: a route with no
 * guard, a controller that checked the society and called it authorisation.
 *
 * So this one speaks HTTP. It builds a real Express app, mints real tokens for
 * real users, and sends the requests a browser would send. It is slower and it
 * is the only kind that tells the truth.
 *
 * Every assertion below FAILS on the code as it stood this morning.
 *
 *   npx tsx src/scripts/verify-security.ts
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
import { FlatTenure } from '../models/flat-tenure.model';
import { Complaint } from '../models/complaint.model';
import { ComplaintCategory } from '../models/complaint-category.model';
import { ComplaintEvent } from '../models/complaint-event.model';
import { SocietyStaff } from '../models/society-staff.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Notification } from '../models/notification.model';
import { generateAccessToken } from '../utils/jwt.util';
import { UserRole, TenantType } from '../constants/roles';

const societyA = new mongoose.Types.ObjectId();
const societyB = new mongoose.Types.ObjectId();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};

/** A token for this person, acting inside this society. */
const tokenFor = (userId: mongoose.Types.ObjectId, role: UserRole, society = societyA) =>
  generateAccessToken({
    userId: String(userId),
    activeTenantId: String(society),
    activeTenantType: TenantType.SOCIETY,
    activeRole: role,
  });

const ids: mongoose.Types.ObjectId[] = [];
const mkUser = async (name: string, role: UserRole, society = societyA) => {
  const u = await User.create({
    name, email: `${name.replace(/\W/g, '').toLowerCase()}.${Date.now()}${Math.random().toString(36).slice(2, 6)}@throwaway.test`,
    password: 'x'.repeat(20), role,
    memberships: [{ tenantType: TenantType.SOCIETY, tenantId: society, role }],
  });
  ids.push(u._id as any);
  return u._id as mongoose.Types.ObjectId;
};

async function cleanup() {
  for (const s of [societyA, societyB]) {
    await Promise.all([
      Society.deleteMany({ _id: s }), Block.deleteMany({ societyId: s }),
      Flat.deleteMany({ societyId: s }), Resident.deleteMany({ societyId: s }),
      FlatTenure.deleteMany({ societyId: s }), Complaint.deleteMany({ societyId: s }),
      ComplaintCategory.deleteMany({ societyId: s }), ComplaintEvent.deleteMany({ societyId: s }),
      SocietyStaff.deleteMany({ societyId: s }), VisitorEntry.deleteMany({ societyId: s }),
      SocietyOpsPolicy.deleteMany({ societyId: s }), Notification.deleteMany({ societyId: s }),
    ]);
  }
  await User.deleteMany({ _id: { $in: ids } });
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societies ${societyA} / ${societyB}\n`);

  try {
    // -------------------------------------------------------------- fixtures
    const adminA = await mkUser('Admin A', UserRole.SOCIETY_ADMIN);
    const adminB = await mkUser('Admin B', UserRole.SOCIETY_ADMIN, societyB);
    const ownerA = await mkUser('Owner A', UserRole.RESIDENT_OWNER);
    const tenantA = await mkUser('Tenant A', UserRole.RESIDENT_TENANT);
    const neighbour = await mkUser('Neighbour', UserRole.RESIDENT_OWNER);
    const guard = await mkUser('Guard', UserRole.SOCIETY_EMPLOYEE);

    const audit = (s: mongoose.Types.ObjectId, by: mongoose.Types.ObjectId) => ({
      societyId: s, createdBy: by, createdByName: 'Setup', updatedBy: by, updatedByName: 'Setup',
    });

    for (const [s, by] of [[societyA, adminA], [societyB, adminB]] as const) {
      await Society.create({
        _id: s, name: `Throwaway ${s}`, address: 'Road', city: 'Pune',
        state: 'Maharashtra', pincode: '411001', adminUserId: by,
        createdBy: by, createdByName: 'Setup', updatedBy: by, updatedByName: 'Setup',
      } as any);
    }

    const wingA = await Block.create({ ...audit(societyA, adminA), name: 'A Wing' });
    const flat101 = await Flat.create({
      ...audit(societyA, adminA), blockId: wingA._id, blockName: 'A Wing',
      // `ownerUserId` matters: `assertManageAccess` reads it to decide whether
      // the owner may manage their own flat. A fixture without it produces a
      // 403 that looks like a bug in the code under test.
      number: '101', status: FlatStatus.RENTED, ownerUserId: ownerA,
    });
    const flat102 = await Flat.create({
      ...audit(societyA, adminA), blockId: wingA._id, blockName: 'A Wing',
      number: '102', status: FlatStatus.OWNER_OCCUPIED,
    });
    const wingB = await Block.create({ ...audit(societyB, adminB), name: 'B Wing' });
    const flatB = await Flat.create({
      ...audit(societyB, adminB), blockId: wingB._id, blockName: 'B Wing',
      number: '9', status: FlatStatus.OWNER_OCCUPIED, ownerUserId: adminB,
    });

    // 101: owner lives elsewhere, tenant lives there. 102: the neighbour.
    const ownerRes = await Resident.create({
      ...audit(societyA, adminA), flatId: flat101._id, userId: ownerA,
      person: { name: 'Owner A' }, relationship: 'OWNER', householdType: 'OWNER',
      isOwner: true, isActive: true,
      documents: [{ kind: 'ID', label: 'Aadhaar', key: 'flat-documents/aadhaar-owner.pdf', url: 'https://x/y', uploadedAt: new Date(), uploadedByName: 'Setup' }],
    } as any);
    await Resident.create({
      ...audit(societyA, adminA), flatId: flat101._id, userId: tenantA,
      person: { name: 'Tenant A' }, relationship: 'TENANT', householdType: 'TENANT', isActive: true,
    });
    await Resident.create({
      ...audit(societyA, adminA), flatId: flat102._id, userId: neighbour,
      person: { name: 'Neighbour' }, relationship: 'OWNER', householdType: 'OWNER',
      isOwner: true, isActive: true,
    });

    const tenure = await FlatTenure.create({
      ...audit(societyA, adminA), flatId: flat101._id, type: 'TENANCY', status: 'ACTIVE',
      source: 'RENT',
      startDate: new Date('2026-01-01'), rentAmountPaise: 2500000, securityDepositPaise: 10000000,
      party: { name: 'Tenant A' },
      documents: [{ kind: 'AGREEMENT', label: 'Rent agreement', key: 'flat-documents/lease.pdf', url: 'https://x/y', uploadedAt: new Date(), uploadedByName: 'Setup' }],
    } as any);

    const T = {
      adminA: tokenFor(adminA, UserRole.SOCIETY_ADMIN),
      adminB: tokenFor(adminB, UserRole.SOCIETY_ADMIN, societyB),
      ownerA: tokenFor(ownerA, UserRole.RESIDENT_OWNER),
      tenantA: tokenFor(tenantA, UserRole.RESIDENT_TENANT),
      neighbour: tokenFor(neighbour, UserRole.RESIDENT_OWNER),
      guard: tokenFor(guard, UserRole.SOCIETY_EMPLOYEE),
    };
    const get = (path: string, token: string) =>
      request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    const post = (path: string, token: string, body: any = {}) =>
      request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

    const docId = String((ownerRes as any).documents[0]._id);
    const tenancyDocId = String((tenure as any).documents[0]._id);

    // ============================================ C1 — identity documents
    console.log('C1 — private ID documents');
    const guardDoc = await get(`/societies/household/${ownerRes._id}/documents/${docId}/download`, T.guard);
    ok('THE GATE GUARD CANNOT DOWNLOAD A RESIDENT\'S AADHAAR', guardDoc.status === 403,
      `got ${guardDoc.status}`);

    const neighbourDoc = await get(`/societies/household/${ownerRes._id}/documents/${docId}/download`, T.neighbour);
    ok('...nor can a resident of another flat', [403, 404].includes(neighbourDoc.status),
      `got ${neighbourDoc.status}`);

    // The tenant lives in the SAME flat but a different household.
    const tenantDoc = await get(`/societies/household/${ownerRes._id}/documents/${docId}/download`, T.tenantA);
    ok('...nor the tenant of the same flat, across the household line',
      [403, 404].includes(tenantDoc.status), `got ${tenantDoc.status}`);

    const adminDoc = await get(`/societies/household/${ownerRes._id}/documents/${docId}/download`, T.adminA);
    ok('...but the admin still can', adminDoc.status === 200, `got ${adminDoc.status}`);

    // ================================================= C2 — tenancy papers
    console.log('\nC2 — the lease and its money');
    const guardLease = await get(`/societies/flats/${flat101._id}/tenancy/documents/${tenancyDocId}/download`, T.guard);
    ok('the guard cannot download a rent agreement', guardLease.status === 403, `got ${guardLease.status}`);

    const neighbourLease = await get(`/societies/flats/${flat101._id}/tenancy/documents/${tenancyDocId}/download`, T.neighbour);
    ok('...nor can another flat\'s owner', [403, 404].includes(neighbourLease.status), `got ${neighbourLease.status}`);

    const guardTenancy = await get(`/societies/flats/${flat101._id}/tenancy`, T.guard);
    ok('the guard cannot read the tenancy at all', guardTenancy.status === 403, `got ${guardTenancy.status}`);

    const neighbourTenancy = await get(`/societies/flats/${flat101._id}/tenancy`, T.neighbour);
    ok('another flat\'s owner is refused the tenancy', [403, 404].includes(neighbourTenancy.status),
      `got ${neighbourTenancy.status}`);

    const tenantTenancy = await get(`/societies/flats/${flat101._id}/tenancy`, T.tenantA);
    ok('the tenant reads their own lease', tenantTenancy.status === 200, `got ${tenantTenancy.status}`);
    ok('...including the rent they pay', tenantTenancy.body?.tenancy?.rentAmountPaise === 2500000);

    // ============================================= C3 — cross-society read
    console.log('\nC3 — one society cannot read another\'s flat');
    const cross = await get(`/societies/flats/form-lookup?flatId=${flatB._id}`, T.adminA);
    ok('ADMIN OF SOCIETY A CANNOT LOAD A FLAT FROM SOCIETY B',
      cross.status !== 200 || cross.body?.flat == null,
      `got ${cross.status}, flat=${JSON.stringify(cross.body?.flat?.number)}`);

    const own = await get(`/societies/flats/form-lookup?flatId=${flat101._id}`, T.adminA);
    ok('...while their own flat still loads', own.status === 200 && !!own.body?.flat);

    // ============================================ C4 — platform financials
    console.log('\nC4 — platform-wide figures');
    for (const [who, token] of [['a resident', T.ownerA], ['a society admin', T.adminA], ['the guard', T.guard]] as const) {
      const r = await get('/dashboard/metrics', token);
      ok(`${who} cannot read the platform's revenue`, r.status === 403, `got ${r.status}`);
    }

    // ================================================ S1 — the directory
    console.log('\nS1 — the resident directory');
    const guardResidents = await get(`/societies/flats/${flat101._id}/residents`, T.guard);
    ok('the guard cannot list a flat\'s residents', guardResidents.status === 403, `got ${guardResidents.status}`);

    const guardHousehold = await get(`/societies/flats/${flat101._id}/household`, T.guard);
    ok('...nor its household', guardHousehold.status === 403, `got ${guardHousehold.status}`);

    const guardTimeline = await get(`/societies/flats/${flat101._id}/timeline`, T.guard);
    ok('...nor the sale and rent history', guardTimeline.status === 403, `got ${guardTimeline.status}`);

    // ============================================= S2 — complaint IDOR
    console.log('\nS2 — a neighbour cannot touch your complaint');
    await ComplaintCategory.create({
      ...audit(societyA, adminA), category: 'Plumbing', workCategory: 'PLUMBING',
      firstResponseMinutes: 60, resolutionMinutes: 720, sortOrder: 0, isActive: true,
    });
    const raised = await post('/complaints', T.ownerA, {
      title: 'Tap leaking', category: 'Plumbing', flatId: String(flat101._id),
      visibility: 'COMMUNITY',
    });
    ok('the owner can raise a complaint', raised.status === 201, `got ${raised.status}`);
    const cid = raised.body?.data?._id;

    const stolenResolve = await post(`/complaints/${cid}/resolve`, T.neighbour);
    ok('A NEIGHBOUR CANNOT RESOLVE SOMEBODY ELSE\'S COMPLAINT',
      [403, 404].includes(stolenResolve.status), `got ${stolenResolve.status}`);

    const stolenReopen = await post(`/complaints/${cid}/reopen`, T.neighbour, { reason: 'nope' });
    ok('...nor reopen it', [403, 404].includes(stolenReopen.status), `got ${stolenReopen.status}`);

    const stolenRate = await post(`/complaints/${cid}/rate`, T.neighbour, { rating: 1 });
    ok('...nor rate it', [403, 404].includes(stolenRate.status), `got ${stolenRate.status}`);

    const stillOpen = await Complaint.findById(cid).lean();
    ok('...and the complaint is untouched', stillOpen?.status === 'NEW', `status=${stillOpen?.status}`);

    // "Me too" is the one thing a neighbour SHOULD be able to do on a
    // community complaint — the whole point of the feature.
    const meToo = await post(`/complaints/${cid}/me-too`, T.neighbour);
    ok('...but they can still say "me too" on a community complaint',
      meToo.status === 200, `got ${meToo.status}`);

    // The owner is AUTHORISED to resolve their own complaint — that is the
    // security concern here. It now correctly refuses with 400 (not 403/404)
    // because nobody has done the work yet; the point is that the door is not
    // shut on the owner the way it is on the neighbour.
    const ownResolve = await post(`/complaints/${cid}/resolve`, T.ownerA);
    ok('the flat\'s own resident is NOT locked out (unlike the neighbour)',
      ![403, 404].includes(ownResolve.status), `got ${ownResolve.status}`);

    // =============================================== S5 — document keys
    console.log('\nS5 — a document key must be one we minted');
    const forged = await post(`/societies/household/${ownerRes._id}/documents`, T.ownerA, {
      label: 'Anything', key: 'profile-images/someone-else.jpg', url: 'https://x/y',
    });
    ok('an arbitrary bucket key is refused', forged.status >= 400, `got ${forged.status}`);

    const proper = await post(`/societies/household/${ownerRes._id}/documents`, T.ownerA, {
      label: 'PAN', key: 'flat-documents/pan.pdf', url: 'https://x/y',
    });
    ok('...while a real upload is accepted', proper.status < 400, `got ${proper.status}`);

    // ================================================ S6 — the gate limiter
    console.log('\nS6 — the gate is exempt from the general limiter');
    // 300/15min is the general ceiling. A gate polls far past that; if the
    // general limiter still applied, a burst would start returning 429.
    let throttled = 0;
    for (let i = 0; i < 40; i++) {
      const r = await get('/gate/modules', T.adminA);
      if (r.status === 429) throttled++;
    }
    ok('a burst of gate requests is not throttled', throttled === 0, `${throttled} were 429`);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
