import { z } from 'zod';

// Owner is assigned via flat creation / sell-transfer, not the household add flow.
const HOUSEHOLD_RELATIONSHIPS = ['SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'RELATIVE', 'TENANT', 'STAFF', 'OTHER'] as const;

const optionalDate = z.coerce.date().optional();

export const addMemberSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  relationship: z.enum(HOUSEHOLD_RELATIONSHIPS),
  email: z.string().trim().email('Invalid email').optional().or(z.literal('')).transform((v) => (v ? v : undefined)),
  phone: z.string().trim().optional().or(z.literal('')).transform((v) => (v ? v : undefined)),
  isHead: z.boolean().optional(),
  moveInDate: optionalDate,
  householdType: z.enum(['OWNER', 'TENANT']).optional(),
  emailToken: z.string().optional(),
  phoneToken: z.string().optional(),
});

export const updateMemberSchema = z.object({
  relationship: z.enum(HOUSEHOLD_RELATIONSHIPS).optional(),
  isActive: z.boolean().optional(),
  moveInDate: optionalDate,
  moveOutDate: optionalDate,
  deactivatedReason: z.string().trim().optional(),
  // Adding a contact to a previously data-only member (each requires an OTP token).
  addEmail: z.string().trim().email('Invalid email').optional().or(z.literal('')).transform((v) => (v ? v : undefined)),
  addPhone: z.string().trim().optional().or(z.literal('')).transform((v) => (v ? v : undefined)),
  emailToken: z.string().optional(),
  phoneToken: z.string().optional(),
});

export const addDocumentSchema = z.object({
  kind: z.string().trim().optional(),
  label: z.string().trim().min(1, 'Label is required'),
  key: z.string().trim().min(1, 'key is required'),
  url: z.string().trim().url('Invalid url'),
});
