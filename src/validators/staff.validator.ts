import { z } from 'zod';
import { STAFF_DESIGNATIONS } from '../models/society-staff.model';
import { WORK_CATEGORIES } from '../models/staff-assignment.model';

const objectId = /^[0-9a-fA-F]{24}$/;
const dateish = z.string().refine(v => !Number.isNaN(new Date(v).getTime()), 'Not a date');

const verification = z.object({
  policeVerifiedOn: dateish.optional(),
  verifiedBy: z.string().max(120).optional(),
  documentKey: z.string().max(300).optional(),
  // The expiry is the point of this block. A verification with no end date
  // cannot be chased, and an unchased one is indistinguishable from none.
  expiresOn: dateish.optional(),
}).optional();

export const createStaffSchema = z.object({
  name: z.string().min(1, 'Who is this?').max(120),
  phone: z.string().min(6, 'A contact number is needed').max(20),
  email: z.string().email().optional().or(z.literal('')),
  photoKey: z.string().max(300).optional(),
  designation: z.enum(STAFF_DESIGNATIONS as [string, ...string[]]),
  employmentType: z.enum(['DIRECT', 'AGENCY', 'CONTRACT']).optional(),
  vendorId: z.string().regex(objectId).optional(),
  joinedOn: dateish.optional(),
  accessRoleId: z.string().regex(objectId).optional(),
  verification,
  emergencyContact: z.object({
    name: z.string().max(120).optional(),
    phone: z.string().max(20).optional(),
    relation: z.string().max(40).optional(),
  }).optional(),
  notes: z.string().max(1000).optional(),
});

export const updateStaffSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  phone: z.string().min(6).max(20).optional(),
  email: z.string().email().optional().or(z.literal('')),
  photoKey: z.string().max(300).optional(),
  designation: z.enum(STAFF_DESIGNATIONS as [string, ...string[]]).optional(),
  // Null clears the role, which is different from not sending the field.
  accessRoleId: z.string().regex(objectId).nullable().optional(),
  verification,
  emergencyContact: z.object({
    name: z.string().max(120).optional(),
    phone: z.string().max(20).optional(),
    relation: z.string().max(40).optional(),
  }).optional(),
  notes: z.string().max(1000).optional(),
});

export const endEmploymentSchema = z.object({
  leftOn: dateish.optional(),
});

export const assignStaffSchema = z.object({
  staffId: z.string().regex(objectId),
  scope: z.enum(['SOCIETY', 'BLOCK']),
  blockId: z.string().regex(objectId).optional(),
  categories: z.array(z.enum(WORK_CATEGORIES)).min(1, 'What kind of work should reach them?'),
  rank: z.enum(['PRIMARY', 'BACKUP']).optional(),
}).refine(v => v.scope === 'SOCIETY' || !!v.blockId, { message: 'Which wing?', path: ['blockId'] });
