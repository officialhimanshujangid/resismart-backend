import mongoose from 'mongoose';
import { ChargeHead, ChargeCategory } from '../models/charge-head.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { seedChartOfAccounts } from './chart-of-accounts.seed';
import { fundAccount } from './funds.service';

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
 * Resolve the GL credit account for a charge head, in priority order:
 *
 *   1. an explicitly linked fund — the head collects into that fund's account
 *   2. an explicit COA code
 *   3. the category default
 *
 * Fund wins because it is the thing the admin actually chose. Previously `fundId`
 * was stored but never read, so money silently followed `category` instead and a
 * head linked to a "Building Painting Fund" credited ordinary income.
 */
export async function resolveIncomeAccount(
  societyId: string,
  category: ChargeCategory,
  explicitCode: string | undefined,
  actor: { userId: string; userName: string },
  fundId?: string,
) {
  if (fundId) return fundAccount(societyId, fundId, actor);

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
  const account = await resolveIncomeAccount(societyId, body.category, body.incomeAccountCode, actor, body.fundId);

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
    quantityKey: body.quantityKey,
    percentOf: body.percentOf,
    percentValue: body.percentValue,
    applicability: body.applicability || { occupancy: ['ALL'] },
    billTo: body.billTo || 'OWNER',
    incomeAccountId: account._id,
    incomeAccountCode: account.code,
    // '' means "no fund" and must not reach Mongoose as an ObjectId cast.
    fundId: body.fundId || undefined,
    gstApplicable: Boolean(body.gstApplicable),
    gstRatePercent: body.gstRatePercent,
    sacCode: body.sacCode,
    countsTowardRwaExemption: body.countsTowardRwaExemption ?? true,
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

  // Re-resolve the GL account if the fund link, category or account code changed.
  //
  // Deliberately does NOT fall back to `head.incomeAccountCode`: once a fund is
  // linked, that field IS the fund's account, so using it as the fallback would
  // resolve straight back to the fund on unlink (and would pin the account to a
  // stale code when the category changes). Only a code supplied by *this* request
  // counts as explicit.
  if (body.category || body.incomeAccountCode || body.fundId !== undefined) {
    const nextFundId = body.fundId !== undefined
      ? (body.fundId || undefined)
      : (head.fundId ? String(head.fundId) : undefined);
    const account = await resolveIncomeAccount(
      societyId,
      body.category || head.category,
      body.incomeAccountCode,
      actor,
      nextFundId,
    );
    head.incomeAccountId = account._id as mongoose.Types.ObjectId;
    head.incomeAccountCode = account.code;
  }

  const assignable = [
    'name', 'description', 'category', 'pricingMode', 'uniformAmountPaise', 'perSizeAmounts',
    'ratePerSqftPaise', 'areaBasis', 'perUnitRatePaise', 'meterType', 'quantityKey', 'percentOf', 'percentValue',
    'applicability', 'billTo', 'gstApplicable', 'gstRatePercent', 'sacCode',
    'countsTowardRwaExemption', 'isRecurring', 'isActive', 'sortOrder',
  ];
  for (const key of assignable) {
    if (body[key] !== undefined) (head as any)[key] = body[key];
  }
  // Assigned separately: '' means unlink, which must become undefined rather than
  // reaching Mongoose as an empty ObjectId cast.
  if (body.fundId !== undefined) head.fundId = body.fundId || undefined;
  await head.save();
  return head;
}
