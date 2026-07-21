import { z } from 'zod';
import { STAFF_DESIGNATIONS } from '../models/society-staff.model';
import { WORK_CATEGORIES } from '../models/staff-assignment.model';
import { HHMM } from '../models/staff-shift.model';
import { LEAVE_KINDS } from '../models/staff-leave.model';

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
  /**
   * Who picks up their open complaints. Optional — omitting it returns the
   * work to the unassigned queue, which is visible. What is NOT allowed is
   * the old behaviour, where it stayed pointing at somebody who had left and
   * every notification about it silently reached nobody.
   */
  handoverToStaffId: z.string().regex(objectId).optional(),
});

/**
 * Bringing somebody back onto the roll.
 *
 * The date is optional and defaults to today. It is NOT the day they first
 * joined — that stays in `spells`, which is the whole point of reinstating the
 * original row instead of creating a second `SF/xxxx`.
 */
export const reinstateStaffSchema = z.object({
  joinedOn: dateish.optional(),
});

/**
 * A document filed against a staff member.
 *
 * `key` is checked again in the service against the staff prefix. Two checks
 * because this one only proves the shape of the string; the service one proves
 * the object came out of our own uploader and not out of another society's
 * folder in the same bucket.
 */
export const staffDocumentSchema = z.object({
  name: z.string().min(1, 'Give the document a name').max(120),
  key: z.string().min(1).max(300),
  url: z.string().max(600).optional(),
});

// Both of these are posted to `/staff/:id/…`, so the person is in the path and
// is never taken from the body — a staffId in two places is a staffId that can
// disagree with itself.
export const staffShiftSchema = z.object({
  // 0 = Sunday, matching Date.getDay(), so no day-of-week mapping is needed
  // anywhere between here and routing.
  weekday: z.number().int().min(0).max(6),
  from: z.string().regex(HHMM, 'Use a 24-hour time like 22:00'),
  to: z.string().regex(HHMM, 'Use a 24-hour time like 06:00'),
});

export const staffLeaveSchema = z.object({
  from: dateish,
  to: dateish,
  kind: z.enum(LEAVE_KINDS as unknown as [string, ...string[]]).optional(),
  reason: z.string().max(300).optional(),
});

export const assignStaffSchema = z.object({
  staffId: z.string().regex(objectId),
  scope: z.enum(['SOCIETY', 'BLOCK']),
  blockId: z.string().regex(objectId).optional(),
  categories: z.array(z.enum(WORK_CATEGORIES)).min(1, 'What kind of work should reach them?'),
  rank: z.enum(['PRIMARY', 'BACKUP']).optional(),
}).refine(v => v.scope === 'SOCIETY' || !!v.blockId, { message: 'Which wing?', path: ['blockId'] });
