/**
 * One-time migration: group legacy `SocietyBill` rows (one bill per flat per
 * template per period) into consolidated `MaintenanceInvoice` documents (one per
 * flat per period, with a line item per old bill) so historical dues appear in
 * the new invoicing UI.
 *
 * SAFE: idempotent (skips periods already migrated) and does NOT post to the GL
 * — these are historical records; opening balances into the ledger are a
 * separate, explicit OPENING voucher decision.
 *
 *   npx ts-node src/scripts/backfill-invoices.ts [societyId]
 */
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { SocietyBill } from '../models/society-bill.model';
import { MaintenanceInvoice, IInvoiceLineItem, InvoiceStatus } from '../models/maintenance-invoice.model';
import { getFinancialYear } from '../utils/financial-year.util';
import { logger } from '../utils/logger.util';

const CATEGORY_MAP: Record<string, IInvoiceLineItem['category']> = {
  MAINTENANCE: 'MAINTENANCE', CORPUS: 'CORPUS', SPECIAL: 'ADHOC', UTILITY: 'UTILITY', CUSTOM: 'OTHER',
};

function deriveStatus(totalPaise: number, paidPaise: number, legacy: string): InvoiceStatus {
  if (legacy === 'WAIVED') return 'WAIVED';
  if (legacy === 'VOID') return 'CANCELLED';
  if (paidPaise >= totalPaise && totalPaise > 0) return 'PAID';
  if (paidPaise > 0) return 'PARTIALLY_PAID';
  return 'ISSUED';
}

async function main() {
  const societyFilter = process.argv[2] ? { societyId: new mongoose.Types.ObjectId(process.argv[2]) } : {};
  await mongoose.connect(appConfig.mongoUri);
  logger.info('[backfill] connected');

  const bills = await SocietyBill.find(societyFilter).lean();
  // group by society|flat|period
  const groups = new Map<string, typeof bills>();
  for (const b of bills) {
    const key = `${b.societyId}|${b.flatId}|${b.billingPeriod}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }

  let created = 0, skipped = 0;
  for (const [, rows] of groups) {
    const first = rows[0];
    const exists = await MaintenanceInvoice.exists({ societyId: first.societyId, flatId: first.flatId, billingPeriod: first.billingPeriod });
    if (exists) { skipped++; continue; }

    const lineItems: IInvoiceLineItem[] = rows.map((b) => ({
      code: b.billTemplateName?.slice(0, 20) || 'CHARGE',
      name: b.billTemplateName || 'Charge',
      category: CATEGORY_MAP[b.category] || 'OTHER',
      baseAmountPaise: b.baseAmountPaise,
      gstApplicable: false, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, gstPaise: 0,
      lineTotalPaise: b.totalAmountPaise,
      isPostable: false, // historical — not posted to the GL
    }));

    const subTotalPaise = rows.reduce((s, b) => s + b.baseAmountPaise, 0);
    const interestPaise = rows.reduce((s, b) => s + (b.lateFeeAmountPaise || 0), 0);
    const totalPaise = rows.reduce((s, b) => s + b.totalAmountPaise, 0);
    const paidPaise = rows.reduce((s, b) => s + (b.paidAmountPaise || 0), 0);
    const { fyString } = getFinancialYear(first.dueDate || first.createdAt || new Date());

    await MaintenanceInvoice.create({
      societyId: first.societyId,
      flatId: first.flatId,
      blockName: first.blockName,
      flatNumber: first.flatNumber,
      flatSizeId: first.flatSizeId,
      flatSizeLabel: first.flatSizeLabel,
      primaryOwnerUserId: first.primaryOwnerUserId,
      primaryOwnerName: first.primaryOwnerName,
      billToRole: 'OWNER',
      invoiceNumber: `LEGACY/${first.billNumber}`,
      financialYear: fyString,
      billingPeriod: first.billingPeriod,
      invoiceDate: first.createdAt || new Date(),
      dueDate: first.dueDate,
      lineItems,
      openingArrearsPaise: 0,
      subTotalPaise,
      gstPaise: 0,
      interestPaise,
      roundingPaise: 0,
      totalPaise,
      grandTotalDuePaise: totalPaise,
      allocatedPaise: paidPaise,
      advanceAppliedPaise: 0,
      waivedPaise: 0,
      outstandingPaise: Math.max(0, totalPaise - paidPaise),
      status: deriveStatus(totalPaise, paidPaise, first.status),
      generatedBy: 'MANUAL',
    });
    created++;
  }

  logger.info(`[backfill] done: ${created} invoices created, ${skipped} periods skipped (already migrated)`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
