import { Request, Response } from 'express';
import {
  listInvestments, createInvestment, updateInvestment, interestAccrualPreview,
  runInterestAccrual, closeInvestment, InvestmentError,
} from '../services/investments.service';
import { auditFinance } from '../utils/finance-audit.util';

const actorOf = (req: Request) => ({ userId: req.user!.userId, userName: req.user!.userName || 'Admin' });
const statusOf = (e: any) => (e instanceof InvestmentError ? e.status : 400);

export const listInvestmentsController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const result = await listInvestments(societyId, { includeClosed: req.query.includeClosed === 'true' });
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

export const createInvestmentController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const inv = await createInvestment(societyId, req.body, actorOf(req));
    auditFinance(req, 'FINANCE_CREATE_INVESTMENT', 'Investment', inv._id, {
      newValues: { bankName: inv.bankName, principalPaise: inv.principalPaise, ratePercent: inv.ratePercent, maturityDate: inv.maturityDate },
    });
    res.json(inv);
  } catch (e: any) { res.status(statusOf(e)).json({ error: e.message }); }
};

export const updateInvestmentController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const inv = await updateInvestment(societyId, req.params.id, req.body);
    auditFinance(req, 'FINANCE_UPDATE_INVESTMENT', 'Investment', inv._id, {
      newValues: { bankName: inv.bankName, ratePercent: inv.ratePercent, maturityDate: inv.maturityDate, linkedFundId: inv.linkedFundId },
    });
    res.json(inv);
  } catch (e: any) { res.status(statusOf(e)).json({ error: e.message }); }
};

export const previewInterestAccrualController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const preview = await interestAccrualPreview(societyId, { upToDate: req.query.upToDate as string | undefined });
    res.json(preview);
  } catch (e: any) { res.status(statusOf(e)).json({ error: e.message }); }
};

export const runInterestAccrualController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const result = await runInterestAccrual(societyId, { upToDate: req.body.upToDate }, actorOf(req));
    if (result.posted) {
      auditFinance(req, 'FINANCE_RUN_INTEREST_ACCRUAL', 'JournalEntry', result.journalEntryId!, {
        newValues: { totalPaise: result.totalPaise, investmentsAccrued: result.investmentsAccrued, upToDate: result.upToDate },
      });
    }
    res.json(result);
  } catch (e: any) { res.status(statusOf(e)).json({ error: e.message }); }
};

export const closeInvestmentController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const inv = await closeInvestment(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'FINANCE_CLOSE_INVESTMENT', 'Investment', inv._id, {
      newValues: { closedOn: inv.closedOn, proceedsPaise: req.body?.proceedsPaise, principalPaise: inv.principalPaise, accruedInterestPaise: inv.accruedInterestPaise },
    });
    res.json(inv);
  } catch (e: any) { res.status(statusOf(e)).json({ error: e.message }); }
};