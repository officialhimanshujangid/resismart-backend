/**
 * Dual-channel OTP service (PHONE + EMAIL).
 *
 * - PHONE: no SMS gateway yet — the code is returned to the caller only in dev
 *   mode (shown on the UI). Never returned in production.
 * - EMAIL: delivered to the real inbox via EmailService; the code is NEVER
 *   returned in the API response, on any environment.
 *
 * Abuse controls: per-target resend cooldown + rolling 24h send cap, plus a
 * wrong-attempt cap on verify. On success we mint a short-lived signed token
 * bound to {channel,target,purpose}; registration endpoints assert that token
 * AND that the verified record still exists, then consume it (one-time use).
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Otp, OtpChannel, OtpPurpose } from '../models/otp.model';
import { appConfig } from '../config/appConfig';
import { logger } from '../utils/logger.util';
import { normalizePhone, isEmail } from '../utils/phone.util';
import EmailService from './email.service';

const MAX_ATTEMPTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const hashCode = (code: string): string => crypto.createHash('sha256').update(code).digest('hex');

/** Normalize a target for storage/lookup consistency. */
export const normalizeTarget = (channel: OtpChannel, raw: string): string =>
  channel === 'EMAIL' ? raw.trim().toLowerCase() : normalizePhone(raw);

export class OtpRateError extends Error {
  constructor(message: string) { super(message); this.name = 'OtpRateError'; }
}
export class OtpInputError extends Error {
  constructor(message: string) { super(message); this.name = 'OtpInputError'; }
}

interface VerifyTokenPayload {
  typ: 'otp_verify';
  channel: OtpChannel;
  target: string;
  purpose: OtpPurpose;
}

export interface RequestResult {
  expiresInSec: number;
  /** Present only for PHONE in dev mode — shown on the UI as a stand-in for SMS. */
  devCode?: string;
}

/** Create/replace an OTP for a channel+target+purpose and deliver it. */
export const requestOtp = async (
  channel: OtpChannel,
  rawTarget: string,
  purpose: OtpPurpose
): Promise<RequestResult> => {
  const target = normalizeTarget(channel, rawTarget);
  if (!target || (channel === 'EMAIL' && !isEmail(target))) {
    throw new OtpInputError(channel === 'EMAIL' ? 'A valid email address is required' : 'A valid phone number is required');
  }

  const now = Date.now();
  const existing = await Otp.findOne({ channel, target, purpose });

  // Rolling 24h send window.
  let windowStart = existing?.windowStart ? existing.windowStart.getTime() : now;
  let sendCount = existing?.sendCount || 0;
  if (now - windowStart > DAY_MS) { windowStart = now; sendCount = 0; }

  if (existing?.lastSentAt && now - existing.lastSentAt.getTime() < appConfig.otpResendCooldownSeconds * 1000) {
    const wait = Math.ceil((appConfig.otpResendCooldownSeconds * 1000 - (now - existing.lastSentAt.getTime())) / 1000);
    throw new OtpRateError(`Please wait ${wait}s before requesting another code.`);
  }
  if (sendCount >= appConfig.otpDailyCap) {
    throw new OtpRateError('Too many codes requested for this contact. Please try again later.');
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(now + appConfig.otpTtlSeconds * 1000);

  await Otp.findOneAndUpdate(
    { channel, target, purpose },
    {
      channel, target, purpose,
      codeHash: hashCode(code),
      expiresAt,
      attempts: 0,
      verified: false,
      lastSentAt: new Date(now),
      sendCount: sendCount + 1,
      windowStart: new Date(windowStart),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (channel === 'EMAIL') {
    EmailService.sendOtpEmail(target, code, Math.round(appConfig.otpTtlSeconds / 60));
    logger.info(`[otp] EMAIL ${purpose} code sent to ${target}`);
    return { expiresInSec: appConfig.otpTtlSeconds }; // never expose the code
  }

  // PHONE — logged always; returned only in dev mode.
  logger.info(`[otp] PHONE ${purpose} code for ${target}: ${code} (dev=${appConfig.otpDevMode})`);
  return {
    expiresInSec: appConfig.otpTtlSeconds,
    ...(appConfig.otpDevMode && !appConfig.isProduction ? { devCode: code } : {}),
  };
};

export type VerifyResult = { ok: true; token: string } | { ok: false; error: string };

/** Verify a submitted code; on success mint a channel/target/purpose-bound token. */
export const verifyOtp = async (
  channel: OtpChannel,
  rawTarget: string,
  purpose: OtpPurpose,
  code: string
): Promise<VerifyResult> => {
  const target = normalizeTarget(channel, rawTarget);
  const record = await Otp.findOne({ channel, target, purpose });

  if (!record) return { ok: false, error: 'No code was requested for this contact. Please request a new one.' };
  if (record.expiresAt.getTime() < Date.now()) return { ok: false, error: 'The code has expired. Please request a new one.' };
  if (record.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Too many incorrect attempts. Please request a new code.' };

  if (record.codeHash !== hashCode(code)) {
    record.attempts += 1;
    await record.save();
    return { ok: false, error: 'Incorrect code. Please try again.' };
  }

  // Mark verified and extend TTL to the token window so the record survives
  // until the verification token expires.
  record.verified = true;
  record.expiresAt = new Date(Date.now() + appConfig.otpVerifyTokenTtlSeconds * 1000);
  await record.save();

  const payload: VerifyTokenPayload = { typ: 'otp_verify', channel, target, purpose };
  const token = jwt.sign(payload, appConfig.jwtAccessSecret, { expiresIn: appConfig.otpVerifyTokenTtlSeconds });
  return { ok: true, token };
};

/**
 * Gate check: the token is valid for this channel/target/purpose AND a verified
 * record still exists. Does NOT consume — call consumeVerification after the
 * dependent write succeeds.
 */
export const assertVerified = async (
  token: string,
  channel: OtpChannel,
  rawTarget: string,
  purpose: OtpPurpose
): Promise<boolean> => {
  const target = normalizeTarget(channel, rawTarget);
  try {
    const decoded = jwt.verify(token, appConfig.jwtAccessSecret) as VerifyTokenPayload;
    if (decoded.typ !== 'otp_verify' || decoded.channel !== channel || decoded.purpose !== purpose || decoded.target !== target) {
      return false;
    }
  } catch {
    return false;
  }
  const record = await Otp.findOne({ channel, target, purpose, verified: true });
  return !!record;
};

/** One-time use: remove the verified OTP after the dependent write succeeds. */
export const consumeVerification = async (
  channel: OtpChannel,
  rawTarget: string,
  purpose: OtpPurpose
): Promise<void> => {
  const target = normalizeTarget(channel, rawTarget);
  await Otp.deleteOne({ channel, target, purpose });
};
