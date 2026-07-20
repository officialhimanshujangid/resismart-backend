import { z } from 'zod';
import { PAUSE_REASONS } from '../models/complaint.model';
import { ASSET_CATEGORIES } from '../models/asset.model';

const objectId = /^[0-9a-fA-F]{24}$/;
const dateish = z.string().refine(v => !Number.isNaN(new Date(v).getTime()), 'Not a date');

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
});

export const assignComplaintSchema = z.object({
  // Null unassigns, which is different from not sending the field.
  staffId: z.string().regex(objectId).nullable().optional(),
});

export const respondSchema = z.object({
  note: z.string().min(1, 'Say something — silence is what residents complain about').max(2000),
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
