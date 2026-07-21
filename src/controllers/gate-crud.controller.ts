import { Request, Response } from 'express';
import * as gates from '../services/gate-crud.service';
import { GateError } from '../services/gate-crud.service';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Someone'),
});

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof GateError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

export const list = async (req: Request, res: Response) => {
  try {
    const rows = await gates.listGates(String(req.user!.activeTenantId), req.query.all === 'true');
    res.json({ success: true, data: rows });
  } catch (e: any) { fail(res, e, 'load gates'); }
};

export const create = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const gate = await gates.createGate(societyId, req.body, actorOf(req));
    auditFinance(req, 'GATE_CREATE', 'Gate', String(gate._id), { newValues: { code: gate.code, name: gate.name } });
    res.status(201).json({ success: true, data: gate, message: `${gate.name} added` });
  } catch (e: any) { fail(res, e, 'add that gate'); }
};

export const update = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const gate = await gates.updateGate(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'GATE_UPDATE', 'Gate', String(gate._id), { newValues: req.body });
    res.json({ success: true, data: gate, message: 'Saved' });
  } catch (e: any) { fail(res, e, 'update that gate'); }
};

export const retire = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const done = await gates.retireGate(societyId, req.params.id, actorOf(req));
    if (!done) return res.status(404).json({ success: false, message: 'That gate could not be found.' });
    auditFinance(req, 'GATE_RETIRE', 'Gate', req.params.id);
    res.json({ success: true, data: { done }, message: 'Gate retired.' });
  } catch (e: any) { fail(res, e, 'retire that gate'); }
};
