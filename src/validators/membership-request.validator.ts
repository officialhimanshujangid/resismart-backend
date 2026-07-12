import { z } from 'zod';

/**
 * Create a resident registration request. At least one identifier (email or phone) is
 * required, since access is granted per-identity at approval time.
 */
export const createRegistrationRequestSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: z.string().trim().toLowerCase().email('Invalid email').optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  relationship: z.enum(['OWNER', 'SPOUSE', 'CHILD', 'PARENT', 'TENANT', 'OTHER']),
}).superRefine((data, ctx) => {
  const hasEmail = !!data.email && data.email.length > 0;
  const hasPhone = !!data.phone && data.phone.length > 0;
  if (!hasEmail && !hasPhone) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email'], message: 'Provide an email or a phone number' });
  }
});

export const rejectRequestSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export type CreateRegistrationRequestInput = z.infer<typeof createRegistrationRequestSchema>;
