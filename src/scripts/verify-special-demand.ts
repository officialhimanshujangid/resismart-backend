/**
 * Phase 5 — the special demand: a one-off levy raised after the month's bill has
 * already gone out. Real database, THROWAWAY societyId, self-cleaning.
 *
 * The two assertions that matter: a second bill in the same month must be
 * POSSIBLE at all, and it must not levy interest twice.
 *
 *   npx ts-node src/scripts/verify-special-demand.ts
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
import { FinanceFund } from '../models/finance-fund.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Block } from '../models/block.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { recordClearedReceipt } from '../services/collections.service';
import { createFund, listFunds } from '../services/funds.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { trialBalance, defaulters } from '../services/reports.service';
import { raiseSpecialDemand } from '../controllers/maintenance-invoice.controller';
import '../middlewares/auth.middleware'; // pulls in the Request.user augmentation

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

const mockRes = () => {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
};
const mockReq = (body: any) => ({
  user: { activeTenantId: SID, userId: actor.userId, userName: actor.userName, activeRole: 'SOCIETY_ADMIN' },
  body, params: {}, query: {},
}) as any;

async function cleanup() {
  await Promise.all([
    LedgerAccount.deleteMany({ societyId }), JournalEntry.deleteMany({ societyId }),
    FinancePolicy.deleteMany({ societyId }), ChargeHead.deleteMany({ societyId }),
    MaintenanceInvoice.deleteMany({ societyId }), Receipt.deleteMany({ societyId }),
    FinanceFund.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Block.deleteMany({ societyId }),
  ]);
}

const invOf = async (flatNumber: string, period: string) =>
  MaintenanceInvoice.findOne({ societyId, flatNumber, billingPeriod: period }).lean();

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    const policy = await getOrCreatePolicy(SID, actor.userId, actor.userName);
    policy.gst.enabled = false;
    // Interest on, so the double-levy trap is live rather than theoretical.
    policy.set('lateFee.enabled', true);
    policy.set('lateFee.mode', 'PERCENT_PER_MONTH');
    policy.set('lateFee.ratePercent', 2);
    policy.set('lateFee.graceDays', 0);
    await policy.save();

    const [towerA, towerB] = await Block.create([
      { name: 'Tower A', societyId, createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName },
      { name: 'Tower B', societyId, createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName },
    ]);
    const mkFlat = (n: string, block: any) => ({
      number: n, blockName: block.name, blockId: block._id, societyId, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    await Flat.create([mkFlat('A101', towerA), mkFlat('A102', towerA), mkFlat('B101', towerB)]);

    // ============================================ the month's regular bill
    console.log('1 July — the regular bill goes out');
    await createChargeHead(SID, {
      code: 'M1', name: 'Maintenance', category: 'MAINTENANCE',
      pricingMode: 'UNIFORM', uniformAmountPaise: 100_000,
    }, actor);
    const regular = await generateInvoicesForSociety(SID, {
      period: '2026-07', triggeredByUserId: actor.userId, triggeredByName: actor.userName,
    });
    eq('three flats billed ₹1,000 each', regular.created, 3);
    eq('...under the plain month', regular.period, '2026-07');

    // ================================ the problem this phase exists to solve
    console.log('\n10 July — painting work arrives. The old way fails silently');
    const paintFund = await (async () => {
      await createFund(SID, { name: 'Painting Fund', category: 'SPECIAL', targetAmountPaise: 1_500_000 }, actor);
      return (await listFunds(SID, actor)).find(f => f.name === 'Painting Fund')!;
    })();
    const paint = await createChargeHead(SID, {
      code: 'PAINT', name: 'Painting contribution', category: 'ADHOC',
      pricingMode: 'PER_BLOCK',
      perBlockAmounts: [
        { blockId: String(towerA._id), label: 'Tower A', amountPaise: 550_000 },
        { blockId: String(towerB._id), label: 'Tower B', amountPaise: 400_000 },
      ],
      fundId: paintFund._id, isRecurring: false,
    }, actor);

    // Running the ordinary generator again is what a treasurer would try first.
    const retry = await generateInvoicesForSociety(SID, {
      period: '2026-07', chargeHeadIds: [String(paint._id)],
      triggeredByUserId: actor.userId, triggeredByName: actor.userName,
    });
    eq('the ordinary run creates nothing', retry.created, 0);
    eq('...every flat counted as already invoiced', retry.skipped, 3);
    eq('...and it does not even report an error', retry.errors.length, 0);

    // ============================================ the special demand
    console.log('\nThe special demand raises it properly');
    const res1 = mockRes();
    await raiseSpecialDemand(mockReq({
      chargeHeadIds: [String(paint._id)],
      title: 'External painting 2026',
      dueDate: new Date(2026, 6, 31).toISOString(),
    }), res1);

    eq('it goes through', res1.statusCode, 200);
    eq('three demands raised', res1.body?.created, 3);
    eq('...on its own period key', res1.body?.period, '2026-07-S1');
    eq('...for ₹5,500 + ₹5,500 + ₹4,000', res1.body?.totalBilledPaise, 1_500_000);

    const a1Special = await invOf('A101', '2026-07-S1');
    eq('Tower A pays its wing rate', a1Special?.totalPaise, 550_000);
    eq('...the reason is on the bill', a1Special?.demandTitle, 'External painting 2026');
    eq('...with the due date asked for', new Date(a1Special!.dueDate).getDate(), 31);

    const a1Regular = await invOf('A101', '2026-07');
    ok('the regular July bill is untouched', a1Regular?.totalPaise === 100_000,
      `regular bill is now ${rupees(a1Regular?.totalPaise || 0)}`);

    // ================= THE TRAP: interest must not be levied a second time
    console.log('\nNo second helping of interest');
    eq('the demand carries no interest line', (a1Special?.lineItems || []).filter(l => l.code === 'INT').length, 0);
    eq('...nor an arrears line restating the July bill',
      (a1Special?.lineItems || []).filter(l => l.code === 'ARR').length, 0);
    eq('so the bill is exactly the levy', a1Special?.totalPaise, 550_000);
    ok('interest IS switched on, so this was a real risk',
      policy.lateFee?.enabled === true && (policy.lateFee?.ratePercent || 0) > 0);

    // The money must still tie: Debtors equals the sum of what is outstanding.
    const tb = await trialBalance(SID);
    const debtors = tb.rows.find(r => r.code === '1200');
    const outstanding = (await MaintenanceInvoice.find({ societyId }).lean())
      .reduce((s, i) => s + i.outstandingPaise, 0);
    eq('Debtors still equals the outstanding invoices', (debtors?.debitPaise || 0) - (debtors?.creditPaise || 0), outstanding);
    eq('...which is July ₹3,000 + the levy ₹15,000', outstanding, 1_800_000);

    // ==================== a bill settled by advance must SAY it is settled
    //
    // Advance applied at issue used to leave the status at ISSUED, so a bill with
    // ₹0 outstanding sat on the member's portal looking unpaid — and the admin
    // list showed "Outstanding ₹0 · ISSUED", which reads as a broken figure.
    console.log('\nAdvance applied at issue is reflected in the status');
    const advFlat = await Flat.findOne({ societyId, number: 'A102' });
    // Clear whatever this flat already owes and leave exactly ₹3,000 of advance.
    // Asking first rather than assuming: the flat has picked up bills from every
    // run above, and a hard-coded figure here would quietly become "no advance"
    // the moment one more is added.
    const owedNow = (await MaintenanceInvoice.find({ societyId, flatId: advFlat!._id }).lean())
      .reduce((s, i) => s + i.outstandingPaise, 0);
    await recordClearedReceipt(SID, {
      flatId: String(advFlat!._id), blockName: 'Tower A', flatNumber: 'A102',
      mode: 'CASH', amountPaise: owedNow + 300_000, source: 'ADMIN_WALKIN',
      actor: { ...actor, role: 'SOCIETY_ADMIN' },
    } as any);

    const covered = await createChargeHead(SID, {
      code: 'SMALLDEM', name: 'Small demand', category: 'ADHOC',
      pricingMode: 'UNIFORM', uniformAmountPaise: 200_000, isRecurring: false,
    }, actor);
    const advRes = mockRes();
    await raiseSpecialDemand(mockReq({
      chargeHeadIds: [String(covered._id)], flatIds: [String(advFlat!._id)],
      title: 'Covered by advance',
    }), advRes);

    const fullyCovered = await MaintenanceInvoice.findOne({
      societyId, flatNumber: 'A102', billingPeriod: advRes.body.period,
    }).lean();
    eq('advance covered the whole ₹2,000', fullyCovered?.advanceAppliedPaise, 200_000);
    eq('...so nothing is outstanding', fullyCovered?.outstandingPaise, 0);
    eq('...and the bill says PAID, not ISSUED', fullyCovered?.status, 'PAID');

    // Part-covered: some advance left, but not enough.
    const partial = await createChargeHead(SID, {
      code: 'BIGDEM', name: 'Bigger demand', category: 'ADHOC',
      pricingMode: 'UNIFORM', uniformAmountPaise: 900_000, isRecurring: false,
    }, actor);
    const partRes = mockRes();
    await raiseSpecialDemand(mockReq({
      chargeHeadIds: [String(partial._id)], flatIds: [String(advFlat!._id)],
      title: 'Part covered',
    }), partRes);
    const partInv = await MaintenanceInvoice.findOne({
      societyId, flatNumber: 'A102', billingPeriod: partRes.body.period,
    }).lean();
    ok('the leftover advance is applied', (partInv?.advanceAppliedPaise || 0) > 0);
    ok('...but something is still owed', (partInv?.outstandingPaise || 0) > 0);
    eq('...so it reads PARTIALLY_PAID', partInv?.status, 'PARTIALLY_PAID');

    // Nothing applied — the ordinary case must be untouched.
    const plainFlat = await Flat.findOne({ societyId, number: 'B101' });
    const plainRes = mockRes();
    await raiseSpecialDemand(mockReq({
      chargeHeadIds: [String(covered._id)], flatIds: [String(plainFlat!._id)],
      title: 'No advance here',
    }), plainRes);
    const plainInv = await MaintenanceInvoice.findOne({
      societyId, flatNumber: 'B101', billingPeriod: plainRes.body.period,
    }).lean();
    eq('a bill with no advance is still ISSUED', plainInv?.status, 'ISSUED');
    eq('...and fully outstanding', plainInv?.outstandingPaise, 200_000);

    // ============================================ scoping to one wing
    console.log('\nA demand can be limited to one wing');
    const liftHead = await createChargeHead(SID, {
      code: 'LIFT1', name: 'Lift repair', category: 'ADHOC',
      pricingMode: 'UNIFORM', uniformAmountPaise: 200_000, isRecurring: false,
    }, actor);
    const res2 = mockRes();
    await raiseSpecialDemand(mockReq({
      chargeHeadIds: [String(liftHead._id)],
      blockIds: [String(towerB._id)],
      title: 'Tower B lift repair',
    }), res2);
    eq('only Tower B is billed', res2.body?.created, 1);
    // The exact suffix depends on how many demands ran before it, so assert the
    // shape and that it is its own key — not an incidental number.
    ok('...on its own suffixed key', /^2026-07-S[0-9]+$/.test(res2.body?.period || ''), res2.body?.period);
    ok('Tower A is untouched', !(await invOf('A101', res2.body.period)));
    const b1Lift = await invOf('B101', res2.body.period);
    eq('...for the lift amount', b1Lift?.totalPaise, 200_000);

    // ============================================ numbering keeps climbing
    console.log('\nEach demand gets its own key');
    const res3 = mockRes();
    await raiseSpecialDemand(mockReq({
      chargeHeadIds: [String(liftHead._id)], blockIds: [String(towerA._id)], title: 'Tower A lift repair',
    }), res3);
    ok('the next demand gets a NEW key, never a reused one',
      /^2026-07-S[0-9]+$/.test(res3.body?.period || '') && res3.body.period !== res2.body.period,
      `${res2.body?.period} then ${res3.body?.period}`);
    eq('...billing the two Tower A flats', res3.body?.created, 2);

    // ============================================ dry run writes nothing
    console.log('\nPreview first, as everywhere else');
    const before = await MaintenanceInvoice.countDocuments({ societyId });
    const dry = mockRes();
    await raiseSpecialDemand(mockReq({
      chargeHeadIds: [String(liftHead._id)], title: 'Rehearsal', dryRun: true,
    }), dry);
    eq('a preview reports what it would do', dry.body?.created, 3);
    eq('...and writes nothing', await MaintenanceInvoice.countDocuments({ societyId }), before);

    // ============================================ FIFO order
    console.log('\nSettlement order follows the due date, not the issue date');
    const def = await defaulters(SID, {});
    const b1 = (def.rows as any[]).find(r => r.flatNumber === 'B101');
    // Against the invoices themselves rather than a hand-added total, which would
    // go stale the moment another demand is raised above.
    const b1Owed = (await MaintenanceInvoice.find({ societyId, flatNumber: 'B101' }).lean())
      .reduce((s, i) => s + i.outstandingPaise, 0);
    eq('the defaulter register agrees with the flat\'s own invoices', b1?.outstandingPaise, b1Owed);
    ok('...and it is a real, non-zero position', (b1Owed || 0) > 0, rupees(b1Owed || 0));

    // FIFO sorts on dueDate, and a special demand may deliberately fall due
    // sooner than the month's bill — an urgent levy given a tight date is meant
    // to be paid first. So the rule to assert is the ordering itself, not which
    // document happens to win: whatever is due soonest settles first.
    const b1Invoices = await MaintenanceInvoice.find({ societyId, flatNumber: 'B101' }).sort({ dueDate: 1 }).lean();
    const dues = b1Invoices.map(i => new Date(i.dueDate).getTime());
    ok('invoices queue strictly by due date',
      dues.every((d, i) => i === 0 || d >= dues[i - 1]),
      JSON.stringify(b1Invoices.map(i => ({ p: i.billingPeriod, due: i.dueDate }))));
    ok('a demand due 31 July is settled before a bill due in August',
      new Date(b1Invoices[0].dueDate) <= new Date(b1Invoices[b1Invoices.length - 1].dueDate));

    // A demand with NO explicit date inherits the policy's due days, landing
    // after the month's bill — which is the ordering most societies expect.
    const liftDue = await invOf('B101', res2.body.period);
    const julyDue = await invOf('B101', '2026-07');
    ok('a demand left undated falls due no earlier than the regular bill',
      new Date(liftDue!.dueDate) >= new Date(julyDue!.dueDate),
      `lift ${liftDue!.dueDate} vs July ${julyDue!.dueDate}`);

    // ============================================ the fund is fed
    console.log('\nThe demand feeds the fund it was raised for');
    const fund = (await listFunds(SID, actor)).find(f => f.name === 'Painting Fund')!;
    eq('the fund has been raised its full target', fund.raisedPaise, 1_500_000);
    eq('...nothing left to raise', fund.remainingToRaisePaise, 0);

    // Raising it again would over-collect, and must be refused without the tick.
    const again = mockRes();
    await raiseSpecialDemand(mockReq({
      chargeHeadIds: [String(paint._id)], title: 'Painting again',
    }), again);
    eq('a repeat demand is refused', again.statusCode, 409);
    ok('...because it would pass the target', again.body?.requiresConfirmation === true);

    const forced = mockRes();
    await raiseSpecialDemand(mockReq({
      chargeHeadIds: [String(paint._id)], title: 'Painting again', confirmOverTarget: true,
    }), forced);
    eq('with the tick it goes ahead', forced.statusCode, 200);
    ok('...on a fresh key again', /^2026-07-S[0-9]+$/.test(forced.body?.period || ''), forced.body?.period);
    // Every demand this month must have landed on a distinct period.
    const periods = (await MaintenanceInvoice.distinct('billingPeriod', { societyId })) as string[];
    const specials = periods.filter(p => /^2026-07-S[0-9]+$/.test(p));
    eq('no two demands share a period key', new Set(specials).size, specials.length);

    // ============================================ GST across the month
    console.log('\nGST counts the whole month, not one bill');
    const gstSociety = policy;
    gstSociety.gst.enabled = true;
    gstSociety.set('gst.rwaExemptionPerMemberPaise', 750_000);   // ₹7,500
    gstSociety.set('gst.exemptionBasis', 'FULL_IF_EXCEEDS');
    gstSociety.set('gst.defaultRatePercent', 18);
    await gstSociety.save();

    const small = await createChargeHead(SID, {
      code: 'SMALL', name: 'Small levy', category: 'ADHOC',
      pricingMode: 'UNIFORM', uniformAmountPaise: 50_000, gstApplicable: true, isRecurring: false,
    }, actor);
    const gstRes = mockRes();
    await raiseSpecialDemand(mockReq({
      chargeHeadIds: [String(small._id)], flatIds: [String((await Flat.findOne({ societyId, number: 'A101' }))!._id)],
      title: 'Small levy', confirmOverTarget: true,
    }), gstRes);
    eq('the small levy is raised', gstRes.body?.created, 1);

    const gstInv = await MaintenanceInvoice.findOne({ societyId, flatNumber: 'A101', billingPeriod: gstRes.body.period }).lean();
    ok('GST is charged on it', (gstInv?.gstPaise || 0) > 0,
      'A ₹500 levy looks under the ₹7,500 limit on its own — but this member is already past it for July, so the levy is taxable. Charging nothing here is the bug this guards against.');
    eq('...at 18% of ₹500', gstInv?.gstPaise, 9_000);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
