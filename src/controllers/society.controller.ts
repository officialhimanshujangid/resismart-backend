import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { Subscription } from '../models/subscription.model';
import { assignFreeTier, getGoverningSubscription, getEffectiveLimits } from '../services/subscription-lifecycle.service';
import { Society } from '../models/society.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { User } from '../models/user.model';
import {
  createSocietySchema,
  createFlatSchema,
  updateFlatSchema,
  registerSocietyPublicSchema,
  registerSocietyAdminSchema,
  updateSocietySchema,
  rejectSocietySchema,
} from '../validators/society.validator';
import { AuditService } from '../services/audit.service';
import EmailService from '../services/email.service';
import { hashPassword } from '../utils/hash.util';
import { TenantType, UserRole } from '../constants/roles';

// Extract the optional extended detail fields, dropping empty strings.
const pickDetails = (d: any) => {
  const out: Record<string, any> = {};
  ['contactPhone', 'city', 'state', 'pincode', 'registrationNumber', 'website'].forEach((k) => {
    if (d[k] !== undefined && d[k] !== '') out[k] = d[k];
  });
  ['totalBlocks', 'totalFlats'].forEach((k) => {
    if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  });
  return out;
};

export const createSociety = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validatedData = createSocietySchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;

    if (!userId || !userName) {
      res.status(401).json({ error: 'Unauthorized credentials' });
      return;
    }

    const newSociety = await Society.create({
      name: validatedData.name,
      address: validatedData.address,
      createdBy: new mongoose.Types.ObjectId(userId),
      createdByName: userName,
      updatedBy: new mongoose.Types.ObjectId(userId),
      updatedByName: userName,
    });

    AuditService.log({
      userId,
      userName,
      tenantId: newSociety._id.toString(),
      tenantType: TenantType.SOCIETY,
      action: 'SOCIETY_CREATE',
      resource: 'Society',
      resourceId: newSociety._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { name: newSociety.name, address: newSociety.address },
    });

    res.status(201).json({
      message: 'Society created successfully',
      society: newSociety,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const createFlat = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validatedData = createFlatSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    const existingFlat = await Flat.findOne({
      societyId: new mongoose.Types.ObjectId(societyId),
      blockName: validatedData.blockName,
      number: validatedData.number,
    }).lean();

    if (existingFlat) {
      res.status(400).json({ error: 'Flat already exists in this block' });
      return;
    }

    const newFlat = await Flat.create({
      number: validatedData.number,
      blockName: validatedData.blockName,
      societyId: new mongoose.Types.ObjectId(societyId),
      status: FlatStatus.VACANT,
      owners: [],
      createdBy: new mongoose.Types.ObjectId(userId),
      createdByName: userName,
      updatedBy: new mongoose.Types.ObjectId(userId),
      updatedByName: userName,
    });

    AuditService.log({
      userId,
      userName,
      tenantId: societyId,
      tenantType: TenantType.SOCIETY,
      action: 'FLAT_CREATE',
      resource: 'Flat',
      resourceId: newFlat._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      newValues: {
        number: newFlat.number,
        blockName: newFlat.blockName,
        status: newFlat.status,
      },
    });

    res.status(201).json({
      message: 'Flat created successfully',
      flat: newFlat,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const updateFlat = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { flatId } = req.params;
    const validatedData = updateFlatSchema.parse(req.body);
    const userId = req.user?.userId;
    const userName = req.user?.userName;
    const societyId = req.user?.activeTenantId;

    if (!userId || !userName || !societyId) {
      res.status(401).json({ error: 'Missing tenant or user details' });
      return;
    }

    const flat = await Flat.findOne({
      _id: flatId,
      societyId: new mongoose.Types.ObjectId(societyId),
    });

    if (!flat) {
      res.status(404).json({ error: 'Flat not found' });
      return;
    }

    const oldValues = {
      status: flat.status,
      owners: flat.owners.map((o) => o.toString()),
    };

    if (validatedData.status) {
      flat.status = validatedData.status as FlatStatus;
    }
    if (validatedData.owners) {
      flat.owners = validatedData.owners.map((id) => new mongoose.Types.ObjectId(id));

      for (const ownerId of validatedData.owners) {
        await User.updateOne(
          { _id: ownerId, 'memberships.tenantId': new mongoose.Types.ObjectId(societyId) },
          { $set: { 'memberships.$.role': UserRole.RESIDENT_OWNER } }
        );
      }
    }

    flat.updatedBy = new mongoose.Types.ObjectId(userId);
    flat.updatedByName = userName;
    await flat.save();

    const newValues = {
      status: flat.status,
      owners: flat.owners.map((o) => o.toString()),
    };

    AuditService.log({
      userId,
      userName,
      tenantId: societyId,
      tenantType: TenantType.SOCIETY,
      action: 'FLAT_UPDATE',
      resource: 'Flat',
      resourceId: flat._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      oldValues,
      newValues,
    });

    res.status(200).json({
      message: 'Flat updated successfully',
      flat,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
      return;
    }
    next(error);
  }
};

export const getFlats = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) {
      res.status(403).json({ error: 'No active society tenant' });
      return;
    }

    const { page, pageSize, isPagination, search, status } = req.query;
    const filter: Record<string, any> = { societyId: new mongoose.Types.ObjectId(societyId) };

    if (status && ['VACANT', 'OWNER_OCCUPIED', 'RENTED'].includes(String(status))) {
      filter.status = status;
    }
    if (search) {
      const rx = new RegExp(String(search), 'i');
      filter.$or = [{ number: rx }, { blockName: rx }];
    }

    if (isPagination === 'true') {
      const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '10'), 10)));
      const skip = (currentPage - 1) * limit;

      const [flats, total] = await Promise.all([
        Flat.find(filter).select('-__v').populate('owners', 'name email').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        Flat.countDocuments(filter),
      ]);

      res.status(200).json({
        flats,
        pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) },
      });
      return;
    }

    const flats = await Flat.find(filter).select('-__v').populate('owners', 'name email').lean();
    res.status(200).json({ flats });
  } catch (error) {
    next(error);
  }
};

/**
 * Paginated society listing for the platform owner dashboard.
 * Supports status filter (PENDING/ACTIVE/REJECTED), search and date range.
 */
export const getSocieties = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, isPagination, search, status, startDate, endDate } = req.query;
    const filter: Record<string, any> = {};

    if (status && ['PENDING', 'ACTIVE', 'REJECTED'].includes(String(status))) {
      filter.status = status;
    }
    if (search) {
      const rx = new RegExp(String(search), 'i');
      filter.$or = [{ name: rx }, { address: rx }, { contactName: rx }, { contactEmail: rx }];
    }
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(String(startDate));
      if (endDate) {
        const end = new Date(String(endDate));
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    // Filter by current subscription lifecycle (trial / subscribed / expired)
    const subscriptionStatus = req.query.subscriptionStatus ? String(req.query.subscriptionStatus) : '';
    if (['trialing', 'active', 'expired'].includes(subscriptionStatus)) {
      if (subscriptionStatus === 'expired') {
        const liveIds = await Subscription.find({ tenantType: 'SOCIETY', status: { $in: ['active', 'trialing'] } }).distinct('tenantId');
        const liveSet = new Set(liveIds.map((i) => i.toString()));
        const expiredIds = await Subscription.find({ tenantType: 'SOCIETY', status: { $in: ['expired', 'cancelled'] } }).distinct('tenantId');
        filter._id = { $in: expiredIds.filter((id) => !liveSet.has(id.toString())) };
      } else {
        const ids = await Subscription.find({ tenantType: 'SOCIETY', status: subscriptionStatus }).distinct('tenantId');
        filter._id = { $in: ids };
      }
    }

    if (isPagination === 'true') {
      const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '10'), 10)));
      const skip = (currentPage - 1) * limit;

      const [societies, total] = await Promise.all([
        Society.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        Society.countDocuments(filter),
      ]);

      res.status(200).json({
        societies,
        pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) },
      });
      return;
    }

    const societies = await Society.find(filter).sort({ createdAt: -1 }).lean();
    res.status(200).json({ societies });
  } catch (error) {
    next(error);
  }
};

/** One-call KPI summary for the societies list (avoids several count requests). */
export const getSocietyStats = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const byStatus = await Society.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    let total = 0, pending = 0, active = 0, rejected = 0;
    for (const r of byStatus) {
      total += r.n;
      if (r._id === 'PENDING') pending = r.n;
      else if (r._id === 'ACTIVE') active = r.n;
      else if (r._id === 'REJECTED') rejected = r.n;
    }

    const liveIds = await Subscription.find({ tenantType: 'SOCIETY', status: { $in: ['active', 'trialing'] } }).distinct('tenantId');
    const liveSet = new Set(liveIds.map((i) => i.toString()));
    const expiredIds = await Subscription.find({ tenantType: 'SOCIETY', status: { $in: ['expired', 'cancelled'] } }).distinct('tenantId');
    const expired = expiredIds.filter((id) => !liveSet.has(id.toString())).length;

    res.status(200).json({ success: true, stats: { total, pending, active, rejected, expired } });
  } catch (error) {
    next(error);
  }
};

export const getSocietyById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const society = await Society.findById(req.params.id).populate('adminUserId', 'name email').lean();
    if (!society) {
      res.status(404).json({ error: 'Society not found' });
      return;
    }
    // Current (governing) plan + any upcoming scheduled terms.
    const [governing, upcoming, eff] = await Promise.all([
      getGoverningSubscription(society._id),
      Subscription.find({ tenantId: society._id, tenantType: 'SOCIETY', status: 'scheduled' })
        .sort({ startDate: 1 }).populate('planId', 'name').lean(),
      getEffectiveLimits(society._id),
    ]);

    let nextAmountPaise = 0;
    if (governing && governing.planId && !governing.isFreeTier) {
      const planDoc = governing.planId as any;
      if (planDoc.getPricingForTenure) {
        const pricing = planDoc.getPricingForTenure(governing.tenure);
        if (pricing) nextAmountPaise = pricing.totalPrice * 100;
      }
    }

    res.status(200).json({
      society,
      subscription: governing,
      upcoming,
      planStatus: { planName: eff.planName, status: eff.status, isFreeTier: eff.isFreeTier, endDate: eff.endDate, graceEndsAt: eff.graceEndsAt },
      nextAmountPaise,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Owner edits an existing society's details. Logs an audit entry with old/new values.
 */
export const updateSociety = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = updateSocietySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const society = await Society.findById(req.params.id);
    if (!society) {
      res.status(404).json({ error: 'Society not found' });
      return;
    }

    const d = parsed.data;
    if (d.name && d.name !== society.name) {
      const dup = await Society.findOne({ name: new RegExp(`^${d.name}$`, 'i'), _id: { $ne: society._id } }).lean();
      if (dup) {
        res.status(409).json({ error: 'Another society already uses this name.' });
        return;
      }
    }

    const oldValues = { name: society.name, address: society.address, contactEmail: society.contactEmail };

    if (d.name !== undefined) society.name = d.name;
    if (d.address !== undefined) society.address = d.address;
    if (d.contactName !== undefined) society.contactName = d.contactName || undefined;
    if (d.contactEmail !== undefined) society.contactEmail = d.contactEmail || undefined;
    if (d.latitude !== undefined && d.longitude !== undefined) {
      society.location = { type: 'Point', coordinates: [d.longitude, d.latitude] };
    }
    const details = pickDetails(d);
    Object.assign(society, details);
    // Allow clearing string detail fields explicitly set to ''
    ['contactPhone', 'city', 'state', 'pincode', 'registrationNumber', 'website'].forEach((k) => {
      if ((d as any)[k] === '') (society as any)[k] = undefined;
    });

    if (req.user?.userId) {
      society.updatedBy = new mongoose.Types.ObjectId(req.user.userId);
      society.updatedByName = req.user.userName || 'Super Admin';
    }
    await society.save();

    AuditService.log({
      userId: req.user?.userId || 'system',
      userName: req.user?.userName || 'Super Admin',
      tenantId: society._id.toString(),
      tenantType: TenantType.SOCIETY,
      action: 'SOCIETY_UPDATE',
      resource: 'Society',
      resourceId: society._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      oldValues,
      newValues: { name: society.name, address: society.address, contactEmail: society.contactEmail },
    });

    res.status(200).json({ message: 'Society updated successfully', society });
  } catch (error) {
    next(error);
  }
};

/**
 * Public endpoint for users registering their own society. Created in PENDING state.
 */
export const registerSocietyPublic = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = registerSocietyPublicSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const { name, address, latitude, longitude, contactName, contactEmail } = parsed.data;

    const existing = await Society.findOne({ name: new RegExp(`^${name}$`, 'i') }).lean();
    if (existing) {
      res.status(409).json({ error: 'A society with this name is already registered.' });
      return;
    }

    const placeholderUserId = new mongoose.Types.ObjectId(); // no real user until approval
    const society = await Society.create({
      name,
      address,
      status: 'PENDING',
      location:
        latitude !== undefined && longitude !== undefined
          ? { type: 'Point', coordinates: [longitude, latitude] }
          : undefined,
      contactName,
      contactEmail,
      ...pickDetails(parsed.data),
      createdBy: placeholderUserId,
      createdByName: contactName,
      updatedBy: placeholderUserId,
      updatedByName: contactName,
    });

    EmailService.sendSocietyPendingEmail(contactEmail, name);

    res.status(201).json({
      message: 'Society registered successfully and is pending approval.',
      society,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Owner-side registration. Society is created ACTIVE and a free trial assigned.
 */
export const registerSocietyAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = registerSocietyAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const { name, address, latitude, longitude, contactName, contactEmail } = parsed.data;

    const superOwnerId = req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : new mongoose.Types.ObjectId();
    const superOwnerName = req.user?.userName || 'Super Admin';

    const society = await Society.create({
      name,
      address,
      status: 'ACTIVE',
      location:
        latitude !== undefined && longitude !== undefined
          ? { type: 'Point', coordinates: [longitude, latitude] }
          : undefined,
      contactName,
      contactEmail,
      ...pickDetails(parsed.data),
      createdBy: superOwnerId,
      createdByName: superOwnerName,
      updatedBy: superOwnerId,
      updatedByName: superOwnerName,
    });

    // If a contact email is supplied, provision the society admin user now.
    if (contactEmail) {
      await provisionSocietyAdmin(society, contactEmail, contactName || name);
    }

    await assignFreeTier(society._id as mongoose.Types.ObjectId);

    res.status(201).json({ message: 'Society registered and activated successfully.', society });
  } catch (error) {
    next(error);
  }
};

/**
 * Approves a PENDING society: provisions the admin user, assigns the trial.
 */
export const approveSociety = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const society = await Society.findById(id);

    if (!society) {
      res.status(404).json({ error: 'Society not found' });
      return;
    }
    if (society.status === 'ACTIVE') {
      res.status(400).json({ error: 'Society is already active' });
      return;
    }

    society.status = 'ACTIVE';
    society.rejectionReason = undefined;
    if (req.user?.userId) {
      society.updatedBy = new mongoose.Types.ObjectId(req.user.userId);
      society.updatedByName = req.user.userName || 'Super Admin';
    }

    if (society.contactEmail && !society.adminUserId) {
      await provisionSocietyAdmin(society, society.contactEmail, society.contactName || society.name);
    }
    await society.save();

    await assignFreeTier(society._id as mongoose.Types.ObjectId);

    AuditService.log({
      userId: req.user?.userId || 'system',
      userName: req.user?.userName || 'Super Admin',
      tenantId: society._id.toString(),
      tenantType: TenantType.SOCIETY,
      action: 'SOCIETY_APPROVE',
      resource: 'Society',
      resourceId: society._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { status: 'ACTIVE' },
    });

    res.status(200).json({ message: 'Society approved and trial activated.', society });
  } catch (error) {
    next(error);
  }
};

/**
 * Rejects a PENDING society with a reason.
 */
export const rejectSociety = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = rejectSocietySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const society = await Society.findById(req.params.id);
    if (!society) {
      res.status(404).json({ error: 'Society not found' });
      return;
    }
    if (society.status === 'ACTIVE') {
      res.status(400).json({ error: 'Cannot reject an already active society' });
      return;
    }

    society.status = 'REJECTED';
    society.rejectionReason = parsed.data.reason;
    if (req.user?.userId) {
      society.updatedBy = new mongoose.Types.ObjectId(req.user.userId);
      society.updatedByName = req.user.userName || 'Super Admin';
    }
    await society.save();

    AuditService.log({
      userId: req.user?.userId || 'system',
      userName: req.user?.userName || 'Super Admin',
      tenantId: society._id.toString(),
      tenantType: TenantType.SOCIETY,
      action: 'SOCIETY_REJECT',
      resource: 'Society',
      resourceId: society._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { status: 'REJECTED', reason: parsed.data.reason },
    });

    res.status(200).json({ message: 'Society rejected.', society });
  } catch (error) {
    next(error);
  }
};

// ---------- Helpers ----------

/**
 * Creates (or links) the SOCIETY_ADMIN user for a society and emails credentials.
 */
async function provisionSocietyAdmin(society: any, email: string, name: string): Promise<void> {
  let user = await User.findOne({ email: email.toLowerCase() });
  const tempPassword = crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) + 'A1';

  if (!user) {
    user = await User.create({
      name,
      email: email.toLowerCase(),
      passwordHash: await hashPassword(tempPassword),
      isActive: true,
      memberships: [{ tenantType: TenantType.SOCIETY, tenantId: society._id, role: UserRole.SOCIETY_ADMIN }],
    });
    EmailService.sendSocietyApprovedEmail(email, society.name, tempPassword);
  } else {
    const already = user.memberships.some(
      (m: any) => m.tenantId.toString() === society._id.toString() && m.role === UserRole.SOCIETY_ADMIN
    );
    if (!already) {
      user.memberships.push({ tenantType: TenantType.SOCIETY, tenantId: society._id, role: UserRole.SOCIETY_ADMIN } as any);
      await user.save();
    }
  }

  society.adminUserId = user._id;
}

