import { Request, Response } from 'express';
import * as budgets from '../services/budget.service';
import { BudgetError } from '../services/budget.service';
import { getFyStartMonth } from '../services/finance-policy.service';

const actorOf = (req: Request) => ({ userId: req.user!.userId, userName: req.user!.userName || 'Admin' });

/** `?fy=a&fy=b` really does arrive as an array; take the last value, never the array. */
const str = (v: unknown): string | undefined => {
  const raw = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
};

const handler = (fn: (societyId: string, req: Request, fyStartMonth: number) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const societyId = req.user?.activeTenantId;
      if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
      const fyStartMonth = await getFyStartMonth(societyId);
      res.json(await fn(societyId, req, fyStartMonth));
    } catch (e: any) {
      res.status(e instanceof BudgetError ? e.status : 400).json({ error: e.message });
    }
  };

/** GET /finance/society/budget?fy= — the year's budget, the years on record, and last year's actuals. */
export const current = handler((societyId, req, fyStartMonth) =>
  budgets.budgetWorkspace(societyId, { fy: str(req.query.fy), fyStartMonth }));

/** PUT /finance/society/budget — save the year's budget, line by account. */
export const upsert = handler((societyId, req, fyStartMonth) =>
  budgets.upsertBudget(societyId, req.body, actorOf(req), fyStartMonth));

/** POST /finance/society/budget/:fy/approve — the general body adopts the budget. */
export const approve = handler((societyId, req, fyStartMonth) =>
  budgets.approveBudget(societyId, String(req.params.fy), actorOf(req), fyStartMonth));
