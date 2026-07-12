import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { PropertyListing } from '../models/property-listing.model';
import { Flat } from '../models/flat.model';
import { Society } from '../models/society.model';
import { createListingSchema, updateListingSchema } from '../validators/property-listing.validator';
import { getAdSetting } from '../services/ad-setting.service';
import { AuditService } from '../services/audit.service';
import { TenantType, UserRole } from '../constants/roles';

/** Statuses that occupy an "active listing" slot for plan-limit purposes. */
export const NON_TERMINAL_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED'];

export const countActiveListings = (societyId: string): Promise<number> =>
  PropertyListing.countDocuments({ societyId: new mongoose.Types.ObjectId(societyId), status: { $in: NON_TERMINAL_STATUSES } });

const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'listing';

const isAdmin = (role?: UserRole) => role === UserRole.SOCIETY_ADMIN || role === UserRole.SOCIETY_COMMITTEE;

const canManage = (req: Request, listing: any): boolean =>
  isAdmin(req.user?.activeRole) || listing.createdByUserId?.toString() === req.user?.userId;

const resolveVerification = (scope: string, flat: any, role?: UserRole, userId?: string) => {
  // Society-level ad created by admin → always verified (the society is the author)
  if (scope === 'SOCIETY' && isAdmin(role)) return { status: 'VERIFIED' as const, method: 'SOCIETY_ADMIN', verifiedAt: new Date() };
  // Flat-level ad created by the flat's registered owner → auto-verified by ownership match
  if (scope === 'FLAT' && flat?.ownerUserId && flat.ownerUserId.toString() === userId) {
    return { status: 'VERIFIED' as const, method: 'OWNER_MATCH', verifiedAt: new Date() };
  }
  // Flat-level ad created by an ADMIN on behalf of a flat → PENDING_OWNER (flat owner must approve)
  if (scope === 'FLAT' && isAdmin(role)) return { status: 'PENDING_OWNER' as const, method: 'ADMIN_POSTED' };
  return { status: 'UNVERIFIED' as const };
};

export const createListing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const d = createListingSchema.parse(req.body);
    const userId = req.user?.userId, userName = req.user?.userName, societyId = req.user?.activeTenantId, role = req.user?.activeRole;
    if (!userId || !userName || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

    const setting = await getAdSetting();
    if (!setting.listingsEnabled) { res.status(403).json({ error: 'The marketplace is currently disabled' }); return; }

    if (d.scope === 'SOCIETY' && !isAdmin(role)) { res.status(403).json({ error: 'Only society admins can post society listings' }); return; }

    let flat: any = null;
    if (d.scope === 'FLAT') {
      flat = await Flat.findOne({ _id: d.flatId, societyId: new mongoose.Types.ObjectId(societyId) });
      if (!flat) { res.status(404).json({ error: 'Flat not found' }); return; }
      if (role === UserRole.RESIDENT_OWNER && (!flat.ownerUserId || flat.ownerUserId.toString() !== userId)) {
        res.status(403).json({ error: 'You can only advertise a flat you own' }); return;
      }
    }

    const society = await Society.findById(societyId).select('location city pincode address name').lean();
    const location = flat?.location?.coordinates?.length ? flat.location : (society?.location?.coordinates?.length ? society.location : undefined);

    const photos = d.photos.length ? d.photos.map((p, i) => ({ ...p, isCover: p.isCover || i === 0 })) : [];
    if (photos.length && !photos.some((p) => p.isCover)) photos[0].isCover = true;

    const listing = await PropertyListing.create({
      kind: d.kind, scope: d.scope, flatId: d.scope === 'FLAT' ? d.flatId : undefined,
      societyId: new mongoose.Types.ObjectId(societyId),
      title: d.title, description: d.description,
      pricePaise: Math.round(d.price * 100),
      priceType: d.kind === 'SALE' ? 'TOTAL' : 'PER_MONTH',
      bedrooms: d.bedrooms, sizeLabel: d.sizeLabel, furnishing: d.furnishing, amenities: d.amenities, photos,
      location, city: society?.city, pincode: society?.pincode, addressLine: flat?.fullAddress || society?.address,
      status: 'DRAFT',
      contact: { name: d.contact?.name || userName, phone: d.contact?.phone, revealPhone: d.contact?.revealPhone ?? false },
      verification: resolveVerification(d.scope, flat, role, userId),
      effectiveRadiusMeters: 0,
      slug: `${slugify(d.title)}-${crypto.randomBytes(4).toString('hex')}`,
      createdByUserId: new mongoose.Types.ObjectId(userId), createdByRole: role || 'UNKNOWN',
      createdBy: new mongoose.Types.ObjectId(userId), createdByName: userName,
      updatedBy: new mongoose.Types.ObjectId(userId), updatedByName: userName,
    });

    AuditService.log({
      userId, userName, tenantId: societyId, tenantType: TenantType.SOCIETY,
      action: 'LISTING_CREATE', resource: 'PropertyListing', resourceId: listing._id.toString(),
      ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown',
      newValues: { kind: d.kind, scope: d.scope, title: d.title },
    });

    res.status(201).json({ message: 'Listing created', listing });
  } catch (error: any) {
    if (error.name === 'ZodError') { res.status(400).json({ errors: error.errors }); return; }
    if (error.code === 11000) { res.status(409).json({ error: 'Slug collision — please retry' }); return; }
    next(error);
  }
};

export const getMyListings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId, societyId = req.user?.activeTenantId, role = req.user?.activeRole;
    if (!userId || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

    const { page, pageSize, isPagination, status, search } = req.query;
    const filter: Record<string, any> = { societyId: new mongoose.Types.ObjectId(societyId) };
    // Admins see all society listings; residents see only their own.
    if (!isAdmin(role)) filter.createdByUserId = new mongoose.Types.ObjectId(userId);
    if (status && typeof status === 'string') filter.status = status;
    if (search && typeof search === 'string') filter.title = { $regex: search, $options: 'i' };

    if (isPagination === 'true') {
      const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '10'), 10)));
      const skip = (currentPage - 1) * limit;
      const [listings, total] = await Promise.all([
        PropertyListing.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
        PropertyListing.countDocuments(filter),
      ]);
      res.status(200).json({ listings, pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) } });
      return;
    }
    const listings = await PropertyListing.find(filter).sort({ updatedAt: -1 }).lean();
    res.status(200).json({ listings });
  } catch (error) {
    next(error);
  }
};

export const getListingById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    const listing = await PropertyListing.findOne({ _id: req.params.id, societyId: new mongoose.Types.ObjectId(societyId) }).lean();
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
    res.status(200).json({ listing });
  } catch (error) {
    next(error);
  }
};

export const updateListing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId, userName = req.user?.userName, societyId = req.user?.activeTenantId;
    if (!userId || !userName || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

    const listing = await PropertyListing.findOne({ _id: req.params.id, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
    if (!canManage(req, listing)) { res.status(403).json({ error: 'You cannot edit this listing' }); return; }

    // Validate only after authorization so unauthorized callers can't probe the schema.
    const d = updateListingSchema.parse(req.body);

    if (d.title !== undefined) listing.title = d.title;
    if (d.description !== undefined) listing.description = d.description;
    if (d.price !== undefined) listing.pricePaise = Math.round(d.price * 100);
    if (d.bedrooms !== undefined) listing.bedrooms = d.bedrooms;
    if (d.sizeLabel !== undefined) listing.sizeLabel = d.sizeLabel;
    if (d.furnishing !== undefined) listing.furnishing = d.furnishing;
    if (d.amenities !== undefined) listing.amenities = d.amenities;
    if (d.photos !== undefined) {
      const photos = d.photos.map((p, i) => ({ ...p, isCover: p.isCover || false }));
      if (photos.length && !photos.some((p) => p.isCover)) photos[0].isCover = true;
      listing.photos = photos as any;
    }
    if (d.contact !== undefined) {
      listing.contact = {
        name: d.contact.name ?? listing.contact.name,
        phone: d.contact.phone ?? listing.contact.phone,
        revealPhone: d.contact.revealPhone ?? listing.contact.revealPhone,
      };
    }
    listing.updatedBy = new mongoose.Types.ObjectId(userId);
    listing.updatedByName = userName;
    await listing.save();

    res.status(200).json({ message: 'Listing updated', listing });
  } catch (error: any) {
    if (error.name === 'ZodError') { res.status(400).json({ errors: error.errors }); return; }
    next(error);
  }
};

/** Transition helper for publish/pause/activate/mark-sold/mark-rented. */
const transition = (action: string, apply: (listing: any, setting: any) => Promise<void> | void) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.userId, userName = req.user?.userName, societyId = req.user?.activeTenantId;
      if (!userId || !userName || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }
      const listing = await PropertyListing.findOne({ _id: req.params.id, societyId: new mongoose.Types.ObjectId(societyId) });
      if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
      if (!canManage(req, listing)) { res.status(403).json({ error: 'You cannot manage this listing' }); return; }

      const setting = await getAdSetting();
      await apply(listing, setting);
      listing.updatedBy = new mongoose.Types.ObjectId(userId);
      listing.updatedByName = userName;
      await listing.save();

      AuditService.log({
        userId, userName, tenantId: societyId, tenantType: TenantType.SOCIETY,
        action, resource: 'PropertyListing', resourceId: listing._id.toString(),
        ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown', newValues: { status: listing.status },
      });
      res.status(200).json({ message: 'Listing updated', listing });
    } catch (error: any) {
      if (error?.status) { res.status(error.status).json({ error: error.message }); return; }
      next(error);
    }
  };

export const publishListing = transition('LISTING_PUBLISH', (listing, setting) => {
  if (!setting.listingsEnabled) throw Object.assign(new Error('The marketplace is currently disabled'), { status: 403 });
  if (['SOLD', 'RENTED', 'TAKEN_DOWN'].includes(listing.status)) throw Object.assign(new Error('This listing can no longer be published'), { status: 400 });
  if (!listing.photos?.length) throw Object.assign(new Error('Add at least one photo before publishing'), { status: 400 });
  listing.status = 'ACTIVE';
  listing.publishedAt = listing.publishedAt || new Date();
  listing.lastBumpedAt = new Date();
  // Free base radius unless a boost is currently active.
  if (!listing.boost?.active) listing.effectiveRadiusMeters = Math.round((setting.baseRadiusKm || 0) * 1000);
  listing.expiresAt = new Date(Date.now() + (setting.listingExpiryDays || 60) * 86400000);
});

export const pauseListing = transition('LISTING_PAUSE', (listing) => {
  if (listing.status !== 'ACTIVE') throw Object.assign(new Error('Only an active listing can be paused'), { status: 400 });
  listing.status = 'PAUSED';
});

export const activateListing = transition('LISTING_ACTIVATE', (listing, setting) => {
  if (listing.status !== 'PAUSED') throw Object.assign(new Error('Only a paused listing can be re-activated'), { status: 400 });
  if (!setting.listingsEnabled) throw Object.assign(new Error('The marketplace is currently disabled'), { status: 403 });
  listing.status = 'ACTIVE';
  listing.lastBumpedAt = new Date();
});

export const markSold = transition('LISTING_MARK_SOLD', (listing) => {
  listing.status = 'SOLD';
  listing.boost = { ...listing.boost, active: false, topPlacement: false } as any;
});

export const markRented = transition('LISTING_MARK_RENTED', (listing) => {
  listing.status = 'RENTED';
  listing.boost = { ...listing.boost, active: false, topPlacement: false } as any;
});

export const deleteListing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    const listing = await PropertyListing.findOne({ _id: req.params.id, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
    if (!canManage(req, listing)) { res.status(403).json({ error: 'You cannot delete this listing' }); return; }
    await listing.deleteOne();
    res.status(200).json({ message: 'Listing deleted' });
  } catch (error) {
    next(error);
  }
};

/**
 * Flat owner approves an admin-posted listing for their flat.
 * Changes verification.status from PENDING_OWNER → VERIFIED.
 * Only the flat's registered ownerUserId may approve.
 */
export const approveVerification = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId, societyId = req.user?.activeTenantId;
    if (!userId || !societyId) { res.status(401).json({ error: 'Auth required' }); return; }

    const listing = await PropertyListing.findOne({ _id: req.params.id, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
    if (listing.verification?.status !== 'PENDING_OWNER') {
      res.status(400).json({ error: 'This listing is not awaiting your approval' }); return;
    }
    if (!listing.flatId) { res.status(400).json({ error: 'Listing has no associated flat' }); return; }

    // Verify the caller is the registered owner of the flat
    const flat = await Flat.findOne({ _id: listing.flatId, societyId: new mongoose.Types.ObjectId(societyId) }).select('ownerUserId').lean();
    if (!flat || flat.ownerUserId?.toString() !== userId) {
      res.status(403).json({ error: 'Only the flat owner can approve this listing' }); return;
    }

    listing.verification = { status: 'VERIFIED', method: 'OWNER_APPROVED', verifiedAt: new Date(), verifiedBy: new mongoose.Types.ObjectId(userId) };
    listing.updatedBy = new mongoose.Types.ObjectId(userId);
    listing.updatedByName = req.user?.userName || 'owner';
    await listing.save();

    AuditService.log({
      userId, userName: req.user?.userName || '', tenantId: societyId, tenantType: TenantType.SOCIETY,
      action: 'LISTING_VERIFY_APPROVED', resource: 'PropertyListing', resourceId: listing._id.toString(),
      ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown', newValues: { verification: 'VERIFIED' },
    });

    res.status(200).json({ message: 'Listing approved and verified', listing });
  } catch (error) {
    next(error);
  }
};

/**
 * Flat owner rejects an admin-posted listing for their flat.
 * Returns the listing to DRAFT status (admin can edit and repost).
 */
export const rejectVerification = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId, societyId = req.user?.activeTenantId;
    if (!userId || !societyId) { res.status(401).json({ error: 'Auth required' }); return; }

    const listing = await PropertyListing.findOne({ _id: req.params.id, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
    if (listing.verification?.status !== 'PENDING_OWNER') {
      res.status(400).json({ error: 'This listing is not awaiting your approval' }); return;
    }
    if (!listing.flatId) { res.status(400).json({ error: 'Listing has no associated flat' }); return; }

    const flat = await Flat.findOne({ _id: listing.flatId, societyId: new mongoose.Types.ObjectId(societyId) }).select('ownerUserId').lean();
    if (!flat || flat.ownerUserId?.toString() !== userId) {
      res.status(403).json({ error: 'Only the flat owner can reject this listing' }); return;
    }

    // Return to DRAFT — admin can fix and resubmit
    listing.status = 'DRAFT';
    listing.verification = { status: 'UNVERIFIED', method: 'OWNER_REJECTED' } as any;
    listing.updatedBy = new mongoose.Types.ObjectId(userId);
    listing.updatedByName = req.user?.userName || 'owner';
    await listing.save();

    AuditService.log({
      userId, userName: req.user?.userName || '', tenantId: societyId, tenantType: TenantType.SOCIETY,
      action: 'LISTING_VERIFY_REJECTED', resource: 'PropertyListing', resourceId: listing._id.toString(),
      ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown', newValues: { verification: 'REJECTED' },
    });

    res.status(200).json({ message: 'Listing rejected and returned to draft', listing });
  } catch (error) {
    next(error);
  }
};
