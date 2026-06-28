import { z } from 'zod';

export const createSocietySchema = z.object({
  name: z.string().min(3, 'Society name must be at least 3 characters long'),
  address: z.string().min(5, 'Address must be at least 5 characters long'),
});

export const createFlatSchema = z.object({
  number: z.string().min(1, 'Flat number is required'),
  blockName: z.string().min(1, 'Block name is required'),
});

export const updateFlatSchema = z.object({
  status: z.enum(['VACANT', 'OWNER_OCCUPIED', 'RENTED']).optional(),
  owners: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Owner User ID')).optional(),
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

// Self-registration from the public landing page (society created in PENDING state)
export const registerSocietyPublicSchema = z.object({
  name: z.string().min(3, 'Society name must be at least 3 characters long'),
  address: z.string().min(5, 'Address must be at least 5 characters long'),
  contactName: z.string().min(2, 'Contact name is required'),
  contactEmail: z.string().email('A valid contact email is required'),
  ...societyDetailFields,
});

// Owner-side registration (auto-approved / ACTIVE)
export const registerSocietyAdminSchema = registerSocietyPublicSchema.extend({
  contactName: z.string().min(2).optional(),
  contactEmail: z.string().email().optional(),
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
