import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { PropertyListing } from '../models/property-listing.model';
import { ListingLead } from '../models/listing-lead.model';
import { ListingReport } from '../models/listing-report.model';
import { User } from '../models/user.model';
import { publicBrowseSchema, leadSchema, mapBboxSchema, reportSchema, citySuggestSchema } from '../validators/marketplace.validator';
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
  ...PUBLIC_CARD, description: 1, amenities: 1, addressLine: 1,
  'contact.name': 1, 'contact.phone': 1, 'contact.revealPhone': 1,
  leadsCount: 1, favoritesCount: 1, updatedAt: 1,
};

/**
 * Mask a phone for public display: keep the last 3 digits, replace the rest with a
 * consistent number of dots. `+91 98765 43210` → `••••••••210`. Returns null if there's
 * no usable number.
 */
const maskPhone = (phone?: string | null): string | null => {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return null;
  const last3 = digits.slice(-3);
  return '•'.repeat(Math.max(4, digits.length - 3)) + last3;
};

/**
 * Strip the raw owner phone from a public listing payload, replacing it with a masked
 * hint. The full number is only ever revealed after a visitor submits the contact form
 * (see `createLead`). MUST be applied to every endpoint that returns `PUBLIC_DETAIL`.
 */
const maskListingContact = (listing: any): any => {
  const rawPhone = listing?.contact?.phone as string | undefined;
  if (listing?.contact) {
    listing.contact.phoneMasked = maskPhone(rawPhone);
    listing.contact.hasPhone = !!rawPhone;
    delete listing.contact.phone;
  }
  return listing;
};

// ── Cursor (keyset pagination) helpers ────────────────────────────────────────

const encodeCursor = (page: number) => page.toString();

const decodeCursor = (cursor: string): number => {
  return parseInt(cursor, 10);
};

// ── Sort map for non-geo mode ─────────────────────────────────────────────────

const sortMap: Record<string, Record<string, 1 | -1>> = {
  price_asc:  { pricePaise: 1 },
  price_desc: { pricePaise: -1 },
  newest:     { publishedAt: -1 },
  relevance:  { 'boost.topPlacement': -1, 'boost.startAt': -1, publishedAt: -1 }, // default
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
            maxDistance: q.radiusKm * 1000,
            spherical: true,
            query: match,
          },
        },
        // The visitor's search radius (maxDistance above) is the single source of truth for
        // visibility — every ACTIVE listing inside the chosen radius shows, so widening the
        // slider always surfaces more results. A boost no longer *gates* visibility; it only
        // wins top placement via the sort below.
        { $sort: { 'boost.topPlacement': -1, 'boost.startAt': -1, distance: 1, publishedAt: -1 } },
        { $limit: q.pageSize + 1 },
        { $project: { ...PUBLIC_CARD, distance: 1 } },
      ]);
      const hasMore = rows.length > q.pageSize;
      const items = rows.slice(0, q.pageSize);
      const listings = items.map((l) => ({ ...l, distanceKm: Math.round((l.distance / 1000) * 10) / 10 }));
      const nextCursor = hasMore ? encodeCursor(q.page + 1) : null;
      res.status(200).json({ listings, hasMore, nextCursor });
      return;
    }

    // ── Text / feed mode ──
    const sort = sortMap[q.sort || 'relevance'];
    const page = q.cursor ? decodeCursor(q.cursor) : q.page;
    const skip = (page - 1) * q.pageSize;
    
    // First page — include total for initial render
    const promises: any[] = [
      PropertyListing.find(match).sort(sort).skip(skip).limit(q.pageSize + 1).select(PUBLIC_CARD).lean()
    ];
    if (page === 1) promises.push(PropertyListing.countDocuments(match));
    
    const [rows, total] = await Promise.all(promises);
    const hasMore = rows.length > q.pageSize;
    const items = rows.slice(0, q.pageSize);
    const nextCursor = hasMore ? encodeCursor(page + 1) : null;
    res.status(200).json({ listings: items, page, hasMore, nextCursor, total });
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

    // Never leak the raw owner number — expose only a masked hint (last 3 digits).
    // The full number is revealed only after the visitor submits the contact form.
    maskListingContact(listing);

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

/**
 * Fetch multiple listings by ID for comparison (up to 4).
 */
export const comparePublic = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter((s) => mongoose.Types.ObjectId.isValid(s)).slice(0, 4);
    if (!ids.length) { res.status(200).json({ listings: [] }); return; }
    const listings = await PropertyListing.find({ _id: { $in: ids } }).select(PUBLIC_DETAIL).lean();
    // Never leak raw owner numbers to anonymous callers — same masking as detailPublic.
    listings.forEach(maskListingContact);
    setPublicCache(res, 60, 300);
    res.status(200).json({ listings });
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
    }).sort({ 'boost.topPlacement': -1, 'boost.startAt': -1, publishedAt: -1 }).limit(6).select(PUBLIC_CARD).lean();
    setPublicCache(res, 120);
    res.status(200).json({ listings });
  } catch (error) {
    next(error);
  }
};

/**
 * Submit a "view number" / callback request. No sign-in or OTP required — the visitor
 * leaves a name + phone and the owner's full contact is revealed in return. Every
 * submission is stored as a lead, which becomes the owner's "who viewed my number" record.
 * Anti-spam: honeypot + route rate limiter + a soft per-phone cap that never blocks the
 * reveal (it just stops flooding the owner's inbox with duplicate rows).
 */
export const createLead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Honeypot — bots fill it; reject silently (return 201 so the trap stays hidden).
    if (req.body._hp) { res.status(201).json({ message: 'Request received' }); return; }

    const parsed = leadSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }
    const { listingId, name, phone, message } = parsed.data;

    const listing = await PropertyListing.findOne({ _id: listingId, status: 'ACTIVE' });
    if (!listing) { res.status(404).json({ error: 'This property is no longer available.' }); return; }

    // De-dupe: if this phone already requested this listing in the last 24h, reveal again
    // without creating a second row or re-notifying the owner (avoids inbox spam on re-taps).
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await ListingLead.findOne({
      listingId: listing._id, 'from.phone': phone, createdAt: { $gte: since },
    }).lean();

    if (!existing) {
      await ListingLead.create({
        listingId: listing._id, societyId: listing.societyId,
        from: { name, phone, phoneVerified: false }, message, source: 'PUBLIC',
        viewerIp: req.ip,
      });
      await PropertyListing.updateOne({ _id: listing._id }, { $inc: { leadsCount: 1 } });

      // Notify the listing owner that someone viewed their number (best-effort, non-blocking).
      try {
        const owner = await User.findById(listing.createdByUserId).select('email name').lean();
        if (owner?.email) {
          EmailService.sendLeadNotificationEmail(
            owner.email, owner.name, listing.title, name, phone, message
          );
        }
      } catch (e: any) { logger.error(`lead email failed: ${e.message}`); }
    }

    res.status(201).json({
      message: 'Contact revealed',
      contact: {
        name: listing.contact?.name || listing.createdByName || 'Owner',
        phone: listing.contact?.phone || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * City autocomplete for the public search bar. Returns distinct cities that currently have
 * active listings, prefix-matched, most-listings-first — so suggestions only ever point at
 * places the visitor can actually find results.
 */
export const cityAutocomplete = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = citySuggestSchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }
    const { q, limit } = parsed.data;

    const match: Record<string, any> = { status: 'ACTIVE', city: { $nin: [null, ''] } };
    if (q) match.city = { $regex: '^' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

    const rows = await PropertyListing.aggregate([
      { $match: match },
      { $group: { _id: { $toLower: '$city' }, city: { $first: '$city' }, count: { $sum: 1 } } },
      { $sort: { count: -1, city: 1 } },
      { $limit: limit },
      { $project: { _id: 0, city: 1, count: 1 } },
    ]);

    setPublicCache(res, 300, 600);
    res.status(200).json({ cities: rows });
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
