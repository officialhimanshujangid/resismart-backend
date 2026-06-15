import { z } from 'zod';

export const createDesignationSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').trim(),
  description: z.string().trim().optional(),
});

export const updateDesignationSchema = z.object({
  name: z.string().min(2).trim().optional(),
  description: z.string().trim().optional(),
  isActive: z.boolean().optional(),
});

export type CreateDesignationInput = z.infer<typeof createDesignationSchema>;
export type UpdateDesignationInput = z.infer<typeof updateDesignationSchema>;
