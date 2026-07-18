import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { generateAndStoreInvoicePdf } from '../services/society-invoice.service';
import { Society } from '../models/society.model';
import { auditFinance } from '../utils/finance-audit.util';
import { projectRunFundImpact } from '../services/fund-projection.service';

export const generateInvoices = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { period, chargeHeadIds, flatIds, dryRun, confirmOverTarget } = req.body;
    const actor = { userId: req.user!.userId, userName: req.user!.userName || 'Admin' };

    // What this run does to any fund with a target. Asked before billing, so
    // over-collection is a decision rather than a discovery.
    const fundImpact = await projectRunFundImpact(societyId, { chargeHeadIds, flatIds }, actor);
    const breaches = fundImpact.filter(f => f.overByPaise > 0);

    // A real run that would push a fund past its target needs saying so out loud.
    // Money taken from members beyond what the society said it needed is hard to
    // explain afterwards and harder to give back.
    if (!dryRun && breaches.length && !confirmOverTarget) {
      res.status(409).json({
        error: breaches
          .map(f => `${f.fundName} would reach ₹${(f.projectedPaise / 100).toLocaleString('en-IN')} against a target of ₹${(f.targetAmountPaise / 100).toLocaleString('en-IN')} — ₹${(f.overByPaise / 100).toLocaleString('en-IN')} more than needed.`)
          .join(' ') + ' Tick the confirmation to bill it anyway.',
        requiresConfirmation: true,
        fundImpact,
      });
      return;
    }

    const result = await generateInvoicesForSociety(societyId, {
      period, chargeHeadIds, flatIds, dryRun,
      triggeredByUserId: req.user!.userId,
      triggeredByName: req.user!.userName || 'Admin',
    });
    if (!dryRun && result.created > 0) auditFinance(req, 'FINANCE_GENERATE_INVOICES', 'MaintenanceInvoice', societyId, { newValues: { period: result.period, created: result.created, totalBilledPaise: result.totalBilledPaise } });
    res.json({ ...result, fundImpact });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

/**
 * POST /invoices/special-demand — raise a one-off levy mid-month.
 *
 * Its own endpoint rather than a flag on generate: the two are different acts.
 * A regular run bills whatever is due this month; this bills one named thing,
 * to a chosen set of flats, for a stated reason, and must never be triggered by
 * the cron. Keeping them apart means the monthly path cannot accidentally
 * inherit special-demand behaviour, or the reverse.
 */
export const raiseSpecialDemand = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { chargeHeadIds, flatIds, blockIds, title, dueDate, dryRun, confirmOverTarget } = req.body;
    const actor = { userId: req.user!.userId, userName: req.user!.userName || 'Admin' };

    const fundImpact = await projectRunFundImpact(societyId, { chargeHeadIds, flatIds }, actor);
    const breaches = fundImpact.filter(f => f.overByPaise > 0);
    if (!dryRun && breaches.length && !confirmOverTarget) {
      res.status(409).json({
        error: breaches
          .map(f => `${f.fundName} would reach ₹${(f.projectedPaise / 100).toLocaleString('en-IN')} against a target of ₹${(f.targetAmountPaise / 100).toLocaleString('en-IN')} — ₹${(f.overByPaise / 100).toLocaleString('en-IN')} more than needed.`)
          .join(' ') + ' Tick the confirmation to bill it anyway.',
        requiresConfirmation: true,
        fundImpact,
      });
      return;
    }

    const result = await generateInvoicesForSociety(societyId, {
      chargeHeadIds, flatIds, dryRun,
      specialDemand: { title, dueDate, blockIds },
      triggeredByUserId: req.user!.userId,
      triggeredByName: req.user!.userName || 'Admin',
    });
    if (!dryRun && result.created > 0) {
      auditFinance(req, 'FINANCE_SPECIAL_DEMAND', 'MaintenanceInvoice', societyId, {
        newValues: { period: result.period, title, created: result.created, totalBilledPaise: result.totalBilledPaise },
      });
    }
    res.json({ ...result, fundImpact });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const listInvoices = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { period, status, blockName, search, page, pageSize } = req.query;
    const query: any = { societyId: new mongoose.Types.ObjectId(societyId) };
    if (period) query.billingPeriod = period;
    if (status) query.status = status;
    if (blockName) query.blockName = blockName;
    if (search) {
      query.$or = [
        { invoiceNumber: { $regex: search, $options: 'i' } },
        { flatNumber: { $regex: search, $options: 'i' } },
        { primaryOwnerName: { $regex: search, $options: 'i' } },
      ];
    }

    const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '20'), 10)));
    const skip = (currentPage - 1) * limit;

    const [invoices, total] = await Promise.all([
      MaintenanceInvoice.find(query).sort({ createdAt: -1, flatNumber: 1 }).skip(skip).limit(limit),
      MaintenanceInvoice.countDocuments(query),
    ]);
    res.json({ invoices, pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getInvoiceDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const invoice = await MaintenanceInvoice.findOne({ _id: req.params.id, societyId });
    if (!invoice) { res.status(404).json({ error: 'Invoice not found' }); return; }
    res.json(invoice);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const downloadInvoicePdf = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const invoice = await MaintenanceInvoice.findOne({ _id: req.params.id, societyId });
    if (!invoice) { res.status(404).json({ error: 'Invoice not found' }); return; }

    const society = await Society.findById(societyId).select('name').lean();
    const url = await generateAndStoreInvoicePdf(invoice, society?.name || 'Society');
    res.json({ url });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getInvoiceSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { period } = req.query;
    const match: any = { societyId: new mongoose.Types.ObjectId(societyId) };
    if (period) match.billingPeriod = period;

    const summary = await MaintenanceInvoice.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          invoiceCount: { $sum: 1 },
          totalBilled: { $sum: '$grandTotalDuePaise' },
          totalCollected: { $sum: { $add: ['$allocatedPaise', '$advanceAppliedPaise'] } },
          totalOutstanding: { $sum: '$outstandingPaise' },
          overdueCount: { $sum: { $cond: [{ $and: [{ $gt: ['$outstandingPaise', 0] }, { $lt: ['$dueDate', new Date()] }] }, 1, 0] } },
          overdueAmount: { $sum: { $cond: [{ $and: [{ $gt: ['$outstandingPaise', 0] }, { $lt: ['$dueDate', new Date()] }] }, '$outstandingPaise', 0] } },
        },
      },
    ]);
    res.json(summary[0] || { invoiceCount: 0, totalBilled: 0, totalCollected: 0, totalOutstanding: 0, overdueCount: 0, overdueAmount: 0 });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
