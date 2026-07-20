import mongoose, { Schema, Document } from 'mongoose';

/**
 * How online money reaches the society.
 *
 * `PLATFORM_ROUTE` was removed: `routeAccountId` was stored and validated but
 * never read at payment time — `createPaymentLink` sent no `transfers` array, so
 * no split settlement ever actually happened and it behaved identically to
 * PLATFORM_COLLECT_PAYOUT. A mode that cannot be explained to the society buying
 * it, and does not do what its name says, is worse than no mode at all.
 * Legacy values are migrated in `getOrCreatePolicy`.
 */
export type SettlementMode = 'OFFLINE_ONLY' | 'OWN_KEYS' | 'PLATFORM_COLLECT_PAYOUT';
export type LateFeeMode = 'FLAT' | 'PERCENT_PER_MONTH' | 'PERCENT_PER_ANNUM' | 'SLAB';
export type RoundingMode = 'NONE' | 'NEAREST_RUPEE' | 'CEIL_RUPEE';

export interface INumberingRule {
  prefix: string;
  template: string;   // tokens: {PREFIX} {FY} {FYSHORT} {SEQ}
  padding: number;
}

export interface IFinancePolicy extends Document {
  societyId: mongoose.Types.ObjectId;

  // No `startDay`: `getFinancialYear` starts every FY on the 1st, and a stored
  // day it silently ignored was a promise the engine never kept.
  financialYear: { startMonth: number };
  gstin?: string;
  pan?: string;

  numbering: {
    invoice: INumberingRule;
    receipt: INumberingRule;
    voucher: INumberingRule;
    journal: INumberingRule;
  };

  billing: {
    autoGenerateEnabled: boolean;
    generationDay: number;      // 1-28
    dueDays: number;            // days after generation
  };

  lateFee: {
    enabled: boolean;
    mode: LateFeeMode;
    compounding: 'SIMPLE' | 'COMPOUND';
    flatAmountPaise?: number;
    ratePercent?: number;       // per-month or per-annum depending on mode
    graceDays: number;
    slabs?: { uptoDays: number; ratePercent: number }[];
    capPerInvoicePaise?: number;
    minChargePaise?: number;
    chargeHeadCode: string;     // COA code interest posts to (default 4140)
  };

  reminders: {
    enabled: boolean;
    beforeDueDays: number[];
    afterDueDays: number[];
    channels: ('EMAIL' | 'SMS' | 'WHATSAPP' | 'PUSH')[];
  };

  gst: {
    enabled: boolean;
    defaultRatePercent: number;
    defaultSac: string;
    placeOfSupplyState?: string;
    /**
     * RWA exemption: monthly contribution per member up to this is exempt
     * (₹7,500 under Notification 12/2017-CT(R) as amended). 0 disables the test.
     */
    rwaExemptionPerMemberPaise: number;
    /**
     * What happens once a member's contribution breaches the exemption. The law
     * is genuinely contested and societies follow both readings, so this is a
     * setting rather than a hard-coded assumption:
     *  - FULL_IF_EXCEEDS: GST on the whole amount (CBIC Circular 109/28/2019)
     *  - EXCESS_ONLY:     GST only on the amount above the limit (Madras HC,
     *                     Greenwood Owners Association, 2021 — which read down
     *                     the circular; the department appealed)
     */
    exemptionBasis: 'FULL_IF_EXCEEDS' | 'EXCESS_ONLY';
    /** Below this annual turnover a society need not register at all (₹20 lakh). */
    registrationThresholdPaise: number;
  };

  tds: {
    enabled: boolean;
    /** Unset = nobody ever chose; see the schema note. */
    configured?: boolean;
    defaultSection?: string;
    defaultRatePercent?: number;
  };

  rounding: { mode: RoundingMode; accountCode: string };

  approvals: {
    expenseThresholdPaise: number;   // above this, expense needs a distinct approver
    requireDualControlForReceipts: boolean;
    refundRequiresApproval: boolean;
  };

  settlement: {
    mode: SettlementMode;
    upiId?: string; // shown to residents for offline UPI payment
    ownKeys?: {
      keyId?: string;
      keySecretEnc?: string; keySecretIv?: string; keySecretTag?: string;
      webhookSecretEnc?: string; webhookSecretIv?: string; webhookSecretTag?: string;
    };
    payoutBank?: {
      accountName?: string;
      accountNumberEnc?: string; accountNumberIv?: string; accountNumberTag?: string;
      last4?: string; ifsc?: string; bankName?: string;
    };
  };

  advance: { autoApply: boolean };

  /**
   * How a payment is appropriated within a bill it doesn't cover in full.
   *
   * Money always goes to the oldest bill first; this decides what it settles
   * inside that bill. Bye-laws commonly require the member's dues to be cleared
   * before the penalty, which also stops interest being levied on interest —
   * hence the default. Lenders conventionally do the reverse.
   */
  allocation: { interestOrder: 'PRINCIPAL_FIRST' | 'INTEREST_FIRST' };

  /**
   * Early-payment rebate. Many societies knock a few percent off for a member who
   * settles the year up front. Only ever a suggestion the committee applies — the
   * rebate posts as an explicit adjustment, never silently at allocation time,
   * because a discount nobody approved is a discount nobody can explain.
   */
  rebate: { enabled: boolean; percent: number; withinDays: number };

  /**
   * Which optional parts of the finance module this society uses. Visibility
   * only — nothing here changes what posts or what is billed, so a society can
   * switch one on years later and find its screen exactly where it left it.
   * Unset means "never chosen": `finance-modules.service` decides once from the
   * society's own data rather than hiding screens somebody is already using.
   */
  modules?: string[];

  /**
   * Has this society said where its books start?
   *
   * Not the same question as the period lock below. This one is asked once, at
   * the beginning: what did you already own, owe and hold on the day you began?
   * A society that never answers it can still produce a Balance Sheet — it will
   * simply be wrong, quietly, from the first day.
   *
   * The answer is allowed to be "nothing". A brand new society genuinely has no
   * opening balances, and `declaredEmpty` records that it was asked and said so,
   * which is a different and much more defensible thing than never asking.
   *
   * `completedAt` unset means unanswered — but see `finance-setup.service`,
   * which infers an answer for a society that was already trading before this
   * existed rather than locking it out of its own books.
   */
  setup?: {
    completedAt?: Date;
    completedBy?: mongoose.Types.ObjectId;
    completedByName?: string;
    /** Sections the society explicitly said it had nothing for. */
    declaredEmpty?: string[];
    /** The OPENING voucher this produced, if any balances were actually entered. */
    openingVoucherId?: mongoose.Types.ObjectId;
    /** Set when the answer came from existing data, not from a person. */
    inferredFrom?: Date;
    /**
     * Set when an admin deliberately reopened the question.
     *
     * Stops `resolveSetup` re-inferring an answer out of the society's own
     * opening voucher, which would make reopening a no-op that silently allows
     * a second opening entry to be posted on top of the first.
     */
    reopenedAt?: Date;
  };

  /**
   * Books closed up to and including this date. Once a year is audited and
   * presented at the AGM, a back-dated entry would silently restate figures the
   * members have already been given. Enforced in `postJournal`.
   */
  lock: { lockedUpToDate?: Date; lockedBy?: mongoose.Types.ObjectId; lockedByName?: string; lockedAt?: Date };

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  updatedBy: mongoose.Types.ObjectId;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const NumberingRuleSchema = new Schema<INumberingRule>({
  prefix: { type: String, required: true },
  template: { type: String, required: true, default: '{PREFIX}/{FYSHORT}/{SEQ}' },
  padding: { type: Number, required: true, default: 5 },
}, { _id: false });

const FinancePolicySchema = new Schema<IFinancePolicy>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true, unique: true },

  financialYear: {
    startMonth: { type: Number, min: 1, max: 12, default: 4 },
  },
  gstin: { type: String, trim: true },
  pan: { type: String, trim: true },

  numbering: {
    invoice: { type: NumberingRuleSchema, default: () => ({ prefix: 'INV', template: '{PREFIX}/{FYSHORT}/{SEQ}', padding: 5 }) },
    receipt: { type: NumberingRuleSchema, default: () => ({ prefix: 'RCPT', template: '{PREFIX}/{FYSHORT}/{SEQ}', padding: 5 }) },
    voucher: { type: NumberingRuleSchema, default: () => ({ prefix: 'PV', template: '{PREFIX}/{FYSHORT}/{SEQ}', padding: 5 }) },
    journal: { type: NumberingRuleSchema, default: () => ({ prefix: 'JV', template: '{PREFIX}/{FYSHORT}/{SEQ}', padding: 5 }) },
  },

  billing: {
    autoGenerateEnabled: { type: Boolean, default: false },
    generationDay: { type: Number, min: 1, max: 28, default: 1 },
    dueDays: { type: Number, min: 0, default: 15 },
  },

  lateFee: {
    enabled: { type: Boolean, default: false },
    mode: { type: String, enum: ['FLAT', 'PERCENT_PER_MONTH', 'PERCENT_PER_ANNUM', 'SLAB'], default: 'PERCENT_PER_ANNUM' },
    compounding: { type: String, enum: ['SIMPLE', 'COMPOUND'], default: 'SIMPLE' },
    flatAmountPaise: { type: Number, min: 0 },
    ratePercent: { type: Number, min: 0, default: 21 }, // typical co-op bye-law rate
    graceDays: { type: Number, min: 0, default: 0 },
    slabs: [{ uptoDays: { type: Number }, ratePercent: { type: Number } }],
    capPerInvoicePaise: { type: Number, min: 0 },
    minChargePaise: { type: Number, min: 0 },
    chargeHeadCode: { type: String, default: '4140' },
  },

  reminders: {
    enabled: { type: Boolean, default: false },
    beforeDueDays: { type: [Number], default: [3, 1] },
    afterDueDays: { type: [Number], default: [3, 7, 15] },
    channels: { type: [String], default: ['EMAIL'] },
  },

  gst: {
    enabled: { type: Boolean, default: false },
    defaultRatePercent: { type: Number, default: 18 },
    defaultSac: { type: String, default: '9995' },
    placeOfSupplyState: { type: String },
    rwaExemptionPerMemberPaise: { type: Number, default: 750000 },   // ₹7,500/month
    exemptionBasis: { type: String, enum: ['FULL_IF_EXCEEDS', 'EXCESS_ONLY'], default: 'FULL_IF_EXCEEDS' },
    registrationThresholdPaise: { type: Number, default: 200000000 }, // ₹20 lakh/year
  },

  tds: {
    enabled: { type: Boolean, default: false },
    // Whether anyone has ever actually answered the question above.
    //
    // `enabled` has always defaulted to false while the engine ignored it and
    // deducted from per-vendor settings regardless. So a stored `false` cannot
    // be read as "this society chose no TDS" — it is far more likely nobody was
    // ever asked. Honouring it as a decision would silently stop deduction for
    // societies that had it working, which is statutory under-deduction. This
    // marker keeps "never chosen" distinguishable from "chosen off", exactly as
    // `modules` does; `resolveTdsEnabled` infers the answer once from the
    // society's own vendors and writes it down.
    configured: { type: Boolean },
    defaultSection: { type: String },
    defaultRatePercent: { type: Number },
  },

  rounding: {
    mode: { type: String, enum: ['NONE', 'NEAREST_RUPEE', 'CEIL_RUPEE'], default: 'NONE' },
    accountCode: { type: String, default: '4900' },
  },

  approvals: {
    expenseThresholdPaise: { type: Number, default: 0 },
    requireDualControlForReceipts: { type: Boolean, default: false },
    refundRequiresApproval: { type: Boolean, default: true },
  },

  settlement: {
    mode: { type: String, enum: ['OFFLINE_ONLY', 'OWN_KEYS', 'PLATFORM_COLLECT_PAYOUT'], default: 'OFFLINE_ONLY' },
    upiId: { type: String, trim: true },
    ownKeys: {
      keyId: { type: String },
      keySecretEnc: { type: String }, keySecretIv: { type: String }, keySecretTag: { type: String },
      webhookSecretEnc: { type: String }, webhookSecretIv: { type: String }, webhookSecretTag: { type: String },
    },
    payoutBank: {
      accountName: { type: String, trim: true },
      accountNumberEnc: { type: String }, accountNumberIv: { type: String }, accountNumberTag: { type: String },
      last4: { type: String }, ifsc: { type: String, trim: true }, bankName: { type: String, trim: true },
    },
  },

  advance: { autoApply: { type: Boolean, default: true } },

  allocation: {
    interestOrder: { type: String, enum: ['PRINCIPAL_FIRST', 'INTEREST_FIRST'], default: 'PRINCIPAL_FIRST' },
  },

  rebate: {
    enabled: { type: Boolean, default: false },
    percent: { type: Number, default: 5, min: 0, max: 100 },
    withinDays: { type: Number, default: 15, min: 0 },
  },

  // "Unset" and "none chosen" must stay distinguishable, or an existing society
  // would have its screens hidden the day this shipped.
  //
  // `default: undefined` is load-bearing and easy to lose. Mongoose gives EVERY
  // array path an automatic default of `[]`, so simply omitting a default here
  // silently produced `[]` on every fresh policy — which meant a society that
  // deliberately switched every module off had its choice re-inferred away on
  // the very next read. The comment above described an intention the schema was
  // not actually implementing.
  modules: { type: [String], default: undefined },

  // Same reasoning as `modules`: no defaults anywhere in here. An empty
  // `declaredEmpty` would read as "asked, nothing to declare" when the truth is
  // "never asked", and `completedAt` is the only thing that separates them.
  setup: {
    completedAt: { type: Date },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    completedByName: { type: String },
    declaredEmpty: { type: [String] },
    openingVoucherId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    inferredFrom: { type: Date },
    reopenedAt: { type: Date },
  },

  lock: {
    lockedUpToDate: { type: Date },
    lockedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    lockedByName: { type: String },
    lockedAt: { type: Date },
  },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

export const FinancePolicy = mongoose.model<IFinancePolicy>('FinancePolicy', FinancePolicySchema);
export default FinancePolicy;
