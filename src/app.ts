import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/auth.routes';
import societyRoutes from './routes/society.routes';
import rentalRoutes from './routes/rental.routes';
import auditRoutes from './routes/audit.routes';
import { errorHandler } from './middlewares/error.middleware';
import { requestLogger } from './middlewares/logger.middleware';

const app = express();

// 0. Request Logger Middleware
app.use(requestLogger);

// 1. Security Headers Configuration
app.use(helmet());

// 2. Cross-Origin Resource Sharing Setup
app.use(cors({
  origin: ['http://localhost:4444', 'http://127.0.0.1:4444', 'http://localhost:3000', 'http://127.0.0.1:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// 3. Compress Response Payloads for Optimization
app.use(compression());

// 4. Rate Limiting Middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
});
app.use('/api', limiter);

// 5. Body Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 6. Base routes
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    platform: process.env.APP_NAME || 'ResiSmart',
  });
});

// 7. Mount Modules
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/societies', societyRoutes);
app.use('/api/v1/rentals', rentalRoutes);
app.use('/api/v1/audits', auditRoutes);

// 8. Global Error Handler Middleware
app.use(errorHandler);

export default app;
