import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  browsePublic, mapPins, detailPublic, similarPublic, comparePublic,
  createLead, reportListing, sitemapHandler, cityAutocomplete,
} from '../controllers/marketplace-public.controller';

const router = Router();

// Public, unauthenticated surface — dedicated rate limiters (in addition to the global one).
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many inquiries from this device. Please try again later.' },
});

router.get('/sitemap.xml', sitemapHandler);
router.get('/cities', readLimiter, cityAutocomplete);
router.get('/listings', readLimiter, browsePublic);
router.get('/listings/map', readLimiter, mapPins);
router.get('/listings/:id/similar', readLimiter, similarPublic);
router.get('/compare', readLimiter, comparePublic);
router.get('/listings/:idOrSlug', readLimiter, detailPublic);
router.post('/leads', leadLimiter, createLead);
router.post('/reports', leadLimiter, reportListing);

export default router;
