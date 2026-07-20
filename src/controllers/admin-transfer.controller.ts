import { Request, Response } from 'express';
import * as transfers from '../services/admin-transfer.service';
import { TransferError } from '../services/admin-transfer.service';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Someone'),
});

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof TransferError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

export const initiate = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const t = await transfers.initiate(societyId, req.body, actorOf(req));
    auditFinance(req, 'ADMIN_TRANSFER_INITIATED', 'AdminTransfer', String(t._id), {
      newValues: { to: t.toName, kind: t.successorKind, fromBecomes: t.fromBecomes },
    });
    res.status(201).json({
      success: true, data: t,
      // Said explicitly. An admin who believes they have already handed over
      // will stop doing the job days before anybody has taken it on.
      message: `${t.toName} has been asked. Nothing changes until they accept — you are still the admin.`,
    });
  } catch (e: any) { fail(res, e, 'start that handover'); }
};

export const sendCode = async (req: Request, res: Response) => {
  try {
    const out = await transfers.sendAcceptanceCode(String(req.user!.activeTenantId), actorOf(req));
    res.json({ success: true, data: out, message: 'A code has been sent.' });
  } catch (e: any) { fail(res, e, 'send that code'); }
};

export const accept = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const t = await transfers.accept(societyId, String(req.body.code), actorOf(req));
    auditFinance(req, 'ADMIN_TRANSFER_ACCEPTED', 'AdminTransfer', String(t._id), {
      newValues: { from: t.fromName, to: t.toName, fromBecomes: t.fromBecomes },
    });
    res.json({
      success: true, data: t,
      // The session still carries the old role until it is refreshed, and a
      // new admin hitting a 403 on their first click would reasonably assume
      // the handover failed.
      message: 'You are now the admin. Please sign in again to pick up your new access.',
    });
  } catch (e: any) { fail(res, e, 'accept that handover'); }
};

export const decline = async (req: Request, res: Response) => {
  try {
    const t = await transfers.decline(String(req.user!.activeTenantId), actorOf(req));
    auditFinance(req, 'ADMIN_TRANSFER_DECLINED', 'AdminTransfer', String(t._id));
    res.json({ success: true, data: t, message: 'Declined.' });
  } catch (e: any) { fail(res, e, 'decline that handover'); }
};

export const cancel = async (req: Request, res: Response) => {
  try {
    const t = await transfers.cancel(String(req.user!.activeTenantId), actorOf(req));
    auditFinance(req, 'ADMIN_TRANSFER_CANCELLED', 'AdminTransfer', String(t._id));
    res.json({ success: true, data: t, message: 'Withdrawn.' });
  } catch (e: any) { fail(res, e, 'withdraw that handover'); }
};

export const breakGlass = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const t = await transfers.breakGlass(societyId, req.body, actorOf(req));
    auditFinance(req, 'ADMIN_BREAK_GLASS', 'AdminTransfer', String(t._id), {
      newValues: {
        from: t.fromName, to: t.toName, reason: t.reason,
        approvedBy: t.approvedByNames,
      },
    });
    res.status(201).json({
      success: true, data: t,
      message: `${t.toName} is now the admin. ${t.fromName} has been told and has 72 hours to object.`,
    });
  } catch (e: any) { fail(res, e, 'carry out that takeover'); }
};

export const object = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const t = await transfers.object(societyId, req.params.id, req.body.note, actorOf(req));
    auditFinance(req, 'ADMIN_BREAK_GLASS_OBJECTED', 'AdminTransfer', String(t._id), {
      newValues: { note: t.objectionNote },
    });
    res.json({
      success: true, data: t,
      message: 'Your objection is on the record and the committee has been told.',
    });
  } catch (e: any) { fail(res, e, 'record your objection'); }
};

export const status = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const [live, past] = await Promise.all([
      transfers.current(societyId),
      transfers.history(societyId),
    ]);
    res.json({ success: true, data: { current: live, history: past } });
  } catch (e: any) { fail(res, e, 'load the handover history'); }
};
