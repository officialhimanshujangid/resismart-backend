import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const tenureEnum = z.enum(['monthly', 'quarterly', 'halfYearly', 'yearly']);

export const checkoutSchema = z.object({
  planId: objectId,
  tenure: tenureEnum,
});

export const verifyPaymentSchema = z.object({
  invoiceId: objectId,
  razorpay_subscription_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

export const assignCashPlanSchema = z.object({
  societyId: objectId.optional(),
  shopId: objectId.optional(),
  tenantId: objectId.optional(),
  tenantType: z.string().optional(),
  planId: objectId,
  tenure: tenureEnum,
  paymentMethod: z.enum(['cash', 'online']).default('cash'),
  note: z.string().max(300).optional(),
  collectedById: objectId.optional(),
  collectedByName: z.string().max(120).optional(),
}).refine(data => data.societyId || data.shopId || data.tenantId, {
  message: 'Must provide either societyId, shopId, or tenantId',
  path: ['tenantId']
});

export const upgradePreviewSchema = z.object({
  societyId: objectId.optional(),
  shopId: objectId.optional(),
  tenantId: objectId.optional(),
  tenantType: z.string().optional(),
  planId: objectId,
  tenure: tenureEnum,
}).refine(data => data.societyId || data.shopId || data.tenantId, {
  message: 'Must provide either societyId, shopId, or tenantId',
  path: ['tenantId']
});
