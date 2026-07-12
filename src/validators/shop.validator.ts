import { z } from 'zod';
import { SHOP_SERVICE_TYPES } from '../models/shop.model';

const shopDetailFields = {
  gstNumber: z.string().max(20).optional().or(z.literal('')),
  storeType: z.string().max(80).optional().or(z.literal('')),
  typeService: z.enum(SHOP_SERVICE_TYPES).optional().or(z.literal('')),
  salesAndProduct: z.string().max(200).optional().or(z.literal('')),
  city: z.string().max(80).optional().or(z.literal('')),
  state: z.string().max(80).optional().or(z.literal('')),
  pincode: z.string().max(12).optional().or(z.literal('')),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
};

// Self-registration from the public landing page (shop created in PENDING state).
// Shop admin = email + phone, both OTP-verified (like a flat owner).
export const registerShopPublicSchema = z.object({
  name: z.string().min(2, 'Shop name must be at least 2 characters long'),
  contactNumber: z.string().min(7).max(20),
  address: z.string().min(5, 'Address must be at least 5 characters long'),
  adminEmail: z.string().email('A valid admin email is required'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
  ...shopDetailFields,
  emailVerificationToken: z.string().min(10, 'Please verify the admin email via OTP'),
  phoneVerificationToken: z.string().min(10, 'Please verify the contact number via OTP'),
});

// Owner-side registration (auto-approved / ACTIVE). Trusted owner — OTP tokens optional.
export const registerShopAdminSchema = registerShopPublicSchema.extend({
  password: z.string().min(6).optional(),
  emailVerificationToken: z.string().optional(),
  phoneVerificationToken: z.string().optional(),
});

// Owner edits an existing shop
export const updateShopSchema = z.object({
  name: z.string().min(2).optional(),
  contactNumber: z.string().min(7).max(20).optional(),
  address: z.string().min(5).optional(),
  adminEmail: z.string().email().optional().or(z.literal('')),
  ...shopDetailFields,
});

export const rejectShopSchema = z.object({
  reason: z.string().min(3, 'Please provide a rejection reason').max(300),
});
