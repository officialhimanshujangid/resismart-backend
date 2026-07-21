/**
 * Notification preferences, per-person email, dedupe/retry, and the gate-pass
 * signing key.
 *
 * Real database, THROWAWAY societyIds, self-cleaning. Never touches existing
 * data — with one exception that is called out where it happens: the pass
 * signing key lives on the single GlobalSetting row, so those assertions save
 * that row and put it back in `finally`.
 *
 * Every assertion here FAILS against the code as it stood before this pass.
 * That is the bar — a test that passes either way proves nothing.
 *
 * What is covered, and why each one exists:
 *
 *   1. **A muted kind is not delivered.** `notification.model` has claimed
 *      mute-by-kind since it was written and there was no preference model
 *      anywhere in the codebase. A resident could not turn GATE_ENTRY off.
 *   2. **HIGH rings through a mute AND through quiet hours.** The model says
 *      "HIGH rings through a muted preference" and there was nothing to ring
 *      through. Somebody is standing at the gate.
 *   3. **A per-channel opt-out is honoured** — and honoured per channel, so
 *      turning email off does not silently take push with it.
 *   4. **Four people with no device each get an email even when a fifth has
 *      one.** The email rung was computed per-BATCH: one committee member with
 *      a subscribed browser suppressed the email for everybody else on the
 *      notice, and the four who owned no device got nothing at all, anywhere.
 *   5. **The same event twice is told once**, via a marker field rather than a
 *      queue — the `Asset.amcWarnedForExpiry` precedent.
 *   6. **A rotated key still verifies a pass signed with the old one**, and a
 *      pass signed with the new one verifies too. Rotating without this is a
 *      silent outage: every pass in somebody's WhatsApp and every offline
 *      guard device's cached key stops working at once.
 *   7. **The environment override wins over the stored pair**, so the private
 *      key can live outside a database row shared by every society.
 *
 *   npx tsx src/scripts/verify-notification-prefs.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import crypto from 'crypto';
import { appConfig } from '../config/appConfig';
import { Notification } from '../models/notification.model';
import { NotificationPreference } from '../models/notification-preference.model';
import { PushToken } from '../models/push-token.model';
import { GlobalSetting } from '../models/global-setting.model';
import { User } from '../models/user.model';
import {
  notify, listForUser, savePreference, getPreference, kindsForUser,
  quietUntil, localMinutes, releaseHeld, retryFailedPushes,
} from '../services/notification.service';
import { registerToken } from '../services/push.service';
import * as pass from '../services/gate-pass.service';
import { UserRole, TenantType } from '../constants/roles';

const societyId = new mongoose.Types.ObjectId();
const SID = societyId.toString();

let pass_ = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass_++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/**
 * Real User rows, because the email rung reads `User.email` — a bare ObjectId
 * would make every "did they get an email?" assertion pass for the wrong
 * reason (nobody found, nothing sent, count of zero).
 */
const userIds: mongoose.Types.ObjectId[] = [];
const mkUser = async (name: string) => {
  const u = await User.create({
    name,
    email: `${name.replace(/\W/g, '').toLowerCase()}.${Date.now()}${Math.random().toString(36).slice(2, 6)}@throwaway.test`,
    password: 'x'.repeat(20), role: UserRole.RESIDENT_OWNER,
    memberships: [{ tenantType: TenantType.SOCIETY, tenantId: societyId, role: UserRole.RESIDENT_OWNER }],
  });
  userIds.push(u._id as any);
  return u._id as mongoose.Types.ObjectId;
};

async function cleanup() {
  await Promise.all([
    Notification.deleteMany({ societyId }),
    NotificationPreference.deleteMany({ societyId }),
    PushToken.deleteMany({ societyId }),
    User.deleteMany({ _id: { $in: userIds } }),
  ]);
}

/** How many rows this person actually has of a given kind. */
const countOf = async (uid: mongoose.Types.ObjectId, kind: string) =>
  Notification.countDocuments({ societyId, userId: uid, kind });

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  // Saved and restored in `finally`. The signing key is a SINGLETON row shared
  // with the running install, so the pass assertions below are the only part of
  // this script that touches anything real — and they put it back.
  const originalSettings = await GlobalSetting.findOne({}).lean();

  try {
    const resident = await mkUser('Muted Rao');
    const quiet = await mkUser('Sleeping Iyer');
    const optedOut = await mkUser('No Email Shah');

    // ==================================================== the quiet-hour math
    console.log('Quiet hours are wall-clock facts, not server facts');
    // 22:00 IST on a fixed instant. Asserted against an EXPLICIT zone rather
    // than the process clock: `getHours()` would read the deployment's timezone,
    // so the same resident's 22:00 would mean one thing on the Mumbai box and
    // another in a UTC container — and nobody would notice until somebody was
    // woken at half past three.
    const at2200IST = new Date('2026-07-21T16:30:00.000Z'); // 22:00 Asia/Kolkata
    eq('22:00 in Kolkata is minute 1320', localMinutes(at2200IST, 'Asia/Kolkata'), 1320);
    // 17:30, not 16:30 — London is on summer time in July. That the arithmetic
    // has to go through the zone's DST rules rather than a fixed offset is
    // exactly why this uses `Intl` and not a stored number of hours.
    eq('...and the same instant is minute 1050 in London (BST, not UTC)',
      localMinutes(at2200IST, 'Europe/London'), 1050);
    ok('an unknown timezone falls back rather than throwing',
      localMinutes(at2200IST, 'Mars/Olympus') === 1320);

    const wrap = { fromMinute: 1320, toMinute: 420 }; // 22:00 → 07:00
    ok('22:00 falls inside a window that wraps midnight',
      !!quietUntil(at2200IST, wrap, 'Asia/Kolkata'));
    const until = quietUntil(at2200IST, wrap, 'Asia/Kolkata')!;
    eq('...and it ends nine hours later, at 07:00',
      Math.round((until.getTime() - at2200IST.getTime()) / 60_000), 540);
    ok('the same instant is NOT quiet for somebody in London',
      quietUntil(at2200IST, wrap, 'Europe/London') === null);
    ok('a zero-width window silences nobody',
      quietUntil(at2200IST, { fromMinute: 600, toMinute: 600 }, 'Asia/Kolkata') === null);

    // ============================================================ defaults
    console.log('\nSomebody who has never opened the settings gets everything');
    const fresh = await getPreference(SID, String(resident));
    eq('nothing is muted by default', fresh.mutedKinds.length, 0);
    ok('every channel is on by default',
      fresh.channels.inApp && fresh.channels.push && fresh.channels.email);
    eq('and there are no quiet hours', fresh.quietHours, undefined);

    // ================================================================ mutes
    console.log('\nA muted kind is not delivered');
    await savePreference(SID, String(resident), { mutedKinds: ['GATE_ENTRY'] });

    const muted = await notify({
      societyId: SID, userIds: [String(resident)],
      kind: 'GATE_ENTRY', title: 'A visitor arrived', body: 'Courier at the gate',
    });
    eq('nothing was written for the muted kind', muted.created, 0);
    eq('...and it is counted as suppressed, not lost', muted.suppressed, 1);
    eq('...so the notification centre stays clean', await countOf(resident, 'GATE_ENTRY'), 0);

    const other = await notify({
      societyId: SID, userIds: [String(resident)],
      kind: 'COMPLAINT_CLOSED', title: 'Your complaint is closed', body: 'Tap fixed',
    });
    eq('muting one kind does not mute the rest', other.created, 1);

    // THE assertion the model has been promising since it was written.
    console.log('\nHIGH rings through');
    const rings = await notify({
      societyId: SID, userIds: [String(resident)],
      kind: 'GATE_ENTRY', title: 'Somebody is at your gate', body: 'Waiting for your answer',
      priority: 'HIGH',
    });
    eq('a HIGH message rings through a muted kind', rings.created, 1);
    eq('...and is not counted as suppressed', rings.suppressed, 0);
    const inbox = await listForUser(SID, String(resident));
    ok('...and the resident can genuinely see it',
      inbox.items.some(i => i.kind === 'GATE_ENTRY' && i.priority === 'HIGH'));

    // ========================================================== quiet hours
    console.log('\nQuiet hours hold the noise, never the record');
    // A window covering the whole day, so this passes whatever time the script
    // is run at. 00:00 → 23:59 wraps nothing and includes every minute but one.
    await savePreference(SID, String(quiet), {
      quietHours: { fromMinute: 0, toMinute: 1439 },
      timezone: 'Asia/Kolkata',
    });

    const held = await notify({
      societyId: SID, userIds: [String(quiet)],
      kind: 'OPENING_DUES', title: 'Your bill is ready', body: 'August maintenance',
      emailIfUnreachable: true,
    });
    eq('the record is still written during quiet hours', held.created, 1);
    eq('...and marked as held', held.held, 1);
    eq('...with no email sent while they sleep', held.emailed, 0);
    const heldRow = await Notification.findOne({ societyId, userId: quiet, kind: 'OPENING_DUES' });
    ok('...and the hold has an end time on the row', !!heldRow?.heldUntil);
    // Quiet hours must DELAY the email, not cancel it. Without this marker the
    // email is skipped at write time and nothing left on the row remembers one
    // was wanted — so a resident with no phone registered sleeps through their
    // bill entirely, which is exactly what "held, not dropped" ruled out.
    ok('...and remembers that an email was wanted', heldRow?.emailOnRelease === true);

    const ringsThroughQuiet = await notify({
      societyId: SID, userIds: [String(quiet)],
      kind: 'GATE_APPROVAL', title: 'Somebody is at your gate', body: 'May they come up?',
      priority: 'HIGH', emailIfUnreachable: true,
    });
    eq('a HIGH message rings through quiet hours', ringsThroughQuiet.created, 1);
    eq('...and is NOT held', ringsThroughQuiet.held, 0);
    eq('...and the email goes out at once', ringsThroughQuiet.emailed, 1);
    const urgentRow = await Notification.findOne({ societyId, userId: quiet, kind: 'GATE_APPROVAL' });
    eq('...with nothing waiting on the row', urgentRow?.heldUntil, undefined);

    // The sweep that delivers what the night held back. Without a caller this
    // would be another declared-and-never-fired feature (see H-20).
    const released = await releaseHeld(new Date(Date.now() + 48 * 60 * 60 * 1000));
    ok('the sweep releases held messages once the window closes', released >= 1);
    const afterRelease = await Notification.findOne({ _id: heldRow!._id });
    eq('...and clears the hold so it is not swept forever', afterRelease?.heldUntil, undefined);
    ok('...and the email the night held back is finally sent',
      afterRelease?.deliveredVia.includes('EMAIL'));
    eq('...with the reminder cleared so it cannot send twice',
      afterRelease?.emailOnRelease, undefined);

    // ====================================================== channel opt-out
    console.log('\nEach channel is opted out of separately');
    await savePreference(SID, String(optedOut), { channels: { email: false } });
    const prefAfter = await getPreference(SID, String(optedOut));
    eq('email is off', prefAfter.channels.email, false);
    eq('...and push is untouched', prefAfter.channels.push, true);
    eq('...and so is the in-app list', prefAfter.channels.inApp, true);

    const noEmail = await notify({
      societyId: SID, userIds: [String(optedOut)],
      kind: 'OPENING_DUES', title: 'Your bill is ready', body: 'August maintenance',
      emailIfUnreachable: true,
    });
    eq('the record is still written', noEmail.created, 1);
    eq('...and no email was sent to somebody who asked for none', noEmail.emailed, 0);

    // In-app off means no row. A switch that leaves the row behind and still
    // calls itself "in-app" is the dead-policy shape §I-E exists to stamp out.
    await savePreference(SID, String(optedOut), { channels: { inApp: false } });
    const noRow = await notify({
      societyId: SID, userIds: [String(optedOut)],
      kind: 'COMPLAINT_COMMENT', title: 'Somebody replied', body: 'On your complaint',
    });
    eq('switching the list off genuinely stops the row', noRow.created, 0);
    const stillUrgent = await notify({
      societyId: SID, userIds: [String(optedOut)],
      kind: 'GATE_APPROVAL', title: 'At your gate', body: 'Waiting', priority: 'HIGH',
    });
    eq('...but a HIGH message is written anyway', stillUrgent.created, 1);
    await savePreference(SID, String(optedOut), { channels: { inApp: true } });

    // ======================================== the per-batch email defect
    console.log('\nThe email rung is per person, not per batch');
    // Five committee members. ONE has a browser subscribed; the other four own
    // no device at all. Before this fix `outcome.attempted` was counted across
    // the whole recipient list, so that one subscription suppressed the email
    // for the four who had no other way of hearing about it.
    const committee = [];
    for (let i = 0; i < 5; i++) committee.push(await mkUser(`Member ${i + 1}`));
    await registerToken({
      societyId: SID, userId: String(committee[0]), platform: 'WEB',
      token: `https://fcm.googleapis.com/test/${new mongoose.Types.ObjectId()}`,
      keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
      deviceLabel: 'Chairman laptop',
    });

    const fanout = await notify({
      societyId: SID, userIds: committee.map(String),
      kind: 'COMPLAINT_ESCALATED', title: 'A complaint has run past its promise',
      body: 'Lift out of order, 4 days open', emailIfUnreachable: true,
    });
    eq('all five got a record', fanout.created, 5);
    eq('the four with no device each got an email', fanout.emailed, 4);
    const chairmanRow = await Notification.findOne({
      societyId, userId: committee[0], kind: 'COMPLAINT_ESCALATED',
    });
    ok('...and the one with a browser did NOT get a duplicate email',
      !chairmanRow?.deliveredVia.includes('EMAIL'));
    const plainRow = await Notification.findOne({
      societyId, userId: committee[1], kind: 'COMPLAINT_ESCALATED',
    });
    ok('...while the ones without a device are marked as emailed',
      plainRow?.deliveredVia.includes('EMAIL'));

    // A failed push is a marker on the row, not a number on the device that
    // nobody reads. There is no working push transport in a script, so the
    // chairman's attempt fails and must be recorded as retryable.
    ok('a push that failed is marked for another try', !!chairmanRow?.pushFailedAt);
    const recovered = await retryFailedPushes();
    eq('...and the retry sweep runs without a transport and recovers nothing', recovered, 0);
    const afterRetry = await Notification.findOne({ _id: chairmanRow!._id });
    ok('...but it did count the attempt, so it cannot loop forever',
      (afterRetry?.pushAttempts || 0) >= 1);

    // ============================================================== dedupe
    console.log('\nThe same event twice is told once');
    const key = `complaint:${new mongoose.Types.ObjectId()}:closed`;
    const firstTime = await notify({
      societyId: SID, userIds: committee.map(String),
      kind: 'COMPLAINT_CLOSED', title: 'Complaint closed', body: 'Lift restored',
      dedupeKey: key,
    });
    eq('the first telling reaches everybody', firstTime.created, 5);
    const secondTime = await notify({
      societyId: SID, userIds: committee.map(String),
      kind: 'COMPLAINT_CLOSED', title: 'Complaint closed', body: 'Lift restored',
      dedupeKey: key,
    });
    eq('the second telling reaches nobody', secondTime.created, 0);
    eq('...and says why', secondTime.duplicates, 5);
    eq('...leaving exactly one row per person',
      await Notification.countDocuments({ societyId, dedupeKey: key }), 5);

    // Two processes reacting to one event at the same instant — the read-then-
    // write above cannot catch that, only the unique partial index can.
    const raceKey = `pass:${new mongoose.Types.ObjectId()}:overuse`;
    const [a, b] = await Promise.all([
      notify({ societyId: SID, userIds: [String(resident)], kind: 'GATE_PASS_OVERUSE', title: 'Pass reused', body: 'x', dedupeKey: raceKey }),
      notify({ societyId: SID, userIds: [String(resident)], kind: 'GATE_PASS_OVERUSE', title: 'Pass reused', body: 'x', dedupeKey: raceKey }),
    ]);
    eq('a simultaneous double-fire still writes exactly one row',
      await Notification.countDocuments({ societyId, dedupeKey: raceKey }), 1);
    eq('...and only one of the two callers claims to have created it', a.created + b.created, 1);

    // Without a key, the same words twice really are two messages — a monthly
    // notice must still be sendable next month.
    const n1 = await notify({ societyId: SID, userIds: [String(resident)], kind: 'ADMIN', title: 'Notice', body: 'AGM' });
    const n2 = await notify({ societyId: SID, userIds: [String(resident)], kind: 'ADMIN', title: 'Notice', body: 'AGM' });
    eq('with no dedupe key the same words can be sent twice', n1.created + n2.created, 2);

    // ============================================== the settings screen data
    console.log('\nThe settings screen offers real switches');
    const kinds = await kindsForUser(SID, String(resident));
    ok('the topics offered are ones this person has actually been sent',
      kinds.includes('COMPLAINT_CLOSED') && kinds.includes('ADMIN'));
    ok('...and a muted topic stays on the list so it can be switched back on',
      kinds.includes('GATE_ENTRY'));

    // ========================================================= the pass key
    console.log('\nThe gate-pass signing key rotates without stranding anybody');

    // A pass signed by the key as it stands now.
    const claimsBefore = `pass-before-${Date.now()}`;
    const beforePair = await currentPair();
    const oldBlob = signBlob(claimsBefore, beforePair.privateKey);
    ok('a pass signed with the current key verifies', await verifyBlob(oldBlob));

    const rotated = await pass.rotateSigningKey({ userId: String(resident), userName: 'Verify script' });
    ok('rotation reports when it happened', !!rotated.rotatedAt);
    ok('...and the grace window is at least the maximum offline window',
      rotated.graceHours >= pass.MAX_OFFLINE_HOURS);

    // THE assertion. Everything already in somebody's WhatsApp was signed with
    // the old key, and every offline guard device is running on a cached copy
    // of the old public key.
    ok('a pass signed with the OLD key still verifies after rotation', await verifyBlob(oldBlob));

    const afterPair = await currentPair();
    ok('...and the signing key genuinely changed', afterPair.publicKey !== beforePair.publicKey);
    const newBlob = signBlob(`pass-after-${Date.now()}`, afterPair.privateKey);
    ok('a pass signed with the NEW key verifies', await verifyBlob(newBlob));

    const keys = await pass.verifyingKeys();
    eq('the guard device is handed BOTH keys for its offline cache', keys.length, 2);
    eq('...newest first, so the common case matches on the first try',
      keys[0], afterPair.publicKey);
    eq('...and the single-key helper still answers with the signing key',
      await pass.verifyingKey(), afterPair.publicKey);

    // A second rotation inside the window would push the FIRST retired key out
    // of the list and kill every pass signed with it, without warning.
    let refused = false;
    try { await pass.rotateSigningKey({ userId: String(resident), userName: 'Verify script' }); }
    catch { refused = true; }
    ok('a second rotation inside the grace window is refused', refused);

    // Nothing may delete the old key before the window closes.
    eq('the retired key cannot be dropped early', await pass.dropRetiredKey(), false);
    const wellPast = new Date(Date.now() + (pass.KEY_GRACE_HOURS + 1) * 60 * 60 * 1000);
    eq('...but is dropped once nothing can still be carrying it',
      await pass.dropRetiredKey(wellPast), true);
    ok('...and a pass signed with it stops verifying then',
      !(await verifyBlobFresh(oldBlob)));

    // ================================================= the env-var override
    console.log('\nThe environment beats the database');
    // The stored private key sits in ONE plaintext row shared by every society,
    // and the society is a claim inside the signed blob — so one leaked row
    // mints passes for every flat on the platform. Pinning the key in the
    // environment is the fix, and it only works if it actually wins.
    const envPair = freshPair();
    const storedPair = await currentPair();
    (appConfig as any).passSigningPublicKey = envPair.publicKey;
    (appConfig as any).passSigningPrivateKey = envPair.privateKey;
    resetKeyCache();

    eq('the signing key now comes from the environment', await pass.signingKeySource(), 'ENV');
    eq('...and it is the env key, not the stored one',
      await pass.verifyingKey(), envPair.publicKey);
    const envBlob = signBlob(`env-${Date.now()}`, envPair.privateKey);
    ok('a pass signed with the env key verifies', await verifyBlobFresh(envBlob));
    // The stored key is still accepted for verification — otherwise the day an
    // operator finally sets the env vars, every outstanding pass dies.
    const storedBlob = signBlob(`stored-${Date.now()}`, storedPair.privateKey);
    ok('...and passes signed before the switch are not stranded',
      await verifyBlobFresh(storedBlob));

    (appConfig as any).passSigningPublicKey = '';
    (appConfig as any).passSigningPrivateKey = '';
    resetKeyCache();

  } finally {
    await cleanup();
    // Put the shared singleton back exactly as it was. This is the only row in
    // the script that belongs to the real install.
    if (originalSettings) {
      await GlobalSetting.replaceOne({ _id: originalSettings._id }, originalSettings as any);
    } else {
      await GlobalSetting.deleteMany({});
    }
    await mongoose.disconnect();
  }

  console.log(`\n${pass_}/${pass_ + fail} passed`);
  if (fail) process.exit(1);
}

// ------------------------------------------------------------------ helpers

/**
 * Sign and verify a blob the same way the service does.
 *
 * Written out rather than reusing `issue()`, because issuing needs a flat, a
 * resident row and a whole society — none of which say anything about whether
 * a signature survives a key rotation, which is the only thing being asked
 * here.
 */
const b64url = (b: Buffer) => b.toString('base64url');

function signBlob(text: string, privateKey: string): string {
  const body = b64url(Buffer.from(JSON.stringify({
    p: String(new mongoose.Types.ObjectId()), s: SID,
    e: Math.floor((Date.now() + 60 * 60 * 1000) / 1000), n: text,
  })));
  const sig = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(privateKey));
  return `${body}.${b64url(sig)}`;
}

const verifyBlob = async (blob: string) => (await pass.verifyPayload(blob)).valid;

/** Same check, but after forcing the service to re-read its keys. */
const verifyBlobFresh = async (blob: string) => {
  resetKeyCache();
  return (await pass.verifyPayload(blob)).valid;
};

function freshPair() {
  const p = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: p.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: p.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

async function currentPair(): Promise<{ publicKey: string; privateKey: string }> {
  // Force the service to resolve (and, on a virgin database, generate) first.
  await pass.verifyingKeys();
  const row = await GlobalSetting.findOne({}).lean();
  return { publicKey: row!.passSigningPublicKey!, privateKey: row!.passSigningPrivateKey! };
}

/**
 * Drop the service's in-process key cache.
 *
 * The service caches deliberately — re-reading the singleton on every scan
 * would be a database round trip at a gate that may have no network. The cache
 * is module-private, so the only honest way to test the env override and the
 * post-drop state is to reach in and clear it, which is what a restart does in
 * production.
 */
function resetKeyCache() {
  const mod = pass as any;
  // `rotateSigningKey` and `dropRetiredKey` clear it themselves; this covers
  // the cases where only the environment changed.
  if (mod.__resetKeyCacheForTests) mod.__resetKeyCacheForTests();
}

main().catch((e) => { console.error(e); process.exit(1); });
