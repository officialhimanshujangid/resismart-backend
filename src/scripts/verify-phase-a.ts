/**
 * Phase A verification — runs against the real database on a THROWAWAY societyId
 * and deletes everything it created on the way out. It never touches existing data.
 *
 *   npx ts-node src/scripts/verify-phase-a.ts
 *
 * Proves the four Phase A claims:
 *   A1  reports are financial-year scoped (they used to sum every year together)
 *   A2  an OPENING voucher balances the books
 *   A3  a fund of any category can actually be collected into, and spent from
 *   A4  one-time levies bill once; SLAB can't silently zero late fees
 */
import '../config/timezone'; // MUST stay first — FY assertions depend on the pinned TZ
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinanceFund } from '../models/finance-fund.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { ChargeHead } from '../models/charge-head.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Expense } from '../models/expense.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { postJournal } from '../services/ledger.service';
import { incomeExpenditure, balanceSheet, trialBalance, fundStatement } from '../services/reports.service';
import { createFund, listFunds } from '../services/funds.service';
import { createChargeHead, updateChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { createExpense, approveExpense, payExpense } from '../services/expenses.service';
import { recordClearedReceipt, clearCheque, bounceReceipt } from '../services/collections.service';
import { updateFinancePolicySchema } from '../validators/society-finance.validator';
import { Receipt } from '../models/receipt.model';

const societyId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const SID = societyId.toString();

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;

/** Dr Debtors / Cr Maintenance Income — a stand-in for a billed month. */
const bill = (date: Date, paise: number) => postJournal(SID, {
  voucherType: 'JOURNAL',
  entryDate: date,
  narration: 'verify: billed',
  lines: [
    { accountCode: '1200', debitPaise: paise, description: 'dues' },
    { accountCode: '4100', creditPaise: paise, description: 'income' },
  ],
  postedBy: actor.userId,
  postedByName: actor.userName,
});

async function cleanup() {
  await Promise.all([
    LedgerAccount.deleteMany({ societyId }),
    JournalEntry.deleteMany({ societyId }),
    FinanceFund.deleteMany({ societyId }),
    FinancePolicy.deleteMany({ societyId }),
    ChargeHead.deleteMany({ societyId }),
    MaintenanceInvoice.deleteMany({ societyId }),
    Expense.deleteMany({ societyId }),
    SequenceCounter.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }),
    Receipt.deleteMany({ societyId }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    await getOrCreatePolicy(SID, actor.userId, actor.userName);

    // ---------------------------------------------------------------- A1
    console.log('A1 — reports are financial-year scoped');
    await bill(new Date(2024, 5, 15), 100_000);  // FY 2024-25 (Jun 2024) ₹1,000
    await bill(new Date(2025, 5, 15), 200_000);  // FY 2025-26 (Jun 2025) ₹2,000

    const ie24 = await incomeExpenditure(SID, { fy: '2024' });
    const ie25 = await incomeExpenditure(SID, { fy: '2025' });
    eq('I&E FY2024-25 income is FY1 only', ie24.totalIncomePaise, 100_000);
    eq('I&E FY2025-26 income is FY2 only', ie25.totalIncomePaise, 200_000);
    eq('FY1 + FY2 equals the lifetime total', ie24.totalIncomePaise + ie25.totalIncomePaise, 300_000);
    ok('FY2 does not leak into FY1 (the original bug)', ie24.totalIncomePaise !== 300_000,
      `I&E FY2024-25 returned ${rupees(ie24.totalIncomePaise)} — the whole point is that it must not be ₹3,000`);
    eq('previous-year comparative on FY2025-26', ie25.previousTotalIncomePaise, 100_000);

    const bs = await balanceSheet(SID, { asOf: '2025-08-01' });
    eq('accumulated surplus = everything before this FY', bs.accumulatedSurplusPaise, 100_000);
    eq('current-year surplus = this FY only', bs.currentSurplusPaise, 200_000);
    ok('balance sheet balances', bs.balanced, `assets ${rupees(bs.assetsTotalPaise)} vs funding ${rupees(bs.liabilitiesPlusFundsPlusEquityPaise)}`);

    // ---------------------------------------------------------------- A2
    console.log('\nA2 — opening balances');
    const opening = await postJournal(SID, {
      voucherType: 'OPENING',
      entryDate: new Date(2024, 3, 1),
      narration: 'verify: opening balances',
      lines: [
        { accountCode: '1100', debitPaise: 500_000, description: 'opening bank' },
        { accountCode: '3900', creditPaise: 500_000, description: 'opening equity' },
      ],
      postedBy: actor.userId,
      postedByName: actor.userName,
    });
    ok('OPENING voucher numbered OB/...', String(opening.voucherNumber).startsWith('OB/'), String(opening.voucherNumber));

    const tb = await trialBalance(SID);
    ok('trial balance ties', tb.balanced, `Dr ${rupees(tb.totalDebitPaise)} vs Cr ${rupees(tb.totalCreditPaise)}`);
    ok('no cache drift vs the ledger', tb.drift.length === 0, JSON.stringify(tb.drift));

    const bs2 = await balanceSheet(SID, { asOf: '2025-08-01' });
    ok('balance sheet still balances after opening', bs2.balanced,
      `assets ${rupees(bs2.assetsTotalPaise)} vs funding ${rupees(bs2.liabilitiesPlusFundsPlusEquityPaise)}`);
    // Bank sits inside the Cash & Bank schedule now, not at the top of the
    // assets list — the Balance Sheet groups accounts under their heading.
    const cashBank = bs2.assets.find(a => a.code === '1000');
    eq('opening bank lands in assets, under Cash & Bank',
      cashBank?.children?.find(c => c.code === '1100')?.amountPaise, 500_000);
    eq('…and rolls up into the heading', cashBank?.amountPaise, 500_000);

    // ---------------------------------------------------------------- A3
    console.log('\nA3 — funds can be collected into and spent from');
    const lift = await createFund(SID, { name: 'Lift Replacement Fund', category: 'SPECIAL' }, actor);
    ok('a SPECIAL fund gets its own ledger account', !!lift.ledgerAccountId, 'no ledgerAccountId');
    const liftAcct = await LedgerAccount.findById(lift.ledgerAccountId);
    ok('the fund account is FUND-type and credit-normal', liftAcct?.type === 'FUND' && liftAcct?.normalBalance === 'CREDIT');
    ok('the fund account is numbered outside the seeded range', Number(liftAcct?.code) >= 3130, `code ${liftAcct?.code}`);

    // Two funds of the same category must not share one account (the double-count bug).
    const corpusA = await createFund(SID, { name: 'Corpus A', category: 'CORPUS' }, actor);
    const corpusB = await createFund(SID, { name: 'Corpus B', category: 'CORPUS' }, actor);
    ok('two CORPUS funds get different accounts',
      String(corpusA.ledgerAccountId) !== String(corpusB.ledgerAccountId),
      'both funds point at the same ledger account — reserves would double-count');

    // A head whose CATEGORY says ADHOC (→ 4150 income) but is linked to a fund
    // must credit the FUND. This is the exact bug the user hit.
    const head = await createChargeHead(SID, {
      code: 'LIFT', name: 'Lift Fund Levy', category: 'ADHOC', pricingMode: 'UNIFORM',
      uniformAmountPaise: 100_000, fundId: String(lift._id),
    }, actor);
    eq('a fund-linked head credits the fund, not income', head.incomeAccountCode, liftAcct?.code);
    ok('...and specifically NOT the ADHOC income default 4150', head.incomeAccountCode !== '4150');

    const blockId = new mongoose.Types.ObjectId();
    await Flat.create([1, 2].map(n => ({
      number: `10${n}`, blockName: 'A', blockId, societyId, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    })));

    await generateInvoicesForSociety(SID, { period: '2025-06', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    let fundsNow = await listFunds(SID, actor);
    const liftBalance = fundsNow.find(f => f._id === String(lift._id))?.currentBalancePaise;
    eq('billing 2 flats × ₹1,000 puts ₹2,000 into the fund', liftBalance, 200_000);
    ok('the fund is no longer stuck at ₹0', (liftBalance || 0) > 0, 'this read ₹0 forever before Phase A');

    const exp = await createExpense(SID, {
      expenseDate: new Date(2025, 6, 1),
      lineItems: [{ expenseAccountCode: '5140', amountPaise: 50_000, fundId: String(lift._id), description: 'lift part' }],
    }, actor);
    await approveExpense(SID, String(exp._id), { userId: new mongoose.Types.ObjectId().toString(), userName: 'Approver' });
    await payExpense(SID, String(exp._id), actor, 'BANK');
    fundsNow = await listFunds(SID, actor);
    eq('spending ₹500 from the fund reduces it', fundsNow.find(f => f._id === String(lift._id))?.currentBalancePaise, 150_000);

    const tb3 = await trialBalance(SID);
    ok('ledger still ties after fund activity', tb3.balanced && tb3.drift.length === 0);

    // ---------------------------------------------------------------- A4
    console.log('\nA4 — silent bugs');
    await createChargeHead(SID, {
      code: 'ONETIME', name: 'One-time Painting Levy', category: 'ADHOC',
      pricingMode: 'FLAT_ADHOC', uniformAmountPaise: 500_000, isRecurring: false,
    }, actor);
    await generateInvoicesForSociety(SID, { period: '2025-07', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const julyInv = await MaintenanceInvoice.findOne({ societyId, billingPeriod: '2025-07' }).lean();
    ok('a one-time levy is NOT auto-billed in a normal run',
      !(julyInv?.lineItems || []).some(l => l.code === 'ONETIME'),
      'the one-time levy was billed again — it would recur every month');

    await generateInvoicesForSociety(SID, {
      period: '2025-08', chargeHeadIds: [String((await ChargeHead.findOne({ societyId, code: 'ONETIME' }))!._id)],
      triggeredByUserId: actor.userId, triggeredByName: actor.userName,
    });
    const augInv = await MaintenanceInvoice.findOne({ societyId, billingPeriod: '2025-08' }).lean();
    ok('...but it IS billed when deliberately selected',
      (augInv?.lineItems || []).some(l => l.code === 'ONETIME'));

    const slabBad = updateFinancePolicySchema.safeParse({ lateFee: { enabled: true, mode: 'SLAB', slabs: [] } });
    ok('SLAB with no slabs is rejected (used to silently charge ₹0)', !slabBad.success);
    const slabGood = updateFinancePolicySchema.safeParse({ lateFee: { enabled: true, mode: 'SLAB', slabs: [{ uptoDays: 30, ratePercent: 12 }] } });
    ok('SLAB with slabs is accepted', slabGood.success);

    // ------------------------------------------------- review regressions
    console.log('\nReview findings — regression locks');

    // The frontend always sends fundId: '' when no fund is chosen.
    const plain = await createChargeHead(SID, {
      code: 'PLAIN', name: 'Plain Maintenance', category: 'MAINTENANCE',
      pricingMode: 'UNIFORM', uniformAmountPaise: 1_000, fundId: '',
    }, actor);
    eq("fundId: '' creates a normal head instead of an ObjectId cast error", plain.incomeAccountCode, '4100');

    // Link → unlink must revert to the category default, not stay on the fund.
    await updateChargeHead(SID, String(plain._id), { category: 'MAINTENANCE', fundId: String(lift._id) }, actor);
    let relinked = await ChargeHead.findById(plain._id);
    eq('linking a fund repoints the head at the fund account', relinked!.incomeAccountCode, liftAcct?.code);
    await updateChargeHead(SID, String(plain._id), { category: 'MAINTENANCE', fundId: '' }, actor);
    relinked = await ChargeHead.findById(plain._id);
    eq('unlinking reverts to the category default', relinked!.incomeAccountCode, '4100');
    ok('...and clears fundId', !relinked!.fundId);

    // Changing category must move the GL account (the UI never sends incomeAccountCode).
    await updateChargeHead(SID, String(plain._id), { category: 'FESTIVAL' }, actor);
    relinked = await ChargeHead.findById(plain._id);
    eq('changing category repoints the GL account', relinked!.incomeAccountCode, '4150');

    // Prior-year-only accounts must survive into the comparative column.
    const ieCmp = await incomeExpenditure(SID, { fy: '2026' });
    eq('an account with only prior-year activity still appears', ieCmp.income.some(r => r.code === '4100'), true);
    eq('...carrying its previous-year figure', ieCmp.income.find(r => r.code === '4100')?.previousAmountPaise, 200_000);
    const bsCmp = await balanceSheet(SID, { fy: '2026' });
    eq('previous-year assets column foots to the previous total',
      bsCmp.assets.reduce((s, r) => s + (r.previousAmountPaise || 0), 0), bsCmp.previous.assetsTotalPaise);
    ok('the previous year balances on its own', bsCmp.previous.assetsTotalPaise === bsCmp.previous.liabilitiesPlusFundsPlusEquityPaise,
      `prev assets ${rupees(bsCmp.previous.assetsTotalPaise)} vs prev funding ${rupees(bsCmp.previous.liabilitiesPlusFundsPlusEquityPaise)}`);

    // Bad input must be rejected, not answered with a 1926 statement.
    let rejected = false;
    try { await balanceSheet(SID, { fy: '26-27' }); } catch { rejected = true; }
    ok("fy='26-27' is rejected (used to silently report FY 1926-1927)", rejected);
    rejected = false;
    try { await trialBalance(SID, { asOf: 'garbage' }); } catch { rejected = true; }
    ok("asOf='garbage' is rejected instead of 500ing on an Invalid Date", rejected);

    // Fund Statement and the Funds page must agree.
    const fs = await fundStatement(SID);
    const fundsList = await listFunds(SID, actor);
    eq('Fund Statement total matches the Funds page total',
      fs.totalPaise, fundsList.reduce((s, f) => s + f.currentBalancePaise, 0));

    // Bouncing a DEPOSITED cheque must take the money back out of the bank.
    // Reversing only the receipt left Bank overstated and Undeposited negative —
    // and because both postings were cached faithfully, every balance check
    // (trial balance, drift, "balanced") still passed while the bank was wrong.
    const balOf = (rows: { code: string; debitPaise: number; creditPaise: number }[], code: string) => {
      const r = rows.find(x => x.code === code);
      return r ? r.debitPaise - r.creditPaise : 0;
    };
    const flatForCheque = await Flat.findOne({ societyId });
    const bankBefore = balOf((await trialBalance(SID)).rows, '1100');

    const chq = await recordClearedReceipt(SID, {
      flatId: String(flatForCheque!._id), blockName: 'A', flatNumber: '101',
      mode: 'CHEQUE', amountPaise: 75_000, source: 'ADMIN_WALKIN',
      instrument: { chequeNo: '000123', bankName: 'HDFC' },
      actor: { ...actor, role: 'SOCIETY_ADMIN' },
    });
    await clearCheque(SID, String(chq._id), actor);
    const bankAfterDeposit = balOf((await trialBalance(SID)).rows, '1100');
    eq('depositing the cheque puts ₹750 in the bank', bankAfterDeposit - bankBefore, 75_000);

    await bounceReceipt(SID, String(chq._id), actor, 'insufficient funds');
    const tbBounced = await trialBalance(SID);
    eq('bouncing a deposited cheque takes the money back out of the bank', balOf(tbBounced.rows, '1100'), bankBefore);
    eq('...and leaves Undeposited Cheques at zero, not negative', balOf(tbBounced.rows, '1120'), 0);
    ok('ledger still ties and has not drifted after the bounce', tbBounced.balanced && tbBounced.drift.length === 0,
      JSON.stringify(tbBounced.drift));

    // billTo is now honoured (it was saved, displayed and ignored).
    await ChargeHead.deleteMany({ societyId });
    const rentedBlock = new mongoose.Types.ObjectId();
    const rented = await Flat.create({
      number: '201', blockName: 'B', blockId: rentedBlock, societyId, status: FlatStatus.RENTED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    await createChargeHead(SID, {
      code: 'OCC', name: 'Occupant Water', category: 'WATER', pricingMode: 'UNIFORM',
      uniformAmountPaise: 10_000, billTo: 'OCCUPANT',
    }, actor);
    await generateInvoicesForSociety(SID, { period: '2025-09', flatIds: [String(rented._id)], triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const occInv = await MaintenanceInvoice.findOne({ societyId, flatId: rented._id, billingPeriod: '2025-09' }).lean();
    eq('a rented flat billed only occupant-billed heads goes to the TENANT', occInv?.billToRole, 'TENANT');

    await createChargeHead(SID, {
      code: 'NOC2', name: 'Non-Occupancy', category: 'NON_OCCUPANCY', pricingMode: 'UNIFORM',
      uniformAmountPaise: 5_000, billTo: 'OWNER',
    }, actor);
    await generateInvoicesForSociety(SID, { period: '2025-10', flatIds: [String(rented._id)], triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const mixInv = await MaintenanceInvoice.findOne({ societyId, flatId: rented._id, billingPeriod: '2025-10' }).lean();
    eq('one owner-billed head puts the whole invoice on the OWNER', mixInv?.billToRole, 'OWNER');
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
