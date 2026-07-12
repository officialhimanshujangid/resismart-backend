import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { User } from '../models/user.model';
import { Flat } from '../models/flat.model';
import { Shop } from '../models/shop.model';
import { resolveUserContexts } from '../services/context.service';

/** GET /me/contexts — every switchable unit (flats/plots/shops + admin roles) for the current user. */
export const getMyContexts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication details missing from session' });
      return;
    }

    const user = await User.findById(userId).exec();
    if (!user || !user.isActive) {
      res.status(401).json({ error: 'User is inactive or no longer exists' });
      return;
    }

    const contexts = await resolveUserContexts(user);
    res.status(200).json({
      contexts,
      activeContextId: req.user?.activeContextId || null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /me/unit-summary — details of the flat/plot/shop the session is scoped to,
 * so the dashboard "My Unit" panel can re-render when the user switches.
 */
export const getUnitSummary = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const unitId = req.user?.activeUnitId;
    const unitType = req.user?.activeUnitType;

    if (!unitId || !unitType) {
      // Tenant-level (admin/employee) session — no single unit.
      res.status(200).json({ unit: null, unitType: null });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(unitId)) {
      res.status(400).json({ error: 'Invalid unit id' });
      return;
    }

    if (unitType === 'SHOP') {
      const shop = await Shop.findById(unitId)
        .select('name address contactNumber city state pincode status storeType typeService')
        .lean();
      if (!shop) {
        res.status(404).json({ error: 'Shop not found' });
        return;
      }
      res.status(200).json({ unitType, unit: shop });
      return;
    }

    // FLAT / plot — scope to the active society tenant for safety.
    const societyId = req.user?.activeTenantId;
    const flat = await Flat.findOne({
      _id: unitId,
      ...(societyId ? { societyId: new mongoose.Types.ObjectId(societyId) } : {}),
    })
      .populate('societyId', 'name address')
      .populate('size', 'name details')
      .populate('blockId', 'name')
      .populate({ path: 'residents', populate: { path: 'userId', select: 'name email phone' } })
      .lean();

    if (!flat) {
      res.status(404).json({ error: 'Flat not found' });
      return;
    }

    res.status(200).json({ unitType, unit: flat });
  } catch (error) {
    next(error);
  }
};
