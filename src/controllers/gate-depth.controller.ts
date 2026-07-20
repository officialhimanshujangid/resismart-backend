import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as depth from '../services/gate-depth.service';
import { DepthError } from '../services/gate-depth.service';
import { Resident } from '../models/resident.model';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Someone'),
});

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof DepthError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

// ------------------------------------------------------------------ vehicles

export const listVehicles = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const rows = await depth.listVehicles(societyId, req.query.flatId ? String(req.query.flatId) : undefined);
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load vehicles'); }
};

export const addVehicle = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const v = await depth.addVehicle(societyId, req.body, actorOf(req));
    auditFinance(req, 'VEHICLE_ADDED', 'ResidentVehicle', String(v._id), {
      newValues: { number: v.displayNumber, flat: v.flatLabel },
    });
    res.status(201).json({ success: true, data: v, message: `${v.displayNumber} added.` });
  } catch (e: any) { fail(res, e, 'add that vehicle'); }
};

export const removeVehicle = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const removed = await depth.removeVehicle(societyId, req.params.id, actorOf(req));
    if (!removed) return res.status(404).json({ success: false, message: 'That vehicle could not be found.' });
    auditFinance(req, 'VEHICLE_REMOVED', 'ResidentVehicle', req.params.id);
    res.json({ success: true, data: { removed }, message: 'Removed.' });
  } catch (e: any) { fail(res, e, 'remove that vehicle'); }
};

/** What the guard's plate box offers as they type. */
export const suggestVehicles = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const rows = await depth.suggestVehicles(societyId, String(req.query.q || ''));
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'look that up'); }
};

/** A resident's own vehicles, for the my-flat screen. */
export const myVehicles = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const homes = await Resident.find(
      { societyId: oid(societyId), userId: oid(req.user!.userId), isActive: true },
      { flatId: 1 },
    ).lean();

    const all = await Promise.all(homes.map(h => depth.listVehicles(societyId, String(h.flatId))));
    res.json({ success: true, data: { vehicles: all.flat(), flatIds: homes.map(h => String(h.flatId)) } });
  } catch (e: any) { fail(res, e, 'load your vehicles'); }
};

// ----------------------------------------------------------------- blocklist

export const listBlocked = async (req: Request, res: Response) => {
  try {
    const rows = await depth.listBlocked(String(req.user!.activeTenantId), req.query.all === 'true');
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load the blocklist'); }
};

export const block = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const row = await depth.block(societyId, req.body, actorOf(req));
    auditFinance(req, 'GATE_BLOCKED', 'GateBlocklist', String(row._id), {
      newValues: { basis: row.basis, reason: row.reason, approvedBy: row.approvedByNames },
    });
    res.status(201).json({
      success: true, data: row,
      // Said out loud, because a committee that believes this is a hard block
      // will not understand why somebody got in.
      message: 'Added. The gate will be warned — it does not refuse entry on its own.',
    });
  } catch (e: any) { fail(res, e, 'add that to the blocklist'); }
};

export const unblock = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const done = await depth.unblock(societyId, req.params.id, req.body?.reason, actorOf(req));
    if (!done) return res.status(404).json({ success: false, message: 'That entry could not be found.' });
    auditFinance(req, 'GATE_UNBLOCKED', 'GateBlocklist', req.params.id);
    res.json({ success: true, data: { done }, message: 'Removed from the list.' });
  } catch (e: any) { fail(res, e, 'take that off the blocklist'); }
};

// ------------------------------------------------------------------- report

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
    res.json({ success: true, data: await depth.opsReport(societyId, from, to) });
  } catch (e: any) { fail(res, e, 'build that report'); }
};
