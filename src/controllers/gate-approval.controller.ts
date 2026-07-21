import { Request, Response } from 'express';
import * as approvals from '../services/gate-approval.service';
import { ApprovalError } from '../services/gate-approval.service';
import * as arrival from '../services/arrival.service';
import { ResidentGatePreference } from '../models/resident-gate-preference.model';
import { Resident } from '../models/resident.model';
import { VISITOR_CATEGORIES } from '../models/society-ops-policy.model';
import mongoose from 'mongoose';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Someone'),
});

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof ApprovalError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

/** The guard asks. Returns a verdict the console acts on immediately. */
export const ask = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const result = await approvals.requestApproval(societyId, req.body, actorOf(req));
    res.status(result.request ? 201 : 200).json({ success: true, data: result });
  } catch (e: any) { fail(res, e, 'ask the flat'); }
};

export const pending = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await approvals.pending(String(req.user!.activeTenantId)) });
  } catch (e: any) { fail(res, e, 'load pending approvals'); }
};

/** A resident's own queue — scoped by who was asked, never by role. */
export const mine = async (req: Request, res: Response) => {
  try {
    const rows = await approvals.myRequests(
      String(req.user!.activeTenantId), String(req.user!.userId),
      req.query.all === 'true',
    );
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load your approvals'); }
};

export const decide = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const request = await approvals.decide(
      societyId, req.params.id, req.body.allow === true, actorOf(req),
      { leaveAtGate: req.body.leaveAtGate === true },
    );
    // Carry the decision onto the waiting entry, so "who is inside" reflects it.
    // Without this the resident's answer changes the request and leaves the
    // person stuck AWAITING forever — the join the whole module was missing.
    await arrival.applyDecision(
      societyId, String(request._id), request.outcome as any,
      { name: request.decidedByName }, actorOf(req),
    ).catch(e => logger.error(`Could not settle entry: ${e.message}`));
    auditFinance(req, 'GATE_APPROVAL_DECIDED', 'ApprovalRequest', String(request._id), {
      newValues: { outcome: request.outcome, visitor: request.visitorName },
    });
    res.json({ success: true, data: request, message: `${request.visitorName}: ${request.outcome.toLowerCase().replace(/_/g, ' ')}` });
  } catch (e: any) { fail(res, e, 'record your answer'); }
};

export const override = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const request = await approvals.override(
      societyId, req.params.id, req.body.allow === true, req.body.reason, actorOf(req),
    );
    await arrival.applyDecision(
      societyId, String(request._id), request.outcome as any,
      { name: request.decidedByName, reason: request.reason }, actorOf(req),
    ).catch(e => logger.error(`Could not settle entry: ${e.message}`));
    // Audited separately from a resident decision, and deliberately so: an
    // override is the event a committee actually goes looking for.
    auditFinance(req, 'GATE_APPROVAL_OVERRIDE', 'ApprovalRequest', String(request._id), {
      newValues: { outcome: request.outcome, visitor: request.visitorName, reason: request.reason },
    });
    res.json({ success: true, data: request, message: 'Recorded, and the flat has been told.' });
  } catch (e: any) { fail(res, e, 'record that override'); }
};

export const report = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const from = req.query.from
      ? new Date(String(req.query.from))
      : new Date(to.getFullYear(), to.getMonth(), 1);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({ success: false, message: 'Those dates could not be read.' });
    }
    res.json({ success: true, data: await approvals.overrideReport(societyId, from, to) });
  } catch (e: any) { fail(res, e, 'build the override report'); }
};

// ------------------------------------------------------------- preferences

/**
 * A resident's own gate preferences, for the flats they actually live in.
 *
 * The flat list comes from their Resident rows, never from the request — so a
 * crafted flatId cannot set preferences on somebody else's home.
 */
export const myPreferences = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const userId = String(req.user!.userId);
    const homes = await Resident.find(
      { societyId: oid(societyId), userId: oid(userId), isActive: true },
      { flatId: 1 },
    ).lean();
    const flatIds = homes.map(h => h.flatId);

    const prefs = await ResidentGatePreference.find({
      societyId: oid(societyId), userId: oid(userId), flatId: { $in: flatIds },
    }).lean();

    res.json({
      success: true,
      data: { preferences: prefs, flatIds: flatIds.map(String), categories: VISITOR_CATEGORIES },
    });
  } catch (e: any) { fail(res, e, 'load your gate preferences'); }
};

export const savePreferences = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const userId = String(req.user!.userId);
    const { flatId, categoryMode, quietHours, expectedVisitors } = req.body;

    // The authorisation check, and the only one that matters here.
    const lives = await Resident.exists({
      societyId: oid(societyId), userId: oid(userId), flatId: oid(flatId), isActive: true,
    });
    if (!lives) return res.status(403).json({ success: false, message: 'That is not your flat.' });

    const doc = await ResidentGatePreference.findOneAndUpdate(
      { societyId: oid(societyId), flatId: oid(flatId), userId: oid(userId) },
      {
        $set: {
          categoryMode, quietHours, expectedVisitors,
          updatedBy: oid(userId),
        },
        $setOnInsert: { createdBy: oid(userId) },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.json({ success: true, data: doc, message: 'Saved.' });
  } catch (e: any) { fail(res, e, 'save your gate preferences'); }
};

/** What the gate will actually do — the same answer the backend will honour. */
export const effective = async (req: Request, res: Response) => {
  try {
    const rule = await approvals.effectivePolicy(
      String(req.user!.activeTenantId),
      String(req.query.category || 'GUEST'),
      { flatId: req.query.flatId ? String(req.query.flatId) : null },
    );
    res.json({ success: true, data: rule });
  } catch (e: any) { fail(res, e, 'work out the gate rule'); }
};
