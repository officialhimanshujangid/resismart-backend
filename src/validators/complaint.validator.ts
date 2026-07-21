import { z } from 'zod';
import { PAUSE_REASONS } from '../models/complaint.model';
import { ASSET_CATEGORIES } from '../models/asset.model';
import { ALL_STATUSES } from '../services/complaint-transitions';

const objectId = /^[0-9a-fA-F]{24}$/;
const dateish = z.string().refine(v => !Number.isNaN(new Date(v).getTime()), 'Not a date');

/**
 * The list filters, which had no schema at all.
 *
 * `filter.status` and `filter.category` were assigned into the Mongo query
 * straight off the query string, and Express's `qs` parser turns
 * `?status[$ne]=CLOSED` into an OBJECT — so that one URL handed a resident
 * every complaint in the society. Declaring them as strings is the fix: an
 * object fails to parse and the request is refused before it reaches a query.
 *
 * `.optional()` throughout, and unknown keys are left alone, because this
 * endpoint's other parameters (paging, search, the `open` flag) are read
 * defensively by the service and adding them here would break any caller that
 * sends one this file forgot.
 */
export const listComplaintsQuerySchema = z.object({
  status: z.enum(ALL_STATUSES as [string, ...string[]]).optional(),
  category: z.string().max(60).optional(),
  q: z.string().max(120).optional(),
  open: z.enum(['true', 'false']).optional(),
  page: z.string().regex(/^\d{1,6}$/).optional(),
  pageSize: z.string().regex(/^\d{1,3}$/).optional(),
});

export const raiseComplaintSchema = z.object({
  kind: z.enum(['SERVICE', 'CONDUCT']).optional(),
  title: z.string().min(1, 'What is the problem?').max(200),
  description: z.string().max(2000).optional(),
  photoKeys: z.array(z.string().max(300)).max(6).optional(),
  categoryId: z.string().regex(objectId).optional(),
  category: z.string().max(60).optional(),
  subCategory: z.string().max(60).optional(),
  flatId: z.string().regex(objectId).optional(),
  blockId: z.string().regex(objectId).optional(),
  assetId: z.string().regex(objectId).optional(),
  visibility: z.enum(['PERSONAL', 'COMMUNITY']).optional(),
  viaChannel: z.enum(['APP', 'MANAGER', 'GUARD']).optional(),
  // Who a conduct complaint is about. Two, because an employee has a staff row
  // and a committee member has none — and a conduct complaint about a committee
  // member was the case the protection could never cover.
  aboutStaffId: z.string().regex(objectId).optional(),
  aboutUserId: z.string().regex(objectId).optional(),
});

export const rejectSchema = z.object({
  // Required. A rejection with no reason is the fastest way to make somebody
  // stop using the system and start knocking on the office door instead.
  reason: z.string().min(1, 'Why is this not being taken forward?').max(1000),
});

export const duplicateSchema = z.object({
  ofId: z.string().regex(objectId, 'Which ticket is this the same as?'),
});

export const assignComplaintSchema = z.object({
  // Null unassigns, which is different from not sending the field.
  staffId: z.string().regex(objectId).nullable().optional(),
});

export const respondSchema = z.object({
  note: z.string().min(1, 'Say something — silence is what residents complain about').max(2000),
  // A reply can carry a picture too. "It looks like this behind the panel" is
  // worth more to a resident than the paragraph explaining it, and the event
  // model has always had somewhere to put it.
  photoKeys: z.array(z.string().max(300)).max(6).optional(),
});

export const pauseSchema = z.object({
  // A closed list. Free text would make every ticket pausable for anything.
  reason: z.enum(PAUSE_REASONS),
});

export const workDoneSchema = z.object({
  note: z.string().max(2000).optional(),
  photoKeys: z.array(z.string().max(300)).max(6).optional(),
});

export const reopenSchema = z.object({
  reason: z.string().min(1, 'Why is it not fixed?').max(1000),
});

/**
 * The two conversation channels.
 *
 * Identical shapes on purpose — a resident's message and a staff note carry the
 * same things — but they are two schemas because they guard two ROUTES with two
 * permissions, and collapsing them would make it a one-line edit to accidentally
 * open the internal channel to residents. The audiences differ, so the doors do.
 */
export const commentSchema = z.object({
  note: z.string().min(1, 'Say something — an empty message helps nobody').max(2000),
  photoKeys: z.array(z.string().max(300)).max(6).optional(),
});

export const internalNoteSchema = z.object({
  note: z.string().min(1, 'An empty note records nothing').max(2000),
  photoKeys: z.array(z.string().max(300)).max(6).optional(),
});

export const rateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  feedback: z.string().max(1000).optional(),
});

export const createAssetSchema = z.object({
  name: z.string().min(1, 'What is it called?').max(120),
  category: z.enum(ASSET_CATEGORIES),
  blockId: z.string().regex(objectId).optional(),
  location: z.string().max(120).optional(),
  vendorId: z.string().regex(objectId).optional(),
  amcExpiresOn: dateish.optional(),
  notes: z.string().max(1000).optional(),
});

export const updateAssetSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  location: z.string().max(120).optional(),
  vendorId: z.string().regex(objectId).nullable().optional(),
  amcExpiresOn: dateish.nullable().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});
