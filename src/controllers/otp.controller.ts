import { Request, Response, NextFunction } from 'express';
import { otpRequestSchema, otpVerifySchema } from '../validators/auth.validator';
import { requestOtp, verifyOtp, OtpRateError, OtpInputError } from '../services/otp.service';

/**
 * POST /auth/otp/request — generate + deliver an OTP.
 * EMAIL is delivered to the inbox (code never returned). PHONE returns the code
 * only in dev mode (no SMS gateway) so the UI can show it.
 */
export const requestOtpHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = otpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    const { channel, target, purpose } = parsed.data;
    const result = await requestOtp(channel, target, purpose);

    res.status(200).json({
      message: channel === 'EMAIL'
        ? 'A verification code has been emailed to this address.'
        : 'Enter the verification code to continue.',
      channel,
      expiresInSec: result.expiresInSec,
      ...(result.devCode ? { devCode: result.devCode } : {}),
    });
  } catch (error) {
    if (error instanceof OtpRateError) { res.status(429).json({ error: error.message }); return; }
    if (error instanceof OtpInputError) { res.status(400).json({ error: error.message }); return; }
    next(error);
  }
};

/**
 * POST /auth/otp/verify — check a code and, on success, return a short-lived
 * channel/target/purpose-bound verification token the registration endpoints require.
 */
export const verifyOtpHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = otpVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    const { channel, target, purpose, code } = parsed.data;
    const result = await verifyOtp(channel, target, purpose, code);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.status(200).json({
      message: `${channel === 'EMAIL' ? 'Email' : 'Phone number'} verified successfully.`,
      channel,
      verificationToken: result.token,
    });
  } catch (error) {
    next(error);
  }
};
