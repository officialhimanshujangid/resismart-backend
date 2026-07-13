import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ListingBoost } from '../models/listing-boost.model';
import { PropertyListing } from '../models/property-listing.model';
import { ListingReport } from '../models/listing-report.model';
import { ListingLead } from '../models/listing-lead.model';
import { Society } from '../models/society.model';
import { User } from '../models/user.model';
import { AuditService } from '../services/audit.service';
import EmailService from '../services/email.service';
import { TenantType } from '../constants/roles';

/** Statuses that represent realized boost revenue (paid, whether still running or ended). */
const PAID_STATUSES = ['ACTIVE', 'EXPIRED'];

/** SYSTEM_OWNER: marketplace revenue KPIs — total earned, active boosts, by-package, last 30 days. */
export const getRevenueStats = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const paidMatch = { status: { $in: PAID_STATUSES }, amountPaise: { $gt: 0 } };

    const [totals, activeBoosts, byPackage, last30] = await Promise.all([
      ListingBoost.aggregate([{ $match: paidMatch }, { $group: { _id: null, revenuePaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } }]),
      ListingBoost.countDocuments({ status: 'ACTIVE' }),
      ListingBoost.aggregate([{ $match: paidMatch }, { $group: { _id: '$packageSnapshot.label', revenuePaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } }, { $sort: { revenuePaise: -1 } }]),
      ListingBoost.aggregate([
        { $match: { ...paidMatch, createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, revenuePaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.status(200).json({
      stats: {
        revenuePaise: totals[0]?.revenuePaise || 0,
        boostsSold: totals[0]?.count || 0,
        activeBoosts,
        byPackage: byPackage.map((p) => ({ label: p._id || 'Unknown', revenuePaise: p.revenuePaise, count: p.count })),
        last30: last30.map((d) => ({ date: d._id, revenuePaise: d.revenuePaise, count: d.count })),
      },
    });
  } catch (error) {
    next(error);
  }
};

/** SYSTEM_OWNER: paginated boost ledger with listing + society names. */
export const getBoostLedger = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, status, societyId } = req.query;
    const filter: Record<string, any> = {};
    if (status && typeof status === 'string') filter.status = status;
    if (societyId && typeof societyId === 'string' && mongoose.Types.ObjectId.isValid(societyId)) filter.societyId = new mongoose.Types.ObjectId(societyId);

    const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '15'), 10)));
    const skip = (currentPage - 1) * limit;

    const [rows, total] = await Promise.all([
      ListingBoost.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('listingId', 'title kind').lean(),
      ListingBoost.countDocuments(filter),
    ]);
    const societyIds = [...new Set(rows.map((r) => String(r.societyId)))];
    const societies = await Society.find({ _id: { $in: societyIds } }).select('name').lean();
    const nameById = new Map(societies.map((s) => [String(s._id), s.name]));
    const boosts = rows.map((r) => ({ ...r, societyName: nameById.get(String(r.societyId)) || '—' }));

    res.status(200).json({ boosts, pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
};

/** SYSTEM_OWNER: paginated all-listings view for moderation. */
export const getAllListings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, status, search } = req.query;
    const filter: Record<string, any> = {};
    if (status && typeof status === 'string') filter.status = status;
    if (search && typeof search === 'string') filter.title = { $regex: search, $options: 'i' };

    const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '15'), 10)));
    const skip = (currentPage - 1) * limit;

    const [rows, total] = await Promise.all([
      PropertyListing.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .select('title kind status pricePaise priceType city verification boost createdByName viewsCount leadsCount societyId photos').lean(),
      PropertyListing.countDocuments(filter),
    ]);
    const societyIds = [...new Set(rows.map((r) => String(r.societyId)))];
    const societies = await Society.find({ _id: { $in: societyIds } }).select('name').lean();
    const nameById = new Map(societies.map((s) => [String(s._id), s.name]));
    const listings = rows.map((r) => ({ ...r, societyName: nameById.get(String(r.societyId)) || '—' }));

    res.status(200).json({ listings, pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
};

/** SYSTEM_OWNER: take a listing down (moderation). Emails the listing author. */
export const takedownListing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const listing = await PropertyListing.findById(req.params.id);
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
    listing.status = 'TAKEN_DOWN';
    listing.boost = { ...listing.boost, active: false, topPlacement: false } as any;
    await listing.save();

    AuditService.log({
      userId: req.user?.userId || 'system', userName: req.user?.userName || 'owner', tenantId: null, tenantType: TenantType.SYSTEM,
      action: 'LISTING_TAKEDOWN', resource: 'PropertyListing', resourceId: listing._id.toString(),
      ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown', newValues: { reason: req.body?.reason || null },
    });

    // Notify author best-effort
    try {
      const author = await User.findById(listing.createdByUserId).select('email name').lean();
      if (author?.email) {
        EmailService.sendListingTakenDownEmail(author.email, author.name, listing.title, req.body?.reason || 'Policy violation');
      }
    } catch (_) { /* non-fatal */ }

    res.status(200).json({ message: 'Listing taken down', listing });
  } catch (error) {
    next(error);
  }
};

/** SYSTEM_OWNER: paginated listing-report queue. */
export const getReports = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, status } = req.query;
    const filter: Record<string, any> = {};
    if (status && typeof status === 'string') filter.status = status;

    const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '20'), 10)));
    const skip = (currentPage - 1) * limit;

    const [rows, total] = await Promise.all([
      ListingReport.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('listingId', 'title kind status slug')
        .lean(),
      ListingReport.countDocuments(filter),
    ]);
    res.status(200).json({ reports: rows, pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
};

/** SYSTEM_OWNER: dismiss a listing report (mark as reviewed). */
export const dismissReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const report = await ListingReport.findById(req.params.id);
    if (!report) { res.status(404).json({ error: 'Report not found' }); return; }
    report.status = 'DISMISSED';
    report.reviewedBy = req.user?.userName || 'owner';
    report.reviewedAt = new Date();
    await report.save();
    res.status(200).json({ message: 'Report dismissed', report });
  } catch (error) {
    next(error);
  }
};

/**
 * SYSTEM_OWNER: platform-wide "ad admin" inbox of every contact-form submission
 * (people who requested a callback / viewed a number), across all societies. Paginated,
 * searchable by enquirer name/phone, filterable by source.
 */
export const getAllLeads = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, search, source } = req.query;
    const filter: Record<string, any> = {};
    if (source && (source === 'PUBLIC' || source === 'IN_APP')) filter.source = source;
    if (search && typeof search === 'string' && search.trim()) {
      const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ 'from.name': rx }, { 'from.phone': rx }];
    }

    const currentPage = Math.max(1, parseInt(String(page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(pageSize || '20'), 10)));
    const skip = (currentPage - 1) * limit;

    const [rows, total, todayCount] = await Promise.all([
      ListingLead.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('listingId', 'title kind slug city pricePaise contact')
        .populate('societyId', 'name city')
        .lean(),
      ListingLead.countDocuments(filter),
      ListingLead.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400000) } }),
    ]);

    res.status(200).json({
      leads: rows,
      stats: { total, last24h: todayCount },
      pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};
