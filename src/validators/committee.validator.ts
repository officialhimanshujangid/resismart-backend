import { z } from 'zod';

const optionalDate = z.coerce.date().optional();

export const startCommitteeSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  termStartDate: z.coerce.date(),
  termEndDate: optionalDate,
  electionDate: optionalDate,
  notes: z.string().trim().optional(),
});

export const designationSchema = z.object({
  label: z.string().trim().min(1, 'Label is required'),
  rank: z.number().int().optional(),
  isOfficeBearer: z.boolean().optional(),
  active: z.boolean().optional(),
});

export const addCommitteeMemberSchema = z.object({
  userId: z.string().trim().min(1, 'Member is required'),
  designationKey: z.string().trim().min(1, 'Designation is required'),
  appointment: z.enum(['ELECTED', 'CO_OPTED', 'APPOINTED']).optional(),
  startDate: optionalDate,
  notes: z.string().trim().optional(),
});

export const updateCommitteeMemberSchema = z.object({
  designationKey: z.string().trim().optional(),
  appointment: z.enum(['ELECTED', 'CO_OPTED', 'APPOINTED']).optional(),
  notes: z.string().trim().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
