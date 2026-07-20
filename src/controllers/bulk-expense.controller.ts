import { Request, Response } from 'express';
import * as bulkExpense from '../services/bulk-expense.service';
import { ImportError } from '../services/bulk-import.service';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Admin'),
});

const sourceOf = (req: Request) => ({
  csvText: req.body?.csvText,
  fileBuffer: req.file?.buffer,
});

const optionsOf = (req: Request): bulkExpense.BulkExpenseOptions => ({
  // Multipart sends everything as strings, so booleans arrive as "true".
  shape: (req.body?.shape === 'PER_ROW' ? 'PER_ROW' : 'ONE_VOUCHER'),
  alreadyPaid: req.body?.alreadyPaid === true || req.body?.alreadyPaid === 'true',
  paymentMode: req.body?.paymentMode,
  defaultDate: req.body?.defaultDate,
  periodLabel: req.body?.periodLabel,
});

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof ImportError) return res.status(e.status).json({ success: false, message: e.message });
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

/** A workbook already filled in with this society's own heads and vendors. */
export const template = async (req: Request, res: Response) => {
  try {
    const buffer = await bulkExpense.templateFor(String(req.user!.activeTenantId));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses-template.xlsx"');
    res.send(buffer);
  } catch (e: any) { fail(res, e, 'build the template'); }
};

export const preview = async (req: Request, res: Response) => {
  try {
    const data = await bulkExpense.preview(String(req.user!.activeTenantId), sourceOf(req), optionsOf(req));
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'read that file'); }
};

export const commit = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const data = await bulkExpense.commit(societyId, sourceOf(req), optionsOf(req), actorOf(req));
    auditFinance(req, 'FINANCE_BULK_EXPENSE', 'Expense', societyId, {
      newValues: { vouchers: data.vouchers, lines: data.lines, totalPaise: data.totalAmountPaise, posted: data.posted },
    });
    res.json({ success: true, data, message: data.summary });
  } catch (e: any) { fail(res, e, 'record those expenses'); }
};

/** Last month's voucher, ready to be edited and sent again. */
export const repeat = async (req: Request, res: Response) => {
  try {
    const data = await bulkExpense.repeatFrom(String(req.user!.activeTenantId), req.params.id);
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load that expense'); }
};
