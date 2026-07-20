/**
 * Phase 9 — passes, the scanner, and what happens when the gate is offline.
 * Real database, THROWAWAY societyIds, self-cleaning. Never touches existing data.
 *
 * What is actually being proved:
 *
 *   1. **A tampered QR is refused before it reaches the database.** The
 *      signature is checked first; a forged pass never gets to argue about
 *      whether it is expired or spent.
 *   2. **A code burns exactly once**, even when two gates redeem it at the
 *      same instant. The filtered update is the mechanism, so it is exercised
 *      concurrently rather than in sequence.
 *   3. **A revoked pass still works at an offline gate — and says so on sync.**
 *      This looks like a bug and is the deliberate design: the person is
 *      already inside, so recording and flagging beats a register that pretends
 *      they are not.
 *   4. **A guard device holds only a verifying key.** If it could sign, every
 *      gate phone could mint passes for the whole society.
 *
 *   npx tsx src/scripts/verify-gate-passes.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import crypto from 'crypto';
import { appConfig } from '../config/appConfig';
import { GatePass } from '../models/gate-pass.model';
import { Notification } from '../models/notification.model';
import { Resident } from '../models/resident.model';
import { Block } from '../models/block.model';
import { Flat, FlatStatus } from '../models/flat.model';
import {
  issue, revoke, redeem, verifyPayload, verifyingKey, listForFlat,
  listForSociety, expireOld, PassError,
} from '../services/gate-pass.service';
import { listForUser } from '../services/notification.service';
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const otherSocietyId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const residentId = new mongoose.Types.ObjectId();
const strangerId = new mongoose.Types.ObjectId();

const resident = { userId: residentId.toString(), userName: 'Asha Rao' };
const stranger = { userId: strangerId.toString(), userName: 'Nosy Neighbour' };
const guard = { userId: adminId.toString(), userName: 'Guard Ramesh' };
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
  for (const s of [societyId, otherSocietyId]) {
    await Promise.all([
      GatePass.deleteMany({ societyId: s }), Notification.deleteMany({ societyId: s }),
      Resident.deleteMany({ societyId: s }), Block.deleteMany({ societyId: s }),
      Flat.deleteMany({ societyId: s }),
    ]);
  }
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    const wing = await Block.create({ ...audit, name: 'A Wing' });
    const flat = await Flat.create({
      ...audit, blockId: wing._id, blockName: 'A Wing', number: '101',
      status: FlatStatus.OWNER_OCCUPIED,
    });
    await Resident.create({
      ...audit, flatId: flat._id, userId: residentId, person: { name: 'Asha Rao' },
      relationship: 'OWNER', householdType: 'OWNER', isOwner: true, isHead: true, isActive: true,
    });

    // ================================================================ issuing
    console.log('Issuing an invitation');
    const p1 = await issue(SID, {
      flatId: String(flat._id), visitorName: 'Guest Vikram', category: 'GUEST',
      visitorPhone: '9876543210',
    }, resident);
    ok('a pass is created', !!p1._id);
    ok('...with a six-digit code', /^[0-9]{6}$/.test(p1.code));
    ok('...and a signed QR payload', p1.qrPayload.includes('.'));
    eq('...starting out usable', p1.status, 'ACTIVE');
    eq('...naming the flat, so an offline guard can read it', p1.flatLabel, 'A Wing 101');

    let notMine = '';
    try {
      await issue(SID, { flatId: String(flat._id), visitorName: 'X', category: 'GUEST' }, stranger);
    } catch (e: any) { notMine = e.message; }
    ok('somebody who does not live there cannot invite to it', notMine.includes('your own flat'), notMine);

    let backwards = '';
    try {
      await issue(SID, {
        flatId: String(flat._id), visitorName: 'X', category: 'GUEST',
        validFrom: new Date(Date.now() + 86_400_000), validTo: new Date(),
      }, resident);
    } catch (e: any) { backwards = e.message; }
    ok('a pass cannot expire before it starts', backwards.includes('expire before'), backwards);

    // ============================================================== the keys
    console.log('\nThe guard device can only CHECK, never sign');
    const pub = await verifyingKey();
    ok('a verifying key exists', pub.includes('BEGIN PUBLIC KEY'));
    ok('...and it is genuinely public — no private half in it', !pub.includes('PRIVATE'));
    const pub2 = await verifyingKey();
    eq('...and stable, so passes already sent out keep working', pub2, pub);

    // ========================================================== verification
    console.log('\nWhat a scanner does with no network');
    const good = await verifyPayload(p1.qrPayload);
    ok('a real pass verifies offline', good.valid);
    eq('...and carries who it is for', good.claims?.n, 'Guest Vikram');
    eq('...and which society, so it cannot be used at another gate', good.claims?.s, SID);

    // Flip one character of the signature.
    const [body, sig] = p1.qrPayload.split('.');
    const tampered = `${body}.${sig.slice(0, -2)}${sig.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
    const bad = await verifyPayload(tampered);
    ok('a tampered signature is refused', !bad.valid);
    ok('...and said so plainly', bad.reason?.includes('tampered'), bad.reason);

    // Re-sign the same claims with a DIFFERENT key — a guard device holding
    // only the public key could never do this, which is the point.
    const rogue = crypto.generateKeyPairSync('ed25519');
    const rogueSig = crypto.sign(null, Buffer.from(body), rogue.privateKey);
    const forged = `${body}.${rogueSig.toString('base64url')}`;
    ok('a pass signed by anybody else is refused', !(await verifyPayload(forged)).valid);

    // Claims edited, then presented without a matching signature.
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    claims.e = Math.floor(Date.now() / 1000) + 999_999;
    const editedBody = Buffer.from(JSON.stringify(claims)).toString('base64url');
    ok('extending the expiry by editing the payload does not work',
      !(await verifyPayload(`${editedBody}.${sig}`)).valid);

    ok('nonsense is refused rather than crashing', !(await verifyPayload('not-a-pass')).valid);

    // =============================================================== redeem
    console.log('\nBurning a pass');
    const used = await redeem(SID, { code: p1.code }, guard);
    eq('the code works once', used.pass.status, 'USED');
    eq('...counted', used.pass.usedCount, 1);
    ok('...and not flagged', !used.overUsed);

    let twice = '';
    try { await redeem(SID, { code: p1.code }, guard); }
    catch (e: any) { twice = e.message; }
    ok('the same code cannot be used again', twice.includes('already been used'), twice);

    // The QR is a second door into the SAME pass, not a second life.
    let byQr = '';
    try { await redeem(SID, { payload: p1.qrPayload }, guard); }
    catch (e: any) { byQr = e.message; }
    ok('...and neither can its QR', byQr.includes('already been used'), byQr);

    // A pass for a party of four.
    const family = await issue(SID, {
      flatId: String(flat._id), visitorName: 'The Menons', category: 'GUEST', maxUses: 4,
    }, resident);
    for (let i = 0; i < 4; i++) await redeem(SID, { payload: family.qrPayload }, guard);
    const spent = await GatePass.findById(family._id).lean();
    eq('a family pass covers exactly its allowance', spent?.usedCount, 4);
    eq('...and is spent afterwards', spent?.status, 'USED');
    let fifth = '';
    try { await redeem(SID, { payload: family.qrPayload }, guard); }
    catch (e: any) { fifth = e.message; }
    ok('...with the fifth turned away', fifth.includes('already been used'), fifth);

    // Two gates, same instant. The database picks the winner, not the ordering.
    const race = await issue(SID, {
      flatId: String(flat._id), visitorName: 'Race Guest', category: 'GUEST',
    }, resident);
    const settledRace = await Promise.allSettled([
      redeem(SID, { code: race.code }, guard),
      redeem(SID, { code: race.code }, guard),
    ]);
    eq('two gates scanning at once — exactly one wins',
      settledRace.filter(r => r.status === 'fulfilled').length, 1);
    const raced = await GatePass.findById(race._id).lean();
    eq('...and the pass was burned once, not twice', raced?.usedCount, 1);

    // ============================================================ revoking
    console.log('\nCancelling');
    const doomed = await issue(SID, {
      flatId: String(flat._id), visitorName: 'Cancelled Caller', category: 'GUEST',
    }, resident);
    const revoked = await revoke(SID, String(doomed._id), 'Changed my mind', resident);
    eq('a pass can be cancelled', revoked.status, 'REVOKED');
    eq('...with the reason kept', revoked.revokedReason, 'Changed my mind');

    let cancelled = '';
    try { await redeem(SID, { code: doomed.code }, guard); }
    catch (e: any) { cancelled = e.message; }
    ok('a cancelled pass is refused at a connected gate',
      cancelled.includes('cancelled by the flat'), cancelled);

    // THE case worth thinking about: the gate was offline and let them in.
    const late = await redeem(SID, { code: doomed.code }, guard, { offlineQueued: true });
    ok('an offline gate that already admitted them is RECORDED, not refused', late.overUsed);
    ok('...and marked for review', !!late.pass.overUsedAt);
    ok('...with what happened written down', late.pass.overUseNote?.includes('revoked'));

    await settle();
    const inbox = await listForUser(SID, String(residentId));
    ok('the flat is told their cancelled pass was used',
      inbox.items.some(i => i.kind === 'GATE_PASS_OVERUSE'));
    ok('...loudly', inbox.items.find(i => i.kind === 'GATE_PASS_OVERUSE')?.priority === 'HIGH');

    // ============================================================== expiry
    console.log('\nTime');
    const old = await issue(SID, {
      flatId: String(flat._id), visitorName: 'Yesterday Guest', category: 'GUEST',
    }, resident);
    await GatePass.collection.updateOne(
      { _id: old._id },
      { $set: { validFrom: new Date(Date.now() - 172_800_000), validTo: new Date(Date.now() - 86_400_000) } },
    );
    let stale = '';
    try { await redeem(SID, { code: old.code }, guard); }
    catch (e: any) { stale = e.message; }
    ok('an expired pass does not work', stale.includes('expired'), stale);

    const expired = await expireOld();
    ok('the sweep retires it', expired >= 1);
    eq('...so its code is free again', (await GatePass.findById(old._id).lean())?.status, 'EXPIRED');

    const future = await issue(SID, {
      flatId: String(flat._id), visitorName: 'Tomorrow Guest', category: 'GUEST',
      validFrom: new Date(Date.now() + 86_400_000), validTo: new Date(Date.now() + 172_800_000),
    }, resident);
    let early = '';
    try { await redeem(SID, { code: future.code }, guard); }
    catch (e: any) { early = e.message; }
    ok('a pass for tomorrow does not work today', early.includes('not valid until'), early);

    // ======================================================= cross-society
    console.log('\nOne society cannot use another\'s passes');
    const live = await issue(SID, {
      flatId: String(flat._id), visitorName: 'Local Guest', category: 'GUEST',
    }, resident);
    let elsewhere = '';
    try { await redeem(String(otherSocietyId), { payload: live.qrPayload }, guard); }
    catch (e: any) { elsewhere = e.message; }
    ok('a signed pass is refused at another society\'s gate',
      elsewhere.includes('another society'), elsewhere);

    let elsewhereCode = '';
    try { await redeem(String(otherSocietyId), { code: live.code }, guard); }
    catch (e: any) { elsewhereCode = e.message; }
    ok('...and so is its code', elsewhereCode.includes('No such pass'), elsewhereCode);

    // ================================================================ lists
    console.log('\nWho sees what');
    const mine = await listForFlat(SID, [String(flat._id)]);
    ok('a resident sees their own flat\'s live passes', mine.length > 0);
    ok('...and only live ones by default', mine.every(p => p.status === 'ACTIVE'));
    const none = await listForFlat(SID, [String(new mongoose.Types.ObjectId())]);
    eq('...and nothing for a flat that is not theirs', none.length, 0);
    const all = await listForSociety(SID, false);
    ok('the gate sees the society\'s passes', all.length > mine.length);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
