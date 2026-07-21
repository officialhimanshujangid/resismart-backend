import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/auth.routes';
import societyRoutes from './routes/society.routes';
import shopRoutes from './routes/shop.routes';
import rentalRoutes from './routes/rental.routes';
import auditRoutes from './routes/audit.routes';
import designationRoutes from './routes/designation.routes';
import systemEmployeeRoutes from './routes/system-employee.routes';
import permissionRoleRoutes from './routes/permission-role.routes';
import uploadRoutes from './routes/upload.routes';
import planRoutes from './routes/plan.routes';
import billingRoutes from './routes/billing.routes';
import settingsRoutes from './routes/settings.routes';
import webhookRoutes from './routes/webhook.routes';
import userRoutes from './routes/user.routes';
import flatSizeRoutes from './routes/flat-size.routes';
import dashboardRoutes from './routes/dashboard.routes';
import meRoutes from './routes/me.routes';
import marketplaceRoutes from './routes/marketplace.routes';
import publicMarketplaceRoutes from './routes/public-marketplace.routes';
import committeeRoutes from './routes/committee.routes';
import accessRoleRoutes from './routes/access-role.routes';
import visitorRoutes from './routes/visitor.routes';
import staffRoutes from './routes/staff.routes';
import complaintRoutes from './routes/complaint.routes';
import parkingRoutes from './routes/parking.routes';
import notificationRoutes from './routes/notification.routes';
import adminTransferRoutes from './routes/admin-transfer.routes';
import societyFinanceRoutes from './routes/society-finance.routes';
import residentFinanceRoutes from './routes/resident-finance.routes';
import { errorHandler } from './middlewares/error.middleware';
import { requestLogger } from './middlewares/logger.middleware';

const app = express();

// Behind a proxy/load balancer in production so express-rate-limit & req.ip work correctly
app.set('trust proxy', 1);

// 0. Request Logger Middleware
app.use(requestLogger);

// 1. Security Headers Configuration
app.use(helmet());

// 2. Cross-Origin Resource Sharing Setup
const allowedOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : '*'; // Fallback to allow all origins if not explicitly set

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// 3. Compress Response Payloads for Optimization
//
// Except the notification stream. Compression buffers, and a server-sent event
// stream that is buffered delivers nothing until the buffer happens to fill —
// which looks exactly like a feature that does not work, intermittently.
app.use(compression({
  filter: (req, res) => req.path.endsWith('/notifications/stream') ? false : compression.filter(req, res),
}));

// 4. Rate Limiting — general API limiter + stricter auth limiter
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again later.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // login/register/reset are sensitive
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again after 15 minutes.' },
  // OTP has its own limiter — don't let OTP traffic burn the login budget.
  skip: (req) => req.path.startsWith('/otp'),
});
// Dedicated limiter for OTP request/verify (in addition to per-target cooldown/cap in the service).
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts from this device. Please try again later.' },
});

// 5. Razorpay webhook — MUST receive the raw body for signature verification,
//    so it is mounted before the JSON body parser.
//
//    It also sits ABOVE the limiters below, so it needs its own — otherwise it
//    is the one unauthenticated surface in the product with no ceiling at all,
//    and every request costs a per-society secret lookup. Sized for a payment
//    provider's retry behaviour, not a human's.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many webhook deliveries.' },
});
app.use('/api/v1/webhooks', webhookLimiter, express.raw({ type: '*/*' }), webhookRoutes);

// 6. Body Parsers
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/**
 * Where visitor management is mounted.
 *
 * The module is `/api/v1/visitors`. `/api/v1/gate` is its former name and stays
 * mounted as an alias for one release: guard tablets hold a cached bundle that
 * still calls the old prefix. Both point at the same router instance, so there
 * is only ever one gate limiter and one module check.
 *
 * To retire the alias, delete the second entry — mount and rate-limiter
 * exemption both follow from this one list.
 */
export const VISITOR_MOUNTS = ['/api/v1/visitors', '/api/v1/gate'] as const;

/**
 * The same list as `req.path` sees it inside the `/api` middleware below.
 *
 * Derived rather than retyped, deliberately. The exemption used to be a literal
 * `'/v1/gate'` sitting two hundred lines away from the mount it had to agree
 * with; when they disagree the guard's tablet drops silently from its 2000/15min
 * device tier to the 300/15min human one and gets cut off mid-shift.
 */
const VISITOR_PATH_PREFIXES = VISITOR_MOUNTS.map((m) => m.replace(/^\/api/, ''));

export const isVisitorPath = (path: string) =>
  VISITOR_PATH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

// 7. Apply rate limiters (otp limiter first so it owns /auth/otp)
app.use('/api/v1/auth/otp', otpLimiter);
app.use('/api/v1/auth', authLimiter);
//
// The gate is exempt from the general limiter and carries its own inside
// `visitor.routes.ts`. It has to be: a busy gate logs an entry a minute and
// polls "who is inside" constantly, so 300-per-15-minutes cuts the guard off
// mid-shift — at which point they fall back to paper and the evening's record
// is lost. That gate limiter existed already and was DEAD, because this line
// ran first and refused the request before the router was ever reached.
//
// This predicate is keyed on literal path strings, so it has to be edited in
// step with the mount below — a mount that moves without it puts the guard's
// tablet back under the human tier. `verify-visitor-routes.ts` asserts on
// `isVisitorPath` directly for exactly that reason.
app.use('/api', (req, res, next) =>
  isVisitorPath(req.path) ? next() : generalLimiter(req, res, next));

// 8. Base route
app.get('/', (_req, res) => {
  res.json({ status: 'online', platform: process.env.APP_NAME || 'Resismart' });
});

// 9. Mount Modules
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/societies', societyRoutes);
app.use('/api/v1/shops', shopRoutes);
app.use('/api/v1/rentals', rentalRoutes);
app.use('/api/v1/audits', auditRoutes);
app.use('/api/v1/designations', designationRoutes);
app.use('/api/v1/system-employees', systemEmployeeRoutes);
app.use('/api/v1/permission-roles', permissionRoleRoutes);
app.use('/api/v1/upload', uploadRoutes);
app.use('/api/v1/plans', planRoutes);
app.use('/api/v1/billing', billingRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/flat-sizes', flatSizeRoutes);
app.use('/api/v1/me', meRoutes);
app.use('/api/v1/marketplace', marketplaceRoutes);
app.use('/api/v1/public/marketplace', publicMarketplaceRoutes);
app.use('/api/v1/committee', committeeRoutes);
app.use('/api/v1/access-roles', accessRoleRoutes);
// Visitor management, at its own name and its old one. See VISITOR_MOUNTS.
VISITOR_MOUNTS.forEach((mount) => app.use(mount, visitorRoutes));
app.use('/api/v1/staff', staffRoutes);
app.use('/api/v1/complaints', complaintRoutes);
app.use('/api/v1/parking', parkingRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/admin-transfer', adminTransferRoutes);
app.use('/api/v1/finance/society', societyFinanceRoutes);
app.use('/api/v1/finance/resident', residentFinanceRoutes);
// 10. JSON 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// 11. Global Error Handler Middleware
app.use(errorHandler);

export default app;
