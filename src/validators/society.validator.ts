import { z } from 'zod';

export const createBlockSchema = z.object({
  name: z.string().min(1, 'Block name is required'),
  totalFloors: z.coerce.number().min(0).optional(),
  blockType: z.string().optional(),
});

export const updateBlockSchema = z.object({
  name: z.string().min(1, 'Block name is required').optional(),
  totalFloors: z.coerce.number().min(0).optional(),
  blockType: z.string().optional(),
});

// When any owner field is filled, the owner is being provisioned — then name,
// email, an OTP-verified phone, and the verification token are all required.
const hasOwnerInfo = (d: { ownerName?: string; ownerEmail?: string; ownerPhone?: string }) =>
  !!(d.ownerName?.trim() || d.ownerEmail?.trim() || d.ownerPhone?.trim());

export const createFlatSchema = z.object({
  blockId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Block ID'),
  number: z.string().min(1, 'Flat number is required'),
  fullAddress: z.string().optional(),
  registrationNumber: z.string().optional(),
  sizeId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Size ID').optional(),
  headOfFamily: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid User ID').optional(),
  familyMembers: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid User ID')).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),

  // Optional owner info — a flat may be created vacant. If present, it must be complete,
  // with BOTH the owner email and phone OTP-verified.
  ownerName: z.string().optional(),
  ownerEmail: z.string().email('Valid owner email is required if providing owner info').optional(),
  ownerPhone: z.string().optional(),
  ownerEmailVerificationToken: z.string().optional(),
  ownerPhoneVerificationToken: z.string().optional(),
}).superRefine((d, ctx) => {
  if (!hasOwnerInfo(d)) return; // vacant flat — nothing to enforce
  if (!d.ownerName?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerName'], message: 'Owner name is required' });
  if (!d.ownerEmail?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerEmail'], message: 'Owner email is required' });
  if (!d.ownerPhone || d.ownerPhone.trim().length < 8) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerPhone'], message: 'A valid owner phone number is required' });
  if (!d.ownerEmailVerificationToken) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerEmailVerificationToken'], message: 'Please verify the owner email via OTP' });
  if (!d.ownerPhoneVerificationToken) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerPhoneVerificationToken'], message: 'Please verify the owner phone number via OTP' });
});

export const updateFlatSchema = z.object({
  status: z.enum(['VACANT', 'OWNER_OCCUPIED', 'RENTED']).optional(),
  ownerUserId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Owner User ID').optional(),
  owners: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Owner User ID')).optional(), // legacy
  fullAddress: z.string().optional(),
  registrationNumber: z.string().optional(),
  sizeId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Size ID').optional(),
  headOfFamily: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid User ID').optional(),
  familyMembers: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid User ID')).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  // Counts for PER_QUANTITY charge heads, e.g. { parkingSlots: 2 }. Whole
  // numbers only — half a parking slot is not a thing anyone can bill for.
  quantities: z.record(
    z.string().max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Use a simple key like parkingSlots'),
    z.number().int('Counts must be whole numbers').min(0),
  ).optional(),
});

export const createResidentSchema = z.object({
  name: z.string().min(2, 'Name is required'),
  email: z.string().email('Valid email is required'),
  phone: z.string().optional(),
  relationship: z.enum(['OWNER', 'SPOUSE', 'CHILD', 'PARENT', 'TENANT', 'OTHER']),
});

export const updateResidentSchema = z.object({
  relationship: z.enum(['OWNER', 'SPOUSE', 'CHILD', 'PARENT', 'TENANT', 'OTHER']).optional(),
  isActive: z.boolean().optional(),
});

export const bulkUploadFlatRowSchema = z.object({
  blockName: z.string().min(1, 'Block name is required'),
  number: z.string().min(1, 'Flat number is required'),
  fullAddress: z.string().optional(),
  registrationNumber: z.string().optional(),
  ownerName: z.string().optional(),
  ownerEmail: z.string().email('Invalid email format').optional(),
  ownerPhone: z.string().optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
}).superRefine((d, ctx) => {
  // Bulk rows can't do interactive OTP, but a provided owner must still be complete
  // with a phone number (so the account can later log in / verify by phone).
  if (!hasOwnerInfo(d)) return;
  if (!d.ownerName?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerName'], message: 'Owner Name is required when an owner is provided' });
  if (!d.ownerEmail?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerEmail'], message: 'Owner Email is required when an owner is provided' });
  if (!d.ownerPhone || d.ownerPhone.trim().length < 8) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerPhone'], message: 'Owner Phone is required when an owner is provided' });
});

// Extended optional detail fields shared across registration & updates
const societyDetailFields = {
  contactPhone: z.string().min(7).max(20).optional().or(z.literal('')),
  city: z.string().max(80).optional().or(z.literal('')),
  state: z.string().max(80).optional().or(z.literal('')),
  pincode: z.string().max(12).optional().or(z.literal('')),
  registrationNumber: z.string().max(60).optional().or(z.literal('')),
  website: z.string().max(120).optional().or(z.literal('')),
  totalBlocks: z.coerce.number().int().min(0).max(100000).optional(),
  totalFlats: z.coerce.number().int().min(0).max(1000000).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
};

// Self-registration from the public landing page (society created in PENDING state).
// Email is the login identity and phone is the org contact — BOTH must be OTP-verified.
export const registerSocietyPublicSchema = z.object({
  name: z.string().min(3, 'Society name must be at least 3 characters long'),
  address: z.string().min(5, 'Address must be at least 5 characters long'),
  contactName: z.string().min(2, 'Contact name is required'),
  contactEmail: z.string().email('A valid contact email is required'),
  ...societyDetailFields,
  contactPhone: z.string().min(8, 'A valid phone number is required'),
  emailVerificationToken: z.string().min(10, 'Please verify your email via OTP'),
  phoneVerificationToken: z.string().min(10, 'Please verify your phone number via OTP'),
});

export const registerSocietyAdminSchema = registerSocietyPublicSchema.extend({
  contactName: z.string().min(2).optional(),
  contactEmail: z.string().email().optional(),
  emailVerificationToken: z.string().optional(),
  phoneVerificationToken: z.string().optional(),
  contactPhone: z.string().min(8).optional(),
}).superRefine((d, ctx) => {
  if (d.contactEmail && !d.emailVerificationToken) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['emailVerificationToken'], message: 'Please verify the email via OTP' });
  if (d.contactPhone && !d.phoneVerificationToken) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phoneVerificationToken'], message: 'Please verify the phone number via OTP' });
});

// Owner edits an existing society
export const updateSocietySchema = z.object({
  name: z.string().min(3).optional(),
  address: z.string().min(5).optional(),
  contactName: z.string().min(2).optional().or(z.literal('')),
  contactEmail: z.string().email().optional().or(z.literal('')),
  ...societyDetailFields,
});

export const rejectSocietySchema = z.object({
  reason: z.string().min(3, 'Please provide a rejection reason').max(300),
});
