import { z } from 'zod';
import { ACCESS_MODULES } from '../models/access-role.model';

const objectId = /^[0-9a-fA-F]{24}$/;

const grant = z.object({
  module: z.enum(ACCESS_MODULES),
  level: z.enum(['NONE', 'READ', 'FULL']),
});

/**
 * `allBlocks: false` with an empty list would be a role that can see nothing at
 * all — almost certainly a half-finished form rather than an intention, and it
 * produces a member who gets 403s they cannot explain.
 */
const scope = z.object({
  allBlocks: z.boolean(),
  blockIds: z.array(z.string().regex(objectId)).max(100).optional(),
}).refine(s => s.allBlocks || (s.blockIds?.length ?? 0) > 0, {
  message: 'Choose at least one wing, or give access to all of them',
});

export const createAccessRoleSchema = z.object({
  name: z.string().min(1, 'A role needs a name').max(60),
  description: z.string().max(300).optional(),
  appliesTo: z.enum(['COMMITTEE', 'STAFF', 'BOTH']).optional(),
  permissions: z.array(grant).max(ACCESS_MODULES.length).optional(),
  scope: scope.optional(),
});

export const updateAccessRoleSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(300).optional(),
  appliesTo: z.enum(['COMMITTEE', 'STAFF', 'BOTH']).optional(),
  permissions: z.array(grant).max(ACCESS_MODULES.length).optional(),
  scope: scope.optional(),
  isActive: z.boolean().optional(),
});

export const assignAccessRoleSchema = z.object({
  // Null clears the assignment, which is different from not sending the field.
  accessRoleId: z.string().regex(objectId).nullable().optional(),
});
