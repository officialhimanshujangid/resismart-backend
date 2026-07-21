import { z } from 'zod';
import { PARKING_ZONE_KINDS } from '../models/parking-zone.model';
import { SLOT_VEHICLE_KINDS, SLOT_SIZES, SLOT_STATUSES } from '../models/parking-slot.model';
import { ALLOCATION_KINDS } from '../models/parking-allocation.model';

const objectId = /^[0-9a-fA-F]{24}$/;

/**
 * The settings wizard — five plain questions, in the order they are asked.
 *
 * Everything after step 1 is optional here rather than in a chain of dependent
 * schemas, because the service is what actually decides: a society answering
 * "no, we do not manage parking" must not be made to fill in a rate first, and
 * a Zod discriminated union on `manage` would produce "Required" against a
 * field the admin was never shown.
 *
 * The one rule worth catching at the door is the last refine: "we charge for it"
 * with no amount is the answer that would otherwise create a head billing ₹0 per
 * slot and look, on every screen, exactly like working parking.
 */
export const configureParkingSchema = z.object({
  manage: z.boolean(),
  chargeable: z.boolean().optional(),
  billingFrequency: z.enum(['MONTHLY', 'YEARLY']).optional(),
  // April is the default the service applies — the start of the Indian
  // financial year — but the month is bounded here so a typo cannot reach a
  // charge head that then bills in no month of the year at all.
  annualBillingMonth: z.number().int().min(1).max(12).optional(),
  // Paise, like every other amount in the system. Bounded at ₹50,000 for one
  // slot: above that it is a rupees-typed-as-paise mistake, and the flat finds
  // out on an invoice.
  perSlotPaise: z.number().int().min(0).max(50_00_000).optional(),
  // `null` and absent both mean "no, two-wheelers are the same as cars". The
  // wizard submits the whole form each time, so a blank field is an answer.
  twoWheelerPaise: z.number().int().min(0).max(50_00_000).nullable().optional(),
}).refine(v => !(v.manage && v.chargeable) || (v.perSlotPaise ?? 0) > 0, {
  message: 'How much is one slot? Enter an amount, or say parking is free.',
  path: ['perSlotPaise'],
});

export const createZoneSchema = z.object({
  name: z.string().min(1, 'Give the area a name — "Basement 1", "Open compound".').max(60),
  kind: z.enum(PARKING_ZONE_KINDS).optional(),
  blockId: z.string().regex(objectId).optional(),
  levelIndex: z.number().int().min(-10).max(50).optional(),
  // Bounded here as well as on the schema so a fat-fingered wizard run is
  // refused with a sentence rather than a Mongoose validation dump.
  rows: z.number().int().min(1).max(200).optional(),
  cols: z.number().int().min(1).max(200).optional(),
  sortOrder: z.number().int().optional(),
});

export const updateZoneSchema = createZoneSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const bulkSlotsSchema = z.object({
  zoneId: z.string().regex(objectId),
  prefix: z.string().min(1, 'What do the slots start with? "B1-", "S-", "P".').max(10),
  startNumber: z.number().int().min(0).max(9999).optional(),
  count: z.number().int().min(1).max(500),
  padTo: z.number().int().min(1).max(6).optional(),
  startRow: z.number().int().min(1).max(200).optional(),
  startCol: z.number().int().min(1).max(200).optional(),
  perRow: z.number().int().min(1).max(200).optional(),
  vehicleKind: z.enum(SLOT_VEHICLE_KINDS).optional(),
  size: z.enum(SLOT_SIZES).optional(),
  isAccessible: z.boolean().optional(),
  hasEvCharger: z.boolean().optional(),
});

export const updateSlotSchema = z.object({
  // ALLOCATED is deliberately absent. The map follows the allocation, and a
  // status set by hand would claim a holder no allocation has ever heard of —
  // the service refuses it too, but a schema that never offers it is clearer.
  status: z.enum(SLOT_STATUSES).refine(s => s !== 'ALLOCATED', {
    message: 'Allot the slot to a flat instead — the map follows the allocation.',
  }).optional(),
  vehicleKind: z.enum(SLOT_VEHICLE_KINDS).optional(),
  size: z.enum(SLOT_SIZES).optional(),
  isAccessible: z.boolean().optional(),
  hasEvCharger: z.boolean().optional(),
  code: z.string().min(1).max(20).optional(),
  isActive: z.boolean().optional(),
});

export const allocateSchema = z.object({
  slotId: z.string().regex(objectId),
  flatId: z.string().regex(objectId),
  vehicleId: z.string().regex(objectId).optional(),
  kind: z.enum(ALLOCATION_KINDS).optional(),
  chargeable: z.boolean().optional(),
  startDate: z.string().optional(),
});

export const releaseSchema = z.object({
  reason: z.string().max(200).optional(),
});

export const transferSchema = z.object({
  toFlatId: z.string().regex(objectId).optional(),
  toSlotId: z.string().regex(objectId).optional(),
  vehicleId: z.string().regex(objectId).optional(),
  chargeable: z.boolean().optional(),
  reason: z.string().max(200).optional(),
}).refine(v => v.toFlatId || v.toSlotId, {
  message: 'Say what is moving — to which flat, or to which slot.',
});

export const raiseRequestSchema = z.object({
  // Optional, and filled in from the caller's own flat when absent. A resident
  // asking for a slot should not have to know their flat's id, and the
  // controller refuses a flat that is not theirs regardless of what is sent.
  flatId: z.string().regex(objectId).optional(),
  vehicleKind: z.enum(SLOT_VEHICLE_KINDS).optional(),
  note: z.string().max(500).optional(),
});

export const decideRequestSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  slotId: z.string().regex(objectId).optional(),
  chargeable: z.boolean().optional(),
  vehicleId: z.string().regex(objectId).optional(),
  note: z.string().max(500).optional(),
}).refine(v => v.decision !== 'APPROVE' || !!v.slotId, {
  message: 'Pick the slot you are giving them.',
});
