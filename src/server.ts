import app from './app';
import { appConfig, assertConfig, isRazorpayConfigured } from './config/appConfig';
import { connectDatabase } from './config/db';
import { logger } from './utils/logger.util';
import { startCronJobs } from './services/cron.service';
import { Otp } from './models/otp.model';
import { User } from './models/user.model';

const startServer = async () => {
  // Fail fast if critical secrets are missing (production)
  assertConfig();

  if (!isRazorpayConfigured()) {
    logger.warn('Razorpay keys are not configured — online checkout will be unavailable until RAZORPAY_KEY_ID/SECRET are set.');
  }

  // Connect to MongoDB
  await connectDatabase();

  // Reconcile OTP indexes — the model was generalized from phone-only to
  // channel+target, so drop the obsolete {phone,purpose} unique index that
  // would otherwise collide on channel-based docs.
  try {
    await Otp.syncIndexes();
    // User email became sparse-unique (was required+unique) to support phone-only
    // login identities — reconcile so null-email identities don't collide.
    await User.syncIndexes();
  } catch (err: any) {
    logger.warn(`[startup] syncIndexes failed: ${err.message}`);
  }

  // Register scheduled jobs (expiry reminders + auto-expire)
  startCronJobs();

  const PORT = appConfig.port;

  app.listen(PORT, () => {
    logger.info(`=========================================`);
    logger.info(` ${appConfig.appName} Server Started Successfully `);
    logger.info(` Port: ${PORT} | Environment: ${appConfig.nodeEnv}`);
    logger.info(`=========================================`);
  });
};

// Handle unhandled rejections and exceptions gracefully
process.on('unhandledRejection', (err: any) => {
  logger.error(`Unhandled Promise Rejection: ${err.message}`);
  if (err.stack) logger.debug(err.stack);
});

process.on('uncaughtException', (err: any) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  if (err.stack) logger.debug(err.stack);
  process.exit(1);
});

startServer();
