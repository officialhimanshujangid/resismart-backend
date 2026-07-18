import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Vendor } from '../models/vendor.model';
import { Expense } from '../models/expense.model';
import { createExpense, approveExpense, payExpense, rejectExpense } from '../services/expenses.service';
import { auditFinance } from '../utils/finance-audit.util';

const actorOf = (req: Request) => ({ userId: req.user!.userId, userName: req.user!.userName || 'Admin' });

// Vendor CRUD lives in vendor.controller.ts. It used to sit here with a blind
// `$set: req.body` update and no way to reach most of the vendor's own fields.

// ---- Expenses ----
export const listExpenses = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const { status, vendorId, search, page, pageSize } = req.query;
    const query: any = { societyId: new mongoose.Types.ObjectId(societyId) };
    if (status) query.status = status;
    if (vendorId) query.vendorId = vendorId;
    if (search) query.$or = [{ voucherNumber: { $regex: search, $options: 'i' } }, { vendorName: { $regex: search, $options: 'i' } }, { description: { $regex: search, $options: 'i' } }];
    const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '20'), 10)));
    const [expenses, total] = await Promise.all([
      Expense.find(query).sort({ createdAt: -1 }).skip((currentPage - 1) * limit).limit(limit),
      Expense.countDocuments(query),
    ]);
    res.json({ expenses, pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

export const getExpenseSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const rows = await Expense.aggregate([
      { $match: { societyId: new mongoose.Types.ObjectId(societyId) } },
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$grossPaise' } } },
    ]);
    const by: any = {}; rows.forEach(r => { by[r._id] = { count: r.count, amount: r.amount }; });
    res.json(by);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

export const createExpenseController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const exp = await createExpense(societyId, req.body, actorOf(req));
    res.json(exp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
};

export const approveExpenseController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const exp = await approveExpense(societyId, req.params.id, actorOf(req));
    auditFinance(req, 'FINANCE_APPROVE_EXPENSE', 'Expense', exp._id.toString(), { newValues: { grossPaise: exp.grossPaise, vendor: exp.vendorName } });
    res.json(exp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
};

export const payExpenseController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const exp = await payExpense(societyId, req.params.id, actorOf(req), req.body.paymentMode);
    auditFinance(req, 'FINANCE_PAY_EXPENSE', 'Expense', exp._id.toString(), { newValues: { netPayablePaise: exp.netPayablePaise } });
    res.json(exp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
};

export const rejectExpenseController = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
    const exp = await rejectExpense(societyId, req.params.id, req.body.rejectionReason, actorOf(req));
    res.json(exp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
};
