import { Request, Response } from 'express';
import * as pdc from '../services/pdc.service';
import { PdcError } from '../services/pdc.service';
import { PdcStatus } from '../models/pdc.model';

const actorOf = (req: Request) => ({
  userId: req.user!.userId,
  userName: req.user!.userName || 'Admin',
  role: req.user!.activeRole || 'SOCIETY_ADMIN',
});
const str = (v: unknown): string | undefined => {
  const raw = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
};

const handler = (fn: (societyId: string, req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const societyId = req.user?.activeTenantId;
      if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
      res.json(await fn(societyId, req));
    } catch (e: any) {
      res.status(e instanceof PdcError ? e.status : 400).json({ error: e.message });
    }
  };

/** GET /finance/society/pdc — the register of cheques being held. */
export const list = handler((societyId, req) => pdc.listPdcs(societyId, {
  status: str(req.query.status) as PdcStatus | undefined,
  flatId: str(req.query.flatId),
}));

/** POST /finance/society/pdc — take a cheque into the register. Posts nothing. */
export const register = handler((societyId, req) => pdc.registerPdc(societyId, req.body, actorOf(req)));

/** POST /finance/society/pdc/:id/deposit — bank it; this is when it becomes money. */
export const deposit = handler((societyId, req) =>
  pdc.depositPdc(societyId, String(req.params.id), req.body || {}, actorOf(req)));

/** POST /finance/society/pdc/:id/status — cleared, bounced, or handed back. */
export const status = handler((societyId, req) =>
  pdc.updatePdcStatus(societyId, String(req.params.id), req.body, actorOf(req)));