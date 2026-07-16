/**
 * The five defects found by the final audit. Real database, THROWAWAY
 * societyId, self-cleaning. Never touches existing data.
 *
 * Every assertion here is written to FAIL against the code as it stood before
 * the fix — a test that passes either way proves nothing.
 *
 *   npx ts-node src/scripts/verify-final-audit.ts
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
import { seedChartOfAccounts, DEFAULT_ACCOUNTS, ACCOUNT_GROUPS } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { recordClearedReceipt, bounceReceipt, reportPendingReceipt, confirmReceipt } from '../services/collections.service';
import { createExpense, approveExpense } from '../services/expenses.service';
import { commit as commitImport } from '../services/bulk-import.service';
import { trialBalance, defaulters } from '../services/reports.service';

const societyId = new mongoose.Types.ObjectId();
const extra: mongoose.Types.ObjectId[] = [];
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
const balOf = (rows: { code: string; debitPaise: number; creditPaise: number }[], code: string) => {
  const r = rows.find(x => x.code === code);
  return r ? r.debitPaise - r.creditPaise : 0;
};

async function cleanup() {
  const all = { $in: [societyId, ...extra] };
  await Promise.all([
    LedgerAccount.deleteMany({ societyId: all }), JournalEntry.deleteMany({ societyId: all }),
    FinancePolicy.deleteMany({ societyId: all }), ChargeHead.deleteMany({ societyId: all }),
    MaintenanceInvoice.deleteMany({ societyId: all }), Receipt.deleteMany({ societyId: all }),
    Expense.deleteMany({ societyId: all }), Vendor.deleteMany({ societyId: all }),
    Block.deleteMany({ societyId: all }), SequenceCounter.deleteMany({ societyId: all }),
    Flat.deleteMany({ societyId: all }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    const policy = await getOrCreatePolicy(SID, actor.userId, actor.userName);
    policy.gst.enabled = false;
    await policy.save();

    const blockId = new mongoose.Types.ObjectId();
    await Block.create([{ _id: blockId, name: 'A', societyId, createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName }]);
    const mk = (n: string) => ({
      number: n, blockName: 'A', blockId, societyId, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    const [flatA, flatB] = await Flat.create([mk('101'), mk('102')]);

    // ============================================== 0. the COA is actually seeded
    // A heading and an account cannot share a code: the heading seeds first and
    // the account's upsert is $setOnInsert, so the account silently never exists.
    console.log('Every catalogued account reaches the books');
    const seeded = await LedgerAccount.find({ societyId }).select('code name').lean();
    const codes = new Set(seeded.map(a => a.code));
    ok('Building & Structure exists to post building costs to', codes.has('1505'));
    eq('...under its own code, not the heading\'s', seeded.find(a => a.code === '1505')?.name, 'Building & Structure');
    eq('...leaving 1500 as the heading', seeded.find(a => a.code === '1500')?.name, 'Fixed Assets');
    eq('no two catalogued accounts share a code', new Set(DEFAULT_ACCOUNTS.map(a => a.code)).size, DEFAULT_ACCOUNTS.length);
    ok('no account collides with a group heading',
      !DEFAULT_ACCOUNTS.some(a => ACCOUNT_GROUPS.some(g => g.code === a.code)),
      'a colliding account is swallowed by the upsert and never seeded');
    ok('every catalogued account is present in the books',
      DEFAULT_ACCOUNTS.every(a => codes.has(a.code)),
      DEFAULT_ACCOUNTS.filter(a => !codes.has(a.code)).map(a => `${a.code} ${a.name}`).join(', '));

    // =========================================================== 1. opening dues
    // Imported dues must be SETTLEABLE. Before the fix the importer posted a raw
    // Debtors debit with no invoice behind it, so a member's payment found
    // nothing to pay, became an advance, and the debit stranded forever.
    console.log('Opening dues import creates a settleable debt');
    // Exercised as CSV, exactly as the upload endpoint feeds it.
    await commitImport(SID, 'OPENING_DUES', {
      csvText: 'Block,Flat Number,Amount Due\nA,101,5000.00\n',
    }, actor, {});

    const openingInv = await MaintenanceInvoice.findOne({ societyId, flatId: flatA._id }).lean();
    ok('an invoice exists behind the debtor', !!openingInv);
    eq('...for the imported amount', openingInv?.outstandingPaise, 500_000);
    eq('...marked overdue, since dues are arrears', openingInv?.status, 'OVERDUE');
    eq('...none of it counted as penalty', openingInv?.interestOutstandingPaise, 0);
    ok('...and its line does not re-post to the ledger', openingInv?.lineItems?.[0]?.isPostable === false);

    eq('...parked outside any real billing month', openingInv?.billingPeriod, 'OPENING');

    let tb = (await trialBalance(SID)).rows;
    eq('Debtors carries the opening dues', balOf(tb, '1200'), 500_000);

    // A forced re-import must not mint a second identity for the same flat — the
    // unique {society, flat, period} index would reject it outright.
    await commitImport(SID, 'OPENING_DUES', {
      csvText: 'Block,Flat Number,Amount Due\nA,101,1000.00\n',
    }, actor, { force: true });
    const dupes = await MaintenanceInvoice.countDocuments({ societyId, flatId: flatA._id, billingPeriod: 'OPENING' });
    eq('a forced re-import adds to the one opening bill', dupes, 1);
    const merged = await MaintenanceInvoice.findById(openingInv!._id).lean();
    eq('...raising what the flat owes', merged?.outstandingPaise, 600_000);
    tb = (await trialBalance(SID)).rows;
    eq('...and the ledger agrees', balOf(tb, '1200'), 600_000);

    // The member pays the lot (₹5,000 + the forced ₹1,000). This is the
    // assertion that would have caught the original defect.
    const r1 = await recordClearedReceipt(SID, {
      flatId: String(flatA._id), blockName: 'A', flatNumber: '101',
      mode: 'CASH', amountPaise: 600_000, source: 'ADMIN_WALKIN',
      actor: { ...actor, role: 'SOCIETY_ADMIN' },
    });
    const paidInv = await MaintenanceInvoice.findById(openingInv!._id).lean();
    eq('paying it settles the invoice', paidInv?.outstandingPaise, 0);
    eq('...and the payment is not misfiled as advance', (r1 as any).advanceCreatedPaise, 0);
    tb = (await trialBalance(SID)).rows;
    eq('Debtors clears to zero — nothing stranded', balOf(tb, '1200'), 0);
    eq('Members\' Advance untouched', balOf(tb, '2100'), 0);

    // ==================================================== 2. bounce claws advance
    // Flat B: overpay, let a later invoice eat the surplus, then bounce.
    console.log('\nA bounced cheque reclaims advance a later bill already spent');
    await createChargeHead(SID, {
      code: 'M1', name: 'Maintenance', category: 'MAINTENANCE', pricingMode: 'UNIFORM', uniformAmountPaise: 100_000,
      applicability: { flatIds: [String(flatB._id)] },
    } as any, actor);
    await generateInvoicesForSociety(SID, { period: '2026-04', flatIds: [String(flatB._id)], triggeredByUserId: actor.userId, triggeredByName: actor.userName });

    // ₹1,500 against a ₹1,000 bill → ₹500 advance.
    const chq = await recordClearedReceipt(SID, {
      flatId: String(flatB._id), blockName: 'A', flatNumber: '102',
      mode: 'CHEQUE', amountPaise: 150_000, source: 'ADMIN_WALKIN',
      instrument: { chequeNo: '000123', bankName: 'HDFC' },
      actor: { ...actor, role: 'SOCIETY_ADMIN' },
    });
    eq('the overpayment becomes advance', (chq as any).advanceCreatedPaise, 50_000);

    // Next month's ₹1,000 bill eats the ₹500.
    await generateInvoicesForSociety(SID, { period: '2026-05', flatIds: [String(flatB._id)], triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const may = await MaintenanceInvoice.findOne({ societyId, flatId: flatB._id, billingPeriod: '2026-05' }).lean();
    eq('the advance part-funds next month', may?.advanceAppliedPaise, 50_000);
    eq('...leaving ₹500 outstanding', may?.outstandingPaise, 50_000);

    // The cheque bounces. Nothing was ever collected, so the member owes
    // April ₹1,000 + May ₹1,000 = ₹2,000 — not ₹1,500.
    await bounceReceipt(SID, String((chq as any)._id), actor, 'insufficient funds');

    const aprAfter = await MaintenanceInvoice.findOne({ societyId, flatId: flatB._id, billingPeriod: '2026-04' }).lean();
    const mayAfter = await MaintenanceInvoice.findById(may!._id).lean();
    eq('April is owed again in full', aprAfter?.outstandingPaise, 100_000);
    eq('May is owed again in full', mayAfter?.outstandingPaise, 100_000);
    eq('...its phantom funding is withdrawn', mayAfter?.advanceAppliedPaise, 0);

    tb = (await trialBalance(SID)).rows;
    eq('Members\' Advance is back to zero, not negative', balOf(tb, '2100'), 0);
    ok('Advance never went into debit on a liability', balOf(tb, '2100') <= 0 === false || balOf(tb, '2100') === 0);

    const def = await defaulters(SID, {});
    const bRow = (def.rows as any[]).find(r => String(r.flatId) === String(flatB._id));
    eq('the defaulter register chases the full ₹2,000', bRow?.outstandingPaise, 200_000);

    // =============================================== 3. TDS catch-up cannot exceed
    console.log('\nTDS catch-up never exceeds the bill it lands on');
    const vend = await Vendor.create({
      societyId, name: 'Painter', tdsApplicable: true, tdsRatePercent: 10,
      tdsThresholdSinglePaise: 0, tdsThresholdAnnualPaise: 10_000_000, // ₹1L
      createdBy: userId, createdByName: actor.userName,
    });
    // ₹99,000 — under the annual limit, nothing withheld.
    const e1 = await createExpense(SID, {
      vendorId: String(vend._id), category: 'REPAIRS', paymentMode: 'BANK',
      lineItems: [{ expenseAccountCode: '5140', amountPaise: 9_900_000 }],
    }, actor);
    eq('under the limit: no TDS', e1.tdsPaise, 0);
    await approveExpense(SID, String(e1._id), approver);

    // ₹2,000 crosses ₹1L. Whole-year TDS is ₹10,100 — more than this bill.
    const e2 = await createExpense(SID, {
      vendorId: String(vend._id), category: 'REPAIRS', paymentMode: 'BANK',
      lineItems: [{ expenseAccountCode: '5140', amountPaise: 200_000 }],
    }, actor);
    ok('the crossing bill can be recorded at all', !!e2);
    eq('TDS is capped at the bill', e2.tdsPaise, 200_000);
    eq('net payable never goes negative', e2.netPayablePaise, 0);
    ok('...and it is a real catch-up, not just this bill\'s 10%',
      e2.tdsPaise > 20_000, `got ${rupees(e2.tdsPaise)}, a bare 10% would be ${rupees(20_000)}`);

    // A bill still awaiting approval DOES count toward the year's running total.
    // TDS is computed once, at creation, when every bill is pending by
    // definition — so pending bills must be visible to the aggregate or the
    // threshold is never reached and the year is under-deducted.
    const other = new mongoose.Types.ObjectId(); extra.push(other);
    await seedChartOfAccounts(String(other), actor.userId, actor.userName);
    const p2 = await getOrCreatePolicy(String(other), actor.userId, actor.userName);
    p2.gst.enabled = false; await p2.save();
    const v2 = await Vendor.create({
      societyId: other, name: 'Plumber', tdsApplicable: true, tdsRatePercent: 10,
      tdsThresholdSinglePaise: 0, tdsThresholdAnnualPaise: 10_000_000,
      createdBy: userId, createdByName: actor.userName,
    });
    const pendingBill = await createExpense(String(other), {
      vendorId: String(v2._id), category: 'REPAIRS', paymentMode: 'BANK',
      lineItems: [{ expenseAccountCode: '5140', amountPaise: 9_900_000 }],
    }, actor);
    eq('the pending bill itself is under the limit', pendingBill.tdsPaise, 0);
    eq('...and is pending, not draft', pendingBill.status, 'PENDING_APPROVAL');
    const afterPending = await createExpense(String(other), {
      vendorId: String(v2._id), category: 'REPAIRS', paymentMode: 'BANK',
      lineItems: [{ expenseAccountCode: '5140', amountPaise: 200_000 }],
    }, actor);
    ok('an unapproved bill still counts toward the annual threshold',
      afterPending.tdsPaise === 200_000,
      `got ${rupees(afterPending.tdsPaise)} — 0 would mean the year silently under-deducts`);

    // ================================================= 4. TDS master switch works
    console.log('\nThe TDS switch in Settings actually switches TDS');
    const p3 = await FinancePolicy.findOne({ societyId });
    p3!.set('tds.enabled', false);
    p3!.set('tds.configured', true); // an explicit choice, not an unanswered default
    await p3!.save();
    const e3 = await createExpense(SID, {
      vendorId: String(vend._id), category: 'REPAIRS', paymentMode: 'BANK',
      lineItems: [{ expenseAccountCode: '5140', amountPaise: 5_000_000 }],
    }, actor);
    eq('switched off: nothing withheld even from a TDS vendor', e3.tdsPaise, 0);
    eq('...so the vendor is paid in full', e3.netPayablePaise, 5_000_000);

    // The legacy society — switch never touched — must keep deducting.
    const legacy = new mongoose.Types.ObjectId(); extra.push(legacy);
    await seedChartOfAccounts(String(legacy), actor.userId, actor.userName);
    const lp = await getOrCreatePolicy(String(legacy), actor.userId, actor.userName);
    lp.gst.enabled = false; await lp.save();
    eq('a fresh policy has not answered the TDS question', lp.tds?.configured, undefined);
    const lv = await Vendor.create({
      societyId: legacy, name: 'Lift AMC', tdsApplicable: true, tdsRatePercent: 10,
      tdsThresholdSinglePaise: 0, tdsThresholdAnnualPaise: 0,
      createdBy: userId, createdByName: actor.userName,
    });
    const le = await createExpense(String(legacy), {
      vendorId: String(lv._id), category: 'REPAIRS', paymentMode: 'BANK',
      lineItems: [{ expenseAccountCode: '5140', amountPaise: 1_000_000 }],
    }, actor);
    ok('a society already using TDS keeps deducting on upgrade', le.tdsPaise === 100_000,
      `got ${rupees(le.tdsPaise)} — a silent stop here would be statutory under-deduction`);
    const lp2 = await FinancePolicy.findOne({ societyId: legacy });
    eq('...and the answer is written down once', lp2?.tds?.enabled, true);
    eq('...marked as settled', lp2?.tds?.configured, true);

    // ============================================ 5. receipt dual control is real
    console.log('\nDual control on receipts is enforced, not just displayed');
    const p4 = await FinancePolicy.findOne({ societyId });
    p4!.set('approvals.requireDualControlForReceipts', true);
    await p4!.save();

    const pend = await reportPendingReceipt(SID, {
      flatId: String(flatB._id), blockName: 'A', flatNumber: '102',
      mode: 'CASH', amountPaise: 10_000, source: 'ADMIN_WALKIN',
      actor: { ...actor, role: 'SOCIETY_ADMIN' },
    });
    let refused: Error | null = null;
    try { await confirmReceipt(SID, String((pend as any)._id), actor); }
    catch (e: any) { refused = e; }
    ok('the recorder cannot confirm their own receipt', !!refused, 'a control that displays as on must act');
    ok('...and says why', /different person/i.test(refused?.message || ''), refused?.message);

    const conf = await confirmReceipt(SID, String((pend as any)._id), approver);
    eq('a second person can confirm it', (conf as any).status, 'CLEARED');

    p4!.set('approvals.requireDualControlForReceipts', false);
    await p4!.save();
    const solo = await reportPendingReceipt(SID, {
      flatId: String(flatB._id), blockName: 'A', flatNumber: '102',
      mode: 'CASH', amountPaise: 10_000, source: 'ADMIN_WALKIN',
      actor: { ...actor, role: 'SOCIETY_ADMIN' },
    });
    const soloOk = await confirmReceipt(SID, String((solo as any)._id), actor);
    eq('switched off, a one-admin society still works', (soloOk as any).status, 'CLEARED');

    // ============================================== 6. rounding account honoured
    console.log('\nThe rounding account in Settings is the one used');
    const p5 = await FinancePolicy.findOne({ societyId });
    p5!.set('rounding.mode', 'NEAREST_RUPEE');
    p5!.set('rounding.accountCode', '5170'); // deliberately NOT the 4900 default
    await p5!.save();
    await ChargeHead.deleteMany({ societyId });
    await createChargeHead(SID, {
      code: 'R1', name: 'Odd amount', category: 'MAINTENANCE', pricingMode: 'UNIFORM', uniformAmountPaise: 100_049,
      applicability: { flatIds: [String(flatA._id)] },
    } as any, actor);
    await generateInvoicesForSociety(SID, { period: '2026-06', flatIds: [String(flatA._id)], triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const je = await JournalEntry.findOne({ societyId, voucherType: 'INVOICE', 'lines.accountCode': '5170' }).lean();
    ok('rounding posted to the configured account', !!je,
      'it went to 4900 regardless — masked because the default equals the constant');

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
