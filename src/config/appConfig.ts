import dotenv from 'dotenv';
import path from 'path';

// Load environmental variables from .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

/**
 * Resolve a secret from the environment.
 * In production we refuse to fall back to a weak default — the process should
 * crash loudly rather than silently sign tokens with a guessable key.
 */
const requireSecret = (key: string, devFallback: string): string => {
  const value = process.env[key];
  if (value && value.trim().length > 0) return value;
  if (isProduction) {
    // Defer throwing until assertConfig() so a single message lists everything missing.
    return '';
  }
  // eslint-disable-next-line no-console
  console.warn(`[config] ${key} is not set — using an insecure development fallback. DO NOT use this in production.`);
  return devFallback;
};

export const appConfig = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,
  appName: process.env.APP_NAME || 'Resismart',
  supportEmail: process.env.SUPPORT_EMAIL || 'support@resismart.com',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:4444',
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/resismart',
  jwtAccessSecret: requireSecret('JWT_ACCESS_SECRET', 'dev_only_access_secret_do_not_use_in_prod'),
  // Dedicated key for finance secrets (society gateway keys, vendor bank). Kept
  // separate from the JWT secret so rotating auth secrets never loses finance data.
  financeEncryptionKey: process.env.FINANCE_ENCRYPTION_KEY || requireSecret('JWT_ACCESS_SECRET', 'dev_only_access_secret_do_not_use_in_prod') + '::finance',
  jwtRefreshSecret: requireSecret('JWT_REFRESH_SECRET', 'dev_only_refresh_secret_do_not_use_in_prod'),
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  smtpHost: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  smtpPort: parseInt(process.env.SMTP_PORT || '2525', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPassword: process.env.SMTP_PASSWORD || '',
  smtpFromName: process.env.SMTP_FROM_NAME || 'SaaS Platform',
  smtpFromEmail: process.env.SMTP_FROM_EMAIL || 'support@resismart.com',
  smtpReplyTo: process.env.SMTP_REPLY_TO || 'support@resismart.com',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  awsRegion: process.env.AWS_REGION || 'eu-north-1',
  awsS3Bucket: process.env.AWS_S3_BUCKET || 'amzn-himanshu-resismart',
  // OTP: no SMS gateway yet — in dev mode the PHONE code is returned in the API
  // response so the user can read it on screen. Defaults to on in dev, OFF in
  // production (never leak codes) unless OTP_DEV_MODE is explicitly set.
  otpDevMode: process.env.OTP_DEV_MODE ? process.env.OTP_DEV_MODE === 'true' : !isProduction,
  otpTtlSeconds: parseInt(process.env.OTP_TTL_SECONDS || '600', 10),        // code validity: 10 minutes
  otpVerifyTokenTtlSeconds: parseInt(process.env.OTP_VERIFY_TTL_SECONDS || '900', 10), // verified window: 15 minutes
  otpResendCooldownSeconds: parseInt(process.env.OTP_RESEND_COOLDOWN || '60', 10),      // min gap between sends
  otpDailyCap: parseInt(process.env.OTP_DAILY_CAP || '5', 10),               // max sends per target/24h
  // Razorpay (live integration)
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  razorpayBypassPennyDrop: process.env.RAZORPAY_BYPASS_PENNY_DROP === 'true',
};

/**
 * Validate critical configuration at boot. Called from server startup.
 * Throws (process exits) when required secrets are missing in production.
 */
export const assertConfig = (): void => {
  const missing: string[] = [];
  if (isProduction) {
    if (!process.env.JWT_ACCESS_SECRET) missing.push('JWT_ACCESS_SECRET');
    if (!process.env.JWT_REFRESH_SECRET) missing.push('JWT_REFRESH_SECRET');
  }
  if (missing.length > 0) {
    throw new Error(
      `Refusing to start: required environment variables are missing in production: ${missing.join(', ')}`
    );
  }
  if (isProduction && appConfig.otpDevMode) {
    // eslint-disable-next-line no-console
    console.warn('[config] OTP_DEV_MODE is ON in production — OTP codes will be exposed in API responses. Set OTP_DEV_MODE=false.');
  }
};

export const isRazorpayConfigured = (): boolean =>
  Boolean(appConfig.razorpayKeyId && appConfig.razorpayKeySecret);
