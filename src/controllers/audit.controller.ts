import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { AuditLog } from '../models/audit.model';

export const getAuditLogs = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const tenantId = req.user?.activeTenantId;

    if (!tenantId) {
      res.status(403).json({ error: 'Access denied: No active tenant context selected' });
      return;
    }

    // Performance Optimization: Strict pagination limits
    const page = parseInt(req.query.page as string || '1', 10);
    const limit = Math.min(parseInt(req.query.limit as string || '20', 10), 100); // Caps limit at 100 to prevent DOS/heavy loading
    const skip = (page - 1) * limit;

    const query = { tenantId: new mongoose.Types.ObjectId(tenantId) };

    // Optimize read query performance using .lean()
    const logs = await AuditLog.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-__v')
      .lean();

    const totalLogs = await AuditLog.countDocuments(query);

    res.status(200).json({
      logs,
      pagination: {
        page,
        limit,
        totalPages: Math.ceil(totalLogs / limit),
        totalLogs,
      },
    });
  } catch (error) {
    next(error);
  }
};
export default getAuditLogs;
