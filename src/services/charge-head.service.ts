import mongoose from 'mongoose';
import { ChargeHead, ChargeCategory, IChargeHead } from '../models/charge-head.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { Block } from '../models/block.model';
import { seedChartOfAccounts } from './chart-of-accounts.seed';
import { fundAccount } from './funds.service';

/**
 * Every wing named must belong to THIS society.
 *
 * Without the check a blockId from another society would be stored happily and
 * then simply never match a flat, so the head would bill nothing and look
 * merely misconfigured rather than wrong.
 */
async function assertBlocksOwned(societyId: string, rows: { blockId?: any }[] = []): Promise<void> {
  const ids = [...new Set(rows.map(r => r.blockId).filter(Boolean).map(String))];
  if (!ids.length) return;
  const found = await Block.countDocuments({ _id: { $in: ids }, societyId });
  if (found !== ids.length) throw new Error('One of those wings does not belong to this society');
}

/**
 * A head must be able to price something.
 *
 * The validator checks this per request; this checks the merged document, which
 * is what actually gets saved. An edit that changes the mode without its config
 * — or drops the config while keeping the mode — passes request validation and
 * would otherwise persist a head that silently bills ₹0 for ever.
 */
function assertPricingConfigured(head: IChargeHead): void {
  const fail = (m: string) => { throw new Error(m); };
  switch (head.pricingMode) {
    case 'UNIFORM':
    case 'FLAT_ADHOC':
      if (!head.uniformAmountPaise) fail('Set the amount to charge');
      break;
    case 'PER_FLAT_SIZE':
      if (!head.perSizeAmounts?.length) fail('Add an amount for at least one flat size');
      break;
    case 'PER_BLOCK':
      if (!head.perBlockAmounts?.length) fail('Add an amount for at least one wing');
      break;
    case 'PER_SQFT':
      if (!head.ratePerSqftPaise) fail('Set the rate per square foot');
      break;
    case 'METERED':
      if (!head.perUnitRatePaise) fail('Set the rate per unit');
      break;
    case 'PER_QUANTITY':
      if (!head.perUnitRatePaise) fail('Set the rate for one unit');
      if (!head.quantityKey) fail('Name the per-flat count to bill, e.g. parkingSlots');
      break;
    case 'PERCENTAGE':
      if (!head.percentValue) fail('Set the percentage to charge');
      if (!head.percentOf) fail('Choose what the percentage is taken of');
      break;
  }
}

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
  await assertBlocksOwned(societyId, body.perBlockAmounts);
  await assertBlocksOwned(societyId, (body.applicability?.blockIds || []).map((blockId: string) => ({ blockId })));

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
    perBlockAmounts: body.perBlockAmounts,
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

  if (body.perBlockAmounts !== undefined) await assertBlocksOwned(societyId, body.perBlockAmounts);
  if (body.applicability?.blockIds !== undefined) {
    await assertBlocksOwned(societyId, (body.applicability.blockIds || []).map((blockId: string) => ({ blockId })));
  }

  const assignable = [
    'name', 'description', 'category', 'pricingMode', 'uniformAmountPaise', 'perSizeAmounts', 'perBlockAmounts',
    'ratePerSqftPaise', 'areaBasis', 'perUnitRatePaise', 'meterType', 'quantityKey', 'percentOf', 'percentValue',
    'billTo', 'gstApplicable', 'gstRatePercent', 'sacCode',
    'countsTowardRwaExemption', 'isRecurring', 'isActive', 'sortOrder',
  ];
  for (const key of assignable) {
    if (body[key] !== undefined) (head as any)[key] = body[key];
  }

  // Merged key by key, NOT assigned wholesale.
  //
  // The edit form only ever sent `applicability: { occupancy }`, and assigning
  // the whole object meant every save silently wiped blockIds, flatIds and
  // exemptFlatIds — which was the only way to scope a head to a wing at all.
  // Now an absent key means "leave it alone" and an empty array means "clear it",
  // so a caller can still deliberately remove a scoping.
  if (body.applicability !== undefined) {
    const current = (head.applicability || {}) as any;
    const patch = body.applicability || {};
    head.applicability = {
      occupancy: patch.occupancy !== undefined ? patch.occupancy : (current.occupancy ?? ['ALL']),
      blockIds: patch.blockIds !== undefined ? patch.blockIds : current.blockIds,
      flatIds: patch.flatIds !== undefined ? patch.flatIds : current.flatIds,
      exemptFlatIds: patch.exemptFlatIds !== undefined ? patch.exemptFlatIds : current.exemptFlatIds,
    } as any;
  }

  // The mode may have changed without its config, or the config without its
  // mode; either way the head must still be able to price something.
  assertPricingConfigured(head);
  // Assigned separately: '' means unlink, which must become undefined rather than
  // reaching Mongoose as an empty ObjectId cast.
  if (body.fundId !== undefined) head.fundId = body.fundId || undefined;
  await head.save();
  return head;
}
