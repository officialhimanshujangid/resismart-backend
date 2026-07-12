import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const boostPackageSchema = z.object({
  _id: objectId.optional(), // present for existing packages, absent for new ones
  label: z.string().trim().min(1, 'Package label is required').max(60),
  pricePaise: z.number().int('Price must be a whole number of paise').min(0).max(100_000_00),
  durationDays: z.number().int().min(1, 'Duration must be at least 1 day').max(365),
  radiusKm: z.number().min(0).max(500),
  topPlacement: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

/**
 * SYSTEM_OWNER update of the singleton marketplace configuration. All fields optional
 * (partial update). Cross-field rules (base <= max, package radius <= max) are enforced
 * here via superRefine so the controller can trust the payload.
 */
export const updateAdSettingSchema = z.object({
  listingsEnabled: z.boolean().optional(),
  baseRadiusKm: z.number().min(0).max(500).optional(),
  maxRadiusKm: z.number().min(0).max(500).optional(),
  listingExpiryDays: z.number().int().min(1).max(365).optional(),
  boostPackages: z.array(boostPackageSchema).max(20).optional(),
}).superRefine((data, ctx) => {
  if (data.baseRadiusKm !== undefined && data.maxRadiusKm !== undefined && data.baseRadiusKm > data.maxRadiusKm) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseRadiusKm'], message: 'Base radius cannot exceed the maximum radius' });
  }
  if (data.maxRadiusKm !== undefined && data.boostPackages) {
    data.boostPackages.forEach((pkg, i) => {
      if (pkg.radiusKm > data.maxRadiusKm!) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['boostPackages', i, 'radiusKm'], message: `Package radius cannot exceed the maximum radius (${data.maxRadiusKm} km)` });
      }
    });
  }
});

export type UpdateAdSettingInput = z.infer<typeof updateAdSettingSchema>;

export const boostCheckoutSchema = z.object({
  packageId: objectId,
});

export const boostVerifySchema = z.object({
  boostId: objectId,
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

/** Public browse: geo (lng/lat) OR text (city/pincode); neither → recent boosted feed. */
export const publicBrowseSchema = z.object({
  lng: z.coerce.number().min(-180).max(180).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  city: z.string().trim().max(80).optional(),
  pincode: z.string().trim().max(12).optional(),
  kind: z.enum(['SALE', 'RENT']).optional(),
  min: z.coerce.number().min(0).optional(),
  max: z.coerce.number().min(0).optional(),
  bedrooms: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});

export const leadSchema = z.object({
  listingId: objectId,
  name: z.string().trim().min(1, 'Name is required').max(120),
  phone: z.string().trim().min(6, 'A valid phone is required').max(20),
  message: z.string().trim().max(1000).optional(),
  otpToken: z.string().min(1, 'Verify your phone number first'),
});

export const savedSearchSchema = z.object({
  name: z.string().trim().max(80).optional(),
  criteria: z.object({
    kind: z.enum(['SALE', 'RENT']).optional(),
    city: z.string().trim().max(80).optional(),
    pincode: z.string().trim().max(12).optional(),
    min: z.coerce.number().min(0).optional(),
    max: z.coerce.number().min(0).optional(),
    bedrooms: z.coerce.number().int().min(0).optional(),
  }).default({}),
  alertsEnabled: z.boolean().default(true),
});

/** Geo-radius browse query. lng/lat optional — falls back to the viewer's society location. */
export const browseQuerySchema = z.object({
  lng: z.coerce.number().min(-180).max(180).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  kind: z.enum(['SALE', 'RENT']).optional(),
  min: z.coerce.number().min(0).optional(),   // rupees
  max: z.coerce.number().min(0).optional(),   // rupees
  bedrooms: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});
