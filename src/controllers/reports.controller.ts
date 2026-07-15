import { Request, Response } from 'express';
import * as reports from '../services/reports.service';

const sid = (req: Request) => req.user?.activeTenantId;
const wrap = (fn: (societyId: string, from?: string, to?: string) => Promise<any>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const societyId = sid(req);
      if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
      const { from, to } = req.query as any;
      res.json(await fn(societyId, from, to));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  };

export const trialBalance = wrap((s) => reports.getTrialBalance(s));
export const incomeExpenditure = wrap((s) => reports.incomeExpenditure(s));
export const balanceSheet = wrap((s) => reports.balanceSheet(s));
export const receiptsAndPayments = wrap((s, f, t) => reports.receiptsAndPayments(s, f, t));
export const defaulters = wrap((s) => reports.defaulters(s));
export const collectionRegister = wrap((s, f, t) => reports.collectionRegister(s, f, t));
export const fundStatement = wrap((s) => reports.fundStatement(s));
export const gstRegister = wrap((s, f, t) => reports.gstRegister(s, f, t));
export const tdsRegister = wrap((s, f, t) => reports.tdsRegister(s, f, t));
