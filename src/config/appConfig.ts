import dotenv from 'dotenv';
import path from 'path';

// Load environmental variables from .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

export const appConfig = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  appName: process.env.APP_NAME || 'ResiSmart',
  supportEmail: process.env.SUPPORT_EMAIL || 'support@resismart.com',
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/resismart',
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || 'fallback_jwt_access_secret_12345',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'fallback_jwt_refresh_secret_12345',
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  smtpHost: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  smtpPort: parseInt(process.env.SMTP_PORT || '2525', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPassword: process.env.SMTP_PASSWORD || '',
  smtpFromName: process.env.SMTP_FROM_NAME || 'SaaS Platform',
  smtpFromEmail: process.env.SMTP_FROM_EMAIL || 'support@resismart.com',
  smtpReplyTo: process.env.SMTP_REPLY_TO || 'support@resismart.com',
};
