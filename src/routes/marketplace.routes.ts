import { Router } from 'express';
import { AdSettingController } from '../controllers/ad-setting.controller';
import {
  createListing, getMyListings, getListingById, updateListing, deleteListing,
  publishListing, pauseListing, activateListing, markSold, markRented, countActiveListings,
} from '../controllers/property-listing.controller';
import { checkoutBoost, verifyBoost, getBoostStatus, getBoostPackages } from '../controllers/listing-boost.controller';
import { browseListings, browseListingDetail } from '../controllers/marketplace-browse.controller';
import { getRevenueStats, getBoostLedger, getAllListings, takedownListing } from '../controllers/marketplace-owner.controller';
import {
  toggleFavorite, listFavorites, getFavoriteIds, compareListings,
  createSavedSearch, listSavedSearches, updateSavedSearch, deleteSavedSearch, getListingLeads,
} from '../controllers/marketplace-engage.controller';
import { authenticateJWT, authorizeRoles, enforceTenantAccess } from '../middlewares/auth.middleware';
import { enforceLimit } from '../middlewares/subscription.guard';
import { UserRole } from '../constants/roles';

const router = Router();

const AUTHOR_ROLES = [UserRole.SOCIETY_ADMIN, UserRole.SOCIETY_COMMITTEE, UserRole.RESIDENT_OWNER];

/**
 * Marketplace module routes. Owner-only configuration lives under /ad-settings; listing,
 * browse, boost and public routes are added in later phases.
 */

// ── SYSTEM_OWNER: marketplace configuration (radius caps, boost packages, master switch) ──
router.get(
  '/ad-settings',
  authenticateJWT,
  authorizeRoles([UserRole.SYSTEM_OWNER, UserRole.SYSTEM_EMPLOYEE]),
  AdSettingController.get
);
router.put(
  '/ad-settings',
  authenticateJWT,
  authorizeRoles([UserRole.SYSTEM_OWNER, UserRole.SYSTEM_EMPLOYEE]),
  AdSettingController.update
);

// ── Listings (in-app authoring by flat owners & society admins) ──
router.get('/listings/mine', authenticateJWT, enforceTenantAccess, getMyListings);
router.post(
  '/listings',
  authenticateJWT,
  enforceTenantAccess,
  authorizeRoles(AUTHOR_ROLES),
  enforceLimit('max_active_listings', countActiveListings),
  createListing
);
router.get('/listings/:id', authenticateJWT, enforceTenantAccess, getListingById);
router.patch('/listings/:id', authenticateJWT, enforceTenantAccess, authorizeRoles(AUTHOR_ROLES), updateListing);
router.delete('/listings/:id', authenticateJWT, enforceTenantAccess, authorizeRoles(AUTHOR_ROLES), deleteListing);
router.post('/listings/:id/publish', authenticateJWT, enforceTenantAccess, authorizeRoles(AUTHOR_ROLES), publishListing);
router.post('/listings/:id/pause', authenticateJWT, enforceTenantAccess, authorizeRoles(AUTHOR_ROLES), pauseListing);
router.post('/listings/:id/activate', authenticateJWT, enforceTenantAccess, authorizeRoles(AUTHOR_ROLES), activateListing);
router.post('/listings/:id/mark-sold', authenticateJWT, enforceTenantAccess, authorizeRoles(AUTHOR_ROLES), markSold);
router.post('/listings/:id/mark-rented', authenticateJWT, enforceTenantAccess, authorizeRoles(AUTHOR_ROLES), markRented);

// ── Boost purchase (Razorpay one-time order) ──
router.get('/boost-packages', authenticateJWT, enforceTenantAccess, getBoostPackages);
router.post('/listings/:id/boost/checkout', authenticateJWT, enforceTenantAccess, authorizeRoles(AUTHOR_ROLES), checkoutBoost);
router.post('/boost/verify', authenticateJWT, enforceTenantAccess, authorizeRoles(AUTHOR_ROLES), verifyBoost);
router.get('/boost/:id/status', authenticateJWT, enforceTenantAccess, getBoostStatus);

// ── In-app geo-radius browse ──
router.get('/browse', authenticateJWT, enforceTenantAccess, browseListings);
router.get('/browse/:id', authenticateJWT, enforceTenantAccess, browseListingDetail);

// ── Engagement: favorites, compare, saved searches, lead inbox ──
router.get('/favorites/ids', authenticateJWT, getFavoriteIds);
router.get('/favorites', authenticateJWT, listFavorites);
router.post('/favorites/:listingId', authenticateJWT, toggleFavorite);
router.get('/compare', authenticateJWT, compareListings);
router.get('/saved-searches', authenticateJWT, listSavedSearches);
router.post('/saved-searches', authenticateJWT, createSavedSearch);
router.patch('/saved-searches/:id', authenticateJWT, updateSavedSearch);
router.delete('/saved-searches/:id', authenticateJWT, deleteSavedSearch);
router.get('/listings/:id/leads', authenticateJWT, enforceTenantAccess, authorizeRoles(AUTHOR_ROLES), getListingLeads);

// ── SYSTEM_OWNER: revenue + moderation ──
const OWNER = [UserRole.SYSTEM_OWNER, UserRole.SYSTEM_EMPLOYEE];
router.get('/owner/revenue/stats', authenticateJWT, authorizeRoles(OWNER), getRevenueStats);
router.get('/owner/revenue/boosts', authenticateJWT, authorizeRoles(OWNER), getBoostLedger);
router.get('/owner/listings', authenticateJWT, authorizeRoles(OWNER), getAllListings);
router.post('/owner/listings/:id/takedown', authenticateJWT, authorizeRoles(OWNER), takedownListing);

export default router;
