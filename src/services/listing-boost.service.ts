import mongoose from 'mongoose';
import { ListingBoost, IListingBoost } from '../models/listing-boost.model';
import { PropertyListing } from '../models/property-listing.model';
import { Invoice } from '../models/invoice.model';
import { getAdSetting } from './ad-setting.service';
import { logger } from '../utils/logger.util';

/**
 * Applies a boost to its listing: widens the effective radius, pins to top, and sets
 * the active window. Buying while a boost is still running STACKS (extends from the
 * current endAt). Idempotent — a second call for an already-active boost is a no-op.
 */
export const applyBoostToListing = async (boost: IListingBoost, paymentId?: string): Promise<void> => {
  if (boost.status === 'ACTIVE' && boost.endAt && boost.endAt > new Date()) return;

  const listing = await PropertyListing.findById(boost.listingId);
  if (!listing) throw new Error('Listing not found while applying boost');

  const now = new Date();
  const snap = boost.packageSnapshot;
  // Stack from the current active endAt if this listing already has a running boost.
  const base = listing.boost?.active && listing.boost?.endAt && listing.boost.endAt > now ? new Date(listing.boost.endAt) : now;
  const endAt = new Date(base.getTime() + snap.durationDays * 86400000);

  boost.status = 'ACTIVE';
  boost.startAt = boost.startAt || now;
  boost.endAt = endAt;
  if (paymentId) boost.razorpayPaymentId = paymentId;
  await boost.save();

  listing.boost = {
    active: true,
    listingBoostId: boost._id as mongoose.Types.ObjectId,
    packageLabel: snap.label,
    radiusKm: snap.radiusKm,
    topPlacement: snap.topPlacement,
    startAt: now,
    endAt,
  } as any;
  listing.effectiveRadiusMeters = Math.round(snap.radiusKm * 1000);
  await listing.save();

  if (boost.invoiceId) {
    await Invoice.updateOne({ _id: boost.invoiceId, status: { $ne: 'PAID' } }, { $set: { status: 'PAID', paidAt: now, razorpayPaymentId: paymentId } });
  }
  logger.info(`Boost ${boost._id} activated for listing ${listing._id} until ${endAt.toISOString()}`);
};

/** Activate a boost from a paid Razorpay ORDER (client verify or webhook). Idempotent. */
export const activateBoostByOrder = async (orderId: string, paymentId?: string): Promise<IListingBoost | null> => {
  if (paymentId) {
    const dup = await ListingBoost.findOne({ razorpayPaymentId: paymentId });
    if (dup) return dup; // already processed
  }
  const boost = await ListingBoost.findOne({ razorpayOrderId: orderId });
  if (!boost) return null;
  if (boost.status === 'ACTIVE') return boost;
  await applyBoostToListing(boost, paymentId);
  return boost;
};

/**
 * Expire boosts whose window has ended: mark EXPIRED and reset their listing to the
 * free base radius (only if that boost is still the one on the listing). Returns count.
 */
export const expireDueBoosts = async (): Promise<number> => {
  const now = new Date();
  const due = await ListingBoost.find({ status: 'ACTIVE', endAt: { $lt: now } });
  if (!due.length) return 0;

  const setting = await getAdSetting();
  const baseMeters = Math.round((setting.baseRadiusKm || 0) * 1000);

  for (const boost of due) {
    boost.status = 'EXPIRED';
    await boost.save();
    await PropertyListing.updateOne(
      { _id: boost.listingId, 'boost.listingBoostId': boost._id },
      { $set: { 'boost.active': false, 'boost.topPlacement': false, effectiveRadiusMeters: baseMeters } }
    );
  }
  logger.info(`[boosts] Expired ${due.length} boost(s)`);
  return due.length;
};

// Throttle the lazy expiry sweep so a hot browse endpoint doesn't hammer it.
let lastSweep = 0;
export const lazyExpireBoosts = async (): Promise<void> => {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  try { await expireDueBoosts(); } catch (e: any) { logger.error(`lazyExpireBoosts failed: ${e.message}`); }
};
