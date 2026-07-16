import { Request, Response } from 'express';
import { SocietyFinanceService, decryptBankAccount } from '../services/society-finance.service';
import { SocietyFinanceSettings } from '../models/society-finance-settings.model';
import { SocietyBill } from '../models/society-bill.model';
import { BillPayment } from '../models/bill-payment.model';
import { FinanceLedgerEntry } from '../models/finance-ledger-entry.model';
import { FinanceFund } from '../models/finance-fund.model';
import mongoose from 'mongoose';
import FinanceNotificationService from '../services/finance-notification.service';
import { User } from '../models/user.model';
import { listFunds, createFund as createFundWithAccount } from '../services/funds.service';

export const getSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const settings = await SocietyFinanceService.getOrCreateSettings(societyId, req.user!.userId, req.user!.userName || 'Admin');
    
    // We do NOT send the encrypted bank account details to the frontend.
    // Instead we send a masked version.
    const responseData = settings.toObject();
    if (responseData.bankAccount) {
      delete (responseData.bankAccount as any).accountNumberEncrypted;
      delete (responseData.bankAccount as any).accountNumberIv;
      delete (responseData.bankAccount as any).accountNumberTag;
    }

    res.json(responseData);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const updateSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    // req.body has already been zod-validated + whitelisted by the route middleware,
    // so only known policy fields are present (no bankAccount/societyId/lastBillSequence,
    // no arbitrary mass-assigned keys). We still upsert via getOrCreateSettings so we
    // never create a settings doc missing its required audit fields.
    const settings = await SocietyFinanceService.getOrCreateSettings(
      societyId,
      req.user!.userId,
      req.user!.userName || 'Admin'
    );

    settings.set(req.body);
    settings.updatedBy = new mongoose.Types.ObjectId(req.user!.userId);
    settings.updatedByName = req.user!.userName || 'Admin';
    await settings.save();

    const responseData = settings.toObject();
    if (responseData.bankAccount) {
      delete (responseData.bankAccount as any).accountNumberEncrypted;
      delete (responseData.bankAccount as any).accountNumberIv;
      delete (responseData.bankAccount as any).accountNumberTag;
    }

    res.json(responseData);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const setupBankDetails = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { accountName, accountNumber, ifsc, bankName } = req.body;
    
    if (!accountName || !accountNumber || !ifsc || !bankName) {
      res.status(400).json({ error: 'Missing required bank details' }); return;
    }

    const bankAccount = await SocietyFinanceService.setupBankDetails(
      societyId,
      { accountName, accountNumber, ifsc, bankName },
      req.user!.userId,
      req.user!.userName || 'Admin'
    );
    
    const safeAccount = { ...bankAccount };
    delete (safeAccount as any).accountNumberEncrypted;
    delete (safeAccount as any).accountNumberIv;
    delete (safeAccount as any).accountNumberTag;

    res.json(safeAccount);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const generateBills = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { period, templateIds, flatIds, dryRun } = req.body;
    
    const result = await SocietyFinanceService.generateBillsForSociety(societyId, {
      period,
      templateIds,
      flatIds,
      dryRun,
      triggeredByUserId: req.user!.userId,
      triggeredByName: req.user!.userName || 'Admin'
    });
    
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const listBills = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { period, status, search, blockName, isPagination, page, pageSize } = req.query;
    const query: any = { societyId };

    if (period) query.billingPeriod = period;
    if (status) query.status = status;
    if (blockName) query.blockName = blockName;
    if (search) {
      query.$or = [
        { billNumber: { $regex: search, $options: 'i' } },
        { flatNumber: { $regex: search, $options: 'i' } },
        { primaryOwnerName: { $regex: search, $options: 'i' } }
      ];
    }

    if (isPagination === 'true') {
      const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '20'), 10)));
      const skip = (currentPage - 1) * limit;
      const [bills, total] = await Promise.all([
        SocietyBill.find(query).sort({ flatNumber: 1, createdAt: -1 }).skip(skip).limit(limit),
        SocietyBill.countDocuments(query),
      ]);
      res.json({ bills, pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) } });
      return;
    }

    const bills = await SocietyBill.find(query).sort({ flatNumber: 1, createdAt: -1 });
    res.json(bills);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getBillSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { period } = req.query;
    const query: any = { societyId };
    if (period) query.billingPeriod = period;

    const summary = await SocietyBill.aggregate([
      { $match: { societyId: new mongoose.Types.ObjectId(societyId), ...(period ? { billingPeriod: period } : {}) } },
      { 
        $group: {
          _id: null,
          totalBilled: { $sum: "$totalAmountPaise" },
          totalCollected: { $sum: "$paidAmountPaise" },
          overdueCount: { 
            $sum: { 
              $cond: [
                { $and: [
                    { $in: ["$status", ["UNPAID", "PARTIALLY_PAID"]] },
                    { $lt: ["$dueDate", new Date()] }
                  ] 
                }, 
                1, 0
              ] 
            } 
          },
          overdueAmount: {
            $sum: {
              $cond: [
                { $and: [
                    { $in: ["$status", ["UNPAID", "PARTIALLY_PAID"]] },
                    { $lt: ["$dueDate", new Date()] }
                  ] 
                }, 
                { $subtract: ["$totalAmountPaise", "$paidAmountPaise"] }, 0
              ] 
            }
          }
        }
      }
    ]);

    res.json(summary[0] || { totalBilled: 0, totalCollected: 0, overdueCount: 0, overdueAmount: 0 });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const listPendingConfirmations = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const payments = await BillPayment.find({ societyId, status: 'PENDING_CONFIRMATION' })
      .populate('billId', 'billNumber billingPeriod totalAmountPaise')
      .sort({ createdAt: 1 });
      
    res.json(payments);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const confirmOfflinePayment = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    
    const { paymentId } = req.params;
    
    const payment = await BillPayment.findOne({ _id: paymentId, societyId });
    if (!payment) { res.status(404).json({ error: 'Payment not found' }); return; }
    if (payment.status !== 'PENDING_CONFIRMATION') { res.status(400).json({ error: 'Payment is not pending' }); return; }
    
    const bill = await SocietyBill.findById(payment.billId);
    if (!bill) { res.status(404).json({ error: 'Bill not found' }); return; }
    
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        payment.status = 'CONFIRMED';
        payment.confirmedAt = new Date();
        payment.confirmedBy = new mongoose.Types.ObjectId(req.user!.userId);
        payment.confirmedByName = req.user!.userName || 'Admin';
        await payment.save({ session });
        
        bill.paidAmountPaise += payment.amountPaise;
        if (bill.paidAmountPaise >= bill.totalAmountPaise) {
          bill.status = 'PAID';
        } else {
          bill.status = 'PARTIALLY_PAID';
        }
        await bill.save({ session });
        
        await FinanceLedgerEntry.create([{
          societyId,
          billId: bill._id,
          paymentId: payment._id,
          entryType: 'PAYMENT_RECEIVED',
          description: `Payment received via ${payment.paymentMethod}`,
          debitPaise: 0,
          creditPaise: payment.amountPaise,
          flatId: bill.flatId,
          flatNumber: bill.flatNumber,
          billingPeriod: bill.billingPeriod,
          performedBy: req.user!.userId,
          performedByName: req.user!.userName || 'Admin',
        }], { session });
      });
    } finally {
      session.endSession();
    }
    
    // Async send email
    const owner = await User.findById(bill.primaryOwnerUserId).select('email name');
    if (owner?.email) {
      FinanceNotificationService.sendPaymentConfirmedEmail(owner.email, owner.name, payment, bill);
    }
    
    res.json({ message: 'Payment confirmed successfully', payment });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const rejectOfflinePayment = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    
    const { paymentId } = req.params;
    const { rejectionReason } = req.body;
    
    if (!rejectionReason) { res.status(400).json({ error: 'Rejection reason is required' }); return; }
    
    const payment = await BillPayment.findOne({ _id: paymentId, societyId });
    if (!payment) { res.status(404).json({ error: 'Payment not found' }); return; }
    if (payment.status !== 'PENDING_CONFIRMATION') { res.status(400).json({ error: 'Payment is not pending' }); return; }
    
    const bill = await SocietyBill.findById(payment.billId);
    if (!bill) { res.status(404).json({ error: 'Bill not found' }); return; }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        payment.status = 'REJECTED';
        payment.rejectionReason = rejectionReason;
        payment.rejectedAt = new Date();
        payment.rejectedBy = new mongoose.Types.ObjectId(req.user!.userId);
        payment.rejectedByName = req.user!.userName || 'Admin';
        await payment.save({ session });
        
        // If there are no other CONFIRMED or PENDING_CONFIRMATION payments, mark bill as UNPAID
        const otherPayments = await BillPayment.countDocuments({ 
          billId: bill._id, 
          status: { $in: ['CONFIRMED', 'PENDING_CONFIRMATION'] },
          _id: { $ne: payment._id }
        }, { session });
        
        if (otherPayments === 0 && bill.status === 'PENDING_CONFIRMATION') {
          bill.status = 'UNPAID';
          await bill.save({ session });
        }
      });
    } finally {
      session.endSession();
    }
    
    const owner = await User.findById(bill.primaryOwnerUserId).select('email name');
    if (owner?.email) {
      FinanceNotificationService.sendPaymentRejectedEmail(owner.email, owner.name, payment, bill);
    }
    
    res.json({ message: 'Payment rejected', payment });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

const fundActor = (req: Request) => ({ userId: req.user!.userId, userName: req.user!.userName || 'Admin' });

export const getFunds = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    res.json(await listFunds(societyId, fundActor(req)));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const createFund = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const { name, category, description, targetAmountPaise, isInvested } = req.body;

    try {
      // Creates the fund together with its own backing FUND ledger account, so it
      // is collectable the moment it exists.
      const fund = await createFundWithAccount(
        societyId,
        { name, category, description, targetAmountPaise, isInvested },
        fundActor(req),
      );
      res.json(fund);
    } catch (e: any) {
      if (e.code === 11000) {
        res.status(409).json({ error: 'A fund with this name already exists' });
        return;
      }
      throw e;
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
