import mongoose from 'mongoose';
import { MaintenanceInvoice, IInvoiceLineItem } from '../models/maintenance-invoice.model';
import { ChargeHead, IChargeHead } from '../models/charge-head.model';
import { MeterReading } from '../models/meter-reading.model';
import { Flat, IFlat } from '../models/flat.model';
import { FlatSize } from '../models/flat-size.model';
import { User } from '../models/user.model';
import { IFinancePolicy } from '../models/finance-policy.model';
import { getOrCreatePolicy } from './finance-policy.service';
import { postJournal, PostLineInput } from './ledger.service';
import { nextDocNumber } from './finance-sequence.service';
import { getFinancialYear } from '../utils/financial-year.util';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';
import { splitPayment } from './allocation.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

// ---- pricing / applicability helpers ----

function isApplicable(head: IChargeHead, flat: IFlat): boolean {
  const occ = head.applicability?.occupancy?.length ? head.applicability.occupancy : ['ALL'];
  if (!(occ.includes('ALL') || occ.includes(flat.status as any))) return false;
  const { blockIds, flatIds, exemptFlatIds } = head.applicability || {};
  if (exemptFlatIds?.some((id) => id.toString() === (flat._id as any).toString())) return false;
  if (flatIds?.length && !flatIds.some((id) => id.toString() === (flat._id as any).toString())) return false;
  if (blockIds?.length && !blockIds.some((id) => id.toString() === flat.blockId?.toString())) return false;
  return true;
}

/**
 * The area to bill a flat on. It lives on the flat's SIZE, and only there.
 *
 * A society defines a handful of sizes and every flat of that size shares the
 * measurement, so it is entered once rather than two hundred times — and a
 * correction fixes every flat at once. Two layouts that genuinely differ are two
 * sizes ("1BHK 1200", "1BHK 1500"), which is how a committee already names them.
 *
 * Deliberately no per-flat override: a second place to put the same number is a
 * second number to keep in step, and the one nobody remembers to update is the
 * one that bills.
 *
 * One helper because the pricing engine and the "why is this flat billed ₹0"
 * warning must never disagree about what the area is.
 */
export function effectiveArea(
  size: { carpetAreaSqft?: number; builtUpAreaSqft?: number } | undefined,
  basis?: 'CARPET' | 'BUILTUP',
): number | undefined {
  return basis === 'BUILTUP' ? size?.builtUpAreaSqft : size?.carpetAreaSqft;
}

function computeBase(
  head: IChargeHead,
  flat: IFlat,
  meterUnits: number,
  maintenanceBasePaise: number,
  runningBasePaise: number,
  size?: { carpetAreaSqft?: number; builtUpAreaSqft?: number },
): number {
  switch (head.pricingMode) {
    case 'UNIFORM':
    case 'FLAT_ADHOC':
      return head.uniformAmountPaise ?? 0;
    case 'PER_FLAT_SIZE': {
      const m = head.perSizeAmounts?.find((s) => s.flatSizeId.toString() === flat.size?.toString());
      return m ? m.amountPaise : (head.uniformAmountPaise ?? 0);
    }
    case 'PER_BLOCK': {
      const m = head.perBlockAmounts?.find((b) => b.blockId.toString() === flat.blockId?.toString());
      return m ? m.amountPaise : (head.uniformAmountPaise ?? 0);
    }
    case 'PER_SQFT': {
      const area = effectiveArea(size, head.areaBasis);
      if (!area || !head.ratePerSqftPaise) return 0;
      return Math.round(area * head.ratePerSqftPaise);
    }
    case 'METERED':
      return head.perUnitRatePaise ? Math.round(meterUnits * head.perUnitRatePaise) : 0;
    case 'PER_QUANTITY': {
      // "2 cars × ₹500". The count lives on the flat under the key the head
      // names; a flat that has no such key bills nothing rather than guessing.
      if (!head.quantityKey || !head.perUnitRatePaise) return 0;
      const qty = flat.quantities?.[head.quantityKey] ?? 0;
      return Math.round(head.perUnitRatePaise * qty);
    }
    case 'PERCENTAGE': {
      const basis = head.percentOf === 'BASE' ? runningBasePaise : maintenanceBasePaise;
      return Math.round(basis * (head.percentValue ?? 0) / 100);
    }
    default:
      return 0;
  }
}

/**
 * How much of a member's monthly contribution is taxable, as a fraction.
 *
 * A resident welfare association's supply to its own members is exempt up to
 * ₹7,500 per member per month. Beyond that the law is genuinely contested and
 * societies follow both readings — CBIC Circular 109/28/2019 says GST applies to
 * the whole amount, the Madras HC (Greenwood Owners Association, 2021) read that
 * down to the excess only — so `policy.gst.exemptionBasis` decides rather than
 * this code. Charging GST on a society that is under the limit is a real,
 * refundable error, which is why a bare `gst.enabled` boolean was not enough.
 *
 * Returns 0 (fully exempt), 1 (fully taxable), or a fraction for EXCESS_ONLY.
 */
function taxableFraction(exemptionCountingBase: number, gstApplicableBase: number, policy: IFinancePolicy): number {
  const limit = policy.gst?.rwaExemptionPerMemberPaise ?? 0;
  if (limit <= 0) return 1;                              // exemption test switched off
  if (exemptionCountingBase <= limit) return 0;          // under the limit — nothing is taxable
  if (policy.gst?.exemptionBasis === 'EXCESS_ONLY') {
    if (gstApplicableBase <= 0) return 0;
    // Only the amount above the limit bears GST, spread across the taxable heads.
    return Math.min(1, (exemptionCountingBase - limit) / gstApplicableBase);
  }
  return 1;                                              // FULL_IF_EXCEEDS
}

/**
 * GST on a charge line. Always CGST+SGST, never IGST — and that is correct, not
 * an oversight: the place of supply for services relating to immovable property
 * is the property's own location (IGST Act s.12(3)), and a society's members
 * occupy that very property. The supply is therefore always intra-state.
 * `policy.gst.placeOfSupplyState` exists for GSTR reporting, not to switch this.
 */
function computeGst(base: number, head: IChargeHead, policy: IFinancePolicy, fraction: number) {
  if (!policy.gst?.enabled || !head.gstApplicable || fraction <= 0) {
    return { rate: 0, gst: 0, cgst: 0, sgst: 0, igst: 0, sac: head.sacCode };
  }
  const rate = head.gstRatePercent ?? policy.gst.defaultRatePercent;
  const gst = Math.round((base * fraction) * rate / 100);
  const cgst = Math.round(gst / 2);
  return { rate, gst, cgst, sgst: gst - cgst, igst: 0, sac: head.sacCode || policy.gst.defaultSac };
}

/**
 * Who the invoice is addressed to.
 *
 * Honours each charge head's `billTo`, which used to be saved, shown in the UI,
 * and then ignored here in favour of the flat's status alone. The member (owner)
 * is liable for anything billed to OWNER, so a single owner-billed head puts the
 * whole invoice on the owner; a rented flat bills the tenant only when every
 * applied head is occupant-billed.
 */
function resolveBillToRole(flat: IFlat, appliedHeads: IChargeHead[]): 'OWNER' | 'TENANT' {
  if (flat.status !== 'RENTED') return 'OWNER';
  if (!appliedHeads.length) return 'OWNER';
  return appliedHeads.every((h) => h.billTo === 'OCCUPANT') ? 'TENANT' : 'OWNER';
}

/**
 * Interest on overdue dues.
 *
 * `base` is chosen by the caller from `lateFee.compounding`: SIMPLE charges on
 * unpaid principal only, COMPOUND on the whole arrears including interest already
 * levied. That switch was declared, validated and shown in Settings but never
 * read here — so the engine charged on total arrears either way and compounded
 * silently, while bye-laws commonly cap interest at 21% per annum SIMPLE.
 */
function computeInterest(base: number, policy: IFinancePolicy, maxDaysOverdue: number): number {
  const lf = policy.lateFee;
  if (!lf?.enabled || base <= 0) return 0;
  if (maxDaysOverdue <= (lf.graceDays || 0)) return 0;
  const arrearsPaise = base;
  let interest = 0;
  switch (lf.mode) {
    case 'FLAT': interest = lf.flatAmountPaise || 0; break;
    case 'PERCENT_PER_MONTH': interest = Math.round(arrearsPaise * (lf.ratePercent || 0) / 100); break;
    case 'PERCENT_PER_ANNUM': interest = Math.round(arrearsPaise * (lf.ratePercent || 0) / 100 / 12); break;
    case 'SLAB': {
      const slabs = (lf.slabs || []).slice().sort((a, b) => a.uptoDays - b.uptoDays);
      const slab = slabs.find((s) => maxDaysOverdue <= s.uptoDays) || slabs[slabs.length - 1];
      interest = slab ? Math.round(arrearsPaise * slab.ratePercent / 100) : 0;
      break;
    }
  }
  if (lf.minChargePaise && interest > 0) interest = Math.max(interest, lf.minChargePaise);
  if (lf.capPerInvoicePaise) interest = Math.min(interest, lf.capPerInvoicePaise);
  return interest;
}

function applyRounding(amountPaise: number, policy: IFinancePolicy): number {
  const mode = policy.rounding?.mode;
  if (mode === 'NEAREST_RUPEE') return Math.round(amountPaise / 100) * 100 - amountPaise;
  if (mode === 'CEIL_RUPEE') return Math.ceil(amountPaise / 100) * 100 - amountPaise;
  return 0;
}

/** Sum of outstanding on prior open invoices + oldest overdue due-date, for arrears & interest. */
async function getFlatArrears(societyId: string, flatId: any): Promise<{ arrearsPaise: number; principalArrearsPaise: number; maxDaysOverdue: number }> {
  const open = await MaintenanceInvoice.find({
    societyId: oid(societyId),
    flatId,
    status: { $in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
  }).select('outstandingPaise interestOutstandingPaise dueDate').lean();
  const arrearsPaise = open.reduce((s, i) => s + (i.outstandingPaise || 0), 0);
  // What the member owes excluding penalty already levied. Charging interest on
  // the full arrears means charging interest on interest — compounding, whatever
  // the policy says.
  const principalArrearsPaise = open.reduce(
    (s, i) => s + Math.max(0, (i.outstandingPaise || 0) - (i.interestOutstandingPaise || 0)),
    0,
  );
  const now = Date.now();
  const maxDaysOverdue = open.reduce((max, i) => {
    if (!i.dueDate) return max;
    const d = Math.floor((now - new Date(i.dueDate).getTime()) / 86400000);
    return Math.max(max, d);
  }, 0);
  return { arrearsPaise, principalArrearsPaise, maxDaysOverdue };
}

/** Members' Advance credit balance for a flat (from the GL), for auto-apply. */
async function getFlatAdvance(societyId: string, flatId: any): Promise<number> {
  const { JournalEntry } = await import('../models/journal-entry.model');
  const agg = await JournalEntry.aggregate([
    { $match: { societyId: oid(societyId) } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountCode': ACCOUNT_CODES.MEMBERS_ADVANCE, 'lines.flatId': flatId } },
    { $group: { _id: null, net: { $sum: { $subtract: ['$lines.creditPaise', '$lines.debitPaise'] } } } },
  ]);
  return Math.max(0, agg[0]?.net || 0);
}

/**
 * Why a head that applies to this flat priced at zero.
 *
 * Only reports gaps a human can fix. A metered head with no reading this month
 * is not a misconfiguration — the reading simply is not in yet — so it stays
 * quiet rather than crying wolf every billing run.
 */
function unbilledReason(
  head: IChargeHead,
  flat: IFlat,
  size?: { carpetAreaSqft?: number; builtUpAreaSqft?: number },
): string | null {
  switch (head.pricingMode) {
    case 'PER_FLAT_SIZE':
      if (!flat.size) return 'no flat size set on this flat';
      if (!head.perSizeAmounts?.some(s => s.flatSizeId.toString() === flat.size?.toString())) {
        return 'no amount set for this flat\'s size';
      }
      return 'amount for this size is zero';
    case 'PER_BLOCK':
      if (!flat.blockId) return 'this flat is not linked to a wing';
      if (!head.perBlockAmounts?.some(b => b.blockId.toString() === flat.blockId?.toString())) {
        return 'no amount set for this flat\'s wing';
      }
      return 'amount for this wing is zero';
    case 'PER_SQFT': {
      const area = effectiveArea(size, head.areaBasis);
      const which = head.areaBasis === 'BUILTUP' ? 'built-up' : 'carpet';
      if (!area) {
        // Point at the size, because that is where the fix belongs — correcting
        // it once there fixes every flat of that size at the same time.
        return flat.size
          ? `no ${which} area on this flat's size — set it in Flat Sizes`
          : `no flat size chosen, so there is no ${which} area to bill on`;
      }
      if (!head.ratePerSqftPaise) return 'no per-sqft rate set on the charge head';
      return null;
    }
    case 'PER_QUANTITY':
      if (!head.quantityKey) return 'no quantity key set on the charge head';
      if (!flat.quantities?.[head.quantityKey]) return `this flat has no "${head.quantityKey}" recorded`;
      return null;
    case 'UNIFORM':
    case 'FLAT_ADHOC':
      return head.uniformAmountPaise ? null : 'no amount set on the charge head';
    case 'PERCENTAGE':
      return head.percentValue ? null : 'no percentage set on the charge head';
    default:
      // METERED with no reading yet — expected, not a gap.
      return null;
  }
}

/** A flat a head applied to but could not price. */
export interface UnbilledFlat {
  flatId: string;
  flat: string;
  chargeHeadCode: string;
  chargeHeadName: string;
  reason: string;
}

/**
 * The next free `YYYY-MM-Sn` for a month.
 *
 * A special demand cannot reuse the month's own key: `{society, flat, period}` is
 * unique, and a second run against `2026-07` is not an error but a silent no-op —
 * every flat is simply "already invoiced" and the caller gets `created: 0`.
 * Suffixing the period sidesteps that without touching the index, exactly as
 * opening dues already do with `OPENING`.
 */
async function nextSpecialPeriod(societyId: string, month: string): Promise<string> {
  const existing = await MaintenanceInvoice.find({
    societyId: oid(societyId),
    billingPeriod: { $regex: `^${month}-S\\d+$` },
  }).select('billingPeriod').lean();

  const highest = existing.reduce((max, i) => {
    const n = Number(i.billingPeriod.split('-S')[1] || 0);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
  return `${month}-S${highest + 1}`;
}

/**
 * How much of this flat's contribution THIS CALENDAR MONTH already counts toward
 * the ₹7,500 RWA exemption.
 *
 * The exemption is tested per member per month, but the engine only ever sees one
 * invoice at a time. Left alone, a ₹500 special demand looks like the member's
 * entire month and escapes GST it may well owe — so the month's earlier bills are
 * added back in before the test.
 */
async function priorExemptionBaseThisMonth(societyId: string, flatId: any, month: string): Promise<number> {
  const invoices = await MaintenanceInvoice.find({
    societyId: oid(societyId), flatId,
    billingPeriod: { $regex: `^${month}` },
  }).select('lineItems').lean();
  if (!invoices.length) return 0;

  // `countsTowardRwaExemption` lives on the charge head, not the invoice line —
  // property tax and common-area electricity are excluded from the computation.
  const headIds = [...new Set(
    invoices.flatMap(i => (i.lineItems || []).map(li => li.chargeHeadId).filter(Boolean).map(String)),
  )];
  const heads = headIds.length
    ? await ChargeHead.find({ _id: { $in: headIds } }).select('countsTowardRwaExemption').lean()
    : [];
  const excluded = new Set(heads.filter(h => h.countsTowardRwaExemption === false).map(h => String(h._id)));

  return invoices.reduce((sum, inv) => sum + (inv.lineItems || []).reduce((s, li) => {
    if (!li.isPostable) return s;                                   // arrears display line
    if (li.chargeHeadId && excluded.has(String(li.chargeHeadId))) return s;
    return s + (li.baseAmountPaise || 0);
  }, 0), 0);
}

export interface GenerateOpts {
  period?: string;
  chargeHeadIds?: string[];
  flatIds?: string[];
  dryRun?: boolean;
  triggeredByUserId?: string;
  triggeredByName?: string;
  /**
   * Raise a one-off demand alongside the month's regular bill — a lift repair,
   * an urgent painting contract. Gets its own `YYYY-MM-Sn` period, and
   * deliberately carries NO interest and NO arrears line: see the notes at each
   * suppression point.
   */
  specialDemand?: { title: string; dueDate?: string; blockIds?: string[] };
}

export interface GenerateResult {
  period: string;
  created: number;
  skipped: number;
  totalBilledPaise: number;
  errors: string[];
  /** Flats a charge head applied to but could not price. Setup gaps, not bills. */
  unbilled: UnbilledFlat[];
}

/**
 * Generate one consolidated MaintenanceInvoice per applicable flat for a period,
 * with line items from active charge heads, arrears carry-forward, penal
 * interest, per-line GST and rounding — posting a balanced INVOICE voucher for
 * each. Idempotent per {society, flat, period}.
 */
export async function generateInvoicesForSociety(societyId: string, opts: GenerateOpts = {}): Promise<GenerateResult> {
  const actorId = opts.triggeredByUserId || 'SYSTEM';
  const actorName = opts.triggeredByName || 'System Cron';
  const policy = await getOrCreatePolicy(societyId, actorId === 'SYSTEM' ? new mongoose.Types.ObjectId().toString() : actorId, actorName);
  const startMonth = policy.financialYear?.startMonth ?? 4;

  const now = new Date();
  const special = opts.specialDemand;
  const month = opts.period || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // A special demand gets its own suffixed key so it cannot collide with the
  // month's regular bill on the unique {society, flat, period} index.
  const period = special ? await nextSpecialPeriod(societyId, month) : month;
  const [py, pm] = month.split('-').map(Number);
  const periodStart = new Date(py, pm - 1, 1);
  const periodEnd = new Date(py, pm, 0, 23, 59, 59, 999);

  const invoiceDate = now;
  const dueDate = special?.dueDate ? new Date(special.dueDate) : new Date(now);
  if (!special?.dueDate) dueDate.setDate(dueDate.getDate() + (policy.billing?.dueDays ?? 15));
  dueDate.setHours(23, 59, 59, 999);
  const { fyString } = getFinancialYear(invoiceDate, startMonth);

  // Active charge heads (optionally filtered), sorted so PERCENTAGE heads run last.
  let headQuery: any = { societyId, isActive: true };
  if (opts.chargeHeadIds?.length) {
    // An explicit selection is deliberate — honour it, including one-time levies.
    headQuery._id = { $in: opts.chargeHeadIds };
  } else {
    // Otherwise bill recurring heads only. `isRecurring` used to be ignored here,
    // so a one-time levy was re-billed every single month.
    headQuery.isRecurring = { $ne: false };
  }
  const heads = (await ChargeHead.find(headQuery).lean<IChargeHead[]>())
    .sort((a, b) => (a.pricingMode === 'PERCENTAGE' ? 1 : 0) - (b.pricingMode === 'PERCENTAGE' ? 1 : 0) || a.sortOrder - b.sortOrder);
  if (!heads.length) return { period, created: 0, skipped: 0, totalBilledPaise: 0, errors: ['No active charge heads'], unbilled: [] };

  const flatQuery: any = { societyId };
  if (opts.flatIds?.length) flatQuery._id = { $in: opts.flatIds };
  // A special demand is often one wing's problem — a lift, a tower's own pump.
  if (special?.blockIds?.length) flatQuery.blockId = { $in: special.blockIds.map(oid) };
  const flats = await Flat.find(flatQuery).lean<IFlat[]>();
  if (!flats.length) return { period, created: 0, skipped: 0, totalBilledPaise: 0, errors: ['No flats found'], unbilled: [] };

  // Denormalization lookups
  const sizeIds = [...new Set(flats.map((f) => f.size?.toString()).filter(Boolean))] as string[];
  const ownerIds = [...new Set(flats.map((f) => f.ownerUserId?.toString()).filter(Boolean))] as string[];
  const sizeDocs = sizeIds.length ? await FlatSize.find({ _id: { $in: sizeIds } }).select('name carpetAreaSqft builtUpAreaSqft').lean() : [];
  const ownerDocs = ownerIds.length ? await User.find({ _id: { $in: ownerIds } }).select('name').lean() : [];
  const sizeLabelById = new Map(sizeDocs.map((s) => [s._id.toString(), s.name]));
  const sizeById = new Map(sizeDocs.map((s) => [s._id.toString(), s]));
  const ownerNameById = new Map(ownerDocs.map((u) => [u._id.toString(), u.name]));

  // Existing invoices for this period → idempotency
  const existing = await MaintenanceInvoice.find({ societyId, billingPeriod: period }).select('flatId').lean();
  const existingFlatIds = new Set(existing.map((e) => e.flatId.toString()));

  let created = 0, skipped = 0, totalBilledPaise = 0;
  const errors: string[] = [];
  const unbilled: UnbilledFlat[] = [];

  for (const flat of flats) {
    if (existingFlatIds.has((flat._id as any).toString())) { skipped++; continue; }

    try {
      // Build line items
      const meterReadings = heads.some((h) => h.pricingMode === 'METERED')
        ? await MeterReading.find({ societyId, flatId: flat._id, billingPeriod: period }).lean()
        : [];
      const meterByHead = new Map(meterReadings.map((m) => [m.chargeHeadId.toString(), m.unitsConsumed]));

      const lineItems: IInvoiceLineItem[] = [];
      const appliedHeads: IChargeHead[] = [];
      let maintenanceBasePaise = 0;
      let runningBasePaise = 0;
      let subTotalPaise = 0;
      let gstTotalPaise = 0;

      // First pass: every base amount. GST can't be decided line by line — the
      // ₹7,500 exemption is tested against the member's WHOLE monthly
      // contribution, so all the bases have to be known before any of them
      // can be taxed.
      const priced: { head: IChargeHead; base: number; meterUnits: number }[] = [];
      for (const head of heads) {
        if (!isApplicable(head, flat)) continue;
        const meterUnits = meterByHead.get((head._id as any).toString()) || 0;
        const flatSize = flat.size ? sizeById.get(flat.size.toString()) : undefined;
        const base = computeBase(head, flat, meterUnits, maintenanceBasePaise, runningBasePaise, flatSize);
        if (base <= 0) {
          // A head that applies to this flat but prices at nothing is almost
          // always a gap in the setup, not a deliberate free ride — a flat with
          // no size, a wing nobody put a rate against, an area never measured.
          // It used to vanish silently; now the preview can name it.
          const why = unbilledReason(head, flat, flatSize);
          if (why) unbilled.push({
            flatId: String(flat._id),
            flat: `${flat.blockName} ${flat.number}`.trim(),
            chargeHeadCode: head.code,
            chargeHeadName: head.name,
            reason: why,
          });
          continue;
        }
        if (head.category === 'MAINTENANCE') maintenanceBasePaise += base;
        runningBasePaise += base;
        priced.push({ head, base, meterUnits });
      }

      // The ₹7,500 exemption is per member per MONTH, but this loop only sees one
      // invoice. On a special demand the month's earlier bills are added back in,
      // or a small mid-month levy would look like the member's whole month and
      // escape GST the society may owe on it.
      const priorBase = special && policy.gst?.enabled
        ? await priorExemptionBaseThisMonth(societyId, flat._id, month)
        : 0;
      const exemptionCountingBase = priced
        .filter(p => p.head.countsTowardRwaExemption !== false)
        .reduce((s, p) => s + p.base, 0) + priorBase;
      const gstApplicableBase = priced.filter(p => p.head.gstApplicable).reduce((s, p) => s + p.base, 0);
      const fraction = taxableFraction(exemptionCountingBase, gstApplicableBase, policy);

      // Second pass: the lines themselves, now that the exemption is known.
      for (const { head, base, meterUnits } of priced) {
        const gst = computeGst(base, head, policy, fraction);
        subTotalPaise += base;
        gstTotalPaise += gst.gst;
        appliedHeads.push(head);

        lineItems.push({
          chargeHeadId: head._id as any,
          code: head.code,
          name: head.name,
          category: head.category,
          pricingMode: head.pricingMode,
          quantity: head.pricingMode === 'METERED' ? meterUnits : undefined,
          ratePaise: head.pricingMode === 'METERED' ? head.perUnitRatePaise : undefined,
          baseAmountPaise: base,
          gstApplicable: gst.gst > 0,
          gstRatePercent: gst.rate || undefined,
          sacCode: gst.sac,
          cgstPaise: gst.cgst,
          sgstPaise: gst.sgst,
          igstPaise: gst.igst,
          gstPaise: gst.gst,
          lineTotalPaise: base + gst.gst,
          incomeAccountCode: head.incomeAccountCode,
          fundId: head.fundId,
          isPostable: true,
        });
      }

      // Arrears + interest
      const { arrearsPaise, principalArrearsPaise, maxDaysOverdue } = await getFlatArrears(societyId, flat._id);
      // The one place `compounding` decides anything: simple interest is charged
      // on unpaid dues only, compound on dues plus the interest already levied.
      const interestBasePaise = policy.lateFee?.compounding === 'COMPOUND' ? arrearsPaise : principalArrearsPaise;
      //
      // A special demand levies NO interest, deliberately.
      //
      // Interest is charged on the outstanding balance, not on a period, so a
      // second invoice in the same month would run the monthly charge a second
      // time against the same unpaid dues — two months' penalty in one month.
      // `capPerInvoicePaise` would not save it either: that caps per invoice, not
      // per month. And penal interest on a fresh painting levy is simply wrong.
      const interestPaise = special ? 0 : computeInterest(interestBasePaise, policy, maxDaysOverdue);
      if (interestPaise > 0) {
        lineItems.push({
          code: 'INT', name: 'Interest on Arrears', category: 'INTEREST',
          baseAmountPaise: interestPaise, gstApplicable: false,
          cgstPaise: 0, sgstPaise: 0, igstPaise: 0, gstPaise: 0,
          lineTotalPaise: interestPaise,
          incomeAccountCode: policy.lateFee?.chargeHeadCode || ACCOUNT_CODES.INTEREST_ON_ARREARS,
          isPostable: true,
        });
      }

      // Skip a flat with nothing to charge this period.
      //
      // Arrears deliberately do NOT keep a flat in: the arrears line is display
      // only (`isPostable: false`) and excluded from the total, so an
      // arrears-only invoice comes to ₹0 — leaving a single ₹0 Debtors line,
      // which `postJournal` rightly refuses ("exactly one of debit or credit").
      // The whole invoice then failed for that flat, visible only as a line in
      // the server log. The arrears are already tracked on the invoices that
      // raised them, and Defaulters reads those, so nothing is lost by skipping.
      if (subTotalPaise === 0 && interestPaise === 0) { skipped++; continue; }

      // Arrears display line (not posted — already in Debtors).
      //
      // Suppressed on a special demand: this month's own regular bill is still
      // open, so it would be restated here as "Arrears Brought Forward" days
      // after it was issued — which reads to a member as being billed twice.
      // The money is unaffected either way (the line is never posted), but the
      // document has to be honest.
      if (arrearsPaise > 0 && !special) {
        lineItems.push({
          code: 'ARR', name: 'Arrears Brought Forward', category: 'ARREARS_BF',
          baseAmountPaise: arrearsPaise, gstApplicable: false,
          cgstPaise: 0, sgstPaise: 0, igstPaise: 0, gstPaise: 0,
          lineTotalPaise: arrearsPaise, isPostable: false,
        });
      }

      const preRound = subTotalPaise + gstTotalPaise + interestPaise;
      const roundingPaise = applyRounding(preRound, policy);
      const totalPaise = preRound + roundingPaise;
      // grandTotalDue = this invoice's OWN charges. Arrears from prior periods stay
      // tracked on their own invoices (openingArrears is informational) so that
      // Σ outstanding across invoices == the Debtors control balance (no double count).
      const grandTotalDuePaise = totalPaise;

      const advanceAvailable = policy.advance?.autoApply ? await getFlatAdvance(societyId, flat._id) : 0;
      const advanceAppliedPaise = Math.min(advanceAvailable, totalPaise);
      const outstandingPaise = totalPaise - advanceAppliedPaise;

      if (opts.dryRun) { created++; totalBilledPaise += totalPaise; continue; }

      // Build the balanced INVOICE journal for current-period charges (arrears excluded).
      const jlines: PostLineInput[] = [];
      const blockId = flat.blockId; // wing cost centre — every line of this bill belongs to it
      for (const li of lineItems) {
        if (!li.isPostable) continue;
        jlines.push({ accountCode: li.incomeAccountCode!, creditPaise: li.baseAmountPaise, flatId: flat._id, fundId: li.fundId, blockId, description: li.name });
      }
      if (gstTotalPaise > 0) jlines.push({ accountCode: ACCOUNT_CODES.GST_OUTPUT, creditPaise: gstTotalPaise, flatId: flat._id, blockId, description: 'GST output' });
      // Honour the configured account. It defaults to 4900, which is why this
      // reading as hard-coded went unnoticed — the default matched the constant,
      // so changing it in Settings silently did nothing.
      const roundingCode = policy.rounding?.accountCode || ACCOUNT_CODES.ROUNDING_OFF;
      if (roundingPaise > 0) jlines.push({ accountCode: roundingCode, creditPaise: roundingPaise, flatId: flat._id, blockId, description: 'Rounding off' });
      if (roundingPaise < 0) jlines.push({ accountCode: roundingCode, debitPaise: -roundingPaise, flatId: flat._id, blockId, description: 'Rounding off' });
      jlines.push({ accountCode: ACCOUNT_CODES.DEBTORS, debitPaise: totalPaise, flatId: flat._id, blockId, description: `Invoice ${period}` });

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const { number: invoiceNumber } = await nextDocNumber(
            societyId, 'INVOICE', fyString,
            { prefix: policy.numbering.invoice.prefix, padding: policy.numbering.invoice.padding, template: policy.numbering.invoice.template },
            session,
          );

          const [invoice] = await MaintenanceInvoice.create([{
            societyId,
            flatId: flat._id,
            blockName: flat.blockName,
            flatNumber: flat.number,
            flatSizeId: flat.size,
            flatSizeLabel: flat.size ? sizeLabelById.get(flat.size.toString()) : undefined,
            primaryOwnerUserId: flat.ownerUserId,
            primaryOwnerName: flat.ownerUserId ? ownerNameById.get(flat.ownerUserId.toString()) : undefined,
            billToRole: resolveBillToRole(flat, appliedHeads),
            invoiceNumber,
            financialYear: fyString,
            billingPeriod: period,
            demandTitle: special?.title,
            periodStart,
            periodEnd,
            invoiceDate,
            dueDate,
            lineItems,
            openingArrearsPaise: arrearsPaise,
            subTotalPaise,
            gstPaise: gstTotalPaise,
            interestPaise,
            roundingPaise,
            totalPaise,
            grandTotalDuePaise,
            allocatedPaise: 0,
            advanceAppliedPaise,
            waivedPaise: 0,
            outstandingPaise,
            // An advance applied at issue settles the bill exactly as a payment
            // would, so it follows the same appropriation order.
            interestOutstandingPaise: interestPaise - splitPayment(
              policy.allocation?.interestOrder || 'PRINCIPAL_FIRST',
              advanceAppliedPaise, totalPaise, interestPaise,
            ).toInterestPaise,
            // Advance applied at issue settles the bill exactly as a payment does,
            // so the status has to say so. Hard-coding ISSUED left a bill with
            // ₹0 outstanding sitting on the member's portal as though it were
            // still owed — the same rule `allocateFifo` already applies when a
            // receipt clears one.
            status: outstandingPaise <= 0
              ? 'PAID'
              : advanceAppliedPaise > 0 ? 'PARTIALLY_PAID' : 'ISSUED',
            generatedBy: opts.triggeredByUserId ? 'MANUAL' : 'CRON',
            generatedByUserId: opts.triggeredByUserId,
          }], { session });

          // Post charges journal (voucher number = invoice number, 1:1).
          const je = await postJournal(societyId, {
            voucherType: 'INVOICE',
            voucherNumber: invoiceNumber,
            entryDate: invoiceDate,
            narration: `Invoice ${invoiceNumber} — flat ${flat.number} (${period})`,
            lines: jlines,
            sourceType: 'INVOICE',
            sourceId: invoice._id,
            postedBy: actorId,
            postedByName: actorName,
            fyStartMonth: startMonth,
          }, session);
          invoice.journalEntryId = je._id;
          await invoice.save({ session });

          // Apply advance credit (contra), if any.
          if (advanceAppliedPaise > 0) {
            await postJournal(societyId, {
              voucherType: 'CONTRA',
              entryDate: invoiceDate,
              narration: `Advance adjusted against ${invoiceNumber}`,
              lines: [
                { accountCode: ACCOUNT_CODES.MEMBERS_ADVANCE, debitPaise: advanceAppliedPaise, flatId: flat._id, blockId },
                { accountCode: ACCOUNT_CODES.DEBTORS, creditPaise: advanceAppliedPaise, flatId: flat._id, blockId },
              ],
              sourceType: 'INVOICE',
              sourceId: invoice._id,
              postedBy: actorId,
              postedByName: actorName,
              fyStartMonth: startMonth,
            }, session);
          }
        });
        created++;
        totalBilledPaise += totalPaise;
      } catch (e: any) {
        if (e.code === 11000) { skipped++; }
        else { logger.error(`Invoice gen failed for flat ${flat._id}: ${e.message}`); errors.push(`Flat ${flat.number}: ${e.message}`); }
      } finally {
        session.endSession();
      }
    } catch (err: any) {
      logger.error(`Invoice gen error for flat ${flat._id}: ${err.message}`);
      errors.push(`Flat ${flat.number}: ${err.message}`);
    }
  }

  return { period, created, skipped, totalBilledPaise, errors, unbilled };
}
