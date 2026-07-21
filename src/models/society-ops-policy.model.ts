import mongoose, { Schema, Document } from 'mongoose';

/**
 * Everything a society decides about its gate, its complaints and its staff.
 *
 * Modelled on `FinancePolicy`: one lazily-created document per society, every
 * rule in one place, and the same hard-won lesson about defaults — see
 * `modules` below.
 */

/** The optional parts of operations. */
export const OPS_MODULES = ['GATE', 'COMPLAINTS', 'STAFF', 'ASSETS', 'PARKING'] as const;
export type OpsModule = typeof OPS_MODULES[number];

/**
 * How much of the gate a society wants.
 *
 * A twenty-flat society replacing a paper register needs entry and nothing
 * else; a five-hundred-flat one wants passes and scanning. A preset is just a
 * set of toggles applied in one click — every switch stays independently
 * changeable afterwards, so any combination remains reachable without making
 * anybody start from thirty questions.
 */
export type GateLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'CUSTOM';

export type CaptureRule = 'OFF' | 'OPTIONAL' | 'REQUIRED';

/**
 * How a visit ENDS.
 *
 *   MANUAL      — somebody at the gate taps "left".
 *   SCAN        — the visitor's code is scanned on the way out.
 *   AUTO_EXPIRE — nobody records departures; the register closes each visit at
 *                 its expected departure time and says so. Read by
 *                 `sweepOverstays`, which in this mode closes the visit instead
 *                 of nagging the host about it — an auto-closed exit is stamped
 *                 `isEstimated`, so the reconciliation accuracy figure still
 *                 counts it as a guess rather than a recorded departure.
 *
 * AUTO_EXPIRE was a promised behaviour with no implementation for the whole
 * life of this module: a society could pick it, save it, and get MANUAL.
 */
export type ExitMode = 'MANUAL' | 'SCAN' | 'AUTO_EXPIRE';

/**
 * The identity documents a gate may ask a visitor for.
 *
 * **Aadhaar is deliberately absent and must stay absent.** It is the document
 * every incumbent asks for and the one no society has any business collecting
 * at a gate; keeping it out of this list is what stops `allowedIdTypes` from
 * being configured into a UIDAI problem by a well-meaning admin.
 *
 * `gate.capture.allowedIdTypes` is a subset of this, and `createEntry` refuses
 * anything outside it — before this list was enforced, `idType` was a free
 * string stored exactly as sent, so the setting described a rule the register
 * did not keep.
 */
export const ID_PROOF_TYPES = ['DRIVING_LICENCE', 'VOTER_ID', 'PASSPORT', 'EMPLOYEE_ID'] as const;
export type IdProofType = typeof ID_PROOF_TYPES[number];

/** How each is said out loud, for a message a guard reads at 10pm. */
export const ID_PROOF_LABELS: Record<string, string> = {
  DRIVING_LICENCE: 'driving licence',
  VOTER_ID: 'voter ID',
  PASSPORT: 'passport',
  EMPLOYEE_ID: 'employee ID card',
};
export type ApprovalMode = 'NONE' | 'NOTIFY_ONLY' | 'REQUIRED';
export type TimeoutAction = 'HOLD' | 'GUARD_DECIDES' | 'AUTO_DENY';
export type ApproverRule = 'ANY_ADULT' | 'HEAD_ONLY' | 'OWNER_ONLY';

/**
 * Who answers for a flat nobody lives in.
 *
 * This is the policy behind the bug a resident actually reported: a visitor for
 * the empty flat next door pinged **every serving committee member, society
 * wide**, with no flat named and a link to a log that — for them — was clamped
 * to their own home. An unexplained alert about a visit you cannot see reads as
 * surveillance even when it is a duty.
 *
 * The ladder, tried in order, each rung falling through to the next when it
 * resolves to nobody:
 *
 *   OWNER_OF_RECORD — the default, and the honest answer. A vacant flat still
 *                     has an owner, and they are the right person to ask about
 *                     their own property. Nobody else has any basis to say yes.
 *   DUTY_ROSTER     — "whoever is responsible this week", by name and per wing.
 *   NAMED_MEMBERS   — the specific people this society appointed for this.
 *   COMMITTEE_ALL   — the old behaviour, kept only as a deliberate, explicit
 *                     choice. It is a last resort, not a default.
 */
export type VacantFlatHandler = 'OWNER_OF_RECORD' | 'DUTY_ROSTER' | 'NAMED_MEMBERS' | 'COMMITTEE_ALL';

export const VISITOR_CATEGORIES = ['GUEST', 'DELIVERY', 'CAB', 'HOUSEHOLD_STAFF', 'CONTRACTOR', 'OTHER'] as const;
export type VisitorCategory = typeof VISITOR_CATEGORIES[number];

/**
 * A resident's own movement, which is NOT a visitor category and is kept out
 * of `VISITOR_CATEGORIES` on purpose.
 *
 * Everything that iterates the visitor categories — the approval rules a
 * society sets per category, the expected-stay table, the "which categories do
 * we record" list — would otherwise silently acquire a row for residents, and
 * the first society to see "Approval required: RESIDENT" in their settings
 * would reasonably conclude the software thinks residents need permission to
 * enter their own home.
 *
 * It is recorded only when `gate.residents.logMovement` is switched on, and
 * `createEntry` refuses it outright otherwise.
 */
export const RESIDENT_MOVEMENT = 'RESIDENT' as const;

export interface IApprovalRule {
  mode: ApprovalMode;
  timeoutSeconds: number;
  onTimeout: TimeoutAction;
  whoCanApprove: ApproverRule;
  allowGuardOverride: boolean;
  overrideRequiresReason: boolean;
}

export interface ISocietyOpsPolicy extends Document {
  societyId: mongoose.Types.ObjectId;

  /**
   * Which optional parts this society uses.
   *
   * ⚠️ NO schema default, and the reason is a scar. `undefined` means "never
   * chosen" and lets the service infer from the society's own data; `[]` means
   * "chose nothing". A `default: []` collapses those two, and the day this
   * ships every society already using the gate would find its screens gone —
   * which reads as data loss even though nothing was lost. Exactly the same
   * decision, for exactly the same reason, as `FinancePolicy.modules`.
   */
  modules?: string[];

  /**
   * Set when `modules` was WORKED OUT rather than chosen.
   *
   * Without this the inference is a one-way door: it writes its guess into
   * `modules`, and from then on that guess is indistinguishable from an admin
   * who deliberately switched everything else off — so a later improvement to
   * the inference, or a new module, can never reach a society that was
   * inferred once. That is precisely how Staff and Complaints came to be
   * invisible to societies created before they existed.
   *
   * While this is set, `resolveOpsModules` re-infers every time. The first
   * explicit save from the settings screen clears it, and from that moment the
   * society's own choice is final.
   */
  modulesInferredAt?: Date;

  gate: {
    level: GateLevel;

    capture: {
      photo: CaptureRule;
      /**
       * Default OPTIONAL, not REQUIRED. Under the DPDP Act a visitor is a data
       * principal too, and consent given under threat of being turned away is
       * not free consent. Every incumbent demands a phone number; that is a
       * compliance gap, not a feature to copy.
       */
      phone: CaptureRule;
      idProof: CaptureRule;
      /**
       * Which of `ID_PROOF_TYPES` this society accepts. Aadhaar is deliberately
       * absent from the universe itself — see `ID_PROOF_TYPES`.
       *
       * Enforced by `assertEntryAllowed`: an entry naming anything else is
       * refused rather than stored. An empty list is read as "no ID is
       * acceptable", which only a society with `idProof: OFF` can mean, so the
       * validator will not save one.
       */
      allowedIdTypes: string[];
      categoriesEnabled: string[];
    };

    exit: {
      trackExit: boolean;
      /**
       * When the society actually answered "do you record people leaving?".
       *
       * `trackExit` defaults to true, so its value alone cannot tell an answer
       * from a default — and the setup checklist needs exactly that difference.
       */
      answeredAt?: Date;
      mode: ExitMode;
      /** Minutes after the expected stay before the gate is told. */
      overstayAlertAfterMinutes: number;
      /** Hour of night the day's stragglers are closed off. 0–23. */
      autoCloseAtHour: number;
      autoCloseNotifyCommittee: boolean;
      /** Expected stay per category, in minutes. Gives exit a forcing function. */
      expectedStayMinutes: Map<string, number>;
    };

    /** One rule per visitor category — a cab is not a contractor. */
    approval: Map<string, IApprovalRule>;

    vehicles: { track: boolean; trackExit: boolean; residentRegistry: boolean };

    /**
     * Default false, and it stays false unless a society deliberately says
     * otherwise. Logging where residents come and go is surveillance, and it is
     * the single loudest complaint against the incumbents.
     */
    residents: { logMovement: boolean; logVehicleOnly: boolean };

    /**
     * See `VacantFlatHandler`. Read by `whoToAsk`, which is the only place the
     * question "who answers for this flat" is ever asked.
     *
     * `namedUserIds` is used only by NAMED_MEMBERS, and an empty list there
     * falls through rather than notifying nobody — a society that picked a
     * handler and then never filled it in must not silently lose every alert
     * about its empty flats.
     */
    vacantFlat: { handler: VacantFlatHandler; namedUserIds: mongoose.Types.ObjectId[] };
  };

  privacy: {
    /** Entries and their photos are purged after this many days. */
    retentionDays: number;
    /**
     * Not configurable, and stored only so the screens can state it. A resident
     * seeing a neighbour's visitor log is the failure that actually happened to
     * a real society, and no society gets to switch that back on.
     */
    residentSeesOwnFlatOnly: boolean;
    purgePhotosWithEntry: boolean;
  };

  /**
   * `shiftBoundSession` used to live here — a switch that promised a guard's
   * login would end with their shift and was read by nothing, settable by
   * nothing, and drawn by no screen. Ending a session with a shift belongs to
   * the auth layer and the staff rota, not to a boolean in the gate settings,
   * and shipping the boolean without them told societies they had a control
   * they did not have. It is gone rather than deprecated (§I-E: a switch that
   * changes nothing is worse than no switch). Nothing else read it, so no
   * migration is needed; stray `false` values on existing documents are ignored
   * by Mongoose and cost nothing.
   */
  guardApp: {
    language: string;
    offlineQueueEnabled: boolean;
  };

  /**
   * What the parking wizard was told, in the wizard's own terms.
   *
   * Note what is NOT here: a rate table, a slot list, or anything the invoice
   * generator reads. `chargeable` and the amounts exist so the wizard can
   * CREATE AND MAINTAIN AN ORDINARY CHARGE HEAD — `category: PARKING`,
   * `pricingMode: PER_QUANTITY`, `quantityKey: parkingSlots` — and everything
   * downstream (the invoice PDF, GST, the 4120 ledger account, defaulter
   * notices, My Bills) then works with no changes at all. A parallel billing
   * path here would have been quicker to write and would have had to be taught
   * every one of those things separately, badly.
   *
   * Switching parking to free deactivates that head; it is never deleted, so
   * last year's invoices still explain themselves.
   */
  parking: {
    chargeable: boolean;
    /** 'YEARLY' pairs with `annualBillingMonth` on the charge head itself. */
    billingFrequency: 'MONTHLY' | 'YEARLY';
    /** 1–12. April by default — the start of the Indian financial year. */
    annualBillingMonth: number;
    perSlotPaise: number;
    /** Absent means two-wheelers are billed at the car rate. */
    twoWheelerPaise?: number;
    /** The heads the wizard owns, so it edits them instead of making more. */
    chargeHeadId?: mongoose.Types.ObjectId;
    twoWheelerChargeHeadId?: mongoose.Types.ObjectId;
  };

  /**
   * What RESIDENTS get — the fourth and last gate.
   *
   * The other three exist already: the plan says what the society bought,
   * `modules` says what it switched on, and `AccessRole` says what the office
   * may do. There was nothing at all for residents: their menu was hardcoded
   * and every resident-facing endpoint was open to every resident, so a
   * society that did not want people inviting their own guests had no way to
   * say so.
   *
   * Plain booleans rather than a permission model, deliberately. A resident is
   * not staff; the question is never "which wing" or "read or write", it is
   * simply whether the society offers the feature to residents at all. One
   * screen of switches an admin can read in ten seconds.
   *
   * Defaults are what an Indian society would actually choose on day one:
   * everything that helps a resident handle their own door is on;
   * `parkingRequest` is off, because most societies want that conversation in
   * person before it becomes a queue.
   */
  residentFeatures: {
    visitorApprove: boolean;
    visitorInvite: boolean;
    visitorHistory: boolean;
    visitorPreferences: boolean;
    complaintRaise: boolean;
    complaintCommunity: boolean;
    vehicleSelfRegister: boolean;
    parkingViewOwn: boolean;
    parkingRequest: boolean;
  };

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const ApprovalRuleSchema = new Schema<IApprovalRule>({
  mode: { type: String, enum: ['NONE', 'NOTIFY_ONLY', 'REQUIRED'], default: 'NOTIFY_ONLY' },
  timeoutSeconds: { type: Number, default: 60, min: 5, max: 600 },
  onTimeout: { type: String, enum: ['HOLD', 'GUARD_DECIDES', 'AUTO_DENY'], default: 'GUARD_DECIDES' },
  whoCanApprove: { type: String, enum: ['ANY_ADULT', 'HEAD_ONLY', 'OWNER_ONLY'], default: 'ANY_ADULT' },
  allowGuardOverride: { type: Boolean, default: true },
  overrideRequiresReason: { type: Boolean, default: true },
}, { _id: false });

const SocietyOpsPolicySchema = new Schema<ISocietyOpsPolicy>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true, unique: true },

  // See the interface. `default: undefined` is not decoration — Mongoose gives
  // every array path an automatic `[]`, so omitting this would quietly make
  // "never chosen" and "chose nothing" the same value, which is the exact
  // distinction this field exists to preserve.
  modules: { type: [String], default: undefined },
  modulesInferredAt: { type: Date },

  gate: {
    level: { type: String, enum: ['L1', 'L2', 'L3', 'L4', 'L5', 'CUSTOM'], default: 'L2' },

    capture: {
      photo: { type: String, enum: ['OFF', 'OPTIONAL', 'REQUIRED'], default: 'OPTIONAL' },
      phone: { type: String, enum: ['OFF', 'OPTIONAL', 'REQUIRED'], default: 'OPTIONAL' },
      idProof: { type: String, enum: ['OFF', 'OPTIONAL', 'REQUIRED'], default: 'OFF' },
      allowedIdTypes: {
        type: [String],
        enum: ID_PROOF_TYPES as unknown as string[],
        default: () => [...ID_PROOF_TYPES],
      },
      categoriesEnabled: { type: [String], default: () => [...VISITOR_CATEGORIES] },
    },

    exit: {
      trackExit: { type: Boolean, default: true },
      answeredAt: { type: Date },
      mode: { type: String, enum: ['MANUAL', 'SCAN', 'AUTO_EXPIRE'], default: 'MANUAL' },
      overstayAlertAfterMinutes: { type: Number, default: 60, min: 5 },
      autoCloseAtHour: { type: Number, default: 23, min: 0, max: 23 },
      autoCloseNotifyCommittee: { type: Boolean, default: true },
      expectedStayMinutes: {
        type: Map, of: Number,
        default: () => new Map<string, number>([
          ['DELIVERY', 15], ['CAB', 15], ['GUEST', 240],
          ['HOUSEHOLD_STAFF', 480], ['CONTRACTOR', 480], ['OTHER', 240],
        ]),
      },
    },

    approval: {
      type: Map, of: ApprovalRuleSchema,
      default: () => new Map<string, any>(),
    },

    vehicles: {
      track: { type: Boolean, default: false },
      trackExit: { type: Boolean, default: false },
      residentRegistry: { type: Boolean, default: false },
    },

    residents: {
      logMovement: { type: Boolean, default: false },
      logVehicleOnly: { type: Boolean, default: false },
    },

    vacantFlat: {
      // OWNER_OF_RECORD, not COMMITTEE_ALL. The old behaviour is still
      // reachable, but a society now has to choose it — because "tell the whole
      // committee about a flat none of them can speak for" was never a decision
      // anybody made; it was the only branch that existed.
      handler: {
        type: String,
        enum: ['OWNER_OF_RECORD', 'DUTY_ROSTER', 'NAMED_MEMBERS', 'COMMITTEE_ALL'],
        default: 'OWNER_OF_RECORD',
      },
      namedUserIds: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
    },
  },

  privacy: {
    retentionDays: { type: Number, default: 90, min: 30, max: 180 },
    residentSeesOwnFlatOnly: { type: Boolean, default: true },
    purgePhotosWithEntry: { type: Boolean, default: true },
  },

  guardApp: {
    language: { type: String, default: 'en' },
    offlineQueueEnabled: { type: Boolean, default: true },
  },

  parking: {
    // Free by default. Many societies allot parking carefully and charge
    // nothing for it, and a module that starts by billing everybody is one an
    // admin switches straight back off.
    chargeable: { type: Boolean, default: false },
    billingFrequency: { type: String, enum: ['MONTHLY', 'YEARLY'], default: 'MONTHLY' },
    annualBillingMonth: { type: Number, default: 4, min: 1, max: 12 },
    perSlotPaise: { type: Number, default: 0, min: 0 },
    twoWheelerPaise: { type: Number, min: 0 },
    chargeHeadId: { type: Schema.Types.ObjectId, ref: 'ChargeHead' },
    twoWheelerChargeHeadId: { type: Schema.Types.ObjectId, ref: 'ChargeHead' },
  },

  residentFeatures: {
    visitorApprove: { type: Boolean, default: true },
    visitorInvite: { type: Boolean, default: true },
    visitorHistory: { type: Boolean, default: true },
    visitorPreferences: { type: Boolean, default: true },
    complaintRaise: { type: Boolean, default: true },
    complaintCommunity: { type: Boolean, default: true },
    vehicleSelfRegister: { type: Boolean, default: true },
    parkingViewOwn: { type: Boolean, default: true },
    parkingRequest: { type: Boolean, default: false },
  },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

export const SocietyOpsPolicy = mongoose.model<ISocietyOpsPolicy>('SocietyOpsPolicy', SocietyOpsPolicySchema);
export default SocietyOpsPolicy;
