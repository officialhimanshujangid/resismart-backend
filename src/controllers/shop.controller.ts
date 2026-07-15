import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { Subscription } from '../models/subscription.model';
import { assignFreeTier, getGoverningSubscription, getEffectiveLimits } from '../services/subscription-lifecycle.service';
import { Shop } from '../models/shop.model';
import { User } from '../models/user.model';
import {
  registerShopPublicSchema,
  registerShopAdminSchema,
  updateShopSchema,
  rejectShopSchema,
} from '../validators/shop.validator';
import { AuditService } from '../services/audit.service';
import EmailService from '../services/email.service';
import { hashPassword } from '../utils/hash.util';
import { normalizePhone } from '../utils/phone.util';
import { assertVerified, consumeVerification } from '../services/otp.service';
import { attachTenantMembership, primaryIdentityId } from '../services/identity.service';
import { TenantType, UserRole } from '../constants/roles';

const pickDetails = (d: any) => {
  const out: Record<string, any> = {};
  ['gstNumber', 'storeType', 'typeService', 'salesAndProduct', 'city', 'state', 'pincode'].forEach((k) => {
    if (d[k] !== undefined && d[k] !== '') out[k] = d[k];
  });
  return out;
};

export const getShops = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { page, pageSize, isPagination, search, status } = req.query;
    const filter: Record<string, any> = {};

    if (search) {
      filter.name = { $regex: search, $options: 'i' };
    }
    if (status && status !== 'all') {
      filter.status = status;
    }

    const subscriptionStatus = req.query.subscriptionStatus ? String(req.query.subscriptionStatus) : '';
    if (['trialing', 'active', 'expired'].includes(subscriptionStatus)) {
      if (subscriptionStatus === 'expired') {
        const liveIds = await Subscription.find({ tenantType: 'SHOP', status: { $in: ['active', 'trialing'] } }).distinct('tenantId');
        const liveSet = new Set(liveIds.map((i) => i.toString()));
        const expiredIds = await Subscription.find({ tenantType: 'SHOP', status: { $in: ['expired', 'cancelled'] } }).distinct('tenantId');
        filter._id = { $in: expiredIds.filter((id) => !liveSet.has(id.toString())) };
      } else {
        const ids = await Subscription.find({ tenantType: 'SHOP', status: subscriptionStatus }).distinct('tenantId');
        filter._id = { $in: ids };
      }
    }

    if (isPagination === 'true') {
      const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '10'), 10)));
      const skip = (currentPage - 1) * limit;

      const [shops, total] = await Promise.all([
        Shop.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        Shop.countDocuments(filter),
      ]);

      res.status(200).json({
        shops,
        pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) },
      });
      return;
    }

    const shops = await Shop.find(filter).sort({ createdAt: -1 }).lean();
    res.status(200).json({ shops });
  } catch (error) {
    next(error);
  }
};

export const getShopStats = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const byStatus = await Shop.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    let total = 0, pending = 0, active = 0, rejected = 0;
    for (const r of byStatus) {
      total += r.n;
      if (r._id === 'PENDING') pending = r.n;
      else if (r._id === 'ACTIVE') active = r.n;
      else if (r._id === 'REJECTED') rejected = r.n;
    }

    const liveIds = await Subscription.find({ tenantType: 'SHOP', status: { $in: ['active', 'trialing'] } }).distinct('tenantId');
    const liveSet = new Set(liveIds.map((i) => i.toString()));
    const expiredIds = await Subscription.find({ tenantType: 'SHOP', status: { $in: ['expired', 'cancelled'] } }).distinct('tenantId');
    const expired = expiredIds.filter((id) => !liveSet.has(id.toString())).length;

    res.status(200).json({ success: true, stats: { total, pending, active, rejected, expired } });
  } catch (error) {
    next(error);
  }
};

export const getShopById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const shop = await Shop.findById(req.params.id).populate('adminUserId', 'name email').lean();
    if (!shop) {
      res.status(404).json({ error: 'Shop not found' });
      return;
    }
    const [governing, upcoming, eff] = await Promise.all([
      getGoverningSubscription(shop._id, 'SHOP'),
      Subscription.find({ tenantId: shop._id, tenantType: 'SHOP', status: 'scheduled' })
        .sort({ startDate: 1 }).populate('planId', 'name').lean(),
      getEffectiveLimits(shop._id, 'SHOP'),
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
      shop,
      subscription: governing,
      upcoming,
      planStatus: { planName: eff.planName, status: eff.status, isFreeTier: eff.isFreeTier, endDate: eff.endDate, graceEndsAt: eff.graceEndsAt },
      nextAmountPaise,
    });
  } catch (error) {
    next(error);
  }
};

export const updateShop = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = updateShopSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const shop = await Shop.findById(req.params.id);
    if (!shop) {
      res.status(404).json({ error: 'Shop not found' });
      return;
    }

    const d = parsed.data;
    if (d.name && d.name !== shop.name) {
      const dup = await Shop.findOne({ name: new RegExp(`^${d.name}$`, 'i'), _id: { $ne: shop._id } }).lean();
      if (dup) {
        res.status(409).json({ error: 'Another shop already uses this name.' });
        return;
      }
    }

    const oldValues = { name: shop.name, address: shop.address, adminEmail: shop.adminEmail };

    if (d.name !== undefined) shop.name = d.name;
    if (d.address !== undefined) shop.address = d.address;
    if (d.contactNumber !== undefined) shop.contactNumber = d.contactNumber;
    if (d.adminEmail !== undefined) shop.adminEmail = d.adminEmail || shop.adminEmail;
    if (d.latitude !== undefined && d.longitude !== undefined) {
      shop.location = { type: 'Point', coordinates: [d.longitude, d.latitude] };
    }
    const details = pickDetails(d);
    Object.assign(shop, details);
    
    ['gstNumber', 'storeType', 'typeService', 'salesAndProduct', 'city', 'state', 'pincode'].forEach((k) => {
      if ((d as any)[k] === '') (shop as any)[k] = undefined;
    });

    if (req.user?.userId) {
      shop.updatedBy = new mongoose.Types.ObjectId(req.user.userId);
      shop.updatedByName = req.user.userName || 'Super Admin';
    }
    await shop.save();

    AuditService.log({
      userId: req.user?.userId || 'system',
      userName: req.user?.userName || 'Super Admin',
      tenantId: shop._id.toString(),
      tenantType: TenantType.SHOP,
      action: 'SHOP_UPDATE',
      resource: 'Shop',
      resourceId: shop._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      oldValues,
      newValues: { name: shop.name, address: shop.address, adminEmail: shop.adminEmail },
    });

    res.status(200).json({ message: 'Shop updated successfully', shop });
  } catch (error) {
    next(error);
  }
};

export const registerShopPublic = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = registerShopPublicSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const { name, address, latitude, longitude, contactNumber, adminEmail, password, emailVerificationToken, phoneVerificationToken } = parsed.data;

    // Shop admin = email + phone, both OTP-verified before creating.
    const normPhone = normalizePhone(contactNumber);
    const normEmail = adminEmail.toLowerCase();
    if (!normPhone) {
      res.status(400).json({ error: 'A valid contact number is required.' });
      return;
    }
    const [emailOk, phoneOk] = await Promise.all([
      assertVerified(emailVerificationToken || '', 'EMAIL', normEmail, 'SHOP_REGISTRATION'),
      assertVerified(phoneVerificationToken || '', 'PHONE', normPhone, 'SHOP_REGISTRATION'),
    ]);
    if (!emailOk) { res.status(400).json({ error: 'Admin email not verified. Please verify the code sent to your email.' }); return; }
    if (!phoneOk) { res.status(400).json({ error: 'Contact number not verified. Please verify the OTP.' }); return; }

    const existing = await Shop.findOne({ name: new RegExp(`^${name}$`, 'i') }).lean();
    if (existing) {
      res.status(409).json({ error: 'A shop with this name is already registered.' });
      return;
    }

    const placeholderUserId = new mongoose.Types.ObjectId();
    const shop = await Shop.create({
      name,
      address,
      contactNumber,
      adminEmail: normEmail,
      status: 'PENDING',
      location:
        latitude !== undefined && longitude !== undefined
          ? { type: 'Point', coordinates: [longitude, latitude] }
          : undefined,
      ...pickDetails(parsed.data),
      createdBy: placeholderUserId,
      createdByName: name,
      updatedBy: placeholderUserId,
      updatedByName: name,
    });

    // Identifier-scoped, passwordless: SHOP_ADMIN on both the email and phone
    // identities (inactive until approval). Login is via OTP — the password field
    // is no longer used as a credential.
    const identities = await attachTenantMembership({
      email: normEmail,
      phone: normPhone,
      name,
      tenantType: TenantType.SHOP,
      tenantId: shop._id,
      role: UserRole.SHOP_ADMIN,
      isActive: false,
    });
    shop.adminUserId = primaryIdentityId(identities);
    await shop.save();

    // One-time use: burn the verifications.
    await Promise.all([
      consumeVerification('EMAIL', normEmail, 'SHOP_REGISTRATION'),
      consumeVerification('PHONE', normPhone, 'SHOP_REGISTRATION'),
    ]);

    if ((EmailService as any).sendShopPendingEmail) {
      (EmailService as any).sendShopPendingEmail(adminEmail, name);
    } else {
      // Fallback
      EmailService.sendSocietyPendingEmail(adminEmail, name);
    }

    res.status(201).json({
      message: 'Shop registered successfully and is pending approval.',
      shop,
    });
  } catch (error) {
    next(error);
  }
};

export const registerShopAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = registerShopAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const { name, address, latitude, longitude, contactNumber, adminEmail, password } = parsed.data;

    const superOwnerId = req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : new mongoose.Types.ObjectId();
    const superOwnerName = req.user?.userName || 'Super Admin';

    const shop = await Shop.create({
      name,
      address,
      contactNumber,
      adminEmail,
      status: 'ACTIVE',
      location:
        latitude !== undefined && longitude !== undefined
          ? { type: 'Point', coordinates: [longitude, latitude] }
          : undefined,
      ...pickDetails(parsed.data),
      createdBy: superOwnerId,
      createdByName: superOwnerName,
      updatedBy: superOwnerId,
      updatedByName: superOwnerName,
    });

    if (adminEmail) {
      await provisionShopAdmin(shop, adminEmail, name, password);
    }

    await assignFreeTier(shop._id as mongoose.Types.ObjectId, 'SHOP');

    res.status(201).json({ message: 'Shop registered and activated successfully.', shop });
  } catch (error) {
    next(error);
  }
};

export const approveShop = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const shop = await Shop.findById(id);

    if (!shop) {
      res.status(404).json({ error: 'Shop not found' });
      return;
    }
    if (shop.status === 'ACTIVE') {
      res.status(400).json({ error: 'Shop is already active' });
      return;
    }

    shop.status = 'ACTIVE';
    shop.rejectionReason = undefined;
    if (req.user?.userId) {
      shop.updatedBy = new mongoose.Types.ObjectId(req.user.userId);
      shop.updatedByName = req.user.userName || 'Super Admin';
    }
    await shop.save();

    if (shop.adminUserId) {
      await User.updateOne({ _id: shop.adminUserId }, { isActive: true });
    } else if (shop.adminEmail) {
      await provisionShopAdmin(shop, shop.adminEmail, shop.name);
    }

    await assignFreeTier(shop._id as mongoose.Types.ObjectId, 'SHOP');

    AuditService.log({
      userId: req.user?.userId || 'system',
      userName: req.user?.userName || 'Super Admin',
      tenantId: shop._id.toString(),
      tenantType: TenantType.SHOP,
      action: 'SHOP_APPROVE',
      resource: 'Shop',
      resourceId: shop._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { status: 'ACTIVE' },
    });

    res.status(200).json({ message: 'Shop approved and trial activated.', shop });
  } catch (error) {
    next(error);
  }
};

export const rejectShop = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = rejectShopSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const shop = await Shop.findById(req.params.id);
    if (!shop) {
      res.status(404).json({ error: 'Shop not found' });
      return;
    }
    if (shop.status === 'ACTIVE') {
      res.status(400).json({ error: 'Cannot reject an already active shop' });
      return;
    }

    shop.status = 'REJECTED';
    shop.rejectionReason = parsed.data.reason;
    if (req.user?.userId) {
      shop.updatedBy = new mongoose.Types.ObjectId(req.user.userId);
      shop.updatedByName = req.user.userName || 'Super Admin';
    }
    await shop.save();

    AuditService.log({
      userId: req.user?.userId || 'system',
      userName: req.user?.userName || 'Super Admin',
      tenantId: shop._id.toString(),
      tenantType: TenantType.SHOP,
      action: 'SHOP_REJECT',
      resource: 'Shop',
      resourceId: shop._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { status: 'REJECTED', reason: parsed.data.reason },
    });

    res.status(200).json({ message: 'Shop rejected.', shop });
  } catch (error) {
    next(error);
  }
};

async function provisionShopAdmin(shop: any, email: string, name: string, _password?: string): Promise<void> {
  // Identifier-scoped, passwordless: activate SHOP_ADMIN on both the email and
  // phone identities so either can log in (via OTP) and see this shop.
  const result = await attachTenantMembership({
    email,
    phone: shop.contactNumber,
    name,
    tenantType: TenantType.SHOP,
    tenantId: shop._id,
    role: UserRole.SHOP_ADMIN,
    isActive: true,
  });

  shop.adminUserId = primaryIdentityId(result);
  await shop.save();
  if (email) EmailService.sendTenantAccessEmail(email, shop.name, 'shop', [], result.generatedPassword);
}

export const getMyShop = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const shopId = req.user?.activeTenantId;
    if (!shopId) return next(new Error('No active tenant'));

    const shop = await Shop.findById(shopId).populate('adminUserId', 'name email').lean();
    if (!shop) {
      res.status(404).json({ error: 'Shop not found' });
      return;
    }
    const [governing, upcoming, eff] = await Promise.all([
      getGoverningSubscription(shop._id, 'SHOP'),
      Subscription.find({ tenantId: shop._id, tenantType: 'SHOP', status: 'scheduled' })
        .sort({ startDate: 1 }).populate('planId', 'name').lean(),
      getEffectiveLimits(shop._id, 'SHOP'),
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
      shop,
      subscription: governing,
      upcoming,
      planStatus: { planName: eff.planName, status: eff.status, isFreeTier: eff.isFreeTier, endDate: eff.endDate, graceEndsAt: eff.graceEndsAt },
      nextAmountPaise,
    });
  } catch (error) {
    next(error);
  }
};

export const updateMyShop = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const shopId = req.user?.activeTenantId;
    if (!shopId) return next(new Error('No active tenant'));

    const parsed = updateShopSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }
    const shop = await Shop.findById(shopId);
    if (!shop) {
      res.status(404).json({ error: 'Shop not found' });
      return;
    }

    const d = parsed.data;
    if (d.name && d.name !== shop.name) {
      const dup = await Shop.findOne({ name: new RegExp(`^${d.name}$`, 'i'), _id: { $ne: shop._id } }).lean();
      if (dup) {
        res.status(409).json({ error: 'Another shop already uses this name.' });
        return;
      }
    }

    const oldValues = { name: shop.name, address: shop.address, adminEmail: shop.adminEmail };

    if (d.name !== undefined) shop.name = d.name;
    if (d.address !== undefined) shop.address = d.address;
    if (d.contactNumber !== undefined) shop.contactNumber = d.contactNumber;
    if (d.adminEmail !== undefined) shop.adminEmail = d.adminEmail || shop.adminEmail;
    if (d.latitude !== undefined && d.longitude !== undefined) {
      shop.location = { type: 'Point', coordinates: [d.longitude, d.latitude] };
    }
    const details = pickDetails(d);
    Object.assign(shop, details);
    
    ['gstNumber', 'storeType', 'typeService', 'salesAndProduct', 'city', 'state', 'pincode'].forEach((k) => {
      if ((d as any)[k] === '') (shop as any)[k] = undefined;
    });

    if (req.user?.userId) {
      shop.updatedBy = new mongoose.Types.ObjectId(req.user.userId);
      shop.updatedByName = req.user.userName || 'Shop Admin';
    }
    await shop.save();

    AuditService.log({
      userId: req.user?.userId || 'system',
      userName: req.user?.userName || 'Shop Admin',
      tenantId: shop._id.toString(),
      tenantType: TenantType.SHOP,
      action: 'SHOP_UPDATE',
      resource: 'Shop',
      resourceId: shop._id.toString(),
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      oldValues,
      newValues: { name: shop.name, address: shop.address, adminEmail: shop.adminEmail },
    });

    res.status(200).json({ message: 'Shop updated successfully', shop });
  } catch (error) {
    next(error);
  }
};
