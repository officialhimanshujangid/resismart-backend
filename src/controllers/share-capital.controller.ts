import { Request, Response } from 'express';
import * as shares from '../services/share-capital.service';
import { ShareError } from '../services/share-capital.service';

const actorOf = (req: Request) => ({ userId: req.user!.userId, userName: req.user!.userName || 'Admin' });

const handler = (fn: (societyId: string, req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const societyId = req.user?.activeTenantId;
      if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
      res.json(await fn(societyId, req));
    } catch (e: any) {
      res.status(e instanceof ShareError ? e.status : 400).json({ error: e.message });
    }
  };

/** GET /finance/society/shares — the register of members. */
export const register = handler((societyId, req) =>
  shares.memberRegister(societyId, { includeHistory: req.query.includeHistory === 'true' }));

/** POST /finance/society/shares — issue a certificate and take the share money in. */
export const issue = handler((societyId, req) => shares.issueShares(societyId, req.body, actorOf(req)));

/** POST /finance/society/shares/:id/transfer — hand the shares to a new member. */
export const transfer = handler((societyId, req) =>
  shares.transferShares(societyId, String(req.params.id), req.body, actorOf(req)));
