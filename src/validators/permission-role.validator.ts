import { z } from 'zod';

const modulePermissionSchema = z.object({
  module: z.string().min(1, 'Module key is required'),
  moduleLabel: z.string().min(1, 'Module label is required'),
  canRead: z.boolean().default(false),
  canCreate: z.boolean().default(false),
  canEdit: z.boolean().default(false),
  canDelete: z.boolean().default(false),
});

export const createPermissionRoleSchema = z.object({
  name: z.string().min(2, 'Role name must be at least 2 characters').trim(),
  description: z.string().trim().optional(),
  permissions: z.array(modulePermissionSchema).min(1, 'At least one module permission is required'),
});

export const updatePermissionRoleSchema = z.object({
  name: z.string().min(2).trim().optional(),
  description: z.string().trim().optional(),
  permissions: z.array(modulePermissionSchema).optional(),
  isActive: z.boolean().optional(),
});

export type CreatePermissionRoleInput = z.infer<typeof createPermissionRoleSchema>;
export type UpdatePermissionRoleInput = z.infer<typeof updatePermissionRoleSchema>;
