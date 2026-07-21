import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const tenureEnum = z.enum(['monthly', 'quarterly', 'halfYearly', 'yearly']);

const billingCycleSchema = z.object({
  tenure: tenureEnum,
  label: z.string().optional(),
  durationMonths: z.number().int().positive(),
  discountPercent: z.number().min(0).max(100).optional(),
  isEnabled: z.boolean().optional(),
  razorpayPlanId: z.string().optional(),
});

/**
 * Capability limits — one number per sellable module, and every value is
 * load-bearing:
 *
 *   0   not in this plan. The module is invisible and its API returns 404 for
 *       everyone in that society, the admin included.
 *   -1  unlimited (absent means the same thing).
 *   N   included, capped at N.
 *
 * The bound is `-1`, not "any negative", because that is the only negative
 * anything downstream reads. `planLimit` hands whatever it finds to
 * `enforceCapacity` as the ceiling, so a stored `-5` becomes `used >= -5` —
 * true for an empty society — and every single creation is refused with a
 * message saying the plan covers -5 flats. A typo in a number box should not
 * be able to freeze a society, so it is refused here instead.
 *
 * Fractions are refused for the same reason: `2.5 staff` is not a number
 * anybody meant, and it reads back to an admin as a limit they cannot reach.
 */
const capabilitiesSchema = z.record(
  z.string(),
  z.number()
    .int('A plan limit must be a whole number')
    .min(-1, 'A plan limit must be 0 (not in this plan), -1 (unlimited) or a positive number'),
);

export const createPlanSchema = z.object({
  name: z.string().min(2, 'Plan name must be at least 2 characters'),
  description: z.string().max(500).optional(),
  module: z.enum(['society', 'shop']).optional(),
  basePrice: z.number().min(0, 'Base price cannot be negative'),
  currency: z.string().length(3).optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  billingCycles: z.array(billingCycleSchema).optional(),
  capabilities: capabilitiesSchema.optional(),
});

export const updatePlanSchema = createPlanSchema.partial();

export { objectId };
