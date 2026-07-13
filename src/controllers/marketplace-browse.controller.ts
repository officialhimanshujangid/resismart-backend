import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { PropertyListing } from '../models/property-listing.model';
import { Society } from '../models/society.model';
import { browseQuerySchema } from '../validators/marketplace.validator';
import { getAdSetting } from '../services/ad-setting.service';
import { lazyExpireBoosts } from '../services/listing-boost.service';

const CARD_PROJECTION = {
  title: 1, kind: 1, scope: 1, pricePaise: 1, priceType: 1, bedrooms: 1, sizeLabel: 1, furnishing: 1,
  city: 1, photos: 1, slug: 1, 'verification.status': 1, 'boost.active': 1, 'boost.topPlacement': 1,
  distance: 1, viewsCount: 1, societyId: 1, location: 1,
};

/**
 * Geo-radius browse. Because each listing carries its OWN visibility radius
 * (`effectiveRadiusMeters`), a single $near can't express it — we $geoNear from the
 * viewer (computing per-listing distance) then keep only listings whose distance is
 * within their own radius. Boosted (top-placement) listings sort first, then nearest.
 */
export const browseListings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = browseQuerySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }
    const q = parsed.data;

    // Viewer location: explicit lng/lat, else the active society's location.
    let coords: number[] | undefined = (q.lng !== undefined && q.lat !== undefined) ? [q.lng, q.lat] : undefined;
    if (!coords && req.user?.activeTenantId) {
      const soc = await Society.findById(req.user.activeTenantId).select('location').lean();
      if (soc?.location?.coordinates?.length === 2) coords = soc.location.coordinates;
    }
    if (!coords) { res.status(200).json({ listings: [], needsLocation: true, page: q.page, hasMore: false }); return; }

    await lazyExpireBoosts();
    const setting = await getAdSetting();
    const maxAllowedMeters = Math.round((setting.maxRadiusKm || 50) * 1000);
    const maxMeters = Math.min(maxAllowedMeters, Math.round(q.radiusKm * 1000));

    const match: Record<string, any> = { status: 'ACTIVE' };
    if (q.kind) match.kind = q.kind;
    if (q.bedrooms !== undefined) match.bedrooms = { $gte: q.bedrooms };
    if (q.min !== undefined || q.max !== undefined) {
      match.pricePaise = {};
      if (q.min !== undefined) match.pricePaise.$gte = q.min * 100;
      if (q.max !== undefined) match.pricePaise.$lte = q.max * 100;
    }

    const skip = (q.page - 1) * q.pageSize;
    const rows = await PropertyListing.aggregate([
      { $geoNear: { near: { type: 'Point', coordinates: coords as [number, number] }, distanceField: 'distance', maxDistance: maxMeters, spherical: true, query: match } },
      { $match: { $expr: { $lte: ['$distance', '$effectiveRadiusMeters'] } } },
      { $sort: { 'boost.topPlacement': -1, 'boost.startAt': -1, distance: 1, publishedAt: -1 } },
      { $skip: skip },
      { $limit: q.pageSize + 1 },
      { $project: CARD_PROJECTION },
    ]);

    const hasMore = rows.length > q.pageSize;
    const listings = rows.slice(0, q.pageSize).map((l) => ({ ...l, distanceKm: Math.round((l.distance / 1000) * 10) / 10 }));
    res.status(200).json({ listings, page: q.page, hasMore, viewer: coords });
  } catch (error) {
    next(error);
  }
};

/** Public-safe listing detail for an authenticated in-app viewer; bumps the view counter. */
export const browseListingDetail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) { res.status(404).json({ error: 'Listing not found' }); return; }
    const listing = await PropertyListing.findOneAndUpdate(
      { _id: req.params.id, status: 'ACTIVE' },
      { $inc: { viewsCount: 1 } },
      { new: true }
    ).populate('societyId', 'name city').lean();
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
    res.status(200).json({ listing });
  } catch (error) {
    next(error);
  }
};
