import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const rupees = z.coerce.number().min(0).max(10_000_000_000);

const photo = z.object({
  url: z.string().url('Invalid photo URL'),
  isCover: z.boolean().default(false),
  blurhash: z.string().optional(),
});

const contact = z.object({
  name: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(20).optional(),
  revealPhone: z.boolean().default(false),
});

const furnishing = z.enum(['UNFURNISHED', 'SEMI_FURNISHED', 'FURNISHED']);

export const createListingSchema = z.object({
  kind: z.enum(['SALE', 'RENT']),
  scope: z.enum(['FLAT', 'SOCIETY']).default('FLAT'),
  flatId: objectId.optional(),
  title: z.string().trim().min(4, 'Title is too short').max(140),
  description: z.string().trim().max(4000).optional(),
  price: rupees,
  bedrooms: z.coerce.number().int().min(0).max(50).optional(),
  sizeLabel: z.string().trim().max(60).optional(),
  furnishing: furnishing.optional(),
  amenities: z.array(z.string().trim().max(40)).max(40).default([]),
  photos: z.array(photo).max(20).default([]),
  contact: contact.optional(),
}).superRefine((d, ctx) => {
  if (d.scope === 'FLAT' && !d.flatId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['flatId'], message: 'Select a flat for a flat listing' });
  }
});

export const updateListingSchema = z.object({
  title: z.string().trim().min(4).max(140).optional(),
  description: z.string().trim().max(4000).optional(),
  price: rupees.optional(),
  bedrooms: z.coerce.number().int().min(0).max(50).optional(),
  sizeLabel: z.string().trim().max(60).optional(),
  furnishing: furnishing.optional(),
  amenities: z.array(z.string().trim().max(40)).max(40).optional(),
  photos: z.array(photo).max(20).optional(),
  contact: contact.optional(),
});

export type CreateListingInput = z.infer<typeof createListingSchema>;
