import mongoose from 'mongoose';
import crypto from 'crypto';
import { GatePass, IGatePass } from '../models/gate-pass.model';
import { GlobalSetting } from '../models/global-setting.model';
import { Flat } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { notify } from './notification.service';
import { householdOfFlat } from './notify-recipients';
import { appConfig } from '../config/appConfig';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class PassError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Actor { userId: string; userName: string }

/**
 * Passes: invitations that a guard can check without asking anybody.
 *
 * The design turns on one constraint that is easy to miss — **the gate loses
 * its network constantly.** Basements, steel doors, a prepaid SIM that ran
 * out. Any scheme where verifying a pass requires a round trip degrades to a
 * guard waving people through, which is worse than no passes at all.
 *
 * So the QR carries everything needed to verify it, signed. The guard's device
 * holds only a PUBLIC key, checks the signature and the expiry itself, and
 * queues the entry. Reconciliation happens on sync, and reconciliation
 * *reports* rather than *blocks*: by the time a double-use is discovered the
 * person is already inside, and refusing to record the second entry would only
 * make the register wrong about who is in the building.
 *
 * The maximum offline window is deliberately short. A pass signed for twelve
 * hours cannot be revoked in a way an offline device will notice, so twelve
 * hours is the most exposure a revoked pass can ever have.
 */

export const MAX_OFFLINE_HOURS = 12;

// ------------------------------------------------------------------ signing

/**
 * The signing material: one key that signs, and every key that still verifies.
 *
 * Two problems are being solved here at once, and they pull in opposite
 * directions.
 *
 * **The security problem.** The private key used to live only as a plaintext
 * field on the single GlobalSetting row, shared by every society on the
 * install, with no way for an operator to supply their own. The society is a
 * CLAIM INSIDE the signed blob (`s`), not a property of the key, so anybody who
 * could read that one document could mint a valid pass for any flat in any
 * society — and offline guard devices, which cannot check anything against the
 * database, would honour it. `PASS_SIGNING_PRIVATE_KEY` in the environment
 * takes the private half out of the database entirely and is what any real
 * install should use. It mirrors `resolveVapid` in push.service exactly:
 * environment first, then whatever was stored, then generate-and-store.
 *
 * **The rotation problem, which is the dangerous one.** A new key is easy; the
 * consequences are not. Every pass already sitting in a guest's WhatsApp was
 * signed with the old key, and every guard device is holding a CACHED copy of
 * the old public key for exactly the hours it has no network. Swap the pair and
 * both stop working, silently, with the failure landing on a guard trying to
 * explain to a real guest why a real invitation is "tampered with".
 *
 * So rotation keeps TWO keys. Signing moves to the new one immediately;
 * verification accepts both until the grace window closes. The window is
 * `MAX_OFFLINE_HOURS` — the longest a signed blob can ever be valid for, and
 * therefore the longest an offline device can be running on stale cache — plus
 * a margin for a device that syncs late. Nothing deletes the old key before
 * then; `dropRetiredKey` refuses to.
 */

interface SigningMaterial {
  /** The pair new passes are signed with. */
  signing: { publicKey: string; privateKey: string };
  /** Every public key a presented pass may legitimately have been signed by, newest first. */
  verifying: string[];
  /** Where the signing key came from, so an operator can tell at a glance. */
  source: 'ENV' | 'STORED' | 'GENERATED';
}

let keysReady: SigningMaterial | null = null;
let keysPending: Promise<SigningMaterial> | null = null;

/**
 * How long a retired key must stay verifiable.
 *
 * At least `MAX_OFFLINE_HOURS`, because that is the longest life a signed blob
 * can have and the longest a disconnected gate can be trusting its cache. The
 * extra hours are for the device that comes back online late — a basement post
 * whose guard goes off shift before syncing. Erring long costs nothing: the
 * old key can only verify blobs that carry their own expiry.
 */
export const KEY_GRACE_HOURS = MAX_OFFLINE_HOURS * 2;

/** Read the singleton. One place, so every path agrees on which row that is. */
const settings = () => GlobalSetting.findOne({}).lean();

function newPair(): { publicKey: string; privateKey: string } {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Whether a retired key is still inside its grace window. */
function stillInGrace(rotatedAt: Date | undefined, now = new Date()): boolean {
  if (!rotatedAt) return false;
  return now.getTime() - new Date(rotatedAt).getTime() < KEY_GRACE_HOURS * 60 * 60 * 1000;
}

async function resolveKeys(): Promise<SigningMaterial> {
  if (keysReady) return keysReady;
  if (keysPending) return keysPending;

  keysPending = (async () => {
    try {
      const stored = await settings();

      // The retired pair is added to the verify list regardless of where the
      // signing key came from, because passes signed by it are already out in
      // the world. Dropped once the window closes, so a key that leaked years
      // ago cannot quietly keep working.
      const retired: string[] = [];
      if (stored?.passSigningPreviousPublicKey && stillInGrace(stored.passSigningRotatedAt)) {
        retired.push(stored.passSigningPreviousPublicKey);
      }
      // An operator rotating ENV-pinned keys has nowhere else to put the old
      // public half — the database never held it.
      if (appConfig.passSigningPreviousPublicKey) retired.push(appConfig.passSigningPreviousPublicKey);

      // 1. Environment wins, always. It is the only configuration an operator
      //    can pin across a rebuilt database, and the only one that keeps the
      //    private half out of Mongo.
      if (appConfig.passSigningPrivateKey && appConfig.passSigningPublicKey) {
        const signing = {
          publicKey: appConfig.passSigningPublicKey,
          privateKey: appConfig.passSigningPrivateKey,
        };
        // The STORED pair is also honoured for verification while it is the
        // one passes in circulation were signed with — otherwise the day an
        // operator finally sets the env vars, every outstanding pass dies.
        if (stored?.passSigningPublicKey && stored.passSigningPublicKey !== signing.publicKey) {
          retired.push(stored.passSigningPublicKey);
        }
        keysReady = { signing, verifying: [signing.publicKey, ...retired], source: 'ENV' };
        return keysReady;
      }

      // 2. Whatever was generated earlier and stored.
      if (stored?.passSigningPublicKey && stored?.passSigningPrivateKey) {
        const signing = {
          publicKey: stored.passSigningPublicKey,
          privateKey: stored.passSigningPrivateKey,
        };
        keysReady = { signing, verifying: [signing.publicKey, ...retired], source: 'STORED' };
        return keysReady;
      }

      // 3. A fresh pair, written back before it is used.
      const generated = newPair();
      await GlobalSetting.findOneAndUpdate(
        {},
        { $set: { passSigningPublicKey: generated.publicKey, passSigningPrivateKey: generated.privateKey } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      // Read back, so a racing second process adopts the winner's pair rather
      // than signing with one nobody stored.
      const settled = await settings();
      const signing = {
        publicKey: settled?.passSigningPublicKey || generated.publicKey,
        privateKey: settled?.passSigningPrivateKey || generated.privateKey,
      };
      logger.warn(
        'Gate passes: generated an Ed25519 signing key and stored it in plaintext. '
        + 'Set PASS_SIGNING_PRIVATE_KEY / PASS_SIGNING_PUBLIC_KEY for any real install.',
      );
      keysReady = { signing, verifying: [signing.publicKey, ...retired], source: 'GENERATED' };
      return keysReady;
    } finally {
      keysPending = null;
    }
  })();

  return keysPending;
}

/** Drop the in-process cache. Called after a rotation so signing switches at once. */
function forgetKeys(): void {
  keysReady = null;
}

/**
 * The same thing, exported, for the verification scripts.
 *
 * The cache is deliberate — re-reading the singleton on every scan would be a
 * database round trip at a gate that may have no network — which means the only
 * honest way to exercise the environment override is to clear it, exactly as a
 * restart does in production. Named for what it is so nobody reaches for it in
 * a request path.
 */
export function __resetKeyCacheForTests(): void {
  forgetKeys();
}

/**
 * What a guard device needs to verify offline. Public by definition.
 *
 * Returns EVERY currently-acceptable key, newest first, because this is what
 * the device caches and runs on when it has no network. Handing back only the
 * newest would mean a rotation turns away every guest holding a pass issued
 * before it — which is the entire failure this two-key scheme exists to
 * prevent, reintroduced at the one place it cannot be recovered from.
 */
export async function verifyingKeys(): Promise<string[]> {
  return (await resolveKeys()).verifying;
}

/**
 * The single newest public key.
 *
 * Kept for callers that genuinely want one string. Anything feeding a guard
 * device's offline cache must use `verifyingKeys` instead.
 */
export async function verifyingKey(): Promise<string> {
  return (await resolveKeys()).signing.publicKey;
}

/** Where the signing key came from, for the health surface. Never the key itself. */
export async function signingKeySource(): Promise<SigningMaterial['source']> {
  return (await resolveKeys()).source;
}

export interface SigningKeyStatus {
  source: SigningMaterial['source'];
  /** How many public keys a guard device should be holding right now. */
  keyCount: number;
  /**
   * Whether `rotateSigningKey` would refuse because the environment pins the pair.
   *
   * NOT the same question as `source === 'ENV'`, and the difference is the
   * whole reason this is a separate field. `source` is ENV only when BOTH
   * halves are set; rotation refuses on the PRIVATE half alone. An install
   * with only `PASS_SIGNING_PRIVATE_KEY` set therefore signs with a stored key
   * and still cannot rotate — so a screen that asked `source` would offer a
   * button that can only ever fail.
   */
  envPinned: boolean;
  /** When the last rotation happened — present only while its retired key still verifies. */
  rotatedAt?: Date;
  /** When that retired key stops verifying, which is also the earliest a further rotation is allowed. */
  retiredKeyExpiresAt?: Date;
  graceHours: number;
  maxOfflineHours: number;
}

/**
 * Everything an operator needs to decide whether to rotate — and no key material.
 *
 * Public keys are harmless, but nothing on this surface needs them: the screen
 * asks "may I rotate, and what is still settling?", and `/scanner-config` is
 * where keys are actually handed out.
 */
export async function signingKeyStatus(now = new Date()): Promise<SigningKeyStatus> {
  const material = await resolveKeys();
  const stored = await settings();
  const inGrace = !!stored?.passSigningPreviousPublicKey && stillInGrace(stored.passSigningRotatedAt, now);
  const rotatedAt = inGrace ? new Date(stored!.passSigningRotatedAt!) : undefined;

  return {
    source: material.source,
    keyCount: material.verifying.length,
    envPinned: !!appConfig.passSigningPrivateKey,
    rotatedAt,
    retiredKeyExpiresAt: rotatedAt
      ? new Date(rotatedAt.getTime() + KEY_GRACE_HOURS * 60 * 60 * 1000)
      : undefined,
    graceHours: KEY_GRACE_HOURS,
    maxOfflineHours: MAX_OFFLINE_HOURS,
  };
}

/**
 * Rotate to a fresh signing pair, keeping the old one verifiable.
 *
 * Deliberately refuses when the environment pins the keys: rotating a value the
 * process reads from `.env` by writing to the database would produce a stored
 * pair that is never used, and an operator convinced they had rotated when they
 * had not. The instruction they need is the one returned in the error.
 *
 * Also refuses a second rotation while the first is still inside its grace
 * window. Ed25519 verification is cheap, but the real reason is that a second
 * rotation would push the FIRST retired key out of the list — every pass signed
 * with it, still valid, still in somebody's WhatsApp, dies without warning. One
 * rotation at a time; wait the window out.
 */
export async function rotateSigningKey(
  actor: Actor, opts: { force?: boolean; now?: Date } = {},
): Promise<{ rotatedAt: Date; verifyingKeys: string[]; graceHours: number }> {
  if (appConfig.passSigningPrivateKey) {
    throw new PassError(
      'Pass signing keys are pinned in the environment. Rotate them by setting '
      + 'PASS_SIGNING_PRIVATE_KEY/PASS_SIGNING_PUBLIC_KEY to a new pair and moving the old '
      + 'public key to PASS_SIGNING_PREVIOUS_PUBLIC_KEY, then restarting.',
      409,
    );
  }

  const now = opts.now || new Date();
  const current = await settings();
  if (!opts.force && current?.passSigningPreviousPublicKey && stillInGrace(current.passSigningRotatedAt, now)) {
    throw new PassError(
      `A rotation is still settling. Passes signed before it stay valid for ${KEY_GRACE_HOURS} hours; `
      + 'rotating again now would cancel every one of them.',
      409,
    );
  }

  const fresh = newPair();
  await GlobalSetting.findOneAndUpdate(
    {},
    {
      $set: {
        passSigningPublicKey: fresh.publicKey,
        passSigningPrivateKey: fresh.privateKey,
        // The pair being retired. Kept in full — the private half too — so a
        // rotation done by mistake can be undone by hand within the window,
        // rather than being an irreversible act on a live gate.
        passSigningPreviousPublicKey: current?.passSigningPublicKey,
        passSigningPreviousPrivateKey: current?.passSigningPrivateKey,
        passSigningRotatedAt: now,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  forgetKeys();
  logger.warn(`Gate passes: signing key rotated by ${actor.userName}. Old key verifies for ${KEY_GRACE_HOURS}h.`);
  return { rotatedAt: now, verifyingKeys: await verifyingKeys(), graceHours: KEY_GRACE_HOURS };
}

/**
 * Delete the retired key once nothing can still be carrying it.
 *
 * Refuses inside the window, and that refusal is the point. Deleting early
 * turns away real guests holding real invitations at a gate that cannot phone
 * anybody to check — so the check lives here, in the only function that can
 * delete, rather than in a caller that might forget.
 */
export async function dropRetiredKey(now = new Date()): Promise<boolean> {
  const current = await settings();
  if (!current?.passSigningPreviousPublicKey) return false;
  if (stillInGrace(current.passSigningRotatedAt, now)) return false;

  await GlobalSetting.updateOne({ _id: current._id }, {
    $unset: {
      passSigningPreviousPublicKey: '',
      passSigningPreviousPrivateKey: '',
      passSigningRotatedAt: '',
    },
  });
  forgetKeys();
  logger.info('Gate passes: the retired signing key is past its grace window and has been removed.');
  return true;
}

interface PassClaims {
  /** Pass id. */
  p: string;
  /** Society, so a pass from one society cannot be read at another's gate. */
  s: string;
  /** Expiry, seconds since epoch. */
  e: number;
  /** Visitor name, so an offline guard can see who they are admitting. */
  n: string;
  /** Flat label, same reason. */
  f?: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

async function sign(claims: PassClaims): Promise<string> {
  // Always the NEWEST key. A retired key still verifies, but nothing new is
  // ever signed with it — otherwise the grace window would never actually
  // drain and the old key could not safely be dropped.
  const { signing } = await resolveKeys();
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(signing.privateKey));
  return `${body}.${b64url(sig)}`;
}

export interface VerifiedPayload {
  valid: boolean;
  reason?: string;
  claims?: PassClaims;
}

/**
 * Check a QR blob's signature and expiry — no database, no network.
 *
 * Exported because this is exactly what the guard device runs offline, and
 * having the server run the identical function means the two can never drift
 * into disagreeing about what a valid pass looks like.
 */
export async function verifyPayload(payload: string, now = new Date()): Promise<VerifiedPayload> {
  try {
    const [body, sig] = payload.split('.');
    if (!body || !sig) return { valid: false, reason: 'That is not a ResiSmart pass.' };

    // Try every key still inside its grace window, newest first. The common
    // case matches on the first, so a rotation costs one extra Ed25519 verify
    // on the rare old pass and nothing at all the rest of the time.
    const keys = await verifyingKeys();
    const signature = Buffer.from(sig, 'base64url');
    const good = keys.some(key => {
      try {
        return crypto.verify(null, Buffer.from(body), crypto.createPublicKey(key), signature);
      } catch {
        // A malformed key in the list (a truncated env var, a half-written
        // rotation) must not take down verification for the good ones.
        return false;
      }
    });
    // Signature first, contents second. Parsing an unverified blob and acting
    // on its claims is how a tampered pass gets a foot in the door.
    if (!good) return { valid: false, reason: 'This pass has been tampered with.' };

    const claims: PassClaims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (claims.e * 1000 < now.getTime()) return { valid: false, reason: 'This pass has expired.', claims };

    return { valid: true, claims };
  } catch {
    return { valid: false, reason: 'That code could not be read.' };
  }
}

// ------------------------------------------------------------------ issuing

export interface IssueInput {
  flatId: string;
  visitorName: string;
  visitorPhone?: string;
  category: string;
  purpose?: string;
  validFrom?: Date;
  validTo?: Date;
  maxUses?: number;
}

/**
 * Six digits, avoiding a collision with any pass that can still be used.
 *
 * Retried rather than sequential: a predictable code is a code a stranger can
 * guess at the gate, and 900,000 possibilities only helps if the next one is
 * not the last one plus a bit.
 */
async function allocateCode(societyId: string): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const code = String(crypto.randomInt(100_000, 1_000_000));
    const clash = await GatePass.exists({ societyId: oid(societyId), code, status: 'ACTIVE' });
    if (!clash) return code;
  }
  throw new PassError('Could not allocate a code just now. Please try again.', 503);
}

export async function issue(societyId: string, input: IssueInput, actor: Actor): Promise<IGatePass> {
  const flat = await Flat.findOne({ _id: oid(input.flatId), societyId: oid(societyId) }).lean();
  if (!flat) throw new PassError('That flat could not be found.', 404);

  // Only somebody who lives there may invite to it. Checked here rather than
  // in the controller so every future caller inherits it.
  const lives = await Resident.exists({
    societyId: oid(societyId), flatId: flat._id, userId: oid(actor.userId), isActive: true,
  });
  if (!lives) throw new PassError('You can only invite visitors to your own flat.', 403);

  const validFrom = input.validFrom || new Date();
  const validTo = input.validTo || new Date(validFrom.getTime() + 24 * 60 * 60 * 1000);
  if (validTo <= validFrom) throw new PassError('The pass would expire before it starts.');

  const maxWindow = new Date(validFrom.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (validTo > maxWindow) throw new PassError('A pass cannot be valid for more than a month.');

  const code = await allocateCode(societyId);

  // The SIGNED expiry is capped at 12 hours even when the pass itself lasts a
  // month. Beyond that window an offline device must come back online to check
  // the pass is still live — otherwise a revoked month-long pass would work at
  // a disconnected gate for the rest of the month.
  const signedExp = Math.min(
    validTo.getTime(),
    Date.now() + MAX_OFFLINE_HOURS * 60 * 60 * 1000,
  );

  const _id = new mongoose.Types.ObjectId();
  const qrPayload = await sign({
    p: String(_id),
    s: String(societyId),
    e: Math.floor(signedExp / 1000),
    n: input.visitorName.trim(),
    f: `${flat.blockName || ''} ${flat.number}`.trim(),
  });

  return GatePass.create({
    _id,
    societyId: oid(societyId),
    flatId: flat._id,
    flatLabel: `${flat.blockName || ''} ${flat.number}`.trim(),
    blockId: flat.blockId,
    visitorName: input.visitorName.trim(),
    visitorPhone: input.visitorPhone,
    category: input.category,
    purpose: input.purpose,
    code, qrPayload,
    validFrom, validTo,
    maxUses: input.maxUses || 1,
    status: 'ACTIVE',
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });
}

export async function revoke(
  societyId: string, id: string, reason: string | undefined, actor: Actor,
  opts: { onBehalf?: boolean } = {},
): Promise<IGatePass> {
  const pass = await GatePass.findOne({ _id: oid(id), societyId: oid(societyId) });
  if (!pass) throw new PassError('That pass could not be found.', 404);

  // `issue` has always checked that the caller lives in the flat. Cancelling
  // checked only the society — so any resident could cancel every invitation
  // in the building, and the host would discover it when their guest was
  // turned away at the gate. The office may still cancel on somebody's behalf.
  if (!opts.onBehalf && pass.flatId) {
    const lives = await Resident.exists({
      societyId: oid(societyId), flatId: pass.flatId, userId: oid(actor.userId), isActive: true,
    });
    if (!lives) throw new PassError('You can only cancel a pass for your own flat.', 403);
  }

  if (pass.status === 'USED') throw new PassError('That pass has already been used.');

  pass.status = 'REVOKED';
  pass.revokedAt = new Date();
  pass.revokedReason = reason?.trim();
  pass.updatedBy = oid(actor.userId); pass.updatedByName = actor.userName;
  await pass.save();
  return pass;
}

// ------------------------------------------------------------------ redeem

export interface RedeemResult {
  pass: IGatePass;
  /** True when this redemption pushed the pass past its allowance. */
  overUsed: boolean;
  message: string;
}

/**
 * Burn a pass. The atomic step this whole feature rests on.
 *
 * The guard is holding the phone; a resident may be revoking the pass at the
 * same instant; a second gate may be scanning the same QR. The filtered update
 * settles all three — `status: 'ACTIVE'` and the usage ceiling are part of the
 * QUERY, so the database decides the winner, not the order two requests
 * happened to arrive in.
 */
/**
 * Which pass is being presented, and would it be accepted — WITHOUT burning it.
 *
 * Exists because burning is irreversible and the caller has more checks to run.
 * `arriveByPass` used to redeem first and validate the resulting entry second,
 * so a society with a REQUIRED capture rule destroyed an invitation on every
 * single scan before discovering it could not record the visit. Asking the
 * question before taking the action is the whole fix, and it belongs here
 * rather than in the caller so the "why not" reasons stay in one place.
 *
 * Throws the same messages `redeem` would, for the same reasons: a guard
 * standing in front of a real guest needs "cancelled by the flat", not
 * "invalid".
 */
export async function inspect(
  societyId: string,
  by: { code?: string; payload?: string },
  opts: { at?: Date } = {},
): Promise<{ id: string; category: string; visitorName: string; visitorPhone?: string; flatId?: string }> {
  const at = opts.at || new Date();
  const { filter, existing } = await locate(societyId, by, at);
  const usable = await GatePass.findOne(filter).lean();
  if (!usable) refuse(existing, at);
  return {
    id: String(usable!._id),
    category: usable!.category,
    visitorName: usable!.visitorName,
    visitorPhone: usable!.visitorPhone,
    flatId: usable!.flatId ? String(usable!.flatId) : undefined,
  };
}

/**
 * Turn "a code or a QR" into the query that claims it, plus whatever row does
 * exist under that identifier — the two things every path below needs.
 */
async function locate(
  societyId: string, by: { code?: string; payload?: string }, at: Date,
): Promise<{ filter: Record<string, unknown>; existing: IGatePass | null }> {
  let passId: string | undefined;

  if (by.payload) {
    const check = await verifyPayload(by.payload, at);
    // A tampered or expired QR never reaches the database at all.
    if (!check.valid) throw new PassError(check.reason || 'That pass is not valid.');
    if (check.claims!.s !== String(societyId)) {
      throw new PassError('That pass belongs to another society.', 403);
    }
    passId = check.claims!.p;
  }

  const filter: Record<string, unknown> = {
    societyId: oid(societyId),
    status: 'ACTIVE',
    validFrom: { $lte: at },
    validTo: { $gte: at },
    $expr: { $lt: ['$usedCount', '$maxUses'] },
  };
  if (passId) filter._id = oid(passId);
  else if (by.code) filter.code = String(by.code).trim();
  else throw new PassError('No pass was presented.');

  // Work out WHY, because "invalid pass" tells a guard standing in front of a
  // real guest nothing they can act on.
  const existing = await GatePass.findOne(
    passId ? { _id: oid(passId), societyId: oid(societyId) }
           : { code: String(by.code).trim(), societyId: oid(societyId) },
  ).sort({ createdAt: -1 });

  return { filter, existing };
}

/** The refusal, in the words a guard can repeat to the person in front of them. */
function refuse(existing: IGatePass | null, at: Date): never {
  if (!existing) throw new PassError('No such pass. Please check the code.', 404);
  if (existing.status === 'REVOKED') throw new PassError('This pass was cancelled by the flat.');
  if (existing.status === 'USED' || existing.usedCount >= existing.maxUses) {
    throw new PassError('This pass has already been used.');
  }
  if (existing.validFrom > at) {
    throw new PassError(`This pass is not valid until ${existing.validFrom.toLocaleString('en-IN')}.`);
  }
  if (existing.validTo < at) throw new PassError('This pass has expired.');
  throw new PassError('That pass cannot be used right now.');
}

export async function redeem(
  societyId: string,
  by: { code?: string; payload?: string },
  actor: Actor,
  opts: { at?: Date; offlineQueued?: boolean } = {},
): Promise<RedeemResult> {
  const at = opts.at || new Date();
  const { filter, existing } = await locate(societyId, by, at);

  const claimed = await GatePass.findOneAndUpdate(
    filter,
    {
      $inc: { usedCount: 1 },
      $set: { usedAt: at, updatedBy: oid(actor.userId), updatedByName: actor.userName },
    },
    { new: true },
  );

  if (claimed) {
    // Mark it spent once the allowance is gone, so the partial unique index
    // releases the six-digit code for reuse.
    if (claimed.usedCount >= claimed.maxUses) {
      claimed.status = 'USED';
      await claimed.save();
    }
    return { pass: claimed, overUsed: false, message: `${claimed.visitorName} — pass accepted` };
  }

  // Nothing was claimed. `existing` — read before the claim — says why.
  if (!existing) throw new PassError('No such pass. Please check the code.', 404);

  if (opts.offlineQueued) {
    /**
     * The reconciliation case, and the one place this service deliberately
     * does NOT refuse.
     *
     * The guard's device verified a real signature offline and let the person
     * in — half an hour ago. Rejecting the sync now would not un-admit
     * anybody; it would only mean the entry never reaches the register, and
     * "who is inside" becomes wrong. So it is recorded, flagged, and shown on
     * the pass. Blocking is a fantasy about a decision that was already made.
     */
    existing.overUsedAt = at;
    existing.overUseNote = existing.status === 'REVOKED'
      ? 'Used at an offline gate after being revoked'
      : 'Used more times than allowed, across offline gates';
    existing.usedCount += 1;
    await existing.save();

    if (existing.flatId) {
      householdOfFlat(societyId, String(existing.flatId))
        .then(({ userIds: to }) => notify({
          societyId, userIds: to, kind: 'GATE_PASS_OVERUSE',
          title: 'A pass was used again',
          body: `${existing.visitorName}'s pass was accepted at an offline gate — ${existing.overUseNote}.`,
          link: '/dashboard/visitors/passes',
          entityType: 'GatePass', entityId: String(existing._id),
          priority: 'HIGH',
        }))
        .catch(e => logger.error(`Pass over-use notice failed: ${e.message}`));
    }

    return { pass: existing, overUsed: true, message: 'Recorded, and flagged for review.' };
  }

  refuse(existing, at);
}

// ------------------------------------------------------------------ reading

export async function listForFlat(societyId: string, flatIds: string[], includeSpent = false) {
  const filter: Record<string, unknown> = {
    societyId: oid(societyId),
    flatId: { $in: flatIds.map(oid) },
  };
  if (!includeSpent) filter.status = 'ACTIVE';
  return GatePass.find(filter).sort({ createdAt: -1 }).limit(100).lean();
}

export async function listForSociety(societyId: string, activeOnly = true) {
  const filter: Record<string, unknown> = { societyId: oid(societyId) };
  if (activeOnly) filter.status = 'ACTIVE';
  return GatePass.find(filter).sort({ createdAt: -1 }).limit(200).lean();
}

/**
 * Retire passes whose window has closed.
 *
 * Not cosmetic: while a pass sits at ACTIVE it holds its six-digit code
 * against the partial unique index, and a society issuing a few hundred a week
 * would slowly find codes harder to allocate.
 */
export async function expireOld(now = new Date()): Promise<number> {
  const res = await GatePass.updateMany(
    { status: 'ACTIVE', validTo: { $lt: now } },
    { $set: { status: 'EXPIRED' } },
  );
  return res.modifiedCount || 0;
}
