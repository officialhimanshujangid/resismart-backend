import { z } from 'zod';

export const updateFinanceSettingsSchema = z.object({
  wantPaymentOnline: z.boolean().optional(),
  autoBillingEnabled: z.boolean().optional(),
  billingGenerationDay: z.number().min(1).max(28).optional(),
  billDueDays: z.number().min(0).optional(),
  billPrefix: z.string().optional(),
  
  lateFeeEnabled: z.boolean().optional(),
  lateFeeGraceDays: z.number().min(0).optional(),
  lateFeePercent: z.number().min(0).optional(),
  lateFeeMode: z.enum(['SIMPLE', 'COMPOUND']).optional(),
  lateFeeCap: z.number().min(0).optional(),

  reminderEnabled: z.boolean().optional(),
  reminderDaysBeforeDue: z.array(z.number().min(1)).optional(),
  reminderDaysAfterDue: z.array(z.number().min(1)).optional(),

  billTemplates: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      category: z.enum(['MAINTENANCE', 'CORPUS', 'SPECIAL', 'UTILITY', 'CUSTOM']),
      pricingMode: z.enum(['UNIFORM', 'PER_FLAT_SIZE']),
      uniformAmountPaise: z.number().min(0).optional(),
      perSizeAmounts: z.array(
        z.object({
          flatSizeId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid flat size ID'),
          label: z.string(),
          amountPaise: z.number().min(0)
        })
      ).optional(),
      applicableTo: z.enum(['ALL', 'OWNER_OCCUPIED', 'RENTED', 'VACANT']),
      isRecurring: z.boolean(),
      isActive: z.boolean().optional()
    })
  ).optional()
});

export const setupBankDetailsSchema = z.object({
  accountName: z.string().min(1),
  accountNumber: z.string().min(5),
  ifsc: z.string().min(11).max(11),
  bankName: z.string().min(1)
});

export const generateBillsSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'Period must be in YYYY-MM format').optional(),
  templateIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
  flatIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
  dryRun: z.boolean().optional()
});

export const reportOfflinePaymentSchema = z.object({
  method: z.enum(['UPI', 'CASH', 'BANK_TRANSFER', 'CHEQUE', 'OTHER']),
  amountPaise: z.number().min(1),
  referenceNote: z.string().optional(),
  paymentDate: z.string().datetime().optional()
});

export const rejectOfflinePaymentSchema = z.object({
  rejectionReason: z.string().min(1, "Reason is required")
});

const objectId = /^[0-9a-fA-F]{24}$/;

export const postJournalSchema = z.object({
  voucherType: z.enum(['JOURNAL', 'OPENING', 'CONTRA']).optional(),
  entryDate: z.string().datetime().optional(),
  narration: z.string().max(500).optional(),
  lines: z.array(z.object({
    accountCode: z.string().min(1, 'accountCode is required'),
    debitPaise: z.number().int().min(0).optional(),
    creditPaise: z.number().int().min(0).optional(),
    flatId: z.string().regex(objectId, 'Invalid flat id').optional(),
    description: z.string().max(300).optional(),
  })).min(2, 'A journal entry needs at least two lines'),
});

// ---- Phase 2: charge heads, policy, invoice generation ----

const chargeCategoryEnum = z.enum([
  'MAINTENANCE', 'SINKING_FUND', 'REPAIR_FUND', 'CORPUS', 'WATER', 'PARKING',
  'FESTIVAL', 'NON_OCCUPANCY', 'UTILITY', 'ADHOC', 'OTHER',
]);

const applicabilitySchema = z.object({
  occupancy: z.array(z.enum(['ALL', 'OWNER_OCCUPIED', 'RENTED', 'VACANT'])).optional(),
  blockIds: z.array(z.string().regex(objectId)).optional(),
  flatIds: z.array(z.string().regex(objectId)).optional(),
  exemptFlatIds: z.array(z.string().regex(objectId)).optional(),
});

export const createChargeHeadSchema = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  category: chargeCategoryEnum,
  pricingMode: z.enum(['UNIFORM', 'PER_FLAT_SIZE', 'PER_SQFT', 'METERED', 'PERCENTAGE', 'FLAT_ADHOC']),
  uniformAmountPaise: z.number().int().min(0).optional(),
  perSizeAmounts: z.array(z.object({
    flatSizeId: z.string().regex(objectId),
    label: z.string(),
    amountPaise: z.number().int().min(0),
  })).optional(),
  ratePerSqftPaise: z.number().int().min(0).optional(),
  areaBasis: z.enum(['CARPET', 'BUILTUP']).optional(),
  perUnitRatePaise: z.number().int().min(0).optional(),
  meterType: z.string().optional(),
  percentOf: z.enum(['MAINTENANCE', 'BASE']).optional(),
  percentValue: z.number().min(0).max(100).optional(),
  applicability: applicabilitySchema.optional(),
  billTo: z.enum(['OWNER', 'OCCUPANT']).optional(),
  incomeAccountCode: z.string().optional(),
  fundId: z.string().regex(objectId).optional(),
  gstApplicable: z.boolean().optional(),
  gstRatePercent: z.number().min(0).max(28).optional(),
  sacCode: z.string().optional(),
  isRecurring: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const updateChargeHeadSchema = createChargeHeadSchema.partial().omit({ code: true });

const numberingRuleSchema = z.object({
  prefix: z.string().min(1).max(10),
  template: z.string().min(1).max(60),
  padding: z.number().int().min(1).max(10),
});

export const updateFinancePolicySchema = z.object({
  financialYear: z.object({ startMonth: z.number().int().min(1).max(12), startDay: z.number().int().min(1).max(28) }).partial().optional(),
  gstin: z.string().max(20).optional(),
  pan: z.string().max(15).optional(),
  numbering: z.object({
    invoice: numberingRuleSchema.optional(),
    receipt: numberingRuleSchema.optional(),
    voucher: numberingRuleSchema.optional(),
    journal: numberingRuleSchema.optional(),
  }).optional(),
  billing: z.object({
    autoGenerateEnabled: z.boolean(),
    generationDay: z.number().int().min(1).max(28),
    dueDays: z.number().int().min(0),
  }).partial().optional(),
  lateFee: z.object({
    enabled: z.boolean(),
    mode: z.enum(['FLAT', 'PERCENT_PER_MONTH', 'PERCENT_PER_ANNUM', 'SLAB']),
    compounding: z.enum(['SIMPLE', 'COMPOUND']),
    flatAmountPaise: z.number().int().min(0),
    ratePercent: z.number().min(0),
    graceDays: z.number().int().min(0),
    slabs: z.array(z.object({ uptoDays: z.number().int().min(0), ratePercent: z.number().min(0) })),
    capPerInvoicePaise: z.number().int().min(0),
    minChargePaise: z.number().int().min(0),
    chargeHeadCode: z.string(),
  }).partial().optional(),
  reminders: z.object({
    enabled: z.boolean(),
    beforeDueDays: z.array(z.number().int().min(0)),
    afterDueDays: z.array(z.number().int().min(0)),
    channels: z.array(z.enum(['EMAIL', 'SMS', 'WHATSAPP', 'PUSH'])),
  }).partial().optional(),
  gst: z.object({
    enabled: z.boolean(),
    defaultRatePercent: z.number().min(0).max(28),
    defaultSac: z.string(),
    placeOfSupplyState: z.string(),
  }).partial().optional(),
  tds: z.object({
    enabled: z.boolean(),
    defaultSection: z.string(),
    defaultRatePercent: z.number().min(0),
  }).partial().optional(),
  rounding: z.object({
    mode: z.enum(['NONE', 'NEAREST_RUPEE', 'CEIL_RUPEE']),
    accountCode: z.string(),
  }).partial().optional(),
  approvals: z.object({
    expenseThresholdPaise: z.number().int().min(0),
    requireDualControlForReceipts: z.boolean(),
    refundRequiresApproval: z.boolean(),
  }).partial().optional(),
  settlement: z.object({ mode: z.enum(['OFFLINE_ONLY', 'OWN_KEYS', 'PLATFORM_ROUTE', 'PLATFORM_COLLECT_PAYOUT']) }).partial().optional(),
  advance: z.object({ autoApply: z.boolean() }).partial().optional(),
});

export const generateInvoicesSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'Period must be in YYYY-MM format').optional(),
  chargeHeadIds: z.array(z.string().regex(objectId)).optional(),
  flatIds: z.array(z.string().regex(objectId)).optional(),
  dryRun: z.boolean().optional(),
});

// ---- Phase 5: settlement ----
export const updateSettlementSchema = z.object({
  mode: z.enum(['OFFLINE_ONLY', 'OWN_KEYS', 'PLATFORM_ROUTE', 'PLATFORM_COLLECT_PAYOUT']),
  upiId: z.string().max(80).optional(),
  keyId: z.string().max(80).optional(),
  keySecret: z.string().max(200).optional(),
  webhookSecret: z.string().max(200).optional(),
  routeAccountId: z.string().max(80).optional(),
  payoutAccountName: z.string().max(120).optional(),
  payoutAccountNumber: z.string().max(30).optional(),
  payoutIfsc: z.string().max(15).optional(),
  payoutBankName: z.string().max(120).optional(),
});

// ---- Phase 4: expenses & vendors ----

export const createVendorSchema = z.object({
  name: z.string().min(1).max(150),
  contactPerson: z.string().max(120).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().max(150).optional(),
  gstin: z.string().max(20).optional(),
  pan: z.string().max(15).optional(),
  tdsApplicable: z.boolean().optional(),
  tdsSection: z.string().max(20).optional(),
  tdsRatePercent: z.number().min(0).max(30).optional(),
  isActive: z.boolean().optional(),
});
export const updateVendorSchema = createVendorSchema.partial();

export const createExpenseSchema = z.object({
  vendorId: z.string().regex(objectId).optional(),
  category: z.string().max(60).optional(),
  description: z.string().max(500).optional(),
  expenseDate: z.string().datetime().optional(),
  paymentMode: z.enum(['BANK', 'CASH', 'CHEQUE', 'UPI']).optional(),
  tdsPaise: z.number().int().min(0).optional(),
  lineItems: z.array(z.object({
    expenseAccountCode: z.string().min(1),
    description: z.string().max(300).optional(),
    amountPaise: z.number().int().min(1),
    fundId: z.string().regex(objectId).optional(),
  })).min(1, 'At least one expense line is required'),
});

export const payExpenseSchema = z.object({ paymentMode: z.enum(['BANK', 'CASH', 'CHEQUE', 'UPI']).optional() });

// ---- Phase 3: collections & receipts ----

const instrumentSchema = z.object({
  chequeNo: z.string().max(40).optional(),
  bankName: z.string().max(120).optional(),
  chequeDate: z.string().optional(),
}).optional();

export const recordPaymentSchema = z.object({
  flatId: z.string().regex(objectId, 'Invalid flat id'),
  mode: z.enum(['CASH', 'CHEQUE', 'UPI', 'BANK_TRANSFER', 'OTHER']),
  amountPaise: z.number().int().min(1),
  instrument: instrumentSchema,
  referenceNote: z.string().max(300).optional(),
  receiptDate: z.string().datetime().optional(),
});

export const reportOfflineReceiptSchema = z.object({
  mode: z.enum(['CASH', 'CHEQUE', 'UPI', 'BANK_TRANSFER', 'OTHER']),
  amountPaise: z.number().int().min(1),
  instrument: instrumentSchema,
  referenceNote: z.string().max(300).optional(),
});

export const payOnlineSchema = z.object({
  amountPaise: z.number().int().min(1).optional(),
});

export const bounceReceiptSchema = z.object({
  reason: z.string().max(300).optional(),
});

export const createFundSchema = z.object({
  name: z.string().min(1, 'Fund name is required').max(120),
  category: z.enum(['CORPUS', 'SINKING', 'REPAIR', 'SPECIAL', 'GENERAL', 'RESERVE', 'MAINTENANCE_POOL', 'OPENING_BALANCE']),
  description: z.string().max(500).optional(),
  targetAmountPaise: z.number().int().min(0).optional(),
  isInvested: z.boolean().optional(),
});
