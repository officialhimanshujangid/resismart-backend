import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { User } from '../models/user.model';
import { Flat } from '../models/flat.model';
import { Shop } from '../models/shop.model';
import { Resident } from '../models/resident.model';
import { FlatTenure } from '../models/flat-tenure.model';
import { FlatEvent } from '../models/flat-event.model';
import { resolveUserContexts } from '../services/context.service';
import { listHouseholdMembers } from '../services/household.service';
import { getCurrentCommittee } from '../services/committee.service';
import { UserRole } from '../constants/roles';

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

/**
 * GET /me/flat — the resident portal payload for the caller's active flat: flat info,
 * the full household roster, the caller's own role/tenure + documents, the merged activity
 * timeline (tenure periods + events), and society/committee summary. Scoped to the JWT's
 * active unit + tenant. Owners get `me.canManage = true` so the UI shows self-service actions.
 */
export const getMyFlat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const unitId = req.user?.activeUnitId;
    const unitType = req.user?.activeUnitType;
    const societyId = req.user?.activeTenantId;
    const role = req.user?.activeRole;
    if (!userId || !societyId) { res.status(401).json({ error: 'Authentication details missing' }); return; }
    if (unitType !== 'FLAT' || !unitId || !mongoose.Types.ObjectId.isValid(unitId)) {
      res.status(400).json({ error: 'No active flat for this session' }); return;
    }

    const flat: any = await Flat.findOne({ _id: unitId, societyId: new mongoose.Types.ObjectId(societyId) })
      .populate('societyId', 'name address city')
      .populate('size', 'name details')
      .populate('blockId', 'name')
      .populate('ownerUserId', 'name email phone')
      .lean();
    if (!flat) { res.status(404).json({ error: 'Flat not found' }); return; }

    const members = await listHouseholdMembers(flat._id, societyId);

    // The caller's own rows in this flat → role/tenure + their documents.
    const myRows = await Resident.find({ flatId: flat._id, userId: new mongoose.Types.ObjectId(userId) }).lean();
    const mine = myRows.find((r) => r.isActive) || myRows[0];
    const myDocuments = (mine?.documents || []).map((d: any) => ({ _id: d._id, residentId: mine!._id, kind: d.kind, label: d.label, uploadedAt: d.uploadedAt }));
    const canManage = role === UserRole.RESIDENT_OWNER || role === UserRole.SOCIETY_ADMIN || role === UserRole.SOCIETY_COMMITTEE;

    const [tenures, events, committee, activeTenancy] = await Promise.all([
      FlatTenure.find({ flatId: flat._id }).sort({ startDate: -1, createdAt: -1 }).lean(),
      FlatEvent.find({ flatId: flat._id }).sort({ createdAt: -1 }).limit(60).lean(),
      getCurrentCommittee(societyId),
      FlatTenure.findOne({ flatId: flat._id, type: 'TENANCY', status: 'ACTIVE' }).lean(),
    ]);
    const tenancy = activeTenancy ? {
      party: (activeTenancy as any).party, startDate: (activeTenancy as any).startDate, endDate: (activeTenancy as any).endDate,
      rentAmountPaise: (activeTenancy as any).rentAmountPaise, securityDepositPaise: (activeTenancy as any).securityDepositPaise,
    } : null;
    const committeeSummary = committee.committee ? {
      name: committee.committee.name,
      officeBearers: committee.members.filter((m: any) => m.isOfficeBearer).map((m: any) => ({ name: m.memberSnapshot?.name, designation: m.designationLabel })),
    } : null;

    res.status(200).json({
      flat: {
        _id: flat._id, number: flat.number, blockName: flat.blockName, status: flat.status,
        fullAddress: flat.fullAddress, size: flat.size, block: flat.blockId,
        owner: flat.ownerUserId ? { name: flat.ownerUserId.name, email: flat.ownerUserId.email } : null,
      },
      society: flat.societyId,
      members,
      me: {
        role, isOwner: !!mine?.isOwner, isHead: !!mine?.isHead,
        relationship: mine?.relationship || null, moveInDate: mine?.moveInDate || null,
        canManage, documents: myDocuments,
      },
      tenures,
      events,
      tenancy,
      committee: committeeSummary,
    });
  } catch (error) {
    next(error);
  }
};
