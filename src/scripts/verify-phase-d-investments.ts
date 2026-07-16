/**
 * Phase D verification — real database, THROWAWAY societyId, self-cleaning.
 * Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-phase-d-investments.ts
 *
 * Covers the FD / investment register (money bank→deposit, interest accrual,
 * where that interest lands, closure) and the PER_QUANTITY pricing mode.
 * Every number below is hand-calculated in the comment above it.
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinanceFund } from '../models/finance-fund.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { ChargeHead } from '../models/charge-head.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { Investment } from '../models/investment.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { createFund, fundAccount } from '../services/funds.service';
import { trialBalance } from '../services/reports.service';
import {
  createInvestment, listInvestments, updateInvestment,
  interestAccrualPreview, runInterestAccrual, closeInvestment,
} from '../services/investments.service';

const societyId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;
const refuses = async (fn: () => Promise<unknown>): Promise<Error | null> => {
  try { await fn(); return null; } catch (e: any) { return e; }
};
const iso = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();

async function cleanup() {
  await Promise.all([
    LedgerAccount.deleteMany({ societyId }), JournalEntry.deleteMany({ societyId }),
    FinanceFund.deleteMany({ societyId }), FinancePolicy.deleteMany({ societyId }),
    ChargeHead.deleteMany({ societyId }), MaintenanceInvoice.deleteMany({ societyId }),
    SequenceCounter.deleteMany({ societyId }), Flat.deleteMany({ societyId }),
    Investment.deleteMany({ societyId }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    await getOrCreatePolicy(SID, actor.userId, actor.userName);

    /** Signed balance of an account in the trial balance: debit − credit. */
    const balOf = (rows: { code: string; debitPaise: number; creditPaise: number }[], code: string) => {
      const r = rows.find(x => x.code === code);
      return r ? r.debitPaise - r.creditPaise : 0;
    };
    const tbNow = async () => (await trialBalance(SID)).rows;

    // ---------------------------------------------------- D1 placing a deposit
    console.log('D1 — placing a fixed deposit');
    // The bank needs money in it before any can move into a deposit.
    const { postJournal } = await import('../services/ledger.service');
    await postJournal(SID, {
      voucherType: 'OPENING', entryDate: new Date(2026, 0, 1), narration: 'verify: opening bank balance',
      lines: [
        { accountCode: '1100', debitPaise: 100_000_000 }, // ₹10,00,000 in the bank
        { accountCode: '3900', creditPaise: 100_000_000 },
      ],
      postedBy: actor.userId, postedByName: actor.userName,
    });

    const bankBefore = balOf(await tbNow(), '1100');
    // ₹5,00,000 at 8% for exactly one year: 1 Apr 2026 → 1 Apr 2027.
    const fd = await createInvestment(SID, {
      bankName: 'HDFC Bank', accountNumberLast4: '4321',
      principalPaise: 50_000_000, ratePercent: 8,
      startDate: iso(2026, 4, 1), maturityDate: iso(2027, 4, 1),
      interestPayout: 'CUMULATIVE',
    }, actor);
    eq('the deposit is on the register at its principal', fd.principalPaise, 50_000_000);
    eq('…worth exactly the principal before any interest', fd.currentValuePaise, 50_000_000);
    eq('…and starts out ACTIVE', fd.status, 'ACTIVE');

    const tbPlaced = await tbNow();
    // A deposit is NOT an expense: the money moves bank → deposit, and the
    // society is worth exactly the same the moment after it is placed.
    eq('placing an FD takes the money OUT of the bank', balOf(tbPlaced, '1100') - bankBefore, -50_000_000);
    eq('…and puts it INTO the deposit account', balOf(tbPlaced, '1300'), 50_000_000);
    eq('…booking no expense at all', balOf(tbPlaced, '5190'), 0);
    const placedTb = await trialBalance(SID);
    ok('…and the ledger ties', placedTb.balanced && placedTb.drift.length === 0, JSON.stringify(placedTb.drift));

    const badTerm = await refuses(() => createInvestment(SID, {
      bankName: 'Bad Bank', principalPaise: 100_000, ratePercent: 7,
      startDate: iso(2026, 4, 1), maturityDate: iso(2026, 3, 1),
    }, actor));
    ok('a deposit cannot mature before it starts', /after the start date/i.test(badTerm?.message || ''), badTerm?.message);

    // ---------------------------------------------------- D2 interest is exact
    console.log('\nD2 — interest for a known span');
    // ₹5,00,000 × 8% × 90/365. 1 Apr 2026 → 30 Jun 2026 is 90 days.
    //   50,000,000 × 0.08 = 4,000,000 paise a year
    //   4,000,000 × 90/365 = 986,301.369… → 986,301 paise = ₹9,863.01
    const GOLDEN_90_DAYS = 986_301;
    const prev = await interestAccrualPreview(SID, { upToDate: iso(2026, 6, 30) });
    const fdRow = prev.rows.find(r => r.investmentId === fd._id)!;
    eq('the span is measured from the deposit’s start', fdRow.days, 90);
    eq('90 days of ₹5,00,000 at 8% is ₹9,863.01', fdRow.interestPaise, GOLDEN_90_DAYS);
    eq('…and the preview totals it', prev.totalPaise, GOLDEN_90_DAYS);
    eq('…crediting income, not a fund, for an unlinked deposit', prev.toIncomePaise, GOLDEN_90_DAYS);
    eq('…with nothing going to any fund', prev.toFundsPaise, 0);
    ok('the preview says where it will land', fdRow.creditToLabel === 'Interest Income (Bank/FD)', fdRow.creditToLabel);
    // Nothing has posted yet — a preview that moved money would not be a preview.
    eq('previewing posts nothing', balOf(await tbNow(), '1300'), 50_000_000);

    // ---------------------------------------------------- D3 fund-linked vs not
    console.log('\nD3 — where the interest is credited');
    const sinking = await createFund(SID, { name: 'Sinking Fund', category: 'SINKING' }, actor);
    const sinkingAcct = await fundAccount(SID, String(sinking._id), actor);
    // ₹2,00,000 at 7% for the same 90-day span, but this money belongs to the
    // sinking fund. 1 Apr 2026 → 30 Jun 2026.
    //   20,000,000 × 0.07 = 1,400,000 paise a year
    //   1,400,000 × 90/365 = 345,205.479… → 345,205 paise = ₹3,452.05
    const GOLDEN_FUND_90 = 345_205;
    const fundFd = await createInvestment(SID, {
      bankName: 'SBI', principalPaise: 20_000_000, ratePercent: 7,
      startDate: iso(2026, 4, 1), maturityDate: iso(2028, 4, 1),
      linkedFundId: String(sinking._id),
    }, actor);
    eq('a fund-linked deposit records its fund', fundFd.linkedFundId, String(sinking._id));

    const prev2 = await interestAccrualPreview(SID, { upToDate: iso(2026, 6, 30) });
    const fundRow = prev2.rows.find(r => r.investmentId === fundFd._id)!;
    eq('90 days of ₹2,00,000 at 7% is ₹3,452.05', fundRow.interestPaise, GOLDEN_FUND_90);
    eq('the preview splits fund interest out', prev2.toFundsPaise, GOLDEN_FUND_90);
    eq('…from income interest', prev2.toIncomePaise, GOLDEN_90_DAYS);

    const incomeBefore = balOf(await tbNow(), '4200');
    const fundAcctBefore = balOf(await tbNow(), sinkingAcct.code);
    const run = await runInterestAccrual(SID, { upToDate: iso(2026, 6, 30) }, actor);
    ok('the accrual run posts', run.posted, JSON.stringify(run.rows.map(r => r.skipReason)));
    eq('…one voucher for both deposits', run.investmentsAccrued, 2);
    eq('…totalling what the preview said', run.totalPaise, GOLDEN_90_DAYS + GOLDEN_FUND_90);

    const tbAccrued = await tbNow();
    // THE point of the linked fund. 4200 and the fund account are both
    // credit-normal, so debit−credit reads negative as each is credited.
    eq('the fund-linked FD credits the FUND’s own account',
      balOf(tbAccrued, sinkingAcct.code) - fundAcctBefore, -GOLDEN_FUND_90);
    eq('…and NOT interest income — 4200 only moves by the unlinked FD’s interest',
      balOf(tbAccrued, '4200') - incomeBefore, -GOLDEN_90_DAYS);
    // Interest accrues INTO the deposit either way: earned, but not yet paid out.
    eq('both lots of interest swell the deposit account',
      balOf(tbAccrued, '1300'), 50_000_000 + 20_000_000 + GOLDEN_90_DAYS + GOLDEN_FUND_90);
    eq('…and none of it touches the bank', balOf(tbAccrued, '1100'), bankBefore - 70_000_000);

    const afterRun = await Investment.findById(fd._id);
    eq('the deposit carries what it earned', afterRun?.accruedInterestPaise, GOLDEN_90_DAYS);
    ok('…and its through-date moved', !!afterRun?.lastAccrualUpTo);

    // ---------------------------------------------------- D4 idempotency
    console.log('\nD4 — running the same period twice');
    const rerun = await runInterestAccrual(SID, { upToDate: iso(2026, 6, 30) }, actor);
    eq('a second run for the same date accrues nothing', rerun.totalPaise, 0);
    eq('…and posts no voucher at all', rerun.posted, false);
    const afterRerun = await Investment.findById(fd._id);
    eq('…leaving the deposit exactly where it was', afterRerun?.accruedInterestPaise, GOLDEN_90_DAYS);
    eq('…and the ledger exactly where it was',
      balOf(await tbNow(), '1300'), 50_000_000 + 20_000_000 + GOLDEN_90_DAYS + GOLDEN_FUND_90);
    ok('…explaining itself in the row', rerun.rows.every(r => !!r.skipReason), JSON.stringify(rerun.rows.map(r => r.skipReason)));

    // Only the UN-accrued span is charged next time — not the whole thing again.
    // 1 Jul 2026 → 30 Sep 2026 is 92 days:
    //   4,000,000 × 92/365 = 1,008,219.178… → 1,008,219 paise = ₹10,082.19
    const GOLDEN_NEXT_92 = 1_008_219;
    const run2 = await interestAccrualPreview(SID, { upToDate: iso(2026, 9, 30) });
    const nextRow = run2.rows.find(r => r.investmentId === fd._id)!;
    eq('the next run picks up only the un-accrued span', nextRow.days, 92);
    eq('…charging just that span’s interest', nextRow.interestPaise, GOLDEN_NEXT_92);

    // ---------------------------------------------------- D5 closing
    console.log('\nD5 — closing a deposit');
    const listBeforeClose = await listInvestments(SID);
    eq('the register shows both live deposits', listBeforeClose.totals.count, 2);
    eq('…with principal totalled', listBeforeClose.totals.principalPaise, 70_000_000);
    eq('…and interest earned totalled', listBeforeClose.totals.accruedInterestPaise, GOLDEN_90_DAYS + GOLDEN_FUND_90);

    // Carrying value = ₹5,00,000 principal + ₹9,863.01 accrued = ₹5,09,863.01.
    // The bank pays exactly that, so there is nothing left over to book.
    const carrying = 50_000_000 + GOLDEN_90_DAYS;
    const bankBeforeClose = balOf(await tbNow(), '1100');
    const incomeBeforeClose = balOf(await tbNow(), '4200');
    const closed = await closeInvestment(SID, fd._id, { closedOn: iso(2026, 6, 30), proceedsPaise: carrying }, actor);
    eq('a closed deposit is marked closed', closed.status, 'CLOSED');
    ok('…with the date recorded', !!closed.closedOn);

    const tbClosed = await tbNow();
    eq('the proceeds come back to the bank', balOf(tbClosed, '1100') - bankBeforeClose, carrying);
    eq('…the deposit leaves the books at principal + accrued',
      balOf(tbClosed, '1300'), 20_000_000 + GOLDEN_FUND_90);
    eq('…and an exact payout books no extra interest', balOf(tbClosed, '4200') - incomeBeforeClose, 0);

    const twice = await refuses(() => closeInvestment(SID, fd._id, { proceedsPaise: 1 }, actor));
    ok('a deposit cannot be closed twice', /already closed/i.test(twice?.message || ''), twice?.message);
    const closedAccrual = await interestAccrualPreview(SID, { upToDate: iso(2026, 12, 31) });
    eq('…and a closed deposit earns nothing more',
      closedAccrual.rows.find(r => r.investmentId === fd._id)?.skipReason, 'Closed');

    // A bank that pays MORE than the books say — the excess is interest income.
    const bonusFd = await createInvestment(SID, {
      bankName: 'Canara Bank', principalPaise: 10_000_000, ratePercent: 6,
      startDate: iso(2026, 4, 1), maturityDate: iso(2027, 4, 1),
    }, actor);
    const incomeBeforeBonus = balOf(await tbNow(), '4200');
    // Nothing accrued on it, so it carries ₹1,00,000. The bank pays ₹1,05,000 →
    // a ₹5,000 excess that has to land somewhere, or it strands in 1300.
    await closeInvestment(SID, bonusFd._id, { closedOn: iso(2026, 7, 1), proceedsPaise: 10_500_000 }, actor);
    eq('paying more than the books say books the extra as interest income',
      balOf(await tbNow(), '4200') - incomeBeforeBonus, -500_000);

    // A bank that pays LESS — a premature-withdrawal penalty comes back out.
    const penaltyFd = await createInvestment(SID, {
      bankName: 'Axis Bank', principalPaise: 10_000_000, ratePercent: 6,
      startDate: iso(2026, 4, 1), maturityDate: iso(2027, 4, 1),
    }, actor);
    const incomeBeforePenalty = balOf(await tbNow(), '4200');
    // Carries ₹1,00,000; broken early for ₹98,000 → a ₹2,000 shortfall.
    await closeInvestment(SID, penaltyFd._id, { closedOn: iso(2026, 7, 1), proceedsPaise: 9_800_000 }, actor);
    eq('paying less takes the shortfall back out of interest income',
      balOf(await tbNow(), '4200') - incomeBeforePenalty, 200_000);

    // ---------------------------------------------------- D6 maturity & edits
    console.log('\nD6 — maturity stops the clock');
    // ₹1,00,000 at 10%, a 30-day deposit: 1 May 2026 → 31 May 2026.
    //   10,000,000 × 0.10 = 1,000,000 paise a year
    //   1,000,000 × 30/365 = 82,191.78… → 82,192 paise = ₹821.92
    const GOLDEN_MATURITY = 82_192;
    const shortFd = await createInvestment(SID, {
      bankName: 'Kotak Bank', principalPaise: 10_000_000, ratePercent: 10,
      startDate: iso(2026, 5, 1), maturityDate: iso(2026, 5, 31),
    }, actor);
    // Asked for interest to 31 Dec — but the deposit matured on 31 May and does
    // not renew, so it stops earning there. Inventing seven more months of
    // interest would overstate a reserve that is really sitting idle.
    const matPrev = await interestAccrualPreview(SID, { upToDate: iso(2026, 12, 31) });
    const matRow = matPrev.rows.find(r => r.investmentId === shortFd._id)!;
    eq('a matured deposit only earns up to its maturity date', matRow.days, 30);
    eq('…which is 30 days of interest, not eight months', matRow.interestPaise, GOLDEN_MATURITY);
    await runInterestAccrual(SID, { upToDate: iso(2026, 12, 31) }, actor);
    const matured = await Investment.findById(shortFd._id);
    eq('…and accruing through maturity marks it MATURED', matured?.status, 'MATURED');
    eq('…for exactly the interest the preview promised', matured?.accruedInterestPaise, GOLDEN_MATURITY);
    const matAgain = await runInterestAccrual(SID, { upToDate: iso(2027, 6, 30) }, actor);
    eq('…and it never earns another paisa after maturity',
      matAgain.rows.find(r => r.investmentId === shortFd._id)?.interestPaise, 0);

    const edited = await updateInvestment(SID, String(fundFd._id), { bankName: 'SBI — Main Branch' });
    eq('a deposit’s details can be corrected', edited.bankName, 'SBI — Main Branch');
    const editClosed = await refuses(() => updateInvestment(SID, fd._id, { bankName: 'Nope' }));
    ok('…but not once it is closed', /closed/i.test(editClosed?.message || ''), editClosed?.message);

    // ---------------------------------------------------- D7 PER_QUANTITY
    console.log('\nD7 — PER_QUANTITY pricing');
    const blockId = new mongoose.Types.ObjectId();
    const [twoCars, noCar] = await Flat.create([
      {
        number: '101', blockName: 'A', blockId, societyId, status: FlatStatus.OWNER_OCCUPIED,
        quantities: { parkingSlots: 2 },
        createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
      },
      {
        // No quantities at all — the flat has no car, and must not be billed.
        number: '102', blockName: 'A', blockId, societyId, status: FlatStatus.OWNER_OCCUPIED,
        createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
      },
    ]);

    // ₹500 a slot. The flat with 2 slots owes 2 × ₹500 = ₹1,000.
    await createChargeHead(SID, {
      code: 'PARK', name: 'Parking', category: 'PARKING',
      pricingMode: 'PER_QUANTITY', perUnitRatePaise: 50_000, quantityKey: 'parkingSlots',
    }, actor);
    await generateInvoicesForSociety(SID, {
      period: '2026-08', flatIds: [String(twoCars._id), String(noCar._id)],
      triggeredByUserId: actor.userId, triggeredByName: actor.userName,
    });

    const twoCarInv = await MaintenanceInvoice.findOne({ societyId, flatId: twoCars._id, billingPeriod: '2026-08' }).lean();
    eq('2 slots × ₹500 bills ₹1,000', twoCarInv?.totalPaise, 100_000);
    eq('…as a single parking line', twoCarInv?.lineItems.find(l => l.code === 'PARK')?.baseAmountPaise, 100_000);
    const noCarInv = await MaintenanceInvoice.findOne({ societyId, flatId: noCar._id, billingPeriod: '2026-08' }).lean();
    // No invoice at all is the right answer: the flat owes nothing, and billing
    // ₹0 for a car it does not have would be a bill it has to query.
    ok('a flat with no count is not billed', !noCarInv || !noCarInv.lineItems.some(l => l.code === 'PARK'),
      JSON.stringify(noCarInv?.lineItems.map(l => l.code)));

    // A head naming a key no flat carries bills nobody — rather than guessing 1.
    await createChargeHead(SID, {
      code: 'PETS', name: 'Pet Registration', category: 'OTHER',
      pricingMode: 'PER_QUANTITY', perUnitRatePaise: 20_000, quantityKey: 'pets',
    }, actor);
    await generateInvoicesForSociety(SID, {
      period: '2026-09', flatIds: [String(twoCars._id)],
      triggeredByUserId: actor.userId, triggeredByName: actor.userName,
    });
    const petInv = await MaintenanceInvoice.findOne({ societyId, flatId: twoCars._id, billingPeriod: '2026-09' }).lean();
    ok('a key the flat does not carry bills nothing', !petInv?.lineItems.some(l => l.code === 'PETS'),
      JSON.stringify(petInv?.lineItems.map(l => l.code)));
    eq('…while the counts it does carry still bill', petInv?.lineItems.find(l => l.code === 'PARK')?.baseAmountPaise, 100_000);

    // ---------------------------------------------------- integrity
    console.log('\nLedger integrity');
    const final = await trialBalance(SID);
    ok('the ledger still ties', final.balanced,
      `Dr ${rupees(final.totalDebitPaise)} vs Cr ${rupees(final.totalCreditPaise)}`);
    ok('no account has drifted from its entries', final.drift.length === 0, JSON.stringify(final.drift));
  } catch (e: any) {
    fail++;
    console.log(`\n  ERROR  ${e.message}\n${e.stack}`);
  } finally {
    await cleanup();
    console.log('\nThrowaway data removed.');
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  process.exit(fail ? 1 : 0);
}

main();