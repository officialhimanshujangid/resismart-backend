import mongoose from 'mongoose';
import crypto from 'crypto';
import { GatePass, IGatePass } from '../models/gate-pass.model';
import { GlobalSetting } from '../models/global-setting.model';
import { Flat } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { notify } from './notification.service';
import { usersOfFlat } from './notify-recipients';
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

const MAX_OFFLINE_HOURS = 12;

// ------------------------------------------------------------------ signing

let keysReady: { publicKey: string; privateKey: string } | null = null;
let keysPending: Promise<{ publicKey: string; privateKey: string }> | null = null;

/**
 * The signing pair, generated once and kept.
 *
 * Same shape as the VAPID resolution in push.service, and for the same reason:
 * regenerating on restart would silently invalidate every pass already handed
 * out, and nothing would look broken until a guest was turned away.
 */
async function signingKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (keysReady) return keysReady;
  if (keysPending) return keysPending;

  keysPending = (async () => {
    try {
      const stored = await GlobalSetting.findOne({
        passSigningPrivateKey: { $exists: true, $ne: '' },
      }).lean();

      if (stored?.passSigningPublicKey && stored?.passSigningPrivateKey) {
        keysReady = { publicKey: stored.passSigningPublicKey, privateKey: stored.passSigningPrivateKey };
        return keysReady;
      }

      const pair = crypto.generateKeyPairSync('ed25519');
      const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

      await GlobalSetting.findOneAndUpdate(
        {},
        { $set: { passSigningPublicKey: publicKey, passSigningPrivateKey: privateKey } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      // Read back, so a racing second process adopts the winner's pair rather
      // than signing with one nobody stored.
      const settled = await GlobalSetting.findOne({}).lean();
      keysReady = {
        publicKey: settled?.passSigningPublicKey || publicKey,
        privateKey: settled?.passSigningPrivateKey || privateKey,
      };
      logger.info('Gate passes: generated an Ed25519 signing key.');
      return keysReady;
    } finally {
      keysPending = null;
    }
  })();

  return keysPending;
}

/** What a guard device needs to verify offline. Public by definition. */
export async function verifyingKey(): Promise<string> {
  return (await signingKeys()).publicKey;
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
  const { privateKey } = await signingKeys();
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(privateKey));
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

    const { publicKey } = await signingKeys();
    const good = crypto.verify(
      null,
      Buffer.from(body),
      crypto.createPublicKey(publicKey),
      Buffer.from(sig, 'base64url'),
    );
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

export async function revoke(societyId: string, id: string, reason: string | undefined, actor: Actor): Promise<IGatePass> {
  const pass = await GatePass.findOne({ _id: oid(id), societyId: oid(societyId) });
  if (!pass) throw new PassError('That pass could not be found.', 404);
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
export async function redeem(
  societyId: string,
  by: { code?: string; payload?: string },
  actor: Actor,
  opts: { at?: Date; offlineQueued?: boolean } = {},
): Promise<RedeemResult> {
  const at = opts.at || new Date();
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

  // Nothing was claimed. Work out WHY, because "invalid pass" tells a guard
  // standing in front of a real guest nothing they can act on.
  const existing = await GatePass.findOne(
    passId ? { _id: oid(passId), societyId: oid(societyId) }
           : { code: String(by.code).trim(), societyId: oid(societyId) },
  ).sort({ createdAt: -1 });

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
      usersOfFlat(societyId, String(existing.flatId))
        .then(to => notify({
          societyId, userIds: to, kind: 'GATE_PASS_OVERUSE',
          title: 'A pass was used again',
          body: `${existing.visitorName}'s pass was accepted at an offline gate — ${existing.overUseNote}.`,
          link: '/dashboard/gate/passes',
          entityType: 'GatePass', entityId: String(existing._id),
          priority: 'HIGH',
        }))
        .catch(e => logger.error(`Pass over-use notice failed: ${e.message}`));
    }

    return { pass: existing, overUsed: true, message: 'Recorded, and flagged for review.' };
  }

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
