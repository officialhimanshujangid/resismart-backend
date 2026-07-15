import mongoose, { Schema, Document } from 'mongoose';

export type SettlementMode = 'OFFLINE_ONLY' | 'OWN_KEYS' | 'PLATFORM_ROUTE' | 'PLATFORM_COLLECT_PAYOUT';
export type LateFeeMode = 'FLAT' | 'PERCENT_PER_MONTH' | 'PERCENT_PER_ANNUM' | 'SLAB';
export type RoundingMode = 'NONE' | 'NEAREST_RUPEE' | 'CEIL_RUPEE';

export interface INumberingRule {
  prefix: string;
  template: string;   // tokens: {PREFIX} {FY} {FYSHORT} {SEQ}
  padding: number;
}

export interface IFinancePolicy extends Document {
  societyId: mongoose.Types.ObjectId;

  financialYear: { startMonth: number; startDay: number };
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
  };

  tds: {
    enabled: boolean;
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
    routeAccountId?: string;
    payoutBank?: {
      accountName?: string;
      accountNumberEnc?: string; accountNumberIv?: string; accountNumberTag?: string;
      last4?: string; ifsc?: string; bankName?: string;
    };
    payoutFundAccountId?: string;
  };

  advance: { autoApply: boolean };

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
    startDay: { type: Number, min: 1, max: 28, default: 1 },
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
  },

  tds: {
    enabled: { type: Boolean, default: false },
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
    mode: { type: String, enum: ['OFFLINE_ONLY', 'OWN_KEYS', 'PLATFORM_ROUTE', 'PLATFORM_COLLECT_PAYOUT'], default: 'OFFLINE_ONLY' },
    upiId: { type: String, trim: true },
    ownKeys: {
      keyId: { type: String },
      keySecretEnc: { type: String }, keySecretIv: { type: String }, keySecretTag: { type: String },
      webhookSecretEnc: { type: String }, webhookSecretIv: { type: String }, webhookSecretTag: { type: String },
    },
    routeAccountId: { type: String },
    payoutBank: {
      accountName: { type: String, trim: true },
      accountNumberEnc: { type: String }, accountNumberIv: { type: String }, accountNumberTag: { type: String },
      last4: { type: String }, ifsc: { type: String, trim: true }, bankName: { type: String, trim: true },
    },
    payoutFundAccountId: { type: String },
  },

  advance: { autoApply: { type: Boolean, default: true } },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByName: { type: String, required: true },
}, { timestamps: true });

export const FinancePolicy = mongoose.model<IFinancePolicy>('FinancePolicy', FinancePolicySchema);
export default FinancePolicy;
