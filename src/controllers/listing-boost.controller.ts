import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { PropertyListing } from '../models/property-listing.model';
import { ListingBoost } from '../models/listing-boost.model';
import { Invoice } from '../models/invoice.model';
import { boostCheckoutSchema, boostVerifySchema } from '../validators/marketplace.validator';
import { getAdSetting } from '../services/ad-setting.service';
import { applyBoostToListing } from '../services/listing-boost.service';
import { RazorpayService } from '../services/razorpay.service';
import { AuditService } from '../services/audit.service';
import { appConfig, isRazorpayConfigured } from '../config/appConfig';
import { TenantType, UserRole } from '../constants/roles';

const isAdmin = (role?: UserRole) => role === UserRole.SOCIETY_ADMIN || role === UserRole.SOCIETY_COMMITTEE;
const canManage = (req: Request, listing: any) => isAdmin(req.user?.activeRole) || listing.createdByUserId?.toString() === req.user?.userId;

/** The active boost packages an advertiser can buy (safe subset of AdSetting). */
export const getBoostPackages = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const setting = await getAdSetting();
    const packages = setting.listingsEnabled
      ? setting.boostPackages.filter((p: any) => p.isActive).map((p: any) => ({
          _id: p._id, label: p.label, pricePaise: p.pricePaise, durationDays: p.durationDays, radiusKm: p.radiusKm, topPlacement: p.topPlacement,
        }))
      : [];
    res.status(200).json({ packages, currency: setting.currency || 'INR', listingsEnabled: setting.listingsEnabled });
  } catch (error) {
    next(error);
  }
};

/** Start a boost purchase: snapshot the package, create the ledger row + Razorpay order. */
export const checkoutBoost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = boostCheckoutSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }
    const userId = req.user?.userId, userName = req.user?.userName, societyId = req.user?.activeTenantId;
    if (!userId || !userName || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

    const listing = await PropertyListing.findOne({ _id: req.params.id, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
    if (!canManage(req, listing)) { res.status(403).json({ error: 'You cannot boost this listing' }); return; }
    if (listing.status !== 'ACTIVE') { res.status(400).json({ error: 'Only an active (published) listing can be boosted' }); return; }

    const setting = await getAdSetting();
    if (!setting.listingsEnabled) { res.status(403).json({ error: 'The marketplace is currently disabled' }); return; }
    const pkg = setting.boostPackages.find((p: any) => p._id.toString() === parsed.data.packageId && p.isActive);
    if (!pkg) { res.status(404).json({ error: 'Boost package not found' }); return; }

    const snapshot = { label: pkg.label, pricePaise: pkg.pricePaise, durationDays: pkg.durationDays, radiusKm: pkg.radiusKm, topPlacement: pkg.topPlacement };

    // Free package → apply immediately, no payment.
    if (pkg.pricePaise <= 0) {
      const boost = await ListingBoost.create({
        listingId: listing._id, societyId: new mongoose.Types.ObjectId(societyId), packageId: parsed.data.packageId,
        packageSnapshot: snapshot, amountPaise: 0, status: 'PENDING',
        purchasedByUserId: new mongoose.Types.ObjectId(userId), purchasedByName: userName,
      });
      await applyBoostToListing(boost);
      res.status(200).json({ free: true, message: 'Boost applied', boostId: boost._id });
      return;
    }

    if (!isRazorpayConfigured()) { res.status(503).json({ error: 'Online payments are not available right now.' }); return; }

    const invoice = await Invoice.create({
      tenantId: new mongoose.Types.ObjectId(societyId), tenantType: 'SOCIETY',
      invoiceType: 'AD_BOOST', amount: pkg.pricePaise, currency: setting.currency || 'INR', status: 'PENDING',
      recordedById: new mongoose.Types.ObjectId(userId), recordedByName: userName,
    });
    const boost = await ListingBoost.create({
      listingId: listing._id, societyId: new mongoose.Types.ObjectId(societyId), packageId: parsed.data.packageId,
      packageSnapshot: snapshot, amountPaise: pkg.pricePaise, currency: setting.currency || 'INR', status: 'PENDING',
      invoiceId: invoice._id, purchasedByUserId: new mongoose.Types.ObjectId(userId), purchasedByName: userName,
    });

    const order = await RazorpayService.createOrder(pkg.pricePaise, boost._id.toString());
    boost.razorpayOrderId = order.id;
    await boost.save();
    invoice.razorpayOrderId = order.id;
    await invoice.save();

    res.status(200).json({
      keyId: appConfig.razorpayKeyId, orderId: order.id, amountPaise: pkg.pricePaise,
      currency: setting.currency || 'INR', boostId: boost._id, packageLabel: pkg.label,
    });
  } catch (error: any) {
    next(error);
  }
};

/** Confirm a boost order from Razorpay Checkout: verify signature, then activate. Idempotent. */
export const verifyBoost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = boostVerifySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0].message }); return; }
    const { boostId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = parsed.data;
    const userId = req.user?.userId, userName = req.user?.userName, societyId = req.user?.activeTenantId;
    if (!userId || !societyId) { res.status(401).json({ error: 'Missing tenant or user details' }); return; }

    const boost = await ListingBoost.findOne({ _id: boostId, societyId: new mongoose.Types.ObjectId(societyId) });
    if (!boost) { res.status(404).json({ error: 'Boost not found' }); return; }
    if (boost.razorpayOrderId !== razorpay_order_id) { res.status(400).json({ error: 'Order mismatch' }); return; }

    if (boost.status !== 'ACTIVE') {
      const valid = RazorpayService.verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
      if (!valid) {
        boost.status = 'FAILED';
        await boost.save();
        res.status(400).json({ error: 'Payment signature verification failed' });
        return;
      }
      await applyBoostToListing(boost, razorpay_payment_id);
      AuditService.log({
        userId, userName: userName || 'user', tenantId: societyId, tenantType: TenantType.SOCIETY,
        action: 'AD_BOOST_ACTIVATE', resource: 'ListingBoost', resourceId: boost._id.toString(),
        ipAddress: req.ip || 'unknown', userAgent: req.headers['user-agent'] || 'unknown',
        newValues: { amountPaise: boost.amountPaise, endAt: boost.endAt, listingId: boost.listingId },
      });
    }

    res.status(200).json({ message: 'Boost active', boostId: boost._id, status: boost.status, endAt: boost.endAt });
  } catch (error: any) {
    next(error);
  }
};

/** Poll a boost's status (client fallback if the verify call was interrupted). */
export const getBoostStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const societyId = req.user?.activeTenantId;
    if (!societyId) { res.status(401).json({ error: 'Missing tenant details' }); return; }
    const boost = await ListingBoost.findOne({ _id: req.params.id, societyId: new mongoose.Types.ObjectId(societyId) }).select('status endAt amountPaise packageSnapshot').lean();
    if (!boost) { res.status(404).json({ error: 'Boost not found' }); return; }
    res.status(200).json({ boost });
  } catch (error) {
    next(error);
  }
};
