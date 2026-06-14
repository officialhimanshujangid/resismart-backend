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
