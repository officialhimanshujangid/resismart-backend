import { z } from 'zod';

const person = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: z.string().trim().toLowerCase().email('Invalid email').optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  relationship: z.enum(['OWNER', 'SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'RELATIVE', 'TENANT', 'STAFF', 'OTHER']).optional(),
});

/** A member of the tenant household on rent-out (a co-tenant/friend, or a tenant's family member). */
const tenantMember = person.extend({ isHead: z.boolean().optional() });

/** A person who will get a login/Resident row must have an email or phone. */
const personWithContact = person.superRefine((d, ctx) => {
  if (!(d.email && d.email.length) && !(d.phone && d.phone.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email'], message: 'Provide an email or phone number' });
  }
});

const rupees = z.coerce.number().min(0).max(1_000_000_000);

const tenancyDoc = z.object({
  kind: z.string().trim().optional(),
  label: z.string().trim().min(1),
  key: z.string().trim().min(1),
  url: z.string().trim().url(),
});

export const rentOutSchema = z.object({
  // The whole tenant household: one or more co-tenants (relationship TENANT) + any family
  // members. Rent to a single family, a group of friends sharing, or a family + friends.
  tenants: z.array(tenantMember).min(1, 'Add at least one tenant').max(25),
  rentAmount: rupees,           // rupees; converted to paise server-side
  securityDeposit: rupees.default(0),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  documents: z.array(tenancyDoc).max(20).default([]),
}).superRefine((d, ctx) => {
  if (d.endDate <= d.startDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'End date must be after the start date' });
  }
  // The head (or the first tenant) must be contactable so the tenancy has a primary tenant.
  const head = d.tenants.find((t) => t.isHead) || d.tenants[0];
  if (head && !(head.email && head.email.length) && !(head.phone && head.phone.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tenants'], message: 'The primary tenant needs an email or phone' });
  }
});

export const sellSchema = z.object({
  buyer: personWithContact,
  saleAmount: rupees.optional(),
  saleDate: z.coerce.date().default(() => new Date()),
});

export const dateActionSchema = z.object({
  date: z.coerce.date().default(() => new Date()),
});

export const historicalTenureSchema = z.object({
  type: z.enum(['OWNERSHIP', 'TENANCY', 'OWNER_OCCUPANCY']),
  partyName: z.string().trim().min(1, 'Party name is required').max(120),
  occupants: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    relationship: z.enum(['OWNER', 'SPOUSE', 'CHILD', 'PARENT', 'TENANT', 'OTHER']).default('OTHER'),
  })).max(20).default([]),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
  saleAmount: rupees.optional(),
  rentAmount: rupees.optional(),
  securityDeposit: rupees.optional(),
  notes: z.string().trim().max(500).optional(),
}).superRefine((d, ctx) => {
  if (d.endDate && d.endDate <= d.startDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'End date must be after the start date' });
  }
});

export const updateTenureSchema = z.object({
  partyName: z.string().trim().min(1).max(120).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(500).optional(),
  saleAmount: rupees.optional(),
  rentAmount: rupees.optional(),
  securityDeposit: rupees.optional(),
});
