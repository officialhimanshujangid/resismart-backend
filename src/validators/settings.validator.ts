import { z } from 'zod';

export const updateSettingsSchema = z.object({
  gracePeriodDays: z.number().int().min(0).max(90).optional(),
  defaultTrialCapabilities: z.record(z.string(), z.number()).optional(),
  // Days-before-expiry to send reminders, e.g. [3,2,1]
  expiryReminderDays: z.array(z.number().int().min(0).max(90)).max(10).optional(),
});
