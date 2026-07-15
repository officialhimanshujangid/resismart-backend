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

function computeBase(head: IChargeHead, flat: IFlat, meterUnits: number, maintenanceBasePaise: number, runningBasePaise: number): number {
  switch (head.pricingMode) {
    case 'UNIFORM':
    case 'FLAT_ADHOC':
      return head.uniformAmountPaise ?? 0;
    case 'PER_FLAT_SIZE': {
      const m = head.perSizeAmounts?.find((s) => s.flatSizeId.toString() === flat.size?.toString());
      return m ? m.amountPaise : (head.uniformAmountPaise ?? 0);
    }
    case 'PER_SQFT': {
      const area = head.areaBasis === 'BUILTUP' ? flat.builtUpAreaSqft : flat.carpetAreaSqft;
      if (!area || !head.ratePerSqftPaise) return 0;
      return Math.round(area * head.ratePerSqftPaise);
    }
    case 'METERED':
      return head.perUnitRatePaise ? Math.round(meterUnits * head.perUnitRatePaise) : 0;
    case 'PERCENTAGE': {
      const basis = head.percentOf === 'BASE' ? runningBasePaise : maintenanceBasePaise;
      return Math.round(basis * (head.percentValue ?? 0) / 100);
    }
    default:
      return 0;
  }
}

function computeGst(base: number, head: IChargeHead, policy: IFinancePolicy) {
  if (!policy.gst?.enabled || !head.gstApplicable) {
    return { rate: 0, gst: 0, cgst: 0, sgst: 0, igst: 0, sac: head.sacCode };
  }
  const rate = head.gstRatePercent ?? policy.gst.defaultRatePercent;
  const gst = Math.round(base * rate / 100);
  const cgst = Math.round(gst / 2);
  return { rate, gst, cgst, sgst: gst - cgst, igst: 0, sac: head.sacCode || policy.gst.defaultSac };
}

function computeInterest(arrearsPaise: number, policy: IFinancePolicy, maxDaysOverdue: number): number {
  const lf = policy.lateFee;
  if (!lf?.enabled || arrearsPaise <= 0) return 0;
  if (maxDaysOverdue <= (lf.graceDays || 0)) return 0;
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
async function getFlatArrears(societyId: string, flatId: any): Promise<{ arrearsPaise: number; maxDaysOverdue: number }> {
  const open = await MaintenanceInvoice.find({
    societyId: oid(societyId),
    flatId,
    status: { $in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
  }).select('outstandingPaise dueDate').lean();
  const arrearsPaise = open.reduce((s, i) => s + (i.outstandingPaise || 0), 0);
  const now = Date.now();
  const maxDaysOverdue = open.reduce((max, i) => {
    if (!i.dueDate) return max;
    const d = Math.floor((now - new Date(i.dueDate).getTime()) / 86400000);
    return Math.max(max, d);
  }, 0);
  return { arrearsPaise, maxDaysOverdue };
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

export interface GenerateOpts {
  period?: string;
  chargeHeadIds?: string[];
  flatIds?: string[];
  dryRun?: boolean;
  triggeredByUserId?: string;
  triggeredByName?: string;
}

export interface GenerateResult {
  period: string;
  created: number;
  skipped: number;
  totalBilledPaise: number;
  errors: string[];
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
  const period = opts.period || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [py, pm] = period.split('-').map(Number);
  const periodStart = new Date(py, pm - 1, 1);
  const periodEnd = new Date(py, pm, 0, 23, 59, 59, 999);

  const invoiceDate = now;
  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + (policy.billing?.dueDays ?? 15));
  dueDate.setHours(23, 59, 59, 999);
  const { fyString } = getFinancialYear(invoiceDate, startMonth);

  // Active charge heads (optionally filtered), sorted so PERCENTAGE heads run last.
  let headQuery: any = { societyId, isActive: true };
  if (opts.chargeHeadIds?.length) headQuery._id = { $in: opts.chargeHeadIds };
  const heads = (await ChargeHead.find(headQuery).lean<IChargeHead[]>())
    .sort((a, b) => (a.pricingMode === 'PERCENTAGE' ? 1 : 0) - (b.pricingMode === 'PERCENTAGE' ? 1 : 0) || a.sortOrder - b.sortOrder);
  if (!heads.length) return { period, created: 0, skipped: 0, totalBilledPaise: 0, errors: ['No active charge heads'] };

  const flatQuery: any = { societyId };
  if (opts.flatIds?.length) flatQuery._id = { $in: opts.flatIds };
  const flats = await Flat.find(flatQuery).lean<IFlat[]>();
  if (!flats.length) return { period, created: 0, skipped: 0, totalBilledPaise: 0, errors: ['No flats found'] };

  // Denormalization lookups
  const sizeIds = [...new Set(flats.map((f) => f.size?.toString()).filter(Boolean))] as string[];
  const ownerIds = [...new Set(flats.map((f) => f.ownerUserId?.toString()).filter(Boolean))] as string[];
  const sizeDocs = sizeIds.length ? await FlatSize.find({ _id: { $in: sizeIds } }).select('name').lean() : [];
  const ownerDocs = ownerIds.length ? await User.find({ _id: { $in: ownerIds } }).select('name').lean() : [];
  const sizeLabelById = new Map(sizeDocs.map((s) => [s._id.toString(), s.name]));
  const ownerNameById = new Map(ownerDocs.map((u) => [u._id.toString(), u.name]));

  // Existing invoices for this period → idempotency
  const existing = await MaintenanceInvoice.find({ societyId, billingPeriod: period }).select('flatId').lean();
  const existingFlatIds = new Set(existing.map((e) => e.flatId.toString()));

  let created = 0, skipped = 0, totalBilledPaise = 0;
  const errors: string[] = [];

  for (const flat of flats) {
    if (existingFlatIds.has((flat._id as any).toString())) { skipped++; continue; }

    try {
      // Build line items
      const meterReadings = heads.some((h) => h.pricingMode === 'METERED')
        ? await MeterReading.find({ societyId, flatId: flat._id, billingPeriod: period }).lean()
        : [];
      const meterByHead = new Map(meterReadings.map((m) => [m.chargeHeadId.toString(), m.unitsConsumed]));

      const lineItems: IInvoiceLineItem[] = [];
      let maintenanceBasePaise = 0;
      let runningBasePaise = 0;
      let subTotalPaise = 0;
      let gstTotalPaise = 0;

      for (const head of heads) {
        if (!isApplicable(head, flat)) continue;
        const meterUnits = meterByHead.get((head._id as any).toString()) || 0;
        const base = computeBase(head, flat, meterUnits, maintenanceBasePaise, runningBasePaise);
        if (base <= 0) continue;

        const gst = computeGst(base, head, policy);
        if (head.category === 'MAINTENANCE') maintenanceBasePaise += base;
        runningBasePaise += base;
        subTotalPaise += base;
        gstTotalPaise += gst.gst;

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
      const { arrearsPaise, maxDaysOverdue } = await getFlatArrears(societyId, flat._id);
      const interestPaise = computeInterest(arrearsPaise, policy, maxDaysOverdue);
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

      // Skip flats with no current charges AND no arrears
      if (subTotalPaise === 0 && interestPaise === 0 && arrearsPaise === 0) { skipped++; continue; }

      // Arrears display line (not posted — already in Debtors)
      if (arrearsPaise > 0) {
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
      for (const li of lineItems) {
        if (!li.isPostable) continue;
        jlines.push({ accountCode: li.incomeAccountCode!, creditPaise: li.baseAmountPaise, flatId: flat._id, fundId: li.fundId, description: li.name });
      }
      if (gstTotalPaise > 0) jlines.push({ accountCode: ACCOUNT_CODES.GST_OUTPUT, creditPaise: gstTotalPaise, flatId: flat._id, description: 'GST output' });
      if (roundingPaise > 0) jlines.push({ accountCode: ACCOUNT_CODES.ROUNDING_OFF, creditPaise: roundingPaise, flatId: flat._id, description: 'Rounding off' });
      if (roundingPaise < 0) jlines.push({ accountCode: ACCOUNT_CODES.ROUNDING_OFF, debitPaise: -roundingPaise, flatId: flat._id, description: 'Rounding off' });
      jlines.push({ accountCode: ACCOUNT_CODES.DEBTORS, debitPaise: totalPaise, flatId: flat._id, description: `Invoice ${period}` });

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
            billToRole: flat.status === 'RENTED' ? 'TENANT' : 'OWNER',
            invoiceNumber,
            financialYear: fyString,
            billingPeriod: period,
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
            status: 'ISSUED',
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
                { accountCode: ACCOUNT_CODES.MEMBERS_ADVANCE, debitPaise: advanceAppliedPaise, flatId: flat._id },
                { accountCode: ACCOUNT_CODES.DEBTORS, creditPaise: advanceAppliedPaise, flatId: flat._id },
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

  return { period, created, skipped, totalBilledPaise, errors };
}
