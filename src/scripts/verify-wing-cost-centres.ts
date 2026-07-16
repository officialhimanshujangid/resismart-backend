/**
 * Per-wing cost centres. Real database, THROWAWAY societyId, self-cleaning.
 * Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-wing-cost-centres.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { ChargeHead } from '../models/charge-head.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Receipt } from '../models/receipt.model';
import { Expense } from '../models/expense.model';
import { Vendor } from '../models/vendor.model';
import { Block } from '../models/block.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { createExpense, approveExpense, payExpense } from '../services/expenses.service';
import { wingWiseIncomeExpenditure, incomeExpenditure } from '../services/reports.service';
import { reverseJournal } from '../services/ledger.service';

const societyId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const approver = { userId: otherUserId.toString(), userName: 'Approver' };
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;

async function cleanup() {
  await Promise.all([
    LedgerAccount.deleteMany({ societyId }), JournalEntry.deleteMany({ societyId }),
    FinancePolicy.deleteMany({ societyId }), ChargeHead.deleteMany({ societyId }),
    MaintenanceInvoice.deleteMany({ societyId }), Receipt.deleteMany({ societyId }),
    Expense.deleteMany({ societyId }), Vendor.deleteMany({ societyId }),
    Block.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }),
  ]);
}

const wingBy = (r: any, label: string) => r.wings.find((w: any) => w.label === label);

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    const policy = await getOrCreatePolicy(SID, actor.userId, actor.userName);
    policy.gst.enabled = false;
    await policy.save();

    // Two wings, deliberately lopsided: A has two flats, B has one. If the split
    // is real, A must bill exactly twice B.
    const [towerA, towerB] = await Block.create([
      { name: 'Tower A', societyId, createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName },
      { name: 'Tower B', societyId, createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName },
    ]);
    const mkFlat = (n: string, block: any) => ({
      number: n, blockName: block.name, blockId: block._id, societyId, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    await Flat.create([mkFlat('A101', towerA), mkFlat('A102', towerA), mkFlat('B101', towerB)]);

    await createChargeHead(SID, {
      code: 'M1', name: 'Maintenance', category: 'MAINTENANCE', pricingMode: 'UNIFORM', uniformAmountPaise: 100_000,
    }, actor);
    await generateInvoicesForSociety(SID, { period: '2026-04', triggeredByUserId: actor.userId, triggeredByName: actor.userName });

    // ---------------------------------------------------- income splits by wing
    console.log('Income lands on the billed flat\'s wing');
    let r = await wingWiseIncomeExpenditure(SID, { fy: '2026' });
    eq('both wings get a column', r.wings.length, 2);
    eq('Tower A billed 2 flats × ₹1,000', wingBy(r, 'Tower A')?.totalIncomePaise, 200_000);
    eq('Tower B billed 1 flat × ₹1,000', wingBy(r, 'Tower B')?.totalIncomePaise, 100_000);
    eq('no income is stranded in Common', r.common.totalIncomePaise, 0);

    // A wing with no activity still gets a column — an absent wing reads as a bug.
    const [towerC] = await Block.create([
      { name: 'Tower C', societyId, createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName },
    ]);
    r = await wingWiseIncomeExpenditure(SID, { fy: '2026' });
    eq('an empty wing still appears', r.wings.length, 3);
    eq('...reporting zero, not absent', wingBy(r, 'Tower C')?.totalIncomePaise, 0);

    // ---------------------------------------------------- expenses
    console.log('\nExpenses honour their wing tag');
    const runExpense = async (lines: any[]) => {
      const exp = await createExpense(SID, { category: 'REPAIRS', description: 'Test', paymentMode: 'BANK', lineItems: lines }, actor);
      await approveExpense(SID, String(exp._id), approver);
      await payExpense(SID, String(exp._id), approver);
      return exp;
    };
    // Tower B's lift — one wing's cost.
    await runExpense([{ expenseAccountCode: '5150', amountPaise: 60_000, blockId: towerB._id }]);
    // Security for everyone — nobody's wing.
    await runExpense([{ expenseAccountCode: '5100', amountPaise: 50_000 }]);
    // One bill, two wings: the split has to survive within a single voucher.
    await runExpense([
      { expenseAccountCode: '5150', amountPaise: 10_000, blockId: towerA._id },
      { expenseAccountCode: '5150', amountPaise: 20_000, blockId: towerB._id },
    ]);

    r = await wingWiseIncomeExpenditure(SID, { fy: '2026' });
    eq('Tower A charged only its own ₹100', wingBy(r, 'Tower A')?.totalExpensePaise, 10_000);
    eq('Tower B charged ₹600 + ₹200', wingBy(r, 'Tower B')?.totalExpensePaise, 80_000);
    eq('shared security sits in Common', r.common.totalExpensePaise, 50_000);
    eq('Common is labelled, not blank', r.common.label, 'Common (not wing-specific)');
    eq('Common carries no blockId', r.common.blockId, null);

    console.log('\nSurplus per wing');
    eq('Tower A: ₹2,000 − ₹100', wingBy(r, 'Tower A')?.surplusPaise, 190_000);
    eq('Tower B: ₹1,000 − ₹800', wingBy(r, 'Tower B')?.surplusPaise, 20_000);
    eq('Common: nothing in, ₹500 out', r.common.surplusPaise, -50_000);

    // ------------------------------------------- the property that matters most
    console.log('\nTies back to the society Income & Expenditure');
    const ie = await incomeExpenditure(SID, { fy: '2026' });
    eq('income total matches I&E', r.totals.totalIncomePaise, ie.totalIncomePaise);
    eq('expense total matches I&E', r.totals.totalExpensePaise, ie.totalExpensePaise);
    eq('surplus matches I&E', r.totals.surplusPaise, ie.surplusPaise);
    ok('no money vanished between the two reports',
      r.totals.totalIncomePaise === 300_000 && r.totals.totalExpensePaise === 140_000,
      `wing-wise says ${rupees(r.totals.totalIncomePaise)} in / ${rupees(r.totals.totalExpensePaise)} out`);

    // ---------------------------------------------------- reversal keeps its wing
    console.log('\nA reversal returns to the wing it came from');
    const liftJe = await JournalEntry.findOne({ societyId, 'lines.blockId': towerB._id, voucherType: 'PAYMENT' }).sort({ createdAt: 1 });
    ok('the wing reached the journal line', !!liftJe);
    const beforeB = wingBy(r, 'Tower B')!.totalExpensePaise;
    await reverseJournal(SID, String(liftJe!._id), { postedBy: actor.userId, postedByName: actor.userName, fyStartMonth: 4 });
    r = await wingWiseIncomeExpenditure(SID, { fy: '2026' });
    const afterB = wingBy(r, 'Tower B')!.totalExpensePaise;
    ok('the reversal came off Tower B, not Common',
      afterB < beforeB && r.common.totalExpensePaise === 50_000,
      `Tower B ${rupees(beforeB)} → ${rupees(afterB)}, Common ${rupees(r.common.totalExpensePaise)}`);
    const ie2 = await incomeExpenditure(SID, { fy: '2026' });
    eq('still ties to I&E after the reversal', r.totals.totalExpensePaise, ie2.totalExpensePaise);

    // ---------------------------------------------------- input hardening
    console.log('\nBad wing input is refused, not cast');
    // '' is what the form sends for Common. It must not reach the ObjectId cast.
    const blank = await createExpense(SID, {
      category: 'REPAIRS', paymentMode: 'BANK', lineItems: [{ expenseAccountCode: '5100', amountPaise: 1_000, blockId: '' }],
    }, actor);
    eq("empty blockId becomes Common, not a CastError", blank.lineItems[0].blockId, undefined);

    let refused = false;
    try {
      await createExpense(SID, {
        category: 'REPAIRS', paymentMode: 'BANK',
        lineItems: [{ expenseAccountCode: '5100', amountPaise: 1_000, blockId: new mongoose.Types.ObjectId() }],
      }, actor);
    } catch { refused = true; }
    ok('a wing from another society is refused', refused);

    console.log('\nName snapshot');
    const tagged = await Expense.findOne({ societyId, 'lineItems.blockId': towerB._id }).lean();
    eq('the wing name is snapshotted on the line', tagged?.lineItems.find(l => String(l.blockId) === String(towerB._id))?.blockName, 'Tower B');

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

// `main` already cleans up and disconnects in its own `finally`; retrying either
// here just buries the real error under a MongoNotConnectedError.
main().catch((e) => { console.error(e); process.exit(1); });
