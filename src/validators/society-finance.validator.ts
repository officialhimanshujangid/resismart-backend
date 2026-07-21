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

export const createAccountSchema = z.object({
  code: z.string().min(1).max(10).regex(/^[0-9]+$/, 'Account code must be numeric'),
  name: z.string().min(1).max(120),
  type: z.enum(['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'FUND', 'EQUITY']),
  isControlAccount: z.boolean().optional(),
  parentAccountId: z.string().regex(objectId).optional(),
});

export const updateAccountSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  parentAccountId: z.union([z.string().regex(objectId), z.literal('')]).nullable().optional(),
});

export const issueSharesSchema = z.object({
  flatId: z.string().regex(objectId, 'Invalid flat id'),
  memberName: z.string().min(1).max(120),
  memberUserId: z.string().regex(objectId).optional(),
  shareCount: z.number().int().min(1).max(10000),
  faceValuePaise: z.number().int().min(0),
  issuedOn: z.string().optional(),
  receivedIn: z.enum(['BANK', 'CASH']).optional(),
});

export const transferSharesSchema = z.object({
  toMemberName: z.string().min(1).max(120),
  toMemberUserId: z.string().regex(objectId).optional(),
  transferredOn: z.string().optional(),
});

// ---- Phase D: defaulter notices & recovery ----

/**
 * `stage` is optional: the service works out the next one due, and it is the
 * service — not this schema — that refuses a stage which skips a step. Zod can
 * see the shape of one request; only the service can see what has been served.
 */
export const issueNoticeSchema = z.object({
  flatId: z.string().regex(objectId, 'Invalid flat id'),
  stage: z.enum(['FIRST', 'SECOND', 'FINAL', 'RECOVERY_101']).optional(),
  issuedOn: z.string().optional(),
  dueByOn: z.string().optional(),
  deliveredVia: z.array(z.enum(['EMAIL', 'HAND', 'POST'])).optional(),
  notes: z.string().max(1000).optional(),
  recoveryRef: z.string().max(120).optional(),
});

export const resolveNoticeSchema = z.object({
  resolvedOn: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

// ---- Phase D: post-dated cheque register ----

export const registerPdcSchema = z.object({
  flatId: z.string().regex(objectId, 'Invalid flat id').optional(),
  payerName: z.string().min(1, 'Who is the cheque from?').max(120),
  chequeNo: z.string().min(1, 'Cheque number is required').max(30),
  bankName: z.string().min(1, 'Which bank is it drawn on?').max(120),
  chequeDate: z.string().min(1, 'A post-dated cheque needs the date written on it'),
  amountPaise: z.number().int().min(1, 'A cheque must be for a positive amount'),
  notes: z.string().max(500).optional(),
});

export const depositPdcSchema = z.object({
  depositedOn: z.string().optional(),
});

export const pdcStatusSchema = z.object({
  status: z.enum(['HELD', 'DEPOSITED', 'CLEARED', 'BOUNCED', 'RETURNED']),
  reason: z.string().max(300).optional(),
});

export const adjustInvoiceSchema = z.object({
  kind: z.enum(['WAIVER', 'WRITE_OFF', 'REBATE']),
  amountPaise: z.number().int().min(1),
  reason: z.string().min(1, 'A reason is required — this is money the society is giving up').max(300),
  adjustedOn: z.string().optional(),
});

export const requestRefundSchema = z.object({
  flatId: z.string().regex(objectId, 'Invalid flat id'),
  amountPaise: z.number().int().min(1),
  mode: z.enum(['BANK', 'CASH']).optional(),
  reason: z.string().min(1).max(300),
});

/**
 * Budget upsert.
 *
 * `accountName` is deliberately NOT accepted: the service reads it off the
 * ledger. Taking it from the client would let a budget line print a name the
 * chart of accounts never had.
 */
export const upsertBudgetSchema = z.object({
  fy: z.string().regex(/^\d{4}(-\d{4})?$/, "Financial year must look like '2026' or '2026-2027'").optional(),
  // An empty array is valid — it clears the budget back to nothing, which is the
  // only way to undo a budget entered against the wrong year.
  lines: z.array(z.object({
    accountCode: z.string().min(1, 'Every budget line needs an account'),
    budgetedPaise: z.number().int('Budget must be a whole number of paise').min(0, 'A budget cannot be negative'),
  })).max(500, 'A budget cannot have more than 500 lines'),
});

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

const chargeHeadFields = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  category: chargeCategoryEnum,
  pricingMode: z.enum(['UNIFORM', 'PER_FLAT_SIZE', 'PER_BLOCK', 'PER_SQFT', 'METERED', 'PERCENTAGE', 'FLAT_ADHOC', 'PER_QUANTITY']),
  uniformAmountPaise: z.number().int().min(0).optional(),
  perSizeAmounts: z.array(z.object({
    flatSizeId: z.string().regex(objectId),
    label: z.string(),
    amountPaise: z.number().int().min(0),
  })).optional(),
  perBlockAmounts: z.array(z.object({
    blockId: z.string().regex(objectId),
    label: z.string(),
    amountPaise: z.number().int().min(0),
  })).optional(),
  ratePerSqftPaise: z.number().int().min(0).optional(),
  areaBasis: z.enum(['CARPET', 'BUILTUP']).optional(),
  perUnitRatePaise: z.number().int().min(0).optional(),
  meterType: z.string().optional(),
  // PER_QUANTITY — the key of Flat.quantities to bill, e.g. 'parkingSlots'.
  quantityKey: z.string().max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Use a simple key like parkingSlots').optional(),
  percentOf: z.enum(['MAINTENANCE', 'BASE']).optional(),
  percentValue: z.number().min(0).max(100).optional(),
  applicability: applicabilitySchema.optional(),
  billTo: z.enum(['OWNER', 'OCCUPANT']).optional(),
  incomeAccountCode: z.string().optional(),
  // '' / null unlinks the head from its fund (falls back to the category default).
  fundId: z.union([z.string().regex(objectId), z.literal('')]).nullable().optional(),
  gstApplicable: z.boolean().optional(),
  gstRatePercent: z.number().min(0).max(28).optional(),
  sacCode: z.string().optional(),
  countsTowardRwaExemption: z.boolean().optional(),
  isRecurring: z.boolean().optional(),
  // MONTHLY unless said otherwise, so every head that exists keeps its habits.
  billingFrequency: z.enum(['MONTHLY', 'YEARLY']).optional(),
  annualBillingMonth: z.number().int().min(1).max(12).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * The chosen pricing mode must actually be able to price something.
 *
 * Every config field is independently optional, so a PER_SQFT head with no rate,
 * or a PER_FLAT_SIZE head with no amounts, used to save happily and then bill ₹0
 * for ever — the engine drops a zero line, so nobody found out until a member
 * asked why their bill was short. Checked on edit as well as create: switching
 * an existing head to a new mode has to satisfy the new mode.
 */
const pricingCoherence = (v: any, ctx: z.RefinementCtx) => {
  const need = (cond: boolean, path: string, message: string) => {
    if (!cond) ctx.addIssue({ code: 'custom', path: [path], message });
  };
  switch (v.pricingMode) {
    case 'UNIFORM':
    case 'FLAT_ADHOC':
      need(!!v.uniformAmountPaise, 'uniformAmountPaise', 'Set the amount to charge');
      break;
    case 'PER_FLAT_SIZE':
      need(!!v.perSizeAmounts?.length, 'perSizeAmounts', 'Add an amount for at least one flat size');
      break;
    case 'PER_BLOCK':
      need(!!v.perBlockAmounts?.length, 'perBlockAmounts', 'Add an amount for at least one wing');
      break;
    case 'PER_SQFT':
      need(!!v.ratePerSqftPaise, 'ratePerSqftPaise', 'Set the rate per square foot');
      break;
    case 'METERED':
      need(!!v.perUnitRatePaise, 'perUnitRatePaise', 'Set the rate per unit');
      break;
    case 'PER_QUANTITY':
      need(!!v.perUnitRatePaise, 'perUnitRatePaise', 'Set the rate for one unit');
      need(!!v.quantityKey, 'quantityKey', 'Name the per-flat count to bill, e.g. parkingSlots');
      break;
    case 'PERCENTAGE':
      need(!!v.percentValue, 'percentValue', 'Set the percentage to charge');
      need(!!v.percentOf, 'percentOf', 'Choose what the percentage is taken of');
      break;
  }

  // A yearly head with no month would be skipped in all twelve — billed never,
  // silently, which is the same class of failure as a mode with no rate.
  if (v.billingFrequency === 'YEARLY') {
    need(!!v.annualBillingMonth, 'annualBillingMonth', 'Which month do you raise this? Most societies use April.');
  }
};

export const createChargeHeadSchema = chargeHeadFields.superRefine(pricingCoherence);
export const updateChargeHeadSchema = chargeHeadFields.partial().omit({ code: true }).superRefine((v, ctx) => {
  // A partial edit that doesn't touch the mode has nothing to check here; the
  // service re-validates against the stored mode when it merges.
  if (v.pricingMode) pricingCoherence(v, ctx);
});

const numberingRuleSchema = z.object({
  prefix: z.string().min(1).max(10),
  template: z.string().min(1).max(60),
  padding: z.number().int().min(1).max(10),
});

export const updateFinancePolicySchema = z.object({
  financialYear: z.object({ startMonth: z.number().int().min(1).max(12) }).partial().optional(),
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
  }).partial()
    // SLAB with no slabs charges ₹0 interest and says nothing (invoicing.service
    // `computeInterest`). Reject the combination rather than let late fees quietly
    // switch themselves off.
    .refine(lf => !(lf.enabled && lf.mode === 'SLAB' && !lf.slabs?.length), {
      message: 'Slab interest needs at least one slab, otherwise no interest would be charged at all.',
      path: ['slabs'],
    })
    .optional(),
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
    rwaExemptionPerMemberPaise: z.number().int().min(0),
    exemptionBasis: z.enum(['FULL_IF_EXCEEDS', 'EXCESS_ONLY']),
    registrationThresholdPaise: z.number().int().min(0),
  }).partial().optional(),
  // null / '' clears the lock and reopens the books.
  lock: z.object({
    lockedUpToDate: z.union([z.string(), z.literal('')]).nullable().optional(),
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
  settlement: z.object({ mode: z.enum(['OFFLINE_ONLY', 'OWN_KEYS', 'PLATFORM_COLLECT_PAYOUT']) }).partial().optional(),
  advance: z.object({ autoApply: z.boolean() }).partial().optional(),
  allocation: z.object({
    interestOrder: z.enum(['PRINCIPAL_FIRST', 'INTEREST_FIRST']),
  }).partial().optional(),
  rebate: z.object({
    enabled: z.boolean(),
    percent: z.number().min(0).max(100),
    withinDays: z.number().int().min(0),
  }).partial().optional(),
  modules: z.array(z.enum([
    'EXPENSES', 'FUNDS', 'REFUNDS', 'SHARES', 'ASSETS', 'INVESTMENTS',
    'BUDGET', 'BANKING', 'PDC', 'NOTICES', 'ACCOUNTING', 'IMPORT',
  ])).optional(),
});

export const generateInvoicesSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'Period must be in YYYY-MM format').optional(),
  chargeHeadIds: z.array(z.string().regex(objectId)).optional(),
  flatIds: z.array(z.string().regex(objectId)).optional(),
  dryRun: z.boolean().optional(),
  /** Acknowledges that this run pushes a fund past its target. */
  confirmOverTarget: z.boolean().optional(),
});

/**
 * A special demand always names at least one charge head and says why. The
 * period is NOT accepted: it is minted server-side as YYYY-MM-Sn so two
 * demands in one month cannot collide.
 */
export const specialDemandSchema = z.object({
  chargeHeadIds: z.array(z.string().regex(objectId)).min(1, "Choose what you are billing for"),
  flatIds: z.array(z.string().regex(objectId)).optional(),
  blockIds: z.array(z.string().regex(objectId)).optional(),
  title: z.string().min(1, "Say what this demand is for — members will see it").max(150),
  dueDate: z.string().optional(),
  dryRun: z.boolean().optional(),
  confirmOverTarget: z.boolean().optional(),
});

// ---- Phase 5: settlement ----
export const updateSettlementSchema = z.object({
  mode: z.enum(['OFFLINE_ONLY', 'OWN_KEYS', 'PLATFORM_COLLECT_PAYOUT']),
  // Empty clears the field; anything else must be a real VPA — residents' pay-by-QR
  // builds a `upi://pay` link from this, and a malformed value yields a dead QR.
  upiId: z.string().max(80).optional()
    .refine(v => v === undefined || v === '' || /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(v),
      { message: 'Enter a valid UPI ID, e.g. society@okhdfcbank' }),
  keyId: z.string().max(80).optional(),
  keySecret: z.string().max(200).optional(),
  webhookSecret: z.string().max(200).optional(),
  payoutAccountName: z.string().max(120).optional(),
  payoutAccountNumber: z.string().max(30).optional(),
  payoutIfsc: z.string().max(15).optional(),
  payoutBankName: z.string().max(120).optional(),
});

// ---- Phase 4: expenses & vendors ----

/** Blank clears the field; anything else must be a well-formed PAN/GSTIN — a
 *  malformed PAN is worse than a missing one, because Form 26Q silently fails
 *  validation at the TRACES end rather than here. */
const panField = z.string().max(15).optional()
  .refine(v => !v || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v.toUpperCase()),
    { message: 'PAN should look like AABCL1234M' });
const gstinField = z.string().max(20).optional()
  .refine(v => !v || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(v.toUpperCase()),
    { message: 'GSTIN should be 15 characters, e.g. 27AABCL1234M1Z5' });

const vendorBankSchema = z.object({
  accountName: z.string().max(120).optional(),
  /** Sent only when changing it; blank keeps whatever is stored. */
  accountNumber: z.string().max(30).optional()
    .refine(v => !v || /^[0-9]{6,20}$/.test(v), { message: 'Account number should be 6–20 digits' }),
  ifsc: z.string().max(15).optional()
    .refine(v => !v || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.toUpperCase()), { message: 'IFSC should look like HDFC0001234' }),
  bankName: z.string().max(120).optional(),
  upiId: z.string().max(80).optional()
    .refine(v => !v || /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(v), { message: 'Enter a valid UPI ID, e.g. vendor@okicici' }),
}).optional();

const vendorFields = z.object({
  name: z.string().min(1).max(150),
  contactPerson: z.string().max(120).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().max(150).optional()
    .refine(v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), { message: 'Enter a valid email address' }),
  gstin: gstinField,
  pan: panField,
  tdsApplicable: z.boolean().optional(),
  tdsSection: z.string().max(20).optional(),
  tdsRatePercent: z.number().min(0).max(30).optional(),
  // These drive whether tax is withheld at all. They were absent here, so the
  // schema defaults could never be changed — not from the UI, not from the API.
  tdsThresholdSinglePaise: z.number().int().min(0).optional(),
  tdsThresholdAnnualPaise: z.number().int().min(0).optional(),
  bank: vendorBankSchema,
  notes: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
});

/**
 * A vendor set up for TDS but missing its rate or PAN is worse than one with TDS
 * off: the flag reads as "handled" while the society under-deducts all year, and
 * Form 26Q cannot be filed for a deductee with no PAN. Applied to create and
 * update alike — a partial edit that switches TDS on must satisfy it too.
 */
const tdsCoherence = (v: any, ctx: z.RefinementCtx) => {
  if (!v.tdsApplicable) return;
  if (!v.tdsRatePercent) {
    ctx.addIssue({ code: 'custom', path: ['tdsRatePercent'], message: 'Set the TDS rate, or turn TDS off for this vendor' });
  }
  if (!v.pan) {
    ctx.addIssue({ code: 'custom', path: ['pan'], message: 'PAN is required for a TDS vendor — Form 26Q cannot be filed without it' });
  }
};

export const createVendorSchema = vendorFields.superRefine(tdsCoherence);
export const updateVendorSchema = vendorFields.partial().superRefine(tdsCoherence);

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
    blockId: z.string().regex(objectId).optional(),
    staffId: z.string().regex(objectId).optional(),
    // What it was spent on, in operations terms. Optional and descriptive —
    // nothing in the posting logic reads them.
    complaintId: z.string().regex(objectId).optional(),
    assetId: z.string().regex(objectId).optional(),
  })).min(1, 'At least one expense line is required'),
});

export const payExpenseSchema = z.object({ paymentMode: z.enum(['BANK', 'CASH', 'CHEQUE', 'UPI']).optional() });

// ---- Phase C: fixed assets & depreciation ----

// Only the 15xx cost heads. 1590 (Accumulated Depreciation) is the contra that
// depreciation credits — an asset's cost must never be booked there.
const assetAccountCodeEnum = z.enum(['1500', '1510', '1520', '1530', '1540']);

export const createAssetSchema = z.object({
  name: z.string().min(1, 'Asset name is required').max(150),
  description: z.string().max(500).optional(),
  assetAccountCode: assetAccountCodeEnum,
  purchaseDate: z.string().datetime().optional(),
  costPaise: z.number().int().min(1, 'Cost is required'),
  salvageValuePaise: z.number().int().min(0).optional(),
  method: z.enum(['SLM', 'WDV']),
  ratePercent: z.number().min(0).max(100),
  usefulLifeYears: z.number().int().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
});

export const updateAssetSchema = createAssetSchema.partial();

export const runDepreciationSchema = z.object({
  upToDate: z.string().datetime().optional(),
});

export const disposeAssetSchema = z.object({
  disposedOn: z.string().optional(),
  proceedsPaise: z.number().int().min(0).optional(),
  receivedIn: z.enum(['BANK', 'CASH']).optional(),
  note: z.string().max(300).optional(),
});

export const reverseDepreciationSchema = z.object({
  reason: z.string().max(300).optional(),
});

// ---- Phase D: fixed deposits & investments ----

export const createInvestmentSchema = z.object({
  bankName: z.string().min(1, 'Bank name is required').max(150),
  accountNumberLast4: z.string().regex(/^\d{4}$/, 'Enter the last 4 digits only').optional(),
  principalPaise: z.number().int().min(1, 'Principal is required'),
  ratePercent: z.number().min(0).max(100),
  startDate: z.string().datetime().optional(),
  maturityDate: z.string().datetime(),
  interestPayout: z.enum(['CUMULATIVE', 'QUARTERLY', 'ON_MATURITY']).optional(),
  // '' unlinks the deposit from its fund — its interest then goes to income.
  linkedFundId: z.union([z.string().regex(objectId), z.literal('')]).nullable().optional(),
  autoRenew: z.boolean().optional(),
});

// Principal and accrued interest are consequences of posted vouchers, so they
// are not editable — omit rather than partial them away.
export const updateInvestmentSchema = createInvestmentSchema.partial().omit({ principalPaise: true });

export const runInterestAccrualSchema = z.object({
  upToDate: z.string().datetime().optional(),
});

export const closeInvestmentSchema = z.object({
  closedOn: z.string().optional(),
  proceedsPaise: z.number().int().min(0).optional(),
});

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
  /**
   * The member knowingly paid more than they owe, and wants the surplus held as
   * advance credit. Opt-in on purpose: without it, an amount above the dues is
   * far more likely to be a typo than a deliberate prepayment, and the server
   * refuses rather than quietly parking someone's money.
   */
  payAdvance: z.boolean().optional(),
});

export const payOnlineSchema = z.object({
  amountPaise: z.number().int().min(1).optional(),
});

export const bounceReceiptSchema = z.object({
  reason: z.string().max(300).optional(),
});

// ---- Phase C: bank reconciliation ----

const bankAccountCode = z.string().min(1, 'Select a bank account').max(10).regex(/^[0-9]+$/, 'Account code must be numeric');

export const importBankStatementSchema = z.object({
  accountCode: bankAccountCode,
  lines: z.array(z.object({
    // Not `.datetime()`: a bank CSV carries '01/04/2026', not an ISO timestamp.
    // The service parses and rejects nonsense, so the message names the row.
    txnDate: z.string().min(1, 'Every row needs a date'),
    description: z.string().max(300).optional(),
    refNo: z.string().max(60).optional(),
    debitPaise: z.number().int().min(0).optional(),
    creditPaise: z.number().int().min(0).optional(),
  })).min(1, 'The statement has no rows to import')
    // A statement is pasted in one go, so an accidental whole-year paste is the
    // realistic failure. Bound it here rather than let insertMany discover it.
    .max(5000, 'Import at most 5,000 rows at a time'),
});

export const autoMatchBankSchema = z.object({
  accountCode: bankAccountCode,
});

export const matchBankLineSchema = z.object({
  journalEntryId: z.string().regex(objectId, 'Invalid voucher id'),
});

// ---- Phase C: bulk import (society onboarding) ----

/**
 * The spreadsheet itself is NOT validated here — zod cannot say whether row 47
 * names a real flat. It only guards the envelope; the import service checks
 * every row and reports the verdicts, which is the whole point of the feature.
 *
 * `csvText` is optional because the same route also accepts a multipart upload,
 * where the file arrives on `req.file` and the body is empty.
 */
export const bulkImportSchema = z.object({
  csvText: z.string()
    // A 200-flat CSV is ~10KB. This bound is a runaway-paste guard, nothing more.
    .max(2_000_000, 'That paste is too large — upload it as a file instead')
    .optional(),
  // Multipart sends fields as text, so 'true' must be accepted alongside true.
  force: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
});

export const createFundSchema = z.object({
  name: z.string().min(1, 'Fund name is required').max(120),
  category: z.enum(['CORPUS', 'SINKING', 'REPAIR', 'SPECIAL', 'GENERAL', 'RESERVE', 'MAINTENANCE_POOL', 'OPENING_BALANCE']),
  description: z.string().max(500).optional(),
  targetAmountPaise: z.number().int().min(0).optional(),
  isInvested: z.boolean().optional(),
});

/**
 * Category is deliberately absent: it decides which seeded ledger account the
 * fund adopted, and changing it once money has moved would strand the balance in
 * the old account.
 */
export const updateFundSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  targetAmountPaise: z.number().int().min(0).optional(),
  isInvested: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const projectChargeHeadSchema = z.object({
  chargeHeadId: z.string().regex(objectId).optional(),
  /** An unsaved form, so the projection can update as the treasurer types. */
  draft: z.any().optional(),
}).refine(v => v.chargeHeadId || v.draft, { message: 'Pass a charge head id or a draft' });

/**
 * Opening balances. Amounts are paise and may not be negative — a negative
 * opening bank balance is an overdraft, which is a liability and belongs on the
 * other side of the entry, not as a minus sign on an asset.
 */
// Capped well below 2^53 so a fat-fingered figure cannot silently lose integer
// precision when summed — ₹10,000 crore is already far past any society.
const openingAmount = z.number().int().min(0).max(1e15);

const openingLine = z.object({
  accountCode: z.string().min(1).max(20),
  amountPaise: openingAmount,
});

export const completeSetupSchema = z.object({
  // A plain `min(8)` string lets "aaaaaaaa" through, which becomes an Invalid
  // Date — a real Date object, so nothing downstream type-checks it, and it
  // reaches the financial-year calculation that keys the voucher sequence.
  entryDate: z.string().refine(v => !Number.isNaN(new Date(v).getTime()), 'Not a date').optional(),
  bankCash: z.array(openingLine).max(50).optional(),
  vendorDues: z.array(z.object({
    vendorId: z.string().regex(objectId),
    amountPaise: openingAmount,
  })).max(500).optional(),
  funds: z.array(openingLine).max(50).optional(),
  deposits: z.array(openingLine).max(50).optional(),
  declaredEmpty: z.array(z.enum(['BANK_CASH', 'FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'])).optional(),
});

/**
 * Bulk expense entry. Multipart sends every field as text, so booleans and the
 * enums have to accept their string forms alongside the real thing.
 */
export const bulkExpenseSchema = z.object({
  csvText: z.string().max(2_000_000, 'That paste is too large — upload it as a file instead').optional(),
  shape: z.enum(['ONE_VOUCHER', 'PER_ROW']).optional(),
  alreadyPaid: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  paymentMode: z.enum(['BANK', 'CASH', 'CHEQUE', 'UPI']).optional(),
  defaultDate: z.string().refine(v => !Number.isNaN(new Date(v).getTime()), 'Not a date').optional(),
  periodLabel: z.string().max(60).optional(),
});
