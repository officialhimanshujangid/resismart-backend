import mongoose from 'mongoose';
import { ChargeHead, ChargeCategory } from '../models/charge-head.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { seedChartOfAccounts } from './chart-of-accounts.seed';

/** Default GL credit account (COA code) for each charge category. */
const CATEGORY_DEFAULT_ACCOUNT_CODE: Record<ChargeCategory, string> = {
  MAINTENANCE: '4100',
  WATER: '4110',
  PARKING: '4120',
  NON_OCCUPANCY: '4130',
  FESTIVAL: '4150',
  UTILITY: '4100',
  ADHOC: '4150',
  OTHER: '4100',
  SINKING_FUND: '3110',
  REPAIR_FUND: '3120',
  CORPUS: '3100',
};

/**
 * Resolve the GL credit account for a charge head. Uses an explicit code if
 * provided, else the category default. Seeds the COA on the fly if the account
 * is missing (society may not have opened settings yet).
 */
export async function resolveIncomeAccount(
  societyId: string,
  category: ChargeCategory,
  explicitCode: string | undefined,
  actor: { userId: string; userName: string },
) {
  const code = explicitCode || CATEGORY_DEFAULT_ACCOUNT_CODE[category] || '4100';
  let account = await LedgerAccount.findOne({ societyId, code });
  if (!account) {
    await seedChartOfAccounts(societyId, actor.userId, actor.userName);
    account = await LedgerAccount.findOne({ societyId, code });
  }
  if (!account) throw new Error(`Ledger account ${code} not found for this society`);
  return account;
}

export async function createChargeHead(societyId: string, body: any, actor: { userId: string; userName: string }) {
  const account = await resolveIncomeAccount(societyId, body.category, body.incomeAccountCode, actor);

  const doc = await ChargeHead.create({
    societyId,
    code: body.code,
    name: body.name,
    description: body.description,
    category: body.category,
    pricingMode: body.pricingMode,
    uniformAmountPaise: body.uniformAmountPaise,
    perSizeAmounts: body.perSizeAmounts,
    ratePerSqftPaise: body.ratePerSqftPaise,
    areaBasis: body.areaBasis,
    perUnitRatePaise: body.perUnitRatePaise,
    meterType: body.meterType,
    percentOf: body.percentOf,
    percentValue: body.percentValue,
    applicability: body.applicability || { occupancy: ['ALL'] },
    billTo: body.billTo || 'OWNER',
    incomeAccountId: account._id,
    incomeAccountCode: account.code,
    fundId: body.fundId,
    gstApplicable: Boolean(body.gstApplicable),
    gstRatePercent: body.gstRatePercent,
    sacCode: body.sacCode,
    isRecurring: body.isRecurring ?? true,
    isActive: body.isActive ?? true,
    sortOrder: body.sortOrder ?? 100,
    createdBy: actor.userId,
    createdByName: actor.userName,
  });
  return doc;
}

export async function updateChargeHead(societyId: string, id: string, body: any, actor: { userId: string; userName: string }) {
  const head = await ChargeHead.findOne({ _id: id, societyId });
  if (!head) throw new Error('Charge head not found');

  // Re-resolve the GL account if category or account code changed.
  if (body.category || body.incomeAccountCode) {
    const account = await resolveIncomeAccount(
      societyId,
      body.category || head.category,
      body.incomeAccountCode || head.incomeAccountCode,
      actor,
    );
    head.incomeAccountId = account._id as mongoose.Types.ObjectId;
    head.incomeAccountCode = account.code;
  }

  const assignable = [
    'name', 'description', 'category', 'pricingMode', 'uniformAmountPaise', 'perSizeAmounts',
    'ratePerSqftPaise', 'areaBasis', 'perUnitRatePaise', 'meterType', 'percentOf', 'percentValue',
    'applicability', 'billTo', 'fundId', 'gstApplicable', 'gstRatePercent', 'sacCode',
    'isRecurring', 'isActive', 'sortOrder',
  ];
  for (const key of assignable) {
    if (body[key] !== undefined) (head as any)[key] = body[key];
  }
  await head.save();
  return head;
}
