import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { postJournal, getTrialBalance } from '../services/ledger.service';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';

/** GET /finance/society/ledger/accounts — the chart of accounts. */
export const listAccounts = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { type, isActive } = req.query;
    const query: any = { societyId };
    if (type) query.type = type;
    if (isActive === 'true') query.isActive = true;
    if (isActive === 'false') query.isActive = false;

    const accounts = await LedgerAccount.find(query).sort({ code: 1 });
    res.json(accounts);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/** POST /finance/society/ledger/accounts/seed — idempotently seed the default COA. */
export const seedAccounts = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const result = await seedChartOfAccounts(societyId, req.user!.userId, req.user!.userName || 'Admin');
    const total = await LedgerAccount.countDocuments({ societyId });
    res.json({ ...result, totalAccounts: total });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/** GET /finance/society/ledger/journal — paginated journal (voucher) list. */
export const listJournal = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { voucherType, financialYear, flatId, accountCode, from, to, page, pageSize } = req.query;
    const query: any = { societyId: new mongoose.Types.ObjectId(societyId) };
    if (voucherType) query.voucherType = voucherType;
    if (financialYear) query.financialYear = financialYear;
    if (flatId) query['lines.flatId'] = new mongoose.Types.ObjectId(String(flatId));
    if (accountCode) query['lines.accountCode'] = accountCode;
    if (from || to) {
      query.entryDate = {};
      if (from) query.entryDate.$gte = new Date(String(from));
      if (to) { const end = new Date(String(to)); end.setHours(23, 59, 59, 999); query.entryDate.$lte = end; }
    }

    const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '25'), 10)));
    const skip = (currentPage - 1) * limit;

    const [entries, total] = await Promise.all([
      JournalEntry.find(query).sort({ entryDate: -1, createdAt: -1 }).skip(skip).limit(limit),
      JournalEntry.countDocuments(query),
    ]);

    res.json({ entries, pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/** GET /finance/society/ledger/trial-balance */
export const getTrialBalanceController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const tb = await getTrialBalance(societyId);
    res.json(tb);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/** POST /finance/society/ledger/journal — post a manual balanced voucher (adjustments / opening balances). */
export const postManualJournal = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { voucherType, entryDate, narration, lines } = req.body;

    const entry = await postJournal(societyId, {
      voucherType: voucherType || 'JOURNAL',
      entryDate: entryDate ? new Date(entryDate) : undefined,
      narration,
      lines,
      sourceType: 'ADJUSTMENT',
      postedBy: req.user!.userId,
      postedByName: req.user!.userName || 'Admin',
    });

    res.json(entry);
  } catch (error: any) {
    // Balance-invariant / account-not-found errors are client errors, not 500s.
    res.status(400).json({ error: error.message });
  }
};
