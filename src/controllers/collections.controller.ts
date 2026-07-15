import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Receipt } from '../models/receipt.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Flat } from '../models/flat.model';
import { Society } from '../models/society.model';
import { recordClearedReceipt, confirmReceipt, rejectReceipt, bounceReceipt, clearCheque } from '../services/collections.service';
import { generateAndStoreReceiptPdf } from '../services/receipt.service';
import { auditFinance } from '../utils/finance-audit.util';
import FinanceNotificationService from '../services/finance-notification.service';
import { User } from '../models/user.model';

async function flatOpenInvoices(societyId: string, flatId: string) {
  return MaintenanceInvoice.find({
    societyId, flatId, outstandingPaise: { $gt: 0 },
    status: { $in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
  }).sort({ dueDate: 1, invoiceDate: 1 }).lean();
}

/** GET /collections/flat/:flatId/outstanding — open invoices + total, for the record-payment dialog. */
export const getFlatOutstanding = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const invoices = await flatOpenInvoices(societyId, req.params.flatId);
    const totalOutstandingPaise = invoices.reduce((s, i) => s + i.outstandingPaise, 0);
    res.json({ totalOutstandingPaise, invoices });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/** POST /collections/record — admin records a walk-in cash/cheque/UPI receipt. */
export const recordPayment = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { flatId, mode, amountPaise, instrument, referenceNote, receiptDate } = req.body;
    const flat = await Flat.findOne({ _id: flatId, societyId }).select('number blockName').lean();
    if (!flat) { res.status(404).json({ error: 'Flat not found' }); return; }

    const receipt = await recordClearedReceipt(societyId, {
      flatId, blockName: flat.blockName, flatNumber: flat.number,
      mode, amountPaise, instrument, referenceNote, receiptDate,
      source: 'ADMIN_WALKIN',
      actor: { userId: req.user!.userId, userName: req.user!.userName || 'Admin', role: req.user!.activeRole || 'SOCIETY_ADMIN' },
    });
    auditFinance(req, 'FINANCE_RECORD_PAYMENT', 'Receipt', receipt._id.toString(), { newValues: { amountPaise: receipt.amountPaise, mode: receipt.mode, flatNumber: receipt.flatNumber } });
    res.json(receipt);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const listReceipts = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { status, mode, search, page, pageSize } = req.query;
    const query: any = { societyId: new mongoose.Types.ObjectId(societyId) };
    if (status) query.status = status;
    if (mode) query.mode = mode;
    if (search) query.$or = [{ receiptNumber: { $regex: search, $options: 'i' } }, { flatNumber: { $regex: search, $options: 'i' } }];

    const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '20'), 10)));
    const [receipts, total] = await Promise.all([
      Receipt.find(query).sort({ createdAt: -1 }).skip((currentPage - 1) * limit).limit(limit),
      Receipt.countDocuments(query),
    ]);
    res.json({ receipts, pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const listPendingReceipts = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const receipts = await Receipt.find({ societyId, status: 'PENDING_CONFIRMATION' }).sort({ createdAt: 1 });
    res.json(receipts);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const confirmReceiptController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const receipt = await confirmReceipt(societyId, req.params.id, { userId: req.user!.userId, userName: req.user!.userName || 'Admin' });
    auditFinance(req, 'FINANCE_CONFIRM_RECEIPT', 'Receipt', receipt._id.toString(), { newValues: { amountPaise: receipt.amountPaise } });

    const owner = await User.findById(await ownerOfFlat(societyId, receipt.flatId)).select('email name');
    if (owner?.email) FinanceNotificationService.sendEmailSafe(owner.email, 'Payment confirmed', `<p>Dear ${owner.name},</p><p>Your payment of ₹${(receipt.amountPaise / 100).toLocaleString('en-IN')} (Receipt ${receipt.receiptNumber}) has been confirmed and applied to your dues.</p>`);
    res.json(receipt);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const rejectReceiptController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const receipt = await rejectReceipt(societyId, req.params.id, req.body.rejectionReason, { userId: req.user!.userId, userName: req.user!.userName || 'Admin' });
    res.json(receipt);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const bounceReceiptController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const receipt = await bounceReceipt(societyId, req.params.id, { userId: req.user!.userId, userName: req.user!.userName || 'Admin' }, req.body.reason);
    auditFinance(req, 'FINANCE_BOUNCE_RECEIPT', 'Receipt', receipt._id.toString(), { newValues: { reason: req.body.reason } });
    res.json(receipt);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const depositChequeController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const receipt = await clearCheque(societyId, req.params.id, { userId: req.user!.userId, userName: req.user!.userName || 'Admin' });
    res.json(receipt);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const downloadReceiptPdf = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const receipt = await Receipt.findOne({ _id: req.params.id, societyId });
    if (!receipt) { res.status(404).json({ error: 'Receipt not found' }); return; }
    const society = await Society.findById(societyId).select('name').lean();
    const url = await generateAndStoreReceiptPdf(receipt, society?.name || 'Society');
    res.json({ url });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

async function ownerOfFlat(societyId: string, flatId: any): Promise<any> {
  const flat = await Flat.findOne({ _id: flatId, societyId }).select('ownerUserId').lean();
  return flat?.ownerUserId;
}
