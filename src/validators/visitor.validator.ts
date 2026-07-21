import { z } from 'zod';
import {
  VISITOR_CATEGORIES, OPS_MODULES, RESIDENT_MOVEMENT, ID_PROOF_TYPES,
} from '../models/society-ops-policy.model';

const objectId = /^[0-9a-fA-F]{24}$/;

export const recordEntrySchema = z.object({
  // RESIDENT is accepted here but is NOT one of the visitor categories — the
  // service refuses it unless the society has switched resident logging on.
  // The check belongs there rather than here because it depends on the
  // society's policy, which a schema cannot see.
  category: z.enum([...VISITOR_CATEGORIES, RESIDENT_MOVEMENT]),
  // Optional, because a resident recorded under `logVehicleOnly` is a plate and
  // a flat — deliberately not a named person. `createEntry` still insists on a
  // name for every actual visitor.
  visitorName: z.string().max(120).optional(),
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
  /**
   * Which physical gate they came in by.
   *
   * Absent from this schema until a verify script caught it, and the failure
   * mode is the quiet one: zod strips unknown keys, so the console sent the
   * gate, the schema dropped it on the floor, and `createEntry` — which reads
   * it, resolves it and stamps a name onto the record — silently fell back to
   * the single-gate default on every single entry. Nothing errored. The gate
   * column was simply always blank, which reads as "we never filled it in"
   * rather than "the software threw it away".
   */
  entryGateId: z.string().regex(objectId).optional(),
  /**
   * Who they came to see, when it is not simply a flat.
   *
   * Absent entirely until now, which is why a visitor for a committee member
   * had nowhere to go: the console could only send `flatId`, so the request
   * resolved to nobody and the entry was invisible to the very person being
   * visited. The service still decides what each kind means — this only says
   * which shapes are allowed through the door.
   */
  hostKind: z.enum(['FLAT', 'COMMITTEE', 'OFFICE', 'STAFF']).optional(),
  hostUserId: z.string().regex(objectId).optional(),
  hostStaffId: z.string().regex(objectId).optional(),
});

/** Marking somebody out, optionally naming the door they left by. */
export const recordExitSchema = z.object({
  exitGateId: z.string().regex(objectId).optional(),
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
      /**
       * Which IDs the gate may ask for — settable at last.
       *
       * The field has existed since the module was written and there was no way
       * to change it and nothing that read it, so every society ran the default
       * list and `idType` was stored exactly as typed. It is a closed enum
       * rather than free text for one reason: Aadhaar. A free-string list would
       * let a society configure "AADHAAR" in ten seconds, and the whole point of
       * `ID_PROOF_TYPES` is that this product does not collect it at a gate.
       *
       * At least one, because an empty list plus `idProof: REQUIRED` is a
       * society whose gate can never admit anybody.
       */
      allowedIdTypes: z.array(z.enum(ID_PROOF_TYPES)).min(1, 'Pick at least one kind of ID.').optional(),
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
    /**
     * Who is asked about a visitor to an empty flat.
     *
     * `COMMITTEE_ALL` is deliberately last and deliberately reachable: it is
     * what the code used to do unconditionally, and a society that genuinely
     * wants it should be able to choose it — as a choice, not as a default
     * nobody knew about.
     */
    vacantFlat: z.object({
      handler: z.enum(['OWNER_OF_RECORD', 'DUTY_ROSTER', 'NAMED_MEMBERS', 'COMMITTEE_ALL']).optional(),
      namedUserIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).max(20).optional(),
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

// ------------------------------------------------------------- duty roster

/**
 * One seat on the rota: a person, a day, a shift, and optionally a wing.
 *
 * `blockId` is nullable rather than merely optional because clearing it is a
 * real edit — "this is not D Wing's problem any more, it is the whole society's"
 * — and an optional-only field cannot express it: an absent key on a PUT has to
 * mean "leave alone", or every partial save would silently unscope the row.
 *
 * `weekday` is 0–6 with 0 = Sunday, matching `Date.prototype.getDay()`. A
 * friendlier enum here would need translating on every read, and the read
 * happens on every visitor to an empty flat.
 */
export const dutyRosterSchema = z.object({
  userId: z.string().regex(objectId, 'Pick the person on duty.'),
  blockId: z.string().regex(objectId).nullable().optional(),
  weekday: z.number().int().min(0).max(6),
  shift: z.enum(['ALL_DAY', 'DAY', 'NIGHT']).optional(),
  notes: z.string().max(300).optional(),
});

/** Everything editable, plus retiring the row. Nothing here may be required. */
export const dutyRosterUpdateSchema = dutyRosterSchema.partial().extend({
  isActive: z.boolean().optional(),
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
  // Same host as the entry. Asking and recording must not be able to disagree
  // about who the visit is for.
  hostKind: z.enum(['FLAT', 'COMMITTEE', 'OFFICE', 'STAFF']).optional(),
  hostUserId: z.string().regex(objectId).optional(),
  hostStaffId: z.string().regex(objectId).optional(),
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
  // What the invitation could not carry. A pass has no photo field, so in a
  // society with `capture.photo: REQUIRED` a scan could never satisfy the rule
  // — every redemption failed, and (before the ordering was fixed) destroyed
  // the invitation on the way. The guard captures it at the gate instead.
  photoKey: z.string().max(300).optional(),
  visitorPhone: z.string().max(20).optional(),
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
    // Required, and now load-bearing: it is the dedupe key that makes a retried
    // sync write one visitor rather than two. A blank one is refused per item
    // in the controller rather than silently treated as its own scan.
    clientId: z.string().min(1, 'Each queued scan needs a client id').max(64),
    code: z.string().regex(/^[0-9]{6}$/).optional(),
    payload: z.string().max(2000).optional(),
    /**
     * A claim about the past, not an instruction.
     *
     * Still accepted, because an offline entry that records the sync time
     * instead of the arrival time makes the evening's register wrong. But the
     * controller clamps a future time to now and refuses anything older than
     * the 12-hour offline window — unbounded, this field let any pass ever
     * issued be replayed forever, which is the exact exposure the signed
     * expiry cap exists to prevent.
     */
    scannedAt: z.string().refine(v => !Number.isNaN(new Date(v).getTime()), 'Not a date').optional(),
  })).max(200),
});
