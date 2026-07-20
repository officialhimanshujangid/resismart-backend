import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as passes from '../services/gate-pass.service';
import { PassError } from '../services/gate-pass.service';
import { Resident } from '../models/resident.model';
import { UserRole } from '../constants/roles';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Someone'),
});

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
    const pass = await passes.revoke(societyId, req.params.id, req.body?.reason, actorOf(req));
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
 * verifying key, and how long a signature is trusted for.
 */
export const scannerConfig = async (_req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: { publicKey: await passes.verifyingKey(), maxOfflineHours: 12 },
    });
  } catch (e: any) { fail(res, e, 'load the scanner configuration'); }
};

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
    const items: any[] = Array.isArray(req.body.items) ? req.body.items.slice(0, 200) : [];

    const results = [];
    for (const item of items) {
      try {
        const r = await passes.redeem(
          societyId,
          { code: item.code, payload: item.payload },
          actor,
          { offlineQueued: true, at: item.scannedAt ? new Date(item.scannedAt) : undefined },
        );
        results.push({
          clientId: item.clientId, ok: true,
          overUsed: r.overUsed, visitorName: r.pass.visitorName, message: r.message,
        });
      } catch (e: any) {
        results.push({ clientId: item.clientId, ok: false, message: e.message });
      }
    }

    res.json({
      success: true,
      data: { results, flagged: results.filter(r => r.overUsed).length },
    });
  } catch (e: any) { fail(res, e, 'sync the gate device'); }
};
