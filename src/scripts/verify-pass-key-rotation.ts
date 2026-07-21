/**
 * The operator's way to rotate the gate-pass signing key.
 *
 * `rotateSigningKey` has existed and been correct for a while, and nothing
 * could call it — no route, no handler, no button. This proves the way in, and
 * proves it is the RIGHT way in, which is mostly a question about who is
 * holding the door:
 *
 *   1. **A society admin cannot rotate.** One installation has ONE signing
 *      key. The society travels as a claim inside the signed blob rather than
 *      as a property of the key, so an admin at one society pressing this
 *      would re-key every gate at every OTHER society on the platform — and
 *      every guard device there would have to be told. That is not a decision
 *      a tenant gets to make about their neighbours.
 *   2. **A system employee cannot either.** Owner only, deliberately: the
 *      blast radius is every gate we run.
 *   3. **The two refusals arrive verbatim.** Both are 409s carrying the exact
 *      remedy — which environment variables to move, or how long to wait. A
 *      handler that swallowed them into "could not rotate" would leave the
 *      operator with a button that fails and no idea why.
 *   4. **A pass signed before the rotation still verifies afterwards**, and
 *      the scanner configuration hands guards BOTH keys. This is the whole
 *      reason rotation keeps two keys, and it is the assertion that would
 *      catch somebody "simplifying" the endpoint into a plain re-key.
 *
 * The GlobalSetting singleton is shared by the whole installation, so the
 * signing fields are snapshotted at the start and put back at the end — this
 * script must not leave a rotation settling on a database somebody else is
 * using.
 *
 *   npx tsx src/scripts/verify-pass-key-rotation.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import crypto from 'crypto';
import request from 'supertest';
import { appConfig } from '../config/appConfig';
import app from '../app';
import { User } from '../models/user.model';
import { GlobalSetting } from '../models/global-setting.model';
import * as passes from '../services/gate-pass.service';
import { generateAccessToken } from '../utils/jwt.util';
import { UserRole, TenantType } from '../constants/roles';

const tenantId = new mongoose.Types.ObjectId();
const societyId = new mongoose.Types.ObjectId();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ids: mongoose.Types.ObjectId[] = [];
const mkUser = async (name: string, role: UserRole, tenant: mongoose.Types.ObjectId, type: TenantType) => {
  const u = await User.create({
    name,
    email: `${name.replace(/\W/g, '').toLowerCase()}.${Date.now()}${Math.random().toString(36).slice(2, 6)}@throwaway.test`,
    password: 'x'.repeat(20), role,
    memberships: [{ tenantType: type, tenantId: tenant, role }],
  });
  ids.push(u._id as any);
  return generateAccessToken({
    userId: String(u._id), activeTenantId: String(tenant), activeTenantType: type, activeRole: role,
  });
};

/** The service caches keys in-process; a restart is what clears it in production. */
const resetKeyCache = () => (passes as any).__resetKeyCacheForTests?.();

const signWith = (privateKey: string, body: string) =>
  `${body}.${crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(privateKey)).toString('base64url')}`;

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log('Connected.\n');

  // Make sure a row exists before snapshotting it, so the restore below puts
  // back a real prior state rather than inventing one.
  await passes.verifyingKeys();
  const before = await GlobalSetting.findOne({}).lean();
  const envPrivateBefore = appConfig.passSigningPrivateKey;

  try {
    const ownerToken = await mkUser('Owner', UserRole.SYSTEM_OWNER, tenantId, TenantType.SYSTEM);
    const employeeToken = await mkUser('SysEmp', UserRole.SYSTEM_EMPLOYEE, tenantId, TenantType.SYSTEM);
    const adminToken = await mkUser('SocietyAdmin', UserRole.SOCIETY_ADMIN, societyId, TenantType.SOCIETY);

    const get = (token?: string) => {
      const r = request(app).get('/api/v1/settings/pass-signing-key');
      return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    const rotate = (token?: string) => {
      const r = request(app).post('/api/v1/settings/pass-signing-key/rotate');
      return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };

    // ------------------------------------------------------------ who may
    console.log('Only ResiSmart itself may rotate the key');
    eq('a signed-out caller cannot read the key status', (await get()).status, 401);
    eq('...nor rotate', (await rotate()).status, 401);

    // The heart of it: this key is not a society's to change.
    eq('a SOCIETY_ADMIN cannot read the key status', (await get(adminToken)).status, 403);
    eq('...and cannot rotate the key every other society also uses',
      (await rotate(adminToken)).status, 403);

    eq('a SYSTEM_EMPLOYEE cannot rotate either', (await rotate(employeeToken)).status, 403);

    // -------------------------------------------------------- the status
    console.log('\nThe status says enough to decide with');
    const status = await get(ownerToken);
    eq('a SYSTEM_OWNER can read it', status.status, 200);
    eq('...and the grace window covers twice the longest a gate can be offline',
      status.body.data.graceHours, passes.MAX_OFFLINE_HOURS * 2);
    ok('...and no key material is on the wire',
      !JSON.stringify(status.body).includes('PRIVATE KEY') && !JSON.stringify(status.body).includes('PUBLIC KEY'));

    // ------------------------------------------------------- the rotation
    console.log('\nRotating does not strand anybody already holding a pass');

    // Sign something with the key as it stands, exactly as an outstanding pass
    // in somebody's WhatsApp was signed.
    resetKeyCache();
    const beforeRow = await GlobalSetting.findOne({}).lean();
    const oldBlob = signWith(beforeRow!.passSigningPrivateKey!, Buffer.from(JSON.stringify({
      p: String(new mongoose.Types.ObjectId()), s: String(societyId),
      e: Math.floor(Date.now() / 1000) + 3600, n: 'Guest',
    })).toString('base64url'));
    ok('a pass signed with the current key verifies', (await passes.verifyPayload(oldBlob)).valid);

    const done = await rotate(ownerToken);
    eq('the owner rotates', done.status, 200);
    eq('...and two keys now verify', done.body.data.keyCount, 2);
    ok('...and the reply says the old passes keep working and devices must refresh',
      /24 hours/.test(done.body.message) && /scanner configuration/i.test(done.body.message),
      done.body.message);

    const gap = new Date(done.body.data.retiredKeyExpiresAt).getTime()
      - new Date(done.body.data.rotatedAt).getTime();
    eq('...and the retired key expires exactly one grace window later',
      gap, passes.KEY_GRACE_HOURS * 60 * 60 * 1000);

    // THE assertion. Every pass already issued was signed with the old key.
    ok('a pass signed BEFORE the rotation still verifies', (await passes.verifyPayload(oldBlob)).valid);

    // ...and the guard device is actually told about both, which is the only
    // way the line above helps a gate with no network.
    const guardToken = await mkUser('GuardAdmin', UserRole.SOCIETY_ADMIN, societyId, TenantType.SOCIETY);
    const config = await request(app)
      .get('/api/v1/visitors/passes/scanner-config')
      .set('Authorization', `Bearer ${guardToken}`);
    eq('the scanner configuration is served', config.status, 200);
    eq('...carrying BOTH keys for the offline cache', config.body.data.publicKeys?.length, 2);
    eq('...newest first', config.body.data.publicKeys?.[0], config.body.data.publicKey);

    // --------------------------------------------------- the two refusals
    console.log('\nA refusal tells the operator what to do instead');

    const again = await rotate(ownerToken);
    eq('a second rotation inside the grace window is refused', again.status, 409);
    ok('...with the service\'s own words, which name the consequence',
      /still settling/.test(again.body.message) && /cancel every one of them/.test(again.body.message),
      again.body.message);

    // Pinned keys: rotating in the database would write a pair the process
    // never reads, and leave an operator certain they had rotated.
    (appConfig as any).passSigningPrivateKey = beforeRow!.passSigningPrivateKey;
    resetKeyCache();
    const pinned = await rotate(ownerToken);
    eq('rotating env-pinned keys is refused', pinned.status, 409);
    ok('...with the instruction naming the variables to move',
      /PASS_SIGNING_PRIVATE_KEY/.test(pinned.body.message)
      && /PASS_SIGNING_PREVIOUS_PUBLIC_KEY/.test(pinned.body.message),
      pinned.body.message);
    (appConfig as any).passSigningPrivateKey = envPrivateBefore;
    resetKeyCache();

    ok('...and the status says so before the operator ever presses it',
      (await get(ownerToken)).body.data.envPinned === false);
  } finally {
    // Put the installation's key back exactly as it was found. A verify script
    // that left a rotation settling would block the real one for 24 hours.
    (appConfig as any).passSigningPrivateKey = envPrivateBefore;
    await User.deleteMany({ _id: { $in: ids } });
    if (before) {
      await GlobalSetting.updateOne({ _id: before._id }, {
        $set: {
          passSigningPublicKey: before.passSigningPublicKey,
          passSigningPrivateKey: before.passSigningPrivateKey,
        },
        $unset: {
          passSigningPreviousPublicKey: '',
          passSigningPreviousPrivateKey: '',
          passSigningRotatedAt: '',
        },
      });
    }
    resetKeyCache();
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
