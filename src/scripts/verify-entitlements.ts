/**
 * Phase 2 — the four gates.
 *
 * Every assertion here FAILS against the code as it stood before this phase.
 *
 *   GATE 1  PLAN       0 = not sold. Was never consulted outside two routes.
 *   GATE 2  SOCIETY    modules, now intersected with the plan.
 *   GATE 3  ROLE       AccessRole — phase 1; here only the catalogue filter.
 *   GATE 4  RESIDENTS  new; did not exist in any form.
 *
 * The persona that matters is a society on a plan that excludes a module. Before
 * this, they saw the menu, opened the page, filled in the form, and only then
 * met an error — if they met one at all, because five of the seven plan
 * capabilities were enforced nowhere.
 *
 *   npx tsx src/scripts/verify-entitlements.ts
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
import { Plan } from '../models/plan.model';
import { Subscription } from '../models/subscription.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { SocietyStaff } from '../models/society-staff.model';
import { AccessRole } from '../models/access-role.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { Complaint } from '../models/complaint.model';
import { ComplaintCategory } from '../models/complaint-category.model';
import { ComplaintEvent } from '../models/complaint-event.model';
import {
  resolveEntitlements, resolveOpsModules, planAllows, planLimit, offeredPermissionsFor,
} from '../services/entitlement.service';
import { generateAccessToken } from '../utils/jwt.util';
import { UserRole, TenantType } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();
const SID = societyId.toString();
const planIds: mongoose.Types.ObjectId[] = [];

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};

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

/** Put the society on a plan with exactly these capabilities. */
async function putOnPlan(caps: Record<string, number>, admin: mongoose.Types.ObjectId) {
  const plan = await Plan.create({
    name: `Throwaway ${new mongoose.Types.ObjectId()}`, basePrice: 100,
    module: 'society', capabilities: caps, isSystem: true,
  } as any);
  planIds.push(plan._id as any);
  await Subscription.deleteMany({ tenantId: societyId });
  await Subscription.create({
    tenantType: 'SOCIETY', tenantId: societyId, planId: plan._id, tenure: 'yearly',
    status: 'active', startDate: new Date('2026-01-01'), endDate: new Date('2027-01-01'),
    capabilities: caps,
    createdBy: admin, createdByName: 'Setup', updatedBy: admin, updatedByName: 'Setup',
  } as any);
}

async function cleanup() {
  await Promise.all([
    Society.deleteMany({ _id: societyId }), Block.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Resident.deleteMany({ societyId }),
    SocietyOpsPolicy.deleteMany({ societyId }), SocietyStaff.deleteMany({ societyId }),
    AccessRole.deleteMany({ societyId }), VisitorEntry.deleteMany({ societyId }),
    Complaint.deleteMany({ societyId }), ComplaintCategory.deleteMany({ societyId }),
    ComplaintEvent.deleteMany({ societyId }),
    Subscription.deleteMany({ tenantId: societyId }),
    Plan.deleteMany({ _id: { $in: planIds } }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    const admin = await mkUser('Admin', UserRole.SOCIETY_ADMIN);
    const resident = await mkUser('Resident', UserRole.RESIDENT_OWNER);

    const audit = {
      societyId, createdBy: admin, createdByName: 'Setup',
      updatedBy: admin, updatedByName: 'Setup',
    };

    await Society.create({
      _id: societyId, name: `Throwaway ${SID}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: admin,
      createdBy: admin, createdByName: 'Setup', updatedBy: admin, updatedByName: 'Setup',
    } as any);
    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const flat = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing',
      number: '101', status: FlatStatus.OWNER_OCCUPIED, ownerUserId: resident,
    });
    await Resident.create({
      ...audit, flatId: flat._id, userId: resident, person: { name: 'Resident' },
      relationship: 'OWNER', householdType: 'OWNER', isActive: true,
    });

    const adminTk = tokenFor(admin, UserRole.SOCIETY_ADMIN);
    const residentTk = tokenFor(resident, UserRole.RESIDENT_OWNER);
    const auth = (tk: string) => ({ Authorization: `Bearer ${tk}` });

    // ================================================== the 0 / -1 / N reading
    console.log('Gate 1 — a plan capability is a number, and 0 is load-bearing');
    ok('0 means not sold', !planAllows({ max_visitor_count: 0 }, 'max_visitor_count'));
    ok('a positive number means sold', planAllows({ max_visitor_count: 50 }, 'max_visitor_count'));
    ok('absent means unlimited, not missing', planAllows({}, 'max_visitor_count'));
    ok('-1 reads as no ceiling', planLimit({ max_visitor_count: -1 }, 'max_visitor_count') === null);
    ok('N reads as a ceiling', planLimit({ max_visitor_count: 50 }, 'max_visitor_count') === 50);

    // ============================================ gate 1 ∩ gate 2 for modules
    console.log('\nGate 1 ∩ Gate 2 — a module must be both sold and switched on');

    // The plan you described: visitors 0, complaints 0, finance generous.
    await putOnPlan({
      max_visitor_count: 0, max_tickets_count: 0, max_staff_count: 5,
      max_flat_count: 50, max_member_count: 200, max_finance_modules: 30,
    }, admin);

    const modules = await resolveOpsModules(SID, {
      max_visitor_count: 0, max_tickets_count: 0, max_staff_count: 5,
    });
    ok('a module the plan excludes is gone', !modules.includes('GATE') && !modules.includes('COMPLAINTS'));
    ok('...and one it includes survives', modules.includes('STAFF'));

    const ent = await resolveEntitlements(SID, String(admin), UserRole.SOCIETY_ADMIN);
    ok('the resolver agrees', !ent.opsModules.includes('GATE'));
    ok('finance is on when the plan sells it', ent.hasFinance);

    // A society cannot switch on what it did not buy.
    await SocietyOpsPolicy.create({
      ...audit, modules: ['GATE', 'COMPLAINTS', 'STAFF'],
    } as any);
    const afterOptIn = await resolveOpsModules(SID, { max_visitor_count: 0 });
    ok('an admin cannot switch on a module the plan excludes',
      !afterOptIn.includes('GATE'), JSON.stringify(afterOptIn));

    // =================================================== 404, not a menu item
    console.log('\n...and the API says it does not exist, rather than refusing');
    const gateCall = await request(app).get('/api/v1/gate/entries').set(auth(adminTk));
    ok('an excluded module 404s for the admin too', gateCall.status === 404,
      `got ${gateCall.status}`);
    ok('...with a reason a screen can act on',
      gateCall.body?.code === 'MODULE_NOT_AVAILABLE', JSON.stringify(gateCall.body));

    const complaintCall = await request(app).get('/api/v1/complaints').set(auth(residentTk));
    ok('the complaints desk is gone too', complaintCall.status === 404,
      `got ${complaintCall.status}`);

    // ============================================== the catalogue is filtered
    const offered = offeredPermissionsFor(['STAFF'], true);
    ok('the role editor stops offering gate permissions',
      !offered.includes('GATE_CONSOLE') && !offered.includes('COMPLAINTS_MANAGE'));
    ok('...still offers the ones that apply',
      offered.includes('STAFF_VIEW') && offered.includes('FINANCE_VIEW'));
    ok('...and drops finance when the plan has none',
      !offeredPermissionsFor(['STAFF'], false).includes('FINANCE_VIEW'));

    // ==================================================== capacity, gate 1(b)
    console.log('\nGate 1 — the numeric half, on capabilities that had no check at all');
    await putOnPlan({
      max_visitor_count: 500, max_tickets_count: 500, max_staff_count: 1,
      max_flat_count: 50, max_member_count: 200, max_finance_modules: 30,
    }, admin);
    await SocietyOpsPolicy.updateOne({ societyId }, { $set: { modules: ['GATE', 'COMPLAINTS', 'STAFF'] } });

    const first = await request(app).post('/api/v1/staff').set(auth(adminTk)).send({
      name: 'Only Guard', phone: '9876500001', designation: 'SECURITY_GUARD',
      employmentType: 'DIRECT',
    });
    ok('the first staff member fits the plan', first.status === 201, `got ${first.status}`);

    const second = await request(app).post('/api/v1/staff').set(auth(adminTk)).send({
      name: 'One Too Many', phone: '9876500002', designation: 'SECURITY_GUARD',
      employmentType: 'DIRECT',
    });
    ok('the second is refused by the plan', second.status === 402, `got ${second.status}`);
    ok('...and the message says the number, the thing and what to do',
      /covers 1 staff/.test(String(second.body?.message)) && /upgrade/i.test(String(second.body?.message)),
      String(second.body?.message));

    // ==================================================== gate 4 — residents
    console.log('\nGate 4 — what residents are offered (did not exist before)');

    const entWithFeatures = await resolveEntitlements(SID, String(resident), UserRole.RESIDENT_OWNER);
    ok('residents may invite guests by default',
      entWithFeatures.residentFeatures.visitorInvite === true);
    ok('...and may not request parking by default',
      entWithFeatures.residentFeatures.parkingRequest === false);

    await SocietyOpsPolicy.updateOne({ societyId },
      { $set: { 'residentFeatures.visitorInvite': false } });

    const invite = await request(app).post('/api/v1/gate/passes').set(auth(residentTk))
      .send({ flatId: String(flat._id), visitorName: 'Guest', category: 'GUEST' });
    ok('a resident is refused when the society handles it at the office',
      invite.status === 403, `got ${invite.status}`);
    ok('...and is told where to go instead',
      invite.body?.code === 'FEATURE_OFF_FOR_RESIDENTS', JSON.stringify(invite.body));

    // The office is NOT governed by a resident switch. It is still refused
    // here, but for the pre-existing reason that issuing a pass is a
    // RESIDENT's act and an admin does not live in flat 101 — what matters is
    // that gate 4 is not what stopped them.
    const officeInvite = await request(app).post('/api/v1/gate/passes').set(auth(adminTk))
      .send({ flatId: String(flat._id), visitorName: 'Guest', category: 'GUEST' });
    ok('...while the resident switch does not bind the office',
      officeInvite.body?.code !== 'FEATURE_OFF_FOR_RESIDENTS',
      JSON.stringify(officeInvite.body));

    // ============================================== one call, and it is closed
    console.log('\nOne resolver, and it fails closed');
    const mine = await request(app).get('/api/v1/me/entitlements').set(auth(residentTk));
    ok('/me/entitlements answers all four gates at once', mine.status === 200);
    ok('...ops modules', Array.isArray(mine.body?.data?.opsModules));
    ok('...permissions', typeof mine.body?.data?.permissions === 'object');
    ok('...resident features', typeof mine.body?.data?.residentFeatures === 'object');
    ok('...and the plan', typeof mine.body?.data?.plan?.name === 'string');
    ok('a resident is not shown the society\'s usage figures',
      mine.body?.data?.usage === undefined);
    ok('...but the admin is',
      Array.isArray((await request(app).get('/api/v1/me/entitlements')
        .set(auth(adminTk))).body?.data?.usage));

    /**
     * The load-bearing property: when resolution FAILS, everything is off.
     *
     * This is the whole reason the endpoint exists. The three calls it replaces
     * each returned `null` on error and the client read `null` as "apply no
     * filtering", so one slow moment showed a resident the full admin menu.
     *
     * A malformed society id is the cheapest way to make the resolver throw
     * for real, rather than asserting against a stub. Note this is NOT the same
     * as an *unknown* society, which correctly resolves to free-tier defaults —
     * a brand-new society has no policy row either.
     */
    const broken = await resolveEntitlements('not-an-object-id', String(resident), UserRole.RESIDENT_OWNER);
    ok('a failure to resolve grants no ops modules', broken.opsModules.length === 0);
    ok('...no finance modules', broken.financeModules.length === 0);
    ok('...no permissions', Object.keys(broken.permissions).length === 0);
    ok('...no resident features', Object.keys(broken.residentFeatures).length === 0);
    ok('...and is emphatically not an admin', broken.isAdmin === false);

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
