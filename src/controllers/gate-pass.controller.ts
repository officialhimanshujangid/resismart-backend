import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as passes from '../services/gate-pass.service';
import { PassError } from '../services/gate-pass.service';
import * as arrival from '../services/arrival.service';
import { Resident } from '../models/resident.model';
import { SocietyStaff } from '../models/society-staff.model';
import { GlobalSetting } from '../models/global-setting.model';
import { allows } from '../services/access-role.service';
import { AuditService } from '../services/audit.service';
import { UserRole, TenantType } from '../constants/roles';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Someone'),
});

/**
 * Is this the office acting for somebody, or a resident acting for themselves?
 *
 * GATE_CONSOLE FULL is the right test: it is what the guard's own screen
 * carries, so the people who can already admit a visitor at the door are the
 * people who can cancel an invitation to one. Absent `req.access` — no
 * `attachAccess` on the route — this is false, which is the safe answer.
 */
const onBehalf = (req: Request) => !!req.access && allows(req.access, 'GATE_CONSOLE', 'FULL');

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof PassError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

export const issue = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const pass = await passes.issue(societyId, {
      ...req.body,
      validFrom: req.body.validFrom ? new Date(req.body.validFrom) : undefined,
      validTo: req.body.validTo ? new Date(req.body.validTo) : undefined,
    }, actorOf(req));
    auditFinance(req, 'GATE_PASS_ISSUED', 'GatePass', String(pass._id), {
      newValues: { visitor: pass.visitorName, flat: pass.flatLabel, validTo: pass.validTo },
    });
    res.status(201).json({ success: true, data: pass, message: `Pass ready — code ${pass.code}` });
  } catch (e: any) { fail(res, e, 'create that pass'); }
};

export const revoke = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const pass = await passes.revoke(societyId, req.params.id, req.body?.reason, actorOf(req), {
      onBehalf: onBehalf(req),
    });
    auditFinance(req, 'GATE_PASS_REVOKED', 'GatePass', String(pass._id), {
      newValues: { reason: pass.revokedReason },
    });
    res.json({
      success: true, data: pass,
      // Said plainly rather than buried: an offline gate genuinely cannot know
      // about this yet, and a resident who assumes otherwise is misled.
      message: 'Cancelled. A gate that is offline may still accept it for up to 12 hours.',
    });
  } catch (e: any) { fail(res, e, 'cancel that pass'); }
};

/** Mine, or the whole society's if I am the one on the gate. */
export const list = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const role = String(req.user!.activeRole || '');
    const isStaff = role === UserRole.SOCIETY_ADMIN
      || role === UserRole.SOCIETY_COMMITTEE
      || role === UserRole.SOCIETY_EMPLOYEE;

    if (isStaff && req.query.scope === 'society') {
      const rows = await passes.listForSociety(societyId, req.query.all !== 'true');
      return res.json({ success: true, data: rows });
    }

    // A resident sees passes for the flats they actually live in — the list of
    // flats comes from their own Resident rows, never from the query string.
    const homes = await Resident.find(
      { societyId: oid(societyId), userId: oid(req.user!.userId), isActive: true },
      { flatId: 1 },
    ).lean();
    const rows = await passes.listForFlat(
      societyId, homes.map(h => String(h.flatId)), req.query.all === 'true',
    );
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load passes'); }
};

export const redeem = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const result = await passes.redeem(
      societyId,
      { code: req.body.code, payload: req.body.payload },
      actorOf(req),
      // No `offlineQueued` here, and nothing in the body can set it.
      //
      // The flag makes a refusal into an accept-and-flag, so if the client
      // could ask for it, every "already used" and "cancelled by the flat"
      // would become a way in. It is set ONLY by the sync handler below, where
      // it describes what the device already did rather than what it wants.
      //
      // scannedAt is dropped for the same reason: a live scan happens now, and
      // a client-supplied time could revive an expired pass.
      {},
    );
    auditFinance(req, result.overUsed ? 'GATE_PASS_OVERUSED' : 'GATE_PASS_REDEEMED',
      'GatePass', String(result.pass._id), {
        newValues: { visitor: result.pass.visitorName, overUsed: result.overUsed },
      });
    res.json({ success: true, data: result, message: result.message });
  } catch (e: any) { fail(res, e, 'check that pass'); }
};

/**
 * What a guard device caches so it can work with no network: the public
 * verifying KEYS, and how long a signature is trusted for.
 *
 * Plural, and that is the load-bearing detail. During a key rotation two keys
 * are legitimate at once — the new one signs, the old one still has to verify
 * every pass already sitting in a guest's WhatsApp. A device that cached only
 * the newest would turn real guests away at a gate with no network and no way
 * to ask anybody. `publicKey` is kept alongside it so a guard app built before
 * this change keeps working; new clients must read `publicKeys`.
 */
export const scannerConfig = async (_req: Request, res: Response) => {
  try {
    const publicKeys = await passes.verifyingKeys();
    res.json({
      success: true,
      data: {
        publicKeys,
        publicKey: publicKeys[0],
        maxOfflineHours: passes.MAX_OFFLINE_HOURS,
        // So an old cache can be spotted and refreshed rather than trusted.
        keyGraceHours: passes.KEY_GRACE_HOURS,
      },
    });
  } catch (e: any) { fail(res, e, 'load the scanner configuration'); }
};

// --------------------------------------------------------------- signing key
//
// These two are NOT society endpoints, and they are mounted on the SYSTEM_OWNER
// settings router rather than beside the rest of the passes routes. One install
// has one signing key: the society is a claim INSIDE the signed blob, not a
// property of the key, so a society admin rotating "their" key would silently
// re-key every gate in every society on the platform. There is also no
// permission that could express this — `requirePermission` resolves access
// against the caller's society, and a SYSTEM_OWNER has none, so it would refuse
// the one person who should be allowed.

/** What is signing today, and what is still settling. Never the key material. */
export const signingKeyStatus = async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await passes.signingKeyStatus() });
  } catch (e: any) { fail(res, e, 'read the pass signing key status'); }
};

/**
 * Rotate to a fresh signing pair.
 *
 * Both of the service's refusals are 409s carrying instructions — "the keys are
 * pinned in the environment, here is how to rotate them there" and "a rotation
 * is still settling, rotating again would cancel every pass signed before it".
 * `fail` passes a PassError's own message and status straight through, so the
 * operator reads the sentence that tells them what to do rather than a generic
 * "could not rotate".
 */
export const rotateSigningKey = async (req: Request, res: Response) => {
  try {
    const result = await passes.rotateSigningKey(actorOf(req));

    // Platform-wide and security-relevant, so it goes in the reviewable trail
    // rather than only the application log. Not `auditFinance` — that stamps
    // every row TenantType.SOCIETY and scopes it to the caller's active
    // society, which is exactly the thing this key is not.
    const setting = await GlobalSetting.findOne({}, { _id: 1 }).lean();
    if (setting) {
      AuditService.log({
        userId: String(req.user!.userId),
        userName: String(req.user!.userName || 'Unknown'),
        tenantId: null,
        tenantType: TenantType.SYSTEM,
        action: 'GATE_PASS_SIGNING_KEY_ROTATED',
        resource: 'GlobalSetting',
        resourceId: String(setting._id),
        ipAddress: req.ip || 'unknown',
        userAgent: (req.headers['user-agent'] as string) || 'unknown',
        newValues: { rotatedAt: result.rotatedAt, graceHours: result.graceHours },
      });
    }

    res.json({
      success: true,
      data: await passes.signingKeyStatus(),
      // Said plainly, because the operator's next move is at the gates and not
      // on this screen: nothing they just did takes effect on a guard device
      // until that device asks for the new key list.
      message: `Rotated. Passes issued before now keep working for ${result.graceHours} hours — `
        + 'every guard device must re-fetch its scanner configuration to accept new ones.',
    });
  } catch (e: any) { fail(res, e, 'rotate the pass signing key'); }
};

/**
 * When the device says it scanned — bounded by what the server can believe.
 *
 * `scannedAt` arrived from the client and was passed straight into `redeem` as
 * the moment to evaluate the pass against. That single line defeated the entire
 * offline design. The signed expiry is capped at twelve hours precisely so a
 * revoked pass can never work at a disconnected gate for longer than that; a
 * client that chooses its own "now" simply names a time inside the window and
 * the cap evaporates. Any pass ever issued — expired, spent, cancelled — became
 * replayable forever by a guard device or a stolen guard token. The live-scan
 * handler refuses client times outright and says so in its own comment; the
 * sync handler accepted them.
 *
 * Now: a future timestamp is a clock that is fast, so it is clamped to now
 * rather than rejected — a device five minutes ahead is a real and harmless
 * thing. A timestamp older than the offline window cannot be honoured, because
 * beyond it the device was required to come back online and re-check; it is
 * refused, loudly, per item.
 */
const OFFLINE_WINDOW_MS = passes.MAX_OFFLINE_HOURS * 60 * 60 * 1000;

function believableScanTime(raw: unknown, now: Date): Date {
  if (raw === undefined || raw === null || raw === '') return now;
  const t = new Date(String(raw));
  if (Number.isNaN(t.getTime())) throw new PassError('That scan time could not be read.');
  if (t.getTime() > now.getTime()) return now;
  if (now.getTime() - t.getTime() > OFFLINE_WINDOW_MS) {
    throw new PassError(
      `That scan is older than ${passes.MAX_OFFLINE_HOURS} hours and cannot be reconciled. Record it at the gate instead.`,
    );
  }
  return t;
}

/**
 * Everything the device queued while it was offline.
 *
 * Each item is settled independently and one failure never stops the rest —
 * a device coming back after an hour underground may be carrying twenty
 * entries, and losing nineteen of them to the first bad one would be worse
 * than the outage.
 */
export const sync = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const actor = actorOf(req);
    const guardStaffId = await guardStaffIdOf(req);
    const items: any[] = Array.isArray(req.body.items) ? req.body.items.slice(0, 200) : [];
    const now = new Date();

    // Within one batch as well as across requests. A device that appends the
    // same queue row twice before sending is a bug on the device, and the
    // society should not end up with the same visitor in the register twice
    // because of it.
    const seen = new Set<string>();

    const results = [];
    for (const item of items) {
      try {
        const clientId = String(item.clientId || '').trim();
        if (!clientId) throw new PassError('Each queued scan needs a client id.');
        if (seen.has(clientId)) {
          results.push({ clientId, ok: true, duplicate: true, overUsed: false, message: 'Already in this batch.' });
          continue;
        }
        seen.add(clientId);

        /**
         * The entry, not just the burn.
         *
         * This handler called `redeem` and stopped. The pass was marked used,
         * the over-use notice went out — and no `VisitorEntry` was ever
         * written. Every visitor admitted during an outage was permanently
         * absent from the register, from "who is inside", from the morning
         * reconciliation, and from the retention purge that is supposed to
         * delete their photograph after ninety days. The one record the whole
         * module exists to keep was the one thing an outage destroyed.
         */
        const r = await arrival.arriveByQueuedPass(
          societyId,
          {
            clientId,
            code: item.code,
            payload: item.payload,
            scannedAt: believableScanTime(item.scannedAt, now),
          },
          actor,
          { guardStaffId },
        );

        results.push({
          clientId, ok: true, duplicate: r.duplicate,
          overUsed: r.overUsed, visitorName: r.entry.visitorName,
          entryId: String(r.entry._id), entryCode: r.entry.entryCode,
          message: r.reason,
        });
      } catch (e: any) {
        results.push({ clientId: item.clientId, ok: false, overUsed: false, message: e.message });
      }
    }

    res.json({
      success: true,
      data: {
        results,
        flagged: results.filter(r => r.overUsed).length,
        recorded: results.filter(r => r.ok && !r.duplicate).length,
      },
    });
  } catch (e: any) { fail(res, e, 'sync the gate device'); }
};

/** The staff _id for the device's guard, so an offline entry names them too. */
async function guardStaffIdOf(req: Request): Promise<string | undefined> {
  const post = await SocietyStaff.findOne({
    societyId: oid(String(req.user!.activeTenantId)),
    userId: oid(String(req.user!.userId)), isActive: true,
  }).select('_id').lean();
  return post ? String(post._id) : undefined;
}
