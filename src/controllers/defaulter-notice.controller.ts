import { Request, Response } from 'express';
import * as notices from '../services/defaulter-notice.service';
import { NoticeError } from '../services/defaulter-notice.service';
import { NoticeStage } from '../models/defaulter-notice.model';
import { sendPdf } from '../services/report-export.service';

const actorOf = (req: Request) => ({ userId: req.user!.userId, userName: req.user!.userName || 'Admin' });
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
      res.status(e instanceof NoticeError ? e.status : 400).json({ error: e.message });
    }
  };

/**
 * GET /finance/society/notices — the notices served, plus the next stage due for
 * each flat so the screen never has to reimplement the escalation ladder.
 */
export const list = handler(async (societyId, req) => {
  const [register, byFlat] = await Promise.all([
    notices.listNotices(societyId, {
      flatId: str(req.query.flatId),
      stage: str(req.query.stage) as NoticeStage | undefined,
      openOnly: str(req.query.openOnly) === 'true',
    }),
    notices.noticeStatusByFlat(societyId),
  ]);
  return { ...register, byFlat };
});

/** POST /finance/society/notices — serve a notice, freezing what it demands. */
export const issue = handler((societyId, req) => notices.issueNotice(societyId, req.body, actorOf(req)));

/** POST /finance/society/notices/:id/resolve — the dues were settled, or it was withdrawn. */
export const resolve = handler((societyId, req) =>
  notices.resolveNotice(societyId, String(req.params.id), req.body || {}));

/** GET /finance/society/notices/:id/pdf — the notice as served, ready to print. */
export const pdf = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    sendPdf(res, await notices.noticePdf(societyId, String(req.params.id)));
  } catch (e: any) {
    // Headers may already be on the wire once streaming has begun.
    if (res.headersSent) { res.end(); return; }
    res.status(e instanceof NoticeError ? e.status : 400).json({ error: e.message });
  }
};