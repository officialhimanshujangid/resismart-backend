/**
 * Tier 2 of the "Gate" → "Visitor Management" rename: the routes moved.
 *
 * `/api/v1/gate` → `/api/v1/visitors`, `/dashboard/gate/*` →
 * `/dashboard/visitors/*`. Everything here exists because a rename of a live
 * path has three ways to hurt somebody, none of which a type checker sees:
 *
 *   1. The gate device's rate-limiter exemption in `app.ts` was keyed on the
 *      literal string `/v1/gate`. Move the mount without it and a guard's
 *      tablet drops from its 2000/15min device tier to the 300/15min human
 *      tier, gets throttled mid-shift, and the guard falls back to paper — at
 *      which point the evening's register is simply lost. That predicate is now
 *      derived from the mount list, and this asserts on it directly, because a
 *      test that had to send 301 requests to catch it would never be run.
 *
 *   2. Clients in the field call the old prefix. A guard tablet holds a cached
 *      bundle; it must keep working for the release in which both are mounted.
 *      So the old prefix is asserted just as hard as the new one — and asserted
 *      to be the SAME router, not a second copy with its own limiter.
 *
 *   3. Ninety days of notification rows carry `link: '/dashboard/gate/log?id=…'`
 *      and the rename does not rewrite them. Those rows are checked to be
 *      untouched (rewriting them is the migration we are avoiding), newly
 *      written rows are checked to use the new shape, and the frontend redirect
 *      table is checked to cover the old shape — including the ordering trap,
 *      where `/dashboard/gate/:path*` matches the bare `/dashboard/gate` too and
 *      would send the console to a directory that has no page.
 *
 *   npx tsx src/scripts/verify-visitor-routes.ts
 */
import '../config/timezone'; // MUST stay first
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import request from 'supertest';
import { appConfig } from '../config/appConfig';
import app, { VISITOR_MOUNTS, isVisitorPath } from '../app';
import { User } from '../models/user.model';
import { Society } from '../models/society.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { SocietyStaff } from '../models/society-staff.model';
import { VisitorEntry } from '../models/visitor-entry.model';
import { SocietyOpsPolicy } from '../models/society-ops-policy.model';
import { Notification } from '../models/notification.model';
import { AccessRole } from '../models/access-role.model';
import { Gate } from '../models/gate.model';
import { createStaff } from '../services/staff.service';
import { generateAccessToken } from '../utils/jwt.util';
import { UserRole, TenantType } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();
const SID = String(societyId);

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const settle = () => new Promise(r => setTimeout(r, 300));

const tokenFor = (userId: mongoose.Types.ObjectId, role: UserRole) =>
  generateAccessToken({
    userId: String(userId), activeTenantId: SID,
    activeTenantType: TenantType.SOCIETY, activeRole: role,
  });

const ids: mongoose.Types.ObjectId[] = [];
const mkUser = async (name: string, role: UserRole) => {
  const u = await User.create({
    name, email: `${name.replace(/\W/g, '').toLowerCase()}.${Date.now()}${Math.random().toString(36).slice(2, 6)}@throwaway.test`,
    password: 'x'.repeat(20), role,
    memberships: [{ tenantType: TenantType.SOCIETY, tenantId: societyId, role }],
  });
  ids.push(u._id as any);
  return u._id as mongoose.Types.ObjectId;
};

async function cleanup() {
  const q = { societyId };
  await Promise.all([
    Society.deleteMany({ _id: societyId }), Block.deleteMany(q), Flat.deleteMany(q),
    Resident.deleteMany(q), SocietyStaff.deleteMany(q), VisitorEntry.deleteMany(q),
    SocietyOpsPolicy.deleteMany(q), Notification.deleteMany(q), AccessRole.deleteMany(q),
    Gate.deleteMany(q),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
}

// The frontend's redirect table, read as text. A backend script cannot ask
// Next.js to resolve a URL, but it can assert the rules that make the old links
// resolve are present and in the order that makes them correct — which is the
// part a person editing next.config.ts later is most likely to get wrong.
const nextConfig = () => {
  const p = path.resolve(__dirname, '../../../frontend/next.config.ts');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    // ------------------------------------------------------------- fixtures
    const adminId = await mkUser('Admin', UserRole.SOCIETY_ADMIN);
    const guardUser = await mkUser('Guard Ramesh', UserRole.SOCIETY_EMPLOYEE);
    const ownerId = await mkUser('Owner Rao', UserRole.RESIDENT_OWNER);
    const actor = { userId: String(adminId), userName: 'Admin' };

    const audit = {
      societyId, createdBy: adminId, createdByName: 'Setup',
      updatedBy: adminId, updatedByName: 'Setup',
    };

    await Society.create({
      _id: societyId, name: `Throwaway ${SID}`, address: 'Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411001', adminUserId: adminId,
      createdBy: adminId, createdByName: 'Setup', updatedBy: adminId, updatedByName: 'Setup',
    } as any);
    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const flat = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing', number: '101',
      status: FlatStatus.OWNER_OCCUPIED, ownerUserId: ownerId,
    });
    await Resident.create({
      ...audit, flatId: flat._id, userId: ownerId, person: { name: 'Owner Rao' },
      relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isActive: true,
    });

    const guardStaff = await createStaff(String(societyId), {
      name: 'Guard Ramesh', phone: '9800000019', designation: 'SECURITY_GUARD',
    }, actor);
    const role = await AccessRole.create({
      ...audit, name: 'Gatekeeper', isActive: true,
      permissions: [
        { module: 'GATE_CONSOLE', level: 'FULL' }, { module: 'GATE_LOGS', level: 'FULL' },
        { module: 'OPS_SETTINGS', level: 'FULL' },
      ],
      scope: { allBlocks: true, blockIds: [] },
    });
    await SocietyStaff.updateOne(
      { _id: guardStaff._id },
      { $set: { userId: guardUser, accessRoleId: role._id } },
    );

    const adminT = tokenFor(adminId, UserRole.SOCIETY_ADMIN);
    const guardT = tokenFor(guardUser, UserRole.SOCIETY_EMPLOYEE);
    const ownerT = tokenFor(ownerId, UserRole.RESIDENT_OWNER);
    const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
    const get = (p: string, t: string) => request(app).get(p).set(auth(t));
    const post = (p: string, t: string, body: any = {}) =>
      request(app).post(p).set(auth(t)).send(body);

    // ================================================ 1. the new prefix works
    console.log('1 — /api/v1/visitors is the module');

    const created = await post('/api/v1/visitors/gates', adminT, {
      code: 'G1', name: 'Main Gate', kind: 'MAIN', handlesEntry: true, handlesExit: true,
    });
    eq('a gate can be created at the new prefix', created.status, 201);

    const listedNew = await get('/api/v1/visitors/gates', guardT);
    eq('...and read back there', listedNew.status, 200);
    eq('...with the gate in it',
      (listedNew.body?.data || []).some((g: any) => g.code === 'G1'), true);

    eq('the register is reachable at the new prefix',
      (await get('/api/v1/visitors/entries', adminT)).status, 200);
    eq('so is the setup checklist',
      (await get('/api/v1/visitors/setup', guardT)).status, 200);
    eq('so is a resident-facing route',
      (await get('/api/v1/visitors/approvals/mine', ownerT)).status, 200);

    // ============================================= 2. the old prefix survives
    console.log('\n2 — /api/v1/gate still answers, for one more release');

    const listedOld = await get('/api/v1/gate/gates', guardT);
    eq('the old prefix has not 404ed', listedOld.status, 200);
    ok('...and returns the same gates as the new one',
      JSON.stringify(listedOld.body?.data) === JSON.stringify(listedNew.body?.data),
      `old=${JSON.stringify(listedOld.body?.data)?.slice(0, 120)}`);

    eq('the register is reachable at the old prefix',
      (await get('/api/v1/gate/entries', adminT)).status, 200);
    eq('...and so is the resident-facing route',
      (await get('/api/v1/gate/approvals/mine', ownerT)).status, 200);

    // Same router instance, not a second copy: a duplicate mount would carry a
    // duplicate rate limiter, so the device's 2000 requests would be counted
    // twice over and run out at half the intended budget.
    const [{ handle: mounted }] = (app as any)._router.stack
      .filter((l: any) => l.name === 'router' && l.handle?.stack?.some(
        (s: any) => s.route?.path === '/inside'));
    const visitorLayers = (app as any)._router.stack
      .filter((l: any) => l.handle === mounted);
    eq('both prefixes are the same router object, mounted twice',
      visitorLayers.length, VISITOR_MOUNTS.length);

    // Authorisation did not soften on either. The rename must not have quietly
    // widened anything: the guard has GATE_CONSOLE but not the admin's rights.
    eq('the old prefix still refuses what the new one refuses',
      (await post('/api/v1/gate/gates', ownerT, { code: 'G2', name: 'Side' })).status,
      (await post('/api/v1/visitors/gates', ownerT, { code: 'G2', name: 'Side' })).status);

    // A neighbouring name is NOT the module — the exemption below is a prefix
    // test, and a sloppy one would hand `/v1/gateway-webhooks` the device tier.
    eq('a lookalike prefix is not the module',
      (await get('/api/v1/gateway/entries', adminT)).status, 404);

    // ====================================== 3. the rate-limiter exemption
    console.log('\n3 — the gate device keeps its own limiter');

    // This is the assertion the whole task turned on. Exercising the limiter
    // would take 301 requests; the predicate is what actually decides, so the
    // predicate is what is asserted.
    for (const mount of VISITOR_MOUNTS) {
      const asPath = mount.replace(/^\/api/, '');
      ok(`${mount} is exempt from the app-wide limiter`, isVisitorPath(asPath));
      ok(`...and so is everything under it`, isVisitorPath(`${asPath}/entries`));
      ok(`...including a nested path`, isVisitorPath(`${asPath}/passes/scanner-config`));
    }
    ok('the new prefix is exempt by name', isVisitorPath('/v1/visitors/inside'));
    ok('the old prefix is still exempt by name', isVisitorPath('/v1/gate/inside'));

    ok('a different module is NOT exempt', !isVisitorPath('/v1/complaints'));
    ok('...nor is one whose name merely starts the same',
      !isVisitorPath('/v1/gateway/webhooks'));
    ok('...nor is /v1/visitorsomething', !isVisitorPath('/v1/visitorsomething'));
    ok('...nor is a path that only contains the name',
      !isVisitorPath('/v1/admin/v1/visitors'));

    // The drift guard. Every mounted prefix must be exempt; that is only
    // guaranteed while both come from VISITOR_MOUNTS.
    ok('every mounted prefix is covered by the exemption',
      VISITOR_MOUNTS.every(m => isVisitorPath(m.replace(/^\/api/, ''))),
      JSON.stringify(VISITOR_MOUNTS));

    // ============================== 4. backend-supplied dashboard hrefs
    console.log('\n4 — the links the backend hands out point at the new screens');

    const setup = await get('/api/v1/visitors/setup', guardT);
    const hrefs: string[] = (setup.body?.data?.steps || setup.body?.steps || [])
      .map((s: any) => s.href).filter(Boolean);
    ok('the checklist returned steps with links', hrefs.length > 0,
      JSON.stringify(setup.body)?.slice(0, 200));
    ok('...and none of them still points at /dashboard/gate',
      hrefs.every(h => !h.startsWith('/dashboard/gate')), JSON.stringify(hrefs));
    ok('...with the visitor steps on the new path',
      hrefs.some(h => h.startsWith('/dashboard/visitors/')), JSON.stringify(hrefs));

    // ======================= 5. a newly written notification uses the new link
    console.log('\n5 — new notifications carry the new link');

    const admitted = await post('/api/v1/visitors/entries', guardT, {
      category: 'GUEST', visitorName: 'Courier Anil', flatId: String(flat._id),
    });
    eq('an arrival is recorded through the new prefix', admitted.status, 201);
    await settle();

    const fresh = await Notification.findOne({ societyId, kind: 'GATE_ENTRY' })
      .sort({ createdAt: -1 }).lean();
    ok('the resident was told', !!fresh, 'no GATE_ENTRY notification was written');
    ok('...and the link points at the new screen',
      !!fresh?.link?.startsWith('/dashboard/visitors/log'), String(fresh?.link));
    // Tier 3 stays put: `kind` drives residents' mute preferences and is stored
    // on every row already written. Renaming it needs a migration for no gain.
    eq('...while the notification KIND is deliberately unchanged', fresh?.kind, 'GATE_ENTRY');

    // ==================== 6. a stored notification of the old shape still works
    console.log('\n6 — the 90 days of links already in the database');

    const OLD_LINK = '/dashboard/gate/log?id=6512f0a0a0a0a0a0a0a0a0a0';
    await Notification.create({
      societyId, userId: ownerId, kind: 'GATE_ENTRY',
      title: 'Somebody arrived', body: 'Written before the rename.',
      link: OLD_LINK, priority: 'NORMAL',
    } as any);

    const inbox = await get('/api/v1/notifications', ownerT);
    eq('the resident can read their notifications', inbox.status, 200);
    const rows: any[] = inbox.body?.data?.items || inbox.body?.data || inbox.body?.items || [];
    const old = rows.find((n: any) => n.link === OLD_LINK);
    ok('the old row is served back exactly as it was stored', !!old,
      `links seen: ${JSON.stringify(rows.map((n: any) => n.link))}`);

    // Read the declared rules in declaration order. Matching on `source:` and
    // `destination:` rather than on the bare strings keeps the prose in that
    // file's own comments from being mistaken for a rule.
    const cfg = nextConfig();
    const grab = (key: string) =>
      [...cfg.matchAll(new RegExp(`${key}:\\s*["']([^"']+)["']`, 'g'))].map(m => m[1]);
    const sources = grab('source');
    const destinations = grab('destination');

    ok('the frontend declares a redirect for the old paths',
      sources.includes('/dashboard/gate/:path*'), JSON.stringify(sources));
    ok('...to the new ones', destinations.includes('/dashboard/visitors/:path*'),
      JSON.stringify(destinations));
    ok('...and one for the bare /dashboard/gate, which the wildcard also matches',
      sources.includes('/dashboard/gate'), JSON.stringify(sources));
    ok('...and one for /dashboard/visitors, which has no index page',
      sources.includes('/dashboard/visitors'), JSON.stringify(sources));
    ok('...both landing on the console',
      destinations.filter(d => d === '/dashboard/visitors/gate-desk').length === 2,
      JSON.stringify(destinations));

    // Order is load-bearing: Next takes the first match, and `:path*` means
    // ZERO or more segments, so the wildcard swallows the bare path if it is
    // listed first and sends the console to a directory with no page.
    const exactAt = sources.indexOf('/dashboard/gate');
    const wildAt = sources.indexOf('/dashboard/gate/:path*');
    ok('...with the exact rule listed BEFORE the wildcard',
      exactAt > -1 && wildAt > -1 && exactAt < wildAt, `exact@${exactAt} wildcard@${wildAt}`);

    // The old-shape link must be one the table actually covers.
    ok('the stored link is a path the redirect table covers',
      OLD_LINK.split('?')[0].startsWith('/dashboard/gate/'), OLD_LINK);

    // The destination those redirects land on has to exist on disk. A redirect
    // to a route nobody moved is a 404 with extra steps.
    const pages = path.resolve(__dirname, '../../../frontend/src/app/(dashboard)/dashboard');
    ok('the visitors routes exist on disk', fs.existsSync(path.join(pages, 'visitors')));
    ok('...including the console, which kept the word "gate" on purpose',
      fs.existsSync(path.join(pages, 'visitors/gate-desk/page.tsx')));
    for (const r of ['approvals', 'blocklist', 'gates', 'log', 'passes', 'preferences', 'scan', 'settings', 'vehicles']) {
      ok(`...and ${r}`, fs.existsSync(path.join(pages, 'visitors', r, 'page.tsx')));
    }
    ok('and the old folder is gone, so nothing is served from two places',
      !fs.existsSync(path.join(pages, 'gate')));

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
