import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Favorite } from '../models/favorite.model';
import { SavedSearch } from '../models/saved-search.model';
import { PropertyListing } from '../models/property-listing.model';
import { ListingLead } from '../models/listing-lead.model';
import { savedSearchSchema } from '../validators/marketplace.validator';
import { UserRole } from '../constants/roles';

const CARD = {
  title: 1, kind: 1, pricePaise: 1, priceType: 1, bedrooms: 1, sizeLabel: 1, furnishing: 1, amenities: 1,
  city: 1, photos: 1, slug: 1, status: 1, 'verification.status': 1, 'boost.topPlacement': 1,
};

// ── Favorites ──
export const toggleFavorite = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId || !mongoose.Types.ObjectId.isValid(req.params.listingId)) { res.status(400).json({ error: 'Invalid request' }); return; }
    const listingId = new mongoose.Types.ObjectId(req.params.listingId);
    const existing = await Favorite.findOne({ userId: new mongoose.Types.ObjectId(userId), listingId });
    if (existing) {
      await existing.deleteOne();
      await PropertyListing.updateOne({ _id: listingId, favoritesCount: { $gt: 0 } }, { $inc: { favoritesCount: -1 } });
      res.status(200).json({ favorited: false });
      return;
    }
    await Favorite.create({ userId: new mongoose.Types.ObjectId(userId), listingId });
    await PropertyListing.updateOne({ _id: listingId }, { $inc: { favoritesCount: 1 } });
    res.status(200).json({ favorited: true });
  } catch (error: any) {
    if (error.code === 11000) { res.status(200).json({ favorited: true }); return; }
    next(error);
  }
};

export const listFavorites = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Auth required' }); return; }
    const favs = await Favorite.find({ userId: new mongoose.Types.ObjectId(userId) }).sort({ createdAt: -1 })
      .populate({ path: 'listingId', select: CARD }).lean();
    const listings = favs.map((f) => f.listingId).filter(Boolean);
    res.status(200).json({ listings });
  } catch (error) {
    next(error);
  }
};

export const getFavoriteIds = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(200).json({ ids: [] }); return; }
    const favs = await Favorite.find({ userId: new mongoose.Types.ObjectId(userId) }).select('listingId').lean();
    res.status(200).json({ ids: favs.map((f) => String(f.listingId)) });
  } catch (error) {
    next(error);
  }
};

/** Side-by-side comparison of up to 4 listings by id. */
export const compareListings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter((s) => mongoose.Types.ObjectId.isValid(s)).slice(0, 4);
    if (!ids.length) { res.status(200).json({ listings: [] }); return; }
    const listings = await PropertyListing.find({ _id: { $in: ids } }).select(CARD).lean();
    res.status(200).json({ listings });
  } catch (error) {
    next(error);
  }
};

// ── Saved searches ──
export const createSavedSearch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Auth required' }); return; }
    const parsed = savedSearchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }
    const c = parsed.data.criteria;
    const saved = await SavedSearch.create({
      userId: new mongoose.Types.ObjectId(userId), name: parsed.data.name, alertsEnabled: parsed.data.alertsEnabled,
      criteria: {
        kind: c.kind, city: c.city, pincode: c.pincode, bedrooms: c.bedrooms,
        minPaise: c.min !== undefined ? c.min * 100 : undefined,
        maxPaise: c.max !== undefined ? c.max * 100 : undefined,
      },
    });
    res.status(201).json({ savedSearch: saved });
  } catch (error) {
    next(error);
  }
};

export const listSavedSearches = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Auth required' }); return; }
    const searches = await SavedSearch.find({ userId: new mongoose.Types.ObjectId(userId) }).sort({ createdAt: -1 }).lean();
    res.status(200).json({ searches });
  } catch (error) {
    next(error);
  }
};

export const updateSavedSearch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Auth required' }); return; }
    const saved = await SavedSearch.findOne({ _id: req.params.id, userId: new mongoose.Types.ObjectId(userId) });
    if (!saved) { res.status(404).json({ error: 'Saved search not found' }); return; }
    if (typeof req.body.alertsEnabled === 'boolean') saved.alertsEnabled = req.body.alertsEnabled;
    if (typeof req.body.name === 'string') saved.name = req.body.name.trim().slice(0, 80);
    await saved.save();
    res.status(200).json({ savedSearch: saved });
  } catch (error) {
    next(error);
  }
};

export const deleteSavedSearch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Auth required' }); return; }
    const r = await SavedSearch.deleteOne({ _id: req.params.id, userId: new mongoose.Types.ObjectId(userId) });
    if (!r.deletedCount) { res.status(404).json({ error: 'Saved search not found' }); return; }
    res.status(200).json({ message: 'Deleted' });
  } catch (error) {
    next(error);
  }
};

/**
 * Aggregated "who viewed my number" inbox for a listing author. Society admins/committee
 * see every lead in their society; a resident owner sees only leads on listings they created.
 * Paginated + searchable by enquirer name/phone.
 */
export const getMyLeads = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId, societyId = req.user?.activeTenantId, role = req.user?.activeRole;
    if (!userId || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }
    const isAdmin = role === UserRole.SOCIETY_ADMIN || role === UserRole.SOCIETY_COMMITTEE;

    // Scope the leads to the listings this user is allowed to see.
    const listingFilter: Record<string, any> = { societyId: new mongoose.Types.ObjectId(societyId) };
    if (!isAdmin) listingFilter.createdByUserId = new mongoose.Types.ObjectId(userId);
    const listingIds = await PropertyListing.find(listingFilter).select('_id').lean();
    const ids = listingIds.map((l) => l._id);

    const { page, pageSize, search } = req.query;
    const filter: Record<string, any> = { listingId: { $in: ids } };
    if (search && typeof search === 'string' && search.trim()) {
      const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ 'from.name': rx }, { 'from.phone': rx }];
    }

    const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '20'), 10)));
    const skip = (currentPage - 1) * limit;

    const [rows, total, last7d] = await Promise.all([
      ListingLead.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('listingId', 'title kind slug city pricePaise').lean(),
      ListingLead.countDocuments(filter),
      ListingLead.countDocuments({ ...filter, createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } }),
    ]);

    res.status(200).json({
      leads: rows,
      stats: { total, last7d, listings: ids.length },
      pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// ── Author lead inbox ──
export const getListingLeads = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId, societyId = req.user?.activeTenantId, role = req.user?.activeRole;
    if (!userId || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }
    const listing = await PropertyListing.findOne({ _id: req.params.id, societyId: new mongoose.Types.ObjectId(societyId) }).select('createdByUserId').lean();
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
    const isAdmin = role === UserRole.SOCIETY_ADMIN || role === UserRole.SOCIETY_COMMITTEE;
    if (!isAdmin && listing.createdByUserId?.toString() !== userId) { res.status(403).json({ error: 'You cannot view leads for this listing' }); return; }

    const leads = await ListingLead.find({ listingId: listing._id }).sort({ createdAt: -1 }).lean();
    res.status(200).json({ leads });
  } catch (error) {
    next(error);
  }
};
