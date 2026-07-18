import mongoose from 'mongoose';
import { ChargeHead, IChargeHead } from '../models/charge-head.model';
import { Flat, IFlat } from '../models/flat.model';
import { FlatSize } from '../models/flat-size.model';
import { listFunds, Actor } from './funds.service';
import { effectiveArea } from './invoicing.service';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * What one billing round of a charge head would raise, and what that does to the
 * fund behind it.
 *
 * The point is to be asked BEFORE the money is demanded. A society that needs
 * ₹1,50,000 for painting should find out that its rates add up to ₹1,65,000
 * while it is still typing them, not when fifteen members ask why they were
 * charged more than the notice said.
 */
export interface FundImpact {
  fundId: string;
  fundName: string;
  targetAmountPaise: number;
  /** Already demanded from members in earlier rounds. */
  raisedPaise: number;
  /** What this run would add. */
  thisRunPaise: number;
  /** Where the fund lands if this run goes ahead. */
  projectedPaise: number;
  /** How far past the target that is. Zero when within it. */
  overByPaise: number;
  /** Still short of the target after this run. */
  shortByPaise: number;
}

export interface ChargeHeadProjection {
  applicableFlats: number;
  /** Flats the head applies to but cannot price — they contribute nothing. */
  unpricedFlats: number;
  perRunPaise: number;
  fund?: FundImpact;
}

/** Mirrors `isApplicable` in invoicing — kept in step by the verification suite. */
function applies(head: Partial<IChargeHead>, flat: IFlat): boolean {
  const occ = head.applicability?.occupancy?.length ? head.applicability.occupancy : ['ALL'];
  if (!(occ.includes('ALL') || occ.includes(flat.status as any))) return false;
  const { blockIds, flatIds, exemptFlatIds } = head.applicability || {};
  if (exemptFlatIds?.some(id => String(id) === String(flat._id))) return false;
  if (flatIds?.length && !flatIds.some(id => String(id) === String(flat._id))) return false;
  if (blockIds?.length && !blockIds.some(id => String(id) === String(flat.blockId))) return false;
  return true;
}

/** Mirrors `computeBase`, minus the cross-head modes. */
function amountFor(head: any, flat: IFlat, size?: { carpetAreaSqft?: number; builtUpAreaSqft?: number }): number {
  switch (head.pricingMode) {
    case 'UNIFORM':
    case 'FLAT_ADHOC':
      return head.uniformAmountPaise ?? 0;
    case 'PER_FLAT_SIZE':
      return head.perSizeAmounts?.find((s: any) => String(s.flatSizeId) === String(flat.size))?.amountPaise ?? 0;
    case 'PER_BLOCK':
      return head.perBlockAmounts?.find((b: any) => String(b.blockId) === String(flat.blockId))?.amountPaise ?? 0;
    case 'PER_SQFT': {
      // Same resolver the engine uses, so a projection can never promise a
      // figure the real run would not produce.
      const area = effectiveArea(size, head.areaBasis);
      return area && head.ratePerSqftPaise ? Math.round(area * head.ratePerSqftPaise) : 0;
    }
    case 'PER_QUANTITY': {
      if (!head.quantityKey || !head.perUnitRatePaise) return 0;
      return Math.round(head.perUnitRatePaise * (flat.quantities?.[head.quantityKey] ?? 0));
    }
    // METERED depends on this month's readings and PERCENTAGE on the other heads
    // in the run, so neither can be projected from the head alone. Both are
    // reported as unpriceable rather than guessed at.
    default:
      return 0;
  }
}

/**
 * Project a charge head — either a saved one (by id) or an unsaved draft the
 * form is still being typed into.
 */
export async function projectChargeHead(
  societyId: string,
  input: { chargeHeadId?: string; draft?: any },
  actor: Actor,
): Promise<ChargeHeadProjection> {
  const head: any = input.chargeHeadId
    ? await ChargeHead.findOne({ _id: input.chargeHeadId, societyId }).lean()
    : input.draft;
  if (!head) throw new Error('Charge head not found');

  // Sizes carry the area a PER_SQFT head multiplies.
  const sizes = await FlatSize.find({ societyId: oid(societyId) }).select('carpetAreaSqft builtUpAreaSqft').lean();
  const sizeById = new Map(sizes.map(s => [String(s._id), s]));
  const flats = await Flat.find({ societyId: oid(societyId) }).lean<IFlat[]>();
  const applicable = flats.filter(f => applies(head, f));

  let perRunPaise = 0;
  let unpricedFlats = 0;
  for (const flat of applicable) {
    const amount = amountFor(head, flat, flat.size ? sizeById.get(String(flat.size)) : undefined);
    if (amount > 0) perRunPaise += amount;
    else unpricedFlats++;
  }

  const result: ChargeHeadProjection = {
    applicableFlats: applicable.length,
    unpricedFlats,
    perRunPaise,
  };

  const fundId = head.fundId ? String(head.fundId) : undefined;
  if (fundId) {
    const fund = (await listFunds(societyId, actor)).find(f => f._id === fundId);
    if (fund && fund.targetAmountPaise > 0) {
      const projectedPaise = fund.raisedPaise + perRunPaise;
      result.fund = {
        fundId,
        fundName: fund.name,
        targetAmountPaise: fund.targetAmountPaise,
        raisedPaise: fund.raisedPaise,
        thisRunPaise: perRunPaise,
        projectedPaise,
        overByPaise: Math.max(0, projectedPaise - fund.targetAmountPaise),
        shortByPaise: Math.max(0, fund.targetAmountPaise - projectedPaise),
      };
    }
  }

  return result;
}

/**
 * The same question for a whole invoice run: across every head that feeds a
 * fund, does this run push any of them past its target?
 */
export async function projectRunFundImpact(
  societyId: string,
  opts: { chargeHeadIds?: string[]; flatIds?: string[] },
  actor: Actor,
): Promise<FundImpact[]> {
  const q: any = { societyId: oid(societyId), isActive: true, fundId: { $exists: true, $ne: null } };
  if (opts.chargeHeadIds?.length) q._id = { $in: opts.chargeHeadIds };
  else q.isRecurring = { $ne: false };

  const heads = await ChargeHead.find(q).lean();
  if (!heads.length) return [];

  const flatQuery: any = { societyId: oid(societyId) };
  if (opts.flatIds?.length) flatQuery._id = { $in: opts.flatIds };
  const flats = await Flat.find(flatQuery).lean<IFlat[]>();
  // Sizes carry the area a PER_SQFT head multiplies.
  const sizes = await FlatSize.find({ societyId: oid(societyId) }).select('carpetAreaSqft builtUpAreaSqft').lean();
  const sizeById = new Map(sizes.map(s => [String(s._id), s]));
  const funds = await listFunds(societyId, actor);

  // Several heads can feed one fund, so their contributions are added before the
  // target is tested — checking each head alone would let two heads that are
  // individually within the target breach it together.
  const perFund = new Map<string, number>();
  for (const head of heads) {
    const fundId = String(head.fundId);
    let sum = 0;
    for (const flat of flats) {
      if (!applies(head as any, flat)) continue;
      sum += amountFor(head, flat, flat.size ? sizeById.get(String(flat.size)) : undefined);
    }
    perFund.set(fundId, (perFund.get(fundId) || 0) + sum);
  }

  const impacts: FundImpact[] = [];
  for (const [fundId, thisRunPaise] of perFund) {
    const fund = funds.find(f => f._id === fundId);
    if (!fund || fund.targetAmountPaise <= 0 || thisRunPaise <= 0) continue;
    const projectedPaise = fund.raisedPaise + thisRunPaise;
    impacts.push({
      fundId,
      fundName: fund.name,
      targetAmountPaise: fund.targetAmountPaise,
      raisedPaise: fund.raisedPaise,
      thisRunPaise,
      projectedPaise,
      overByPaise: Math.max(0, projectedPaise - fund.targetAmountPaise),
      shortByPaise: Math.max(0, fund.targetAmountPaise - projectedPaise),
    });
  }
  return impacts;
}
