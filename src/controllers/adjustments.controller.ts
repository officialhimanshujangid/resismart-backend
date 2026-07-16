import { Request, Response } from 'express';
import * as adj from '../services/adjustments.service';
import { AdjustmentError } from '../services/adjustments.service';
import { auditFinance } from '../utils/finance-audit.util';

const actorOf = (req: Request) => ({ userId: req.user!.userId, userName: req.user!.userName || 'Admin' });

const handler = (fn: (societyId: string, req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const societyId = req.user?.activeTenantId;
      if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
      res.json(await fn(societyId, req));
    } catch (e: any) {
      res.status(e instanceof AdjustmentError ? e.status : 400).json({ error: e.message });
    }
  };

/** GET /finance/society/invoices/:id/rebate — what a rebate would come to. */
export const rebateSuggestion = handler((s, req) =>
  adj.rebateSuggestion(s, String(req.params.id), actorOf(req)));

/** POST /finance/society/invoices/:id/adjust — waive, write off or rebate. */
export const adjustInvoice = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const result = await adj.adjustInvoice(societyId, String(req.params.id), req.body, actorOf(req));
    auditFinance(req, 'FINANCE_ADJUST_INVOICE', 'MaintenanceInvoice', String(req.params.id), {
      newValues: { kind: req.body.kind, amountPaise: req.body.amountPaise, reason: req.body.reason, voucherNumber: result.voucherNumber },
    });
    res.json(result);
  } catch (e: any) {
    res.status(e instanceof AdjustmentError ? e.status : 400).json({ error: e.message });
  }
};

export const listRefunds = handler((s, req) => adj.listRefunds(s, { status: req.query.status as string | undefined }));

export const requestRefund = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const refund = await adj.requestRefund(societyId, req.body, actorOf(req));
    auditFinance(req, 'FINANCE_REQUEST_REFUND', 'Refund', String(refund._id), {
      newValues: { amountPaise: refund.amountPaise, flat: `${refund.blockName} ${refund.flatNumber}`, status: refund.status },
    });
    res.json(refund);
  } catch (e: any) {
    res.status(e instanceof AdjustmentError ? e.status : 400).json({ error: e.message });
  }
};

export const payRefund = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const refund = await adj.payRefund(societyId, String(req.params.id), actorOf(req));
    auditFinance(req, 'FINANCE_PAY_REFUND', 'Refund', String(refund._id), {
      newValues: { amountPaise: refund.amountPaise, approvedByName: refund.approvedByName },
    });
    res.json(refund);
  } catch (e: any) {
    res.status(e instanceof AdjustmentError ? e.status : 400).json({ error: e.message });
  }
};

export const rejectRefund = handler((s, req) =>
  adj.rejectRefund(s, String(req.params.id), actorOf(req), req.body.rejectionReason));
