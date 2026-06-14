import { z } from 'zod';

export const createRentalSchema = z.object({
  flatId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid flat ID format'),
  tenantId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid tenant ID format'),
  rentAmount: z.number().positive('Rent amount must be a positive number'),
  securityDeposit: z.number().nonnegative('Security deposit must be positive or zero'),
  startDate: z.string().datetime({ message: 'Invalid start date format (ISO DateTime required)' }),
  endDate: z.string().datetime({ message: 'Invalid end date format (ISO DateTime required)' }),
});

export const updateRentalSchema = z.object({
  rentAmount: z.number().positive().optional(),
  securityDeposit: z.number().nonnegative().optional(),
  isActive: z.boolean().optional(),
});
