import mongoose, { Schema, Document } from 'mongoose';

/**
 * Everything a society decides about its gate, its complaints and its staff.
 *
 * Modelled on `FinancePolicy`: one lazily-created document per society, every
 * rule in one place, and the same hard-won lesson about defaults — see
 * `modules` below.
 */

/** The optional parts of operations. */
export const OPS_MODULES = ['GATE', 'COMPLAINTS', 'STAFF', 'ASSETS'] as const;
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
export type ExitMode = 'MANUAL' | 'SCAN' | 'AUTO_EXPIRE';
export type ApprovalMode = 'NONE' | 'NOTIFY_ONLY' | 'REQUIRED';
export type TimeoutAction = 'HOLD' | 'GUARD_DECIDES' | 'AUTO_DENY';
export type ApproverRule = 'ANY_ADULT' | 'HEAD_ONLY' | 'OWNER_ONLY';

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
      /** Aadhaar is deliberately absent — see the module doc. */
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

  guardApp: {
    language: string;
    offlineQueueEnabled: boolean;
    shiftBoundSession: boolean;
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
      allowedIdTypes: { type: [String], default: () => ['DRIVING_LICENCE', 'VOTER_ID', 'PASSPORT', 'EMPLOYEE_ID'] },
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
  },

  privacy: {
    retentionDays: { type: Number, default: 90, min: 30, max: 180 },
    residentSeesOwnFlatOnly: { type: Boolean, default: true },
    purgePhotosWithEntry: { type: Boolean, default: true },
  },

  guardApp: {
    language: { type: String, default: 'en' },
    offlineQueueEnabled: { type: Boolean, default: true },
    shiftBoundSession: { type: Boolean, default: false },
  },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

export const SocietyOpsPolicy = mongoose.model<ISocietyOpsPolicy>('SocietyOpsPolicy', SocietyOpsPolicySchema);
export default SocietyOpsPolicy;
