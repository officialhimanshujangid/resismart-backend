import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { generateAndStoreInvoicePdf } from '../services/society-invoice.service';
import { Society } from '../models/society.model';
import { auditFinance } from '../utils/finance-audit.util';

export const generateInvoices = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { period, chargeHeadIds, flatIds, dryRun } = req.body;
    const result = await generateInvoicesForSociety(societyId, {
      period, chargeHeadIds, flatIds, dryRun,
      triggeredByUserId: req.user!.userId,
      triggeredByName: req.user!.userName || 'Admin',
    });
    if (!dryRun && result.created > 0) auditFinance(req, 'FINANCE_GENERATE_INVOICES', 'MaintenanceInvoice', societyId, { newValues: { period: result.period, created: result.created, totalBilledPaise: result.totalBilledPaise } });
    res.json(result);
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
