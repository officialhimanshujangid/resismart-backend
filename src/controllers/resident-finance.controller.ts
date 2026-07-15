import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Receipt } from '../models/receipt.model';
import { JournalEntry } from '../models/journal-entry.model';
import { Flat } from '../models/flat.model';
import { Society } from '../models/society.model';
import { SocietyFinanceSettings } from '../models/society-finance-settings.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { reportPendingReceipt } from '../services/collections.service';
import { generateAndStoreInvoicePdf } from '../services/society-invoice.service';
import { generateAndStoreReceiptPdf } from '../services/receipt.service';
import { depositAccountForMode } from '../services/collections.service';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { getFinancialYear } from '../utils/financial-year.util';
import { nextDocNumber } from '../services/finance-sequence.service';
import { resolveGateway } from '../services/payment-gateway-resolver.service';
import { getActiveUnitId } from '../middlewares/auth.middleware';
import { ACCOUNT_CODES } from '../services/chart-of-accounts.seed';

const ctx = (req: Request) => ({ flatId: getActiveUnitId(req), societyId: req.user?.activeTenantId });

/** GET /finance/resident/invoices — my flat's invoices. */
export const listMyInvoices = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId } = ctx(req);
    if (!flatId) { res.status(403).json({ error: 'No active flat selected' }); return; }
    const invoices = await MaintenanceInvoice.find({ flatId }).sort({ createdAt: -1 }).lean();
    res.json(invoices);
  } catch (error: any) { res.status(500).json({ error: error.message }); }
};

/** GET /finance/resident/outstanding — dues summary + advance balance. */
export const getMyOutstanding = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId, societyId } = ctx(req);
    if (!flatId || !societyId) { res.status(403).json({ error: 'No active flat' }); return; }
    const open = await MaintenanceInvoice.find({ flatId, outstandingPaise: { $gt: 0 }, status: { $in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }).sort({ dueDate: 1 }).lean();
    const totalOutstandingPaise = open.reduce((s, i) => s + i.outstandingPaise, 0);
    const adv = await JournalEntry.aggregate([
      { $match: { societyId: new mongoose.Types.ObjectId(societyId) } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': ACCOUNT_CODES.MEMBERS_ADVANCE, 'lines.flatId': new mongoose.Types.ObjectId(flatId) } },
      { $group: { _id: null, net: { $sum: { $subtract: ['$lines.creditPaise', '$lines.debitPaise'] } } } },
    ]);
    const policy = await FinancePolicy.findOne({ societyId }).select('settlement.upiId').lean();
    const legacy = await SocietyFinanceSettings.findOne({ societyId }).select('upiId').lean();
    let onlineEnabled = false;
    try { onlineEnabled = (await resolveGateway(societyId)).online; } catch { onlineEnabled = false; }
    res.json({ totalOutstandingPaise, advanceBalancePaise: Math.max(0, adv[0]?.net || 0), openInvoices: open, onlineEnabled, upiId: policy?.settlement?.upiId || legacy?.upiId });
  } catch (error: any) { res.status(500).json({ error: error.message }); }
};

/** GET /finance/resident/receipts — my payment receipts. */
export const listMyReceipts = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId } = ctx(req);
    if (!flatId) { res.status(403).json({ error: 'No active flat' }); return; }
    const receipts = await Receipt.find({ flatId, status: { $in: ['CLEARED', 'PENDING_CONFIRMATION', 'BOUNCED'] } }).sort({ createdAt: -1 }).lean();
    res.json(receipts);
  } catch (error: any) { res.status(500).json({ error: error.message }); }
};

/** GET /finance/resident/statement — per-flat account ledger (running balance). */
export const getMyStatement = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId, societyId } = ctx(req);
    if (!flatId || !societyId) { res.status(403).json({ error: 'No active flat' }); return; }
    const rows = await JournalEntry.aggregate([
      { $match: { societyId: new mongoose.Types.ObjectId(societyId) } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': ACCOUNT_CODES.DEBTORS, 'lines.flatId': new mongoose.Types.ObjectId(flatId) } },
      { $sort: { entryDate: 1, createdAt: 1 } },
      { $project: { _id: 0, date: '$entryDate', voucherNumber: 1, voucherType: 1, narration: 1, debitPaise: '$lines.debitPaise', creditPaise: '$lines.creditPaise' } },
    ]);
    let balance = 0;
    const entries = rows.map((r: any) => { balance += (r.debitPaise - r.creditPaise); return { ...r, balancePaise: balance }; });
    res.json({ entries, closingBalancePaise: balance });
  } catch (error: any) { res.status(500).json({ error: error.message }); }
};

/** POST /finance/resident/pay-online — pay dues online (defaults to full outstanding). */
export const payOnline = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId, societyId } = ctx(req);
    if (!flatId || !societyId) { res.status(403).json({ error: 'No active flat' }); return; }

    // Resolve the society's settlement mode (offline-only / own-keys / platform).
    const gateway = await resolveGateway(societyId);
    if (!gateway.online) { res.status(400).json({ error: 'Online payments are disabled for this society' }); return; }

    const open = await MaintenanceInvoice.find({ flatId, outstandingPaise: { $gt: 0 }, status: { $in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }).lean();
    const totalOutstanding = open.reduce((s, i) => s + i.outstandingPaise, 0);
    const amountPaise = Number(req.body.amountPaise) || totalOutstanding;
    if (amountPaise <= 0) { res.status(400).json({ error: 'Nothing outstanding to pay' }); return; }
    if (amountPaise > totalOutstanding + 0) { /* allow advance top-up */ }

    // Idempotency: reuse a live gateway link if one is already open for this flat.
    const existing = await Receipt.findOne({ flatId, status: 'INITIATED', mode: 'RAZORPAY', razorpayPaymentLinkUrl: { $exists: true, $ne: null } });
    if (existing?.razorpayPaymentLinkUrl) { res.json({ paymentLinkUrl: existing.razorpayPaymentLinkUrl, receiptId: existing._id }); return; }

    const flat = await Flat.findOne({ _id: flatId, societyId }).select('number blockName').lean();
    const policy = await getOrCreatePolicy(societyId, req.user!.userId, req.user!.userName || 'Resident');
    const { fyString } = getFinancialYear(new Date(), policy.financialYear?.startMonth ?? 4);
    const { number: receiptNumber } = await nextDocNumber(societyId, 'RECEIPT', fyString, { prefix: policy.numbering.receipt.prefix, padding: policy.numbering.receipt.padding, template: policy.numbering.receipt.template });

    const receipt = await Receipt.create({
      societyId, flatId, blockName: flat?.blockName || '', flatNumber: flat?.number || '',
      receiptNumber, financialYear: fyString, receiptDate: new Date(),
      mode: 'RAZORPAY', amountPaise, allocations: [], advanceCreatedPaise: 0,
      depositAccountCode: depositAccountForMode('RAZORPAY'),
      status: 'INITIATED', source: 'RESIDENT',
      recordedBy: req.user!.userId, recordedByName: req.user!.userName || 'Resident', recordedByRole: req.user!.activeRole,
    });

    const link = await gateway.createLink({
      amountPaise, description: `Maintenance dues — Flat ${flat?.number}`,
      customer: { name: req.user!.userName },
      notes: { receiptId: receipt._id.toString(), societyId: String(societyId), kind: 'SOCIETY_RECEIPT' },
    });
    receipt.razorpayPaymentLinkId = link.id;
    receipt.razorpayPaymentLinkUrl = link.short_url;
    await receipt.save();
    res.json({ paymentLinkUrl: link.short_url, receiptId: receipt._id });
  } catch (error: any) { res.status(500).json({ error: error.message }); }
};

/** POST /finance/resident/report-offline — report a cash/UPI/cheque/bank payment for confirmation. */
export const reportOffline = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId, societyId } = ctx(req);
    if (!flatId || !societyId) { res.status(403).json({ error: 'No active flat' }); return; }
    const { mode, amountPaise, referenceNote, instrument } = req.body;

    const open = await MaintenanceInvoice.find({ flatId, outstandingPaise: { $gt: 0 }, status: { $in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }).lean();
    const totalOutstanding = open.reduce((s, i) => s + i.outstandingPaise, 0);
    // Include amounts already awaiting confirmation so a bill can't be over-reported.
    const pending = await Receipt.aggregate([
      { $match: { flatId: new mongoose.Types.ObjectId(flatId), status: 'PENDING_CONFIRMATION' } },
      { $group: { _id: null, total: { $sum: '$amountPaise' } } },
    ]);
    const room = totalOutstanding - (pending[0]?.total || 0);
    if (room <= 0) { res.status(400).json({ error: 'Your dues are fully paid or awaiting confirmation' }); return; }
    if (amountPaise > room) { res.status(400).json({ error: `Amount exceeds outstanding dues of ₹${(room / 100).toLocaleString('en-IN')}` }); return; }

    const flat = await Flat.findOne({ _id: flatId, societyId }).select('number blockName').lean();
    const receipt = await reportPendingReceipt(societyId, {
      flatId, blockName: flat?.blockName || '', flatNumber: flat?.number || '',
      mode, amountPaise, referenceNote, instrument,
      source: 'RESIDENT',
      actor: { userId: req.user!.userId, userName: req.user!.userName || 'Resident', role: req.user!.activeRole || 'RESIDENT_OWNER' },
    });
    res.json({ message: 'Payment reported. Awaiting confirmation by the committee.', receipt });
  } catch (error: any) { res.status(400).json({ error: error.message }); }
};

export const downloadMyInvoicePdf = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId, societyId } = ctx(req);
    if (!flatId || !societyId) { res.status(403).json({ error: 'No active flat' }); return; }
    const invoice = await MaintenanceInvoice.findOne({ _id: req.params.id, flatId });
    if (!invoice) { res.status(404).json({ error: 'Invoice not found' }); return; }
    const society = await Society.findById(societyId).select('name').lean();
    const url = await generateAndStoreInvoicePdf(invoice, society?.name || 'Society');
    res.json({ url });
  } catch (error: any) { res.status(500).json({ error: error.message }); }
};

export const downloadMyReceiptPdf = async (req: Request, res: Response): Promise<void> => {
  try {
    const { flatId, societyId } = ctx(req);
    if (!flatId || !societyId) { res.status(403).json({ error: 'No active flat' }); return; }
    const receipt = await Receipt.findOne({ _id: req.params.id, flatId });
    if (!receipt) { res.status(404).json({ error: 'Receipt not found' }); return; }
    const society = await Society.findById(societyId).select('name').lean();
    const url = await generateAndStoreReceiptPdf(receipt, society?.name || 'Society');
    res.json({ url });
  } catch (error: any) { res.status(500).json({ error: error.message }); }
};
