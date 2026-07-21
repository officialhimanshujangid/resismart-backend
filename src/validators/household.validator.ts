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
  /**
   * The key must be one our own upload route minted.
   *
   * `flat-document.service.ts:127` already defends this exact attack and says
   * why: without the prefix a caller can attach ANY object in the bucket —
   * including another society's — to their own record, then read it back
   * through the presigned-download endpoint. The household and tenancy paths
   * accepted a bare string, so the defence existed on one of three doors.
   */
  key: z.string().trim().min(1, 'key is required')
    // `flat-documents` is the only prefix `POST /upload/document` writes to
    // (upload.routes.ts:35). Accepting a second, wider prefix "just in case"
    // would reopen the hole this closes.
    .refine(k => k.startsWith('flat-documents/'),
      'That file was not uploaded through the document uploader'),
  url: z.string().trim().url('Invalid url'),
});
