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

// Capability limits: integers (-1 means unlimited)
const capabilitiesSchema = z.record(z.string(), z.number());

export const createPlanSchema = z.object({
  name: z.string().min(2, 'Plan name must be at least 2 characters'),
  description: z.string().max(500).optional(),
  basePrice: z.number().min(0, 'Base price cannot be negative'),
  currency: z.string().length(3).optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  billingCycles: z.array(billingCycleSchema).optional(),
  capabilities: capabilitiesSchema.optional(),
});

export const updatePlanSchema = createPlanSchema.partial();

export { objectId };
