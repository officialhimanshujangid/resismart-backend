/**
 * A charge head that is raised once a year.
 *
 * Small change, real money, so it ships on its own rather than buried inside
 * the parking module that needs it. Two things have to be true and the second
 * matters more than the first:
 *
 *   1. a YEARLY head bills in exactly one month of twelve, and re-running that
 *      month does not bill it twice;
 *   2. **every head that already exists keeps billing monthly.** The field is
 *      new, so no stored head has it — a query written as `billingFrequency:
 *      'MONTHLY'` would have quietly stopped billing every society in
 *      production on the day it shipped. That is the assertion below that is
 *      genuinely load-bearing.
 *
 *   npx tsx src/scripts/verify-yearly-billing.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { ChargeHead } from '../models/charge-head.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Block } from '../models/block.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';

const societyId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};

async function cleanup() {
  await Promise.all([
    LedgerAccount.deleteMany({ societyId }), JournalEntry.deleteMany({ societyId }),
    FinancePolicy.deleteMany({ societyId }), ChargeHead.deleteMany({ societyId }),
    MaintenanceInvoice.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Block.deleteMany({ societyId }),
  ]);
}

/** Total billed to a flat in a period, in paise. */
async function billed(period: string): Promise<number> {
  const rows = await MaintenanceInvoice.find({ societyId, billingPeriod: period }).lean();
  return rows.reduce((sum, r: any) => sum + (r.totalPaise || 0), 0);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    await getOrCreatePolicy(SID, actor.userId, actor.userName);

    const wing = await Block.create({
      societyId, name: 'A Wing',
      createdBy: userId, createdByName: 'Setup', updatedBy: userId, updatedByName: 'Setup',
    });
    await Flat.create({
      societyId, blockId: wing._id, blockName: 'A Wing', number: '101',
      status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: 'Setup', updatedBy: userId, updatedByName: 'Setup',
    });

    // ------------------------------------------------------------- the heads
    console.log('Two heads: one monthly, one raised every April');

    const monthly = await createChargeHead(SID, {
      code: 'MAINT', name: 'Maintenance', category: 'MAINTENANCE',
      pricingMode: 'UNIFORM', uniformAmountPaise: 100_000, // ₹1,000
      incomeAccountCode: '4100',
    } as any, actor);

    const yearly = await createChargeHead(SID, {
      code: 'PARK-YR', name: 'Parking (yearly)', category: 'PARKING',
      pricingMode: 'UNIFORM', uniformAmountPaise: 600_000, // ₹6,000 once a year
      incomeAccountCode: '4120',
      billingFrequency: 'YEARLY', annualBillingMonth: 4,
    } as any, actor);

    ok('a head defaults to monthly', (monthly as any).billingFrequency === 'MONTHLY');
    ok('...and a yearly one remembers its month',
      (yearly as any).billingFrequency === 'YEARLY' && (yearly as any).annualBillingMonth === 4);

    /**
     * The head that matters most: one stored WITHOUT the field at all, exactly
     * as every head in every existing society is stored today.
     */
    await ChargeHead.collection.insertOne({
      societyId, code: 'LEGACY', name: 'Water (legacy row)', category: 'WATER',
      pricingMode: 'UNIFORM', uniformAmountPaise: 50_000,
      incomeAccountId: (monthly as any).incomeAccountId, incomeAccountCode: '4100',
      applicability: { occupancy: ['ALL'] }, billTo: 'OWNER',
      gstApplicable: false, countsTowardRwaExemption: true,
      isRecurring: true, isActive: true, sortOrder: 100,
      createdBy: userId, createdByName: 'Setup',
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    const legacy = await ChargeHead.findOne({ societyId, code: 'LEGACY' }).lean();
    ok('a head stored before this field existed has none',
      (legacy as any)?.billingFrequency === undefined);

    // ------------------------------------------------------------ March: no
    console.log('\nMarch — the annual charge is not due');
    await generateInvoicesForSociety(SID, { period: '2026-03', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const march = await billed('2026-03');
    ok('monthly + legacy are billed', march === 150_000, `got ${march}`);
    ok('...and the yearly head is NOT', march !== 750_000);

    // ------------------------------------------------------------ April: yes
    console.log('\nApril — it is');
    await generateInvoicesForSociety(SID, { period: '2026-04', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const april = await billed('2026-04');
    ok('the annual charge lands exactly once', april === 750_000, `got ${april}`);

    // Re-running the same month must not bill it again. Idempotency already
    // holds on {society, flat, period}; this proves the new branch did not
    // find a way around it.
    await generateInvoicesForSociety(SID, { period: '2026-04', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    ok('re-running April does not charge it twice',
      (await billed('2026-04')) === 750_000);

    // ------------------------------------------------------------- May: no
    console.log('\nMay — back to normal');
    await generateInvoicesForSociety(SID, { period: '2026-05', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    ok('the month after is unaffected', (await billed('2026-05')) === 150_000);

    // -------------------------------------------------- an explicit selection
    console.log('\nAn explicit selection still honours the operator');
    await generateInvoicesForSociety(SID, {
      period: '2026-06', chargeHeadIds: [String((yearly as any)._id)], triggeredByUserId: actor.userId, triggeredByName: actor.userName,
    });
    ok('naming a yearly head bills it out of its month',
      (await billed('2026-06')) === 600_000, 'an operator asking for it by name means it');

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  await mongoose.disconnect();
  process.exit(1);
});
