import { Request, Response } from 'express';
import * as brs from '../services/bank-reconciliation.service';
import { BankReconciliationError } from '../services/bank-reconciliation.service';

const actorOf = (req: Request) => ({ userId: req.user!.userId, userName: req.user!.userName || 'Admin' });

/** Same reasoning as reports.controller: `?asOf=a&asOf=b` really does arrive as an array. */
const str = (v: unknown): string | undefined => {
  const raw = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
};

/**
 * Wraps every handler so a BankReconciliationError becomes the status it carries
 * ("this line is already matched" is a 400 the operator should read), while
 * anything unexpected stays a 500 and does not leak internals.
 */
const handler = (fn: (societyId: string, req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const societyId = req.user?.activeTenantId;
      if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
      res.json(await fn(societyId, req));
    } catch (e: any) {
      if (e instanceof BankReconciliationError) { res.status(e.status).json({ error: e.message }); return; }
      // `parseDate` reports bad input as 'Invalid <field> date' — the caller's fault.
      if (/^Invalid /.test(e?.message || '')) { res.status(400).json({ error: e.message }); return; }
      res.status(500).json({ error: e?.message || 'Bank reconciliation failed.' });
    }
  };

/** GET /finance/society/bank/accounts — the bank account picker. */
export const listBankAccounts = handler((s) => brs.bankAccounts(s));

/** GET /finance/society/bank/reconciliation?accountCode=1100&asOf=... — the BRS. */
export const getReconciliation = handler((s, req) => {
  const accountCode = str(req.query.accountCode);
  if (!accountCode) throw new BankReconciliationError('accountCode is required');
  return brs.reconciliation(s, { accountCode, asOf: str(req.query.asOf) });
});

/** POST /finance/society/bank/import — insert statement rows, skipping any already imported. */
export const importStatement = handler((s, req) => brs.importStatement(s, req.body, actorOf(req)));

/** POST /finance/society/bank/auto-match — pair the obvious ones. */
export const autoMatch = handler((s, req) => brs.autoMatch(s, req.body.accountCode, actorOf(req)));

/** POST /finance/society/bank/lines/:id/match — tie a line to a voucher by hand. */
export const matchLine = handler((s, req) => brs.matchLine(s, String(req.params.id), req.body.journalEntryId, actorOf(req)));

/** POST /finance/society/bank/lines/:id/unmatch — undo a match. */
export const unmatchLine = handler((s, req) => brs.unmatchLine(s, String(req.params.id), actorOf(req)));

/** POST /finance/society/bank/lines/:id/ignore — drop a row that is not a transaction. */
export const ignoreLine = handler((s, req) => brs.ignoreLine(s, String(req.params.id), actorOf(req)));
