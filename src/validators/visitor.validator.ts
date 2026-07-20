import { z } from 'zod';
import { VISITOR_CATEGORIES, OPS_MODULES } from '../models/society-ops-policy.model';

const objectId = /^[0-9a-fA-F]{24}$/;

export const recordEntrySchema = z.object({
  category: z.enum(VISITOR_CATEGORIES),
  visitorName: z.string().min(1, 'Who is at the gate?').max(120),
  visitorPhone: z.string().max(20).optional(),
  photoKey: z.string().max(300).optional(),
  idType: z.string().max(40).optional(),
  // Only the last four digits are ever stored. A full ID number would be
  // personal data we have no reason to hold, and Aadhaar has no field at all.
  idLast4: z.string().max(4).optional(),
  flatId: z.string().regex(objectId).optional(),
  vehicleNumber: z.string().max(20).optional(),
  vehiclePhotoKey: z.string().max(300).optional(),
  notes: z.string().max(500).optional(),
});

const captureRule = z.enum(['OFF', 'OPTIONAL', 'REQUIRED']);

const approvalRule = z.object({
  mode: z.enum(['NONE', 'NOTIFY_ONLY', 'REQUIRED']).optional(),
  timeoutSeconds: z.number().int().min(5).max(600).optional(),
  onTimeout: z.enum(['HOLD', 'GUARD_DECIDES', 'AUTO_DENY']).optional(),
  whoCanApprove: z.enum(['ANY_ADULT', 'HEAD_ONLY', 'OWNER_ONLY']).optional(),
  allowGuardOverride: z.boolean().optional(),
  overrideRequiresReason: z.boolean().optional(),
});

export const updateOpsPolicySchema = z.object({
  /** Applying a preset replaces the switches it owns and ignores the rest. */
  preset: z.enum(['L1', 'L2', 'L3', 'L4', 'L5']).optional(),
  modules: z.array(z.enum(OPS_MODULES)).optional(),

  gate: z.object({
    capture: z.object({
      photo: captureRule.optional(),
      phone: captureRule.optional(),
      idProof: captureRule.optional(),
      categoriesEnabled: z.array(z.enum(VISITOR_CATEGORIES)).optional(),
    }).optional(),
    exit: z.object({
      trackExit: z.boolean().optional(),
      mode: z.enum(['MANUAL', 'SCAN', 'AUTO_EXPIRE']).optional(),
      overstayAlertAfterMinutes: z.number().int().min(5).max(1440).optional(),
      autoCloseAtHour: z.number().int().min(0).max(23).optional(),
      autoCloseNotifyCommittee: z.boolean().optional(),
      expectedStayMinutes: z.record(z.string(), z.number().int().min(5).max(1440)).optional(),
    }).optional(),
    approval: z.record(z.string(), approvalRule).optional(),
    vehicles: z.object({
      track: z.boolean().optional(),
      trackExit: z.boolean().optional(),
      residentRegistry: z.boolean().optional(),
    }).optional(),
    residents: z.object({
      logMovement: z.boolean().optional(),
      logVehicleOnly: z.boolean().optional(),
    }).optional(),
  }).optional(),

  privacy: z.object({
    // Bounded, not free. Keeping visitor data for years is not a preference a
    // society gets to have under the DPDP Act's storage limitation.
    retentionDays: z.number().int().min(30).max(180).optional(),
    // residentSeesOwnFlatOnly is deliberately absent: it is not settable.
  }).optional(),

  guardApp: z.object({
    language: z.string().max(5).optional(),
    offlineQueueEnabled: z.boolean().optional(),
  }).optional(),
});

/**
 * Asking the flat. Same shape as an entry, minus everything the register adds —
 * the request is about a decision, and asking for an id proof before anybody
 * has agreed to let the person in is the wrong order.
 */
export const askApprovalSchema = z.object({
  flatId: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
  visitorName: z.string().min(1, 'Who is at the gate?').max(120),
  visitorPhone: z.string().max(20).optional(),
  category: z.enum(VISITOR_CATEGORIES),
  photoKey: z.string().max(300).optional(),
  vehicleNumber: z.string().max(20).optional(),
  notes: z.string().max(500).optional(),
});

export const decideApprovalSchema = z.object({
  allow: z.boolean(),
  leaveAtGate: z.boolean().optional(),
});

/**
 * An override without a reason is refused by the SERVICE, not here — whether a
 * reason is needed is the society's own policy, and a validator cannot see it.
 * Validating it here would either reject societies that allow reasonless
 * overrides, or pass ones that do not.
 */
export const overrideApprovalSchema = z.object({
  allow: z.boolean(),
  reason: z.string().max(300).optional(),
});

export const gatePreferenceSchema = z.object({
  flatId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  categoryMode: z.record(z.string(), z.enum(['ASK', 'NOTIFY_ONLY', 'LEAVE_AT_GATE'])).optional(),
  quietHours: z.object({
    fromMinute: z.number().int().min(0).max(1439),
    toMinute: z.number().int().min(0).max(1439),
  }).nullable().optional(),
  expectedVisitors: z.array(z.object({
    name: z.string().min(1).max(120),
    phone: z.string().max(20).optional(),
    note: z.string().max(200).optional(),
  })).max(50).optional(),
});

// ------------------------------------------------------------------ passes

export const issuePassSchema = z.object({
  flatId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  visitorName: z.string().min(1, 'Who are you expecting?').max(120),
  visitorPhone: z.string().max(20).optional(),
  category: z.enum(VISITOR_CATEGORIES),
  purpose: z.string().max(200).optional(),
  validFrom: z.string().refine(v => !Number.isNaN(new Date(v).getTime()), 'Not a date').optional(),
  validTo: z.string().refine(v => !Number.isNaN(new Date(v).getTime()), 'Not a date').optional(),
  // A single pass covering a party of twenty is a party, not an invitation.
  maxUses: z.number().int().min(1).max(20).optional(),
});

export const revokePassSchema = z.object({
  reason: z.string().max(200).optional(),
});

/**
 * One of the two, and the service decides which — a QR carries its own proof,
 * a typed code does not. Requiring exactly one keeps a client from sending a
 * valid code alongside a forged payload and hoping something accepts it.
 */
export const redeemPassSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/, 'A pass code is six digits').optional(),
  payload: z.string().max(2000).optional(),
}).refine(v => !!v.code !== !!v.payload, { message: 'Send either a code or a scanned pass, not both' });

// ------------------------------------------------------ vehicles & blocklist

export const addVehicleSchema = z.object({
  flatId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  number: z.string().min(4, 'That does not look like a registration number').max(25),
  kind: z.enum(['CAR', 'BIKE', 'CYCLE', 'OTHER']).optional(),
  make: z.string().max(60).optional(),
  colour: z.string().max(30).optional(),
  parkingSlot: z.string().max(20).optional(),
});

/**
 * No NAME basis, and that absence is the design.
 *
 * A blocklist keyed on a hand-typed name turns away the wrong Ramesh — which
 * is precisely why MyGate declared the feature unfeasible. The enum stops the
 * idea at the door rather than relying on everyone remembering.
 */
export const blockSchema = z.object({
  basis: z.enum(['PHONE', 'VEHICLE', 'PASS_ISSUER']),
  value: z.string().min(4).max(30),
  label: z.string().max(120).optional(),
  reason: z.string().min(5, 'Please say why — this is kept permanently').max(300),
  approverUserIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).min(1, 'Another committee member has to agree').max(10),
  sourceEntryId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});

export const unblockSchema = z.object({
  reason: z.string().max(300).optional(),
});

export const syncPassesSchema = z.object({
  items: z.array(z.object({
    clientId: z.string().max(64),
    code: z.string().regex(/^[0-9]{6}$/).optional(),
    payload: z.string().max(2000).optional(),
    scannedAt: z.string().refine(v => !Number.isNaN(new Date(v).getTime()), 'Not a date').optional(),
  })).max(200),
});
