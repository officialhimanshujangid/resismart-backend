import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { PropertyListing } from '../models/property-listing.model';
import { ListingLead } from '../models/listing-lead.model';
import { ListingReport } from '../models/listing-report.model';
import { User } from '../models/user.model';
import { publicBrowseSchema, leadSchema, mapBboxSchema, reportSchema } from '../validators/marketplace.validator';
import { assertVerified } from '../services/otp.service';
import { lazyExpireBoosts } from '../services/listing-boost.service';
import EmailService from '../services/email.service';
import { logger } from '../utils/logger.util';

// ── Cache-Control helpers ──────────────────────────────────────────────────────

const setPublicCache = (res: Response, maxAge: number, swr = 0) => {
  res.set('Cache-Control', `public, max-age=${maxAge}${swr ? `, stale-while-revalidate=${swr}` : ''}`);
};

const etag = (data: any) => `"${crypto.createHash('md5').update(JSON.stringify(data)).digest('hex').slice(0, 16)}"`;

// ── Public-safe field projections ──────────────────────────────────────────────

const PUBLIC_CARD = {
  title: 1, kind: 1, pricePaise: 1, priceType: 1, bedrooms: 1, sizeLabel: 1, furnishing: 1,
  city: 1, pincode: 1, photos: 1, slug: 1, 'verification.status': 1, 'boost.active': 1,
  'boost.topPlacement': 1, location: 1, viewsCount: 1, publishedAt: 1, societyId: 1, effectiveRadiusMeters: 1,
};
const PUBLIC_DETAIL = {
  ...PUBLIC_CARD, description: 1, amenities: 1,
  'contact.name': 1, 'contact.revealPhone': 1, leadsCount: 1, favoritesCount: 1, updatedAt: 1,
};

// ── Cursor (keyset pagination) helpers ────────────────────────────────────────

const encodeCursor = (doc: any) =>
  Buffer.from(JSON.stringify({ publishedAt: doc.publishedAt, _id: doc._id })).toString('base64url');

const decodeCursor = (cursor: string): { publishedAt: Date; _id: mongoose.Types.ObjectId } | null => {
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    return { publishedAt: new Date(obj.publishedAt), _id: new mongoose.Types.ObjectId(obj._id) };
  } catch { return null; }
};

// ── Sort map for non-geo mode ─────────────────────────────────────────────────

const sortMap: Record<string, Record<string, 1 | -1>> = {
  price_asc:  { pricePaise: 1 },
  price_desc: { pricePaise: -1 },
  newest:     { publishedAt: -1 },
  relevance:  { 'boost.topPlacement': -1, publishedAt: -1 }, // default
};

/**
 * Public marketplace browse.
 * - Geo (lng/lat): $geoNear → per-listing radius filter → sort by topPlacement + distance.
 * - Text/feed: cursor-keyset paginated, sort by boost priority + publishedAt.
 */
export const browsePublic = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = publicBrowseSchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }
    const q = parsed.data;
    await lazyExpireBoosts();

    const match: Record<string, any> = { status: 'ACTIVE' };
    if (q.kind)      match.kind = q.kind;
    if (q.furnishing) match.furnishing = q.furnishing;
    if (q.bedrooms !== undefined) match.bedrooms = { $gte: q.bedrooms };
    if (q.city)    match.city = { $regex: q.city, $options: 'i' };
    if (q.pincode) match.pincode = q.pincode;
    if (q.min !== undefined || q.max !== undefined) {
      match.pricePaise = {};
      if (q.min !== undefined) match.pricePaise.$gte = q.min * 100;
      if (q.max !== undefined) match.pricePaise.$lte = q.max * 100;
    }

    setPublicCache(res, 30, 120);

    // ── Geo mode ──
    if (q.lng !== undefined && q.lat !== undefined) {
      const rows = await PropertyListing.aggregate([
        {
          $geoNear: {
            near: { type: 'Point', coordinates: [q.lng, q.lat] as [number, number] },
            distanceField: 'distance',
            maxDistance: 200_000,
            spherical: true,
            query: match,
          },
        },
        { $match: { $expr: { $lte: ['$distance', '$effectiveRadiusMeters'] } } },
        { $sort: { 'boost.topPlacement': -1, distance: 1, publishedAt: -1 } },
        { $limit: q.pageSize + 1 },
        { $project: { ...PUBLIC_CARD, distance: 1 } },
      ]);
      const hasMore = rows.length > q.pageSize;
      const items = rows.slice(0, q.pageSize);
      const listings = items.map((l) => ({ ...l, distanceKm: Math.round((l.distance / 1000) * 10) / 10 }));
      const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;
      res.status(200).json({ listings, hasMore, nextCursor });
      return;
    }

    // ── Text / feed mode with cursor keyset pagination ──
    const sort = sortMap[q.sort || 'relevance'];
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (c) {
        // Keyset: continue after the last seen document (by publishedAt + _id)
        match.$or = [
          { publishedAt: { $lt: c.publishedAt } },
          { publishedAt: c.publishedAt, _id: { $lt: c._id } },
        ];
        // Override sort to: topPlacement desc, publishedAt desc, _id desc (stable)
        const rows = await PropertyListing.find(match)
          .sort({ 'boost.topPlacement': -1, publishedAt: -1, _id: -1 })
          .limit(q.pageSize + 1)
          .select(PUBLIC_CARD)
          .lean();
        const hasMore = rows.length > q.pageSize;
        const items = rows.slice(0, q.pageSize);
        const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;
        res.status(200).json({ listings: items, hasMore, nextCursor });
        return;
      }
    }

    // First page (no cursor) — include total for initial render
    const skip = (q.page - 1) * q.pageSize;
    const [rows, total] = await Promise.all([
      PropertyListing.find(match).sort(sort).skip(skip).limit(q.pageSize + 1).select(PUBLIC_CARD).lean(),
      PropertyListing.countDocuments(match),
    ]);
    const hasMore = rows.length > q.pageSize;
    const items = rows.slice(0, q.pageSize);
    const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;
    res.status(200).json({ listings: items, page: q.page, hasMore, nextCursor, total });
  } catch (error) {
    next(error);
  }
};

/**
 * Lightweight map-pins fetch for the current viewport bbox.
 * Returns only _id, slug, location, boost.topPlacement — no PII.
 */
export const mapPins = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = mapBboxSchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }

    const [minLng, minLat, maxLng, maxLat] = parsed.data.bbox.split(',').map(Number);
    const pins = await PropertyListing.find({
      status: 'ACTIVE',
      location: {
        $geoWithin: {
          $box: [[minLng, minLat], [maxLng, maxLat]],
        },
      },
    })
      .limit(500)
      .select({ _id: 1, slug: 1, location: 1, 'boost.topPlacement': 1, title: 1, pricePaise: 1, kind: 1 })
      .lean();

    setPublicCache(res, 60, 300);
    res.status(200).json({ pins });
  } catch (error) {
    next(error);
  }
};

/** Public listing detail by slug or id; bumps the view counter (fire-and-forget); ETag. */
export const detailPublic = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const key = req.params.idOrSlug;
    const query = mongoose.Types.ObjectId.isValid(key) ? { _id: key } : { slug: key };
    const listing = await PropertyListing.findOne({ ...query, status: 'ACTIVE' })
      .select(PUBLIC_DETAIL)
      .populate('societyId', 'name city')
      .lean();
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }

    // Bump view counter fire-and-forget (non-blocking)
    PropertyListing.updateOne({ _id: listing._id }, { $inc: { viewsCount: 1 } }).catch(() => null);

    // ETag from updatedAt + viewsCount so browsers revalidate only when content changes.
    const tag = etag({ u: listing.updatedAt, v: listing.viewsCount });
    if (req.headers['if-none-match'] === tag) { res.status(304).end(); return; }
    res.set('ETag', tag);
    setPublicCache(res, 60, 300);
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
    setPublicCache(res, 120);
    res.status(200).json({ listings });
  } catch (error) {
    next(error);
  }
};

/**
 * Submit an inquiry. Requires an OTP-verified phone; reveals the owner's contact on success.
 * Anti-spam: honeypot field + per-phone lead cap (5 leads / 24 hr).
 */
export const createLead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Honeypot — bots fill it, reject silently (return 201 to not reveal the trap)
    if (req.body._hp) { res.status(201).json({ message: 'Inquiry sent' }); return; }

    const parsed = leadSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }
    const { listingId, name, phone, message, otpToken } = parsed.data;

    const verified = await assertVerified(otpToken, 'PHONE', phone, 'GENERIC');
    if (!verified) { res.status(401).json({ error: 'Please verify your phone number to send an inquiry.' }); return; }

    // Per-phone lead cap: max 5 leads per 24 hours
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await ListingLead.countDocuments({ 'from.phone': phone, createdAt: { $gte: since } });
    if (recentCount >= 5) {
      res.status(429).json({ error: 'Too many inquiries from this number. Please try again tomorrow.' });
      return;
    }

    const listing = await PropertyListing.findOne({ _id: listingId, status: 'ACTIVE' });
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }

    await ListingLead.create({
      listingId: listing._id, societyId: listing.societyId,
      from: { name, phone, phoneVerified: true }, message, source: 'PUBLIC',
    });
    await PropertyListing.updateOne({ _id: listing._id }, { $inc: { leadsCount: 1 } });

    // Notify the listing owner (best-effort, non-blocking)
    try {
      const owner = await User.findById(listing.createdByUserId).select('email name').lean();
      if (owner?.email) {
        EmailService.sendLeadNotificationEmail(
          owner.email, owner.name, listing.title, name, phone, message
        );
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

/** Report a listing for abuse. Honeypot-protected, no auth required. */
export const reportListing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Honeypot
    if (req.body._hp) { res.status(201).json({ message: 'Report submitted' }); return; }

    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }
    const { listingId, reason, details } = parsed.data;

    const listing = await PropertyListing.findById(listingId).select('societyId').lean();
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }

    await ListingReport.create({
      listingId, societyId: listing.societyId, reason, details,
      ip: req.ip, source: 'PUBLIC',
    });

    res.status(201).json({ message: 'Report submitted. Thank you for helping keep listings trustworthy.' });
  } catch (error) {
    next(error);
  }
};

/** SEO sitemap — XML list of all active listing slugs. */
export const sitemapHandler = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const listings = await PropertyListing.find({ status: 'ACTIVE' })
      .select({ slug: 1, updatedAt: 1 })
      .sort({ publishedAt: -1 })
      .limit(10_000)
      .lean();

    const baseUrl = process.env.PUBLIC_SITE_URL || 'https://resismart.in';
    const urls = listings
      .map(
        (l) =>
          `  <url>\n    <loc>${baseUrl}/marketplace/${l.slug}</loc>\n    <lastmod>${l.updatedAt.toISOString().split('T')[0]}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`
      )
      .join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;

    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.status(200).send(xml);
  } catch (error) {
    next(error);
  }
};
