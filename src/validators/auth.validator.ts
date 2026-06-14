import { z } from 'zod';

export const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters long'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string(),
});

export const selectContextSchema = z.object({
  tenantId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid tenant MongoDB ObjectId'),
  role: z.string(),
});
