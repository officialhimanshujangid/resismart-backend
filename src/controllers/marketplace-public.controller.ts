import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { PropertyListing } from '../models/property-listing.model';
import { ListingLead } from '../models/listing-lead.model';
import { User } from '../models/user.model';
import { publicBrowseSchema, leadSchema } from '../validators/marketplace.validator';
import { assertVerified } from '../services/otp.service';
import { lazyExpireBoosts } from '../services/listing-boost.service';
import EmailService from '../services/email.service';
import { logger } from '../utils/logger.util';

// Public-safe fields — NEVER exposes contact.phone or the exact addressLine.
const PUBLIC_CARD = {
  title: 1, kind: 1, pricePaise: 1, priceType: 1, bedrooms: 1, sizeLabel: 1, furnishing: 1,
  city: 1, pincode: 1, photos: 1, slug: 1, 'verification.status': 1, 'boost.active': 1,
  'boost.topPlacement': 1, location: 1, viewsCount: 1, publishedAt: 1, societyId: 1,
};
const PUBLIC_DETAIL = { ...PUBLIC_CARD, description: 1, amenities: 1, 'contact.name': 1, 'contact.revealPhone': 1, leadsCount: 1 };

/** Public marketplace browse. Geo (lng/lat) OR text (city/pincode); else a recent boosted feed. */
export const browsePublic = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = publicBrowseSchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }
    const q = parsed.data;
    await lazyExpireBoosts();

    const match: Record<string, any> = { status: 'ACTIVE' };
    if (q.kind) match.kind = q.kind;
    if (q.bedrooms !== undefined) match.bedrooms = { $gte: q.bedrooms };
    if (q.city) match.city = { $regex: q.city, $options: 'i' };
    if (q.pincode) match.pincode = q.pincode;
    if (q.min !== undefined || q.max !== undefined) {
      match.pricePaise = {};
      if (q.min !== undefined) match.pricePaise.$gte = q.min * 100;
      if (q.max !== undefined) match.pricePaise.$lte = q.max * 100;
    }

    const skip = (q.page - 1) * q.pageSize;

    // Geo mode: honor each listing's own radius via $geoNear + distance match.
    if (q.lng !== undefined && q.lat !== undefined) {
      const rows = await PropertyListing.aggregate([
        { $geoNear: { near: { type: 'Point', coordinates: [q.lng, q.lat] as [number, number] }, distanceField: 'distance', maxDistance: 200000, spherical: true, query: match } },
        { $match: { $expr: { $lte: ['$distance', '$effectiveRadiusMeters'] } } },
        { $sort: { 'boost.topPlacement': -1, distance: 1, publishedAt: -1 } },
        { $skip: skip }, { $limit: q.pageSize + 1 }, { $project: { ...PUBLIC_CARD, distance: 1 } },
      ]);
      const hasMore = rows.length > q.pageSize;
      const listings = rows.slice(0, q.pageSize).map((l) => ({ ...l, distanceKm: Math.round((l.distance / 1000) * 10) / 10 }));
      res.status(200).json({ listings, page: q.page, hasMore });
      return;
    }

    // Text / feed mode.
    const [rows, total] = await Promise.all([
      PropertyListing.find(match).sort({ 'boost.topPlacement': -1, publishedAt: -1 }).skip(skip).limit(q.pageSize).select(PUBLIC_CARD).lean(),
      PropertyListing.countDocuments(match),
    ]);
    res.status(200).json({ listings: rows, page: q.page, hasMore: skip + rows.length < total, total });
  } catch (error) {
    next(error);
  }
};

/** Public listing detail by slug or id; bumps the view counter; hides phone/address. */
export const detailPublic = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const key = req.params.idOrSlug;
    const query = mongoose.Types.ObjectId.isValid(key) ? { _id: key } : { slug: key };
    const listing = await PropertyListing.findOneAndUpdate(
      { ...query, status: 'ACTIVE' }, { $inc: { viewsCount: 1 } }, { new: true }
    ).select(PUBLIC_DETAIL).populate('societyId', 'name city').lean();
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
    res.status(200).json({ listing });
  } catch (error) {
    next(error);
  }
};

/** Similar active listings — same kind, same city or nearby price. */
export const similarPublic = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) { res.status(200).json({ listings: [] }); return; }
    const base = await PropertyListing.findById(req.params.id).select('kind city pricePaise').lean();
    if (!base) { res.status(200).json({ listings: [] }); return; }
    const lo = Math.round(base.pricePaise * 0.7), hi = Math.round(base.pricePaise * 1.3);
    const listings = await PropertyListing.find({
      _id: { $ne: base._id }, status: 'ACTIVE', kind: base.kind,
      $or: [{ city: base.city }, { pricePaise: { $gte: lo, $lte: hi } }],
    }).sort({ 'boost.topPlacement': -1, publishedAt: -1 }).limit(6).select(PUBLIC_CARD).lean();
    res.status(200).json({ listings });
  } catch (error) {
    next(error);
  }
};

/** Submit an inquiry. Requires an OTP-verified phone; reveals the owner's contact on success. */
export const createLead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = leadSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }
    const { listingId, name, phone, message, otpToken } = parsed.data;

    const verified = await assertVerified(otpToken, 'PHONE', phone, 'GENERIC');
    if (!verified) { res.status(401).json({ error: 'Please verify your phone number to send an inquiry.' }); return; }

    const listing = await PropertyListing.findOne({ _id: listingId, status: 'ACTIVE' });
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }

    await ListingLead.create({
      listingId: listing._id, societyId: listing.societyId,
      from: { name, phone, phoneVerified: true }, message, source: 'PUBLIC',
    });
    await PropertyListing.updateOne({ _id: listing._id }, { $inc: { leadsCount: 1 } });

    // Notify the listing owner (best-effort).
    try {
      const owner = await User.findById(listing.createdByUserId).select('email name').lean();
      if (owner?.email) {
        EmailService.sendEmail({
          to: owner.email,
          subject: `New inquiry on "${listing.title}"`,
          html: `<p>${name} (${phone}) is interested in your listing <strong>${listing.title}</strong>.</p>${message ? `<p>Message: ${message}</p>` : ''}`,
        });
      }
    } catch (e: any) { logger.error(`lead email failed: ${e.message}`); }

    res.status(201).json({
      message: 'Inquiry sent',
      contact: { name: listing.contact?.name || 'Owner', phone: listing.contact?.phone || null },
    });
  } catch (error) {
    next(error);
  }
};
