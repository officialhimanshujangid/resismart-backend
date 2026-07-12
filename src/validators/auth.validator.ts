import { z } from 'zod';

export const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters long'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
});

export const loginSchema = z.object({
  // identifier = email address OR phone number
  identifier: z.string().min(3, 'Email or phone number is required'),
  password: z.string(),
});

const OTP_PURPOSES = ['SOCIETY_REGISTRATION', 'SHOP_REGISTRATION', 'FLAT_REGISTRATION', 'LOGIN', 'GENERIC'] as const;

export const loginOtpRequestSchema = z.object({
  identifier: z.string().min(3, 'Enter your email or phone number'),
});

export const loginOtpVerifySchema = z.object({
  identifier: z.string().min(3, 'Enter your email or phone number'),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
const OTP_CHANNELS = ['PHONE', 'EMAIL'] as const;

export const otpRequestSchema = z.object({
  channel: z.enum(OTP_CHANNELS),
  target: z.string().min(3, 'A valid email or phone number is required'),
  purpose: z.enum(OTP_PURPOSES).default('GENERIC'),
});

export const otpVerifySchema = z.object({
  channel: z.enum(OTP_CHANNELS),
  target: z.string().min(3, 'A valid email or phone number is required'),
  purpose: z.enum(OTP_PURPOSES).default('GENERIC'),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
});
