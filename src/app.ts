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
import dashboardRoutes from './routes/dashboard.routes';
import webhookRoutes from './routes/webhook.routes';
import userRoutes from './routes/user.routes';
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
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// 3. Compress Response Payloads for Optimization
app.use(compression());

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
});

// 5. Razorpay webhook — MUST receive the raw body for signature verification,
//    so it is mounted before the JSON body parser.
app.use('/api/v1/webhooks', express.raw({ type: '*/*' }), webhookRoutes);

// 6. Body Parsers
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 7. Apply rate limiters
app.use('/api/v1/auth', authLimiter);
app.use('/api', generalLimiter);

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

// 10. JSON 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// 11. Global Error Handler Middleware
app.use(errorHandler);

export default app;
