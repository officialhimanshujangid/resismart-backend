/**
 * Phase 4 — fund targets: what was demanded vs what was needed.
 * Real database, THROWAWAY societyId, self-cleaning. Never touches existing data.
 *
 * The load-bearing assertion is "spending does not reopen the demand": a fund
 * that raised its target and then paid the contractor must NOT ask members for
 * more. Comparing the target to the fund's balance would do exactly that.
 *
 *   npx ts-node src/scripts/verify-fund-targets.ts
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
import { FinanceFund } from '../models/finance-fund.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Block } from '../models/block.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { createFund, listFunds, updateFund } from '../services/funds.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { recordClearedReceipt } from '../services/collections.service';
import { createExpense, approveExpense, payExpense } from '../services/expenses.service';
import { projectChargeHead, projectRunFundImpact } from '../services/fund-projection.service';
import { generateInvoices as generateCtrl } from '../controllers/maintenance-invoice.controller';
// Pulls in the `Request.user` global augmentation, which lives in the auth
// middleware. Without it ts-node compiles this entry point without ever seeing
// the declaration and every `req.user` in the controller fails to type.
import '../middlewares/auth.middleware';

const societyId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const approverId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const approver = { userId: approverId.toString(), userName: 'Approver' };
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
    Expense.deleteMany({ societyId }), Vendor.deleteMany({ societyId }),
    FinanceFund.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Block.deleteMany({ societyId }),
  ]);
}

const fundNamed = async (name: string) => (await listFunds(SID, actor)).find(f => f.name === name)!;

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    const policy = await getOrCreatePolicy(SID, actor.userId, actor.userName);
    policy.gst.enabled = false;
    await policy.save();

    const [towerA, towerB] = await Block.create([
      { name: 'Tower A', societyId, createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName },
      { name: 'Tower B', societyId, createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName },
    ]);
    const mkFlat = (n: string, block: any) => ({
      number: n, blockName: block.name, blockId: block._id, societyId, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    // 2 flats in Tower A, 1 in Tower B.
    const [a1, a2, b1] = await Flat.create([mkFlat('A101', towerA), mkFlat('A102', towerA), mkFlat('B101', towerB)]);

    // ==================================================== the target is editable
    console.log('A target can be corrected after the fact');
    const created = await createFund(SID, {
      name: 'Painting Fund 2026', category: 'SPECIAL', targetAmountPaise: 100_000,
    }, actor);
    eq('it starts at what was typed', created.targetAmountPaise, 100_000);

    const fixed = await updateFund(SID, String(created._id), { targetAmountPaise: 1_500_000 }, approver);
    eq('and can be corrected — there was no way to do this at all before', fixed.targetAmountPaise, 1_500_000);
    eq('the correction is attributed', fixed.updatedByName, 'Approver');

    const paintFund = await fundNamed('Painting Fund 2026');
    eq('nothing raised yet', paintFund.raisedPaise, 0);
    eq('so the whole target is still to raise', paintFund.remainingToRaisePaise, 1_500_000);

    // ==================================================== projection before billing
    console.log('\nWhat a charge head would raise, asked before it bills');
    const head = await createChargeHead(SID, {
      code: 'PAINT26', name: 'Painting contribution', category: 'ADHOC',
      pricingMode: 'PER_BLOCK',
      perBlockAmounts: [
        { blockId: String(towerA._id), label: 'Tower A', amountPaise: 550_000 },
        { blockId: String(towerB._id), label: 'Tower B', amountPaise: 400_000 },
      ],
      fundId: paintFund._id,
      isRecurring: false,
    }, actor);

    const proj = await projectChargeHead(SID, { chargeHeadId: String(head._id) }, actor);
    eq('it applies to every flat', proj.applicableFlats, 3);
    eq('none is left unpriced', proj.unpricedFlats, 0);
    eq('one round raises ₹5,500 + ₹5,500 + ₹4,000', proj.perRunPaise, 1_500_000);
    eq('...which is exactly the target', proj.fund?.projectedPaise, 1_500_000);
    eq('...so nothing over', proj.fund?.overByPaise, 0);
    eq('...and nothing short', proj.fund?.shortByPaise, 0);

    // An unsaved draft must project too, so the form can warn while it is typed.
    const draftProj = await projectChargeHead(SID, {
      draft: {
        pricingMode: 'PER_BLOCK', fundId: paintFund._id,
        perBlockAmounts: [
          { blockId: String(towerA._id), amountPaise: 600_000 },
          { blockId: String(towerB._id), amountPaise: 450_000 },
        ],
      },
    }, actor);
    eq('a draft projects to ₹6,000 × 2 + ₹4,500', draftProj.perRunPaise, 1_650_000);
    eq('...and is flagged as ₹1,500 over the target', draftProj.fund?.overByPaise, 150_000);

    // ==================================================== the run-level guard
    console.log('\nA run that would over-collect is refused until acknowledged');
    const over = await createChargeHead(SID, {
      code: 'EXTRA', name: 'Extra painting top-up', category: 'ADHOC',
      pricingMode: 'UNIFORM', uniformAmountPaise: 100_000,
      fundId: paintFund._id, isRecurring: false,
    }, actor);

    const bothImpact = await projectRunFundImpact(SID, { chargeHeadIds: [String(head._id), String(over._id)] }, actor);
    eq('two heads feeding one fund are added together', bothImpact.length, 1);
    eq('...₹15,000 + ₹3,000', bothImpact[0].thisRunPaise, 1_800_000);
    eq('...₹3,000 past the target', bothImpact[0].overByPaise, 300_000);

    const blocked = mockRes();
    await generateCtrl(mockReq({ period: '2026-04', chargeHeadIds: [String(head._id), String(over._id)] }), blocked);
    eq('the real run is refused', blocked.statusCode, 409);
    ok('...saying it needs confirming', blocked.body?.requiresConfirmation === true);
    ok('...and by how much', /more than needed/i.test(blocked.body?.error || ''), blocked.body?.error);
    eq('nothing was billed', await MaintenanceInvoice.countDocuments({ societyId }), 0);

    // A dry run must still answer, never refuse — that is the point of a preview.
    const dry = mockRes();
    await generateCtrl(mockReq({ period: '2026-04', chargeHeadIds: [String(head._id), String(over._id)], dryRun: true }), dry);
    eq('a preview is allowed through', dry.statusCode, 200);
    eq('...and carries the fund warning', dry.body?.fundImpact?.[0]?.overByPaise, 300_000);
    eq('...having written nothing', await MaintenanceInvoice.countDocuments({ societyId }), 0);

    // ==================================================== billing within target
    console.log('\nBilling exactly the target');
    const good = mockRes();
    await generateCtrl(mockReq({ period: '2026-04', chargeHeadIds: [String(head._id)] }), good);
    eq('a run inside the target goes through untouched', good.statusCode, 200);
    eq('three invoices raised', good.body?.created, 3);

    let fund = await fundNamed('Painting Fund 2026');
    eq('the fund has been demanded its full target', fund.raisedPaise, 1_500_000);
    eq('...nothing left to raise', fund.remainingToRaisePaise, 0);
    eq('...and nothing over-raised', fund.overRaisedPaise, 0);
    eq('but no cash has arrived yet', fund.collectedPaise, 0);
    eq('the balance equals what was demanded, for now', fund.currentBalancePaise, 1_500_000);

    // ==================================================== collected vs raised
    console.log('\nRaised is what was asked for; collected is what came in');
    const payFor = async (flat: any, n: string, paise: number) => {
      await recordClearedReceipt(SID, {
        flatId: String(flat._id), blockName: flat.blockName, flatNumber: n,
        mode: 'BANK_TRANSFER', amountPaise: paise, source: 'ADMIN_WALKIN',
        actor: { ...actor, role: 'SOCIETY_ADMIN' },
      } as any);
    };
    await payFor(a1, 'A101', 550_000);
    await payFor(b1, 'B101', 400_000);

    fund = await fundNamed('Painting Fund 2026');
    eq('raised is unchanged by payment', fund.raisedPaise, 1_500_000);
    eq('collected tracks the cash', fund.collectedPaise, 950_000);
    ok('...and lags what was raised', fund.collectedPaise < fund.raisedPaise,
      'the fund is credited when the bill is raised, not when it is paid');

    // ============================ THE ONE THAT MATTERS: spending must not reopen
    console.log('\nSpending from the fund must NOT reopen the demand');
    const vendor = await Vendor.create({
      societyId, name: 'Painter Co', createdBy: userId, createdByName: actor.userName,
    });
    const bill = await createExpense(SID, {
      vendorId: String(vendor._id), category: 'REPAIRS', paymentMode: 'BANK',
      lineItems: [{ expenseAccountCode: '5140', amountPaise: 1_400_000, fundId: paintFund._id }],
    }, actor);
    await approveExpense(SID, String(bill._id), approver);
    await payExpense(SID, String(bill._id), approver);

    fund = await fundNamed('Painting Fund 2026');
    eq('₹14,000 has been spent from it', fund.spentPaise, 1_400_000);
    eq('the balance is down to ₹1,000', fund.currentBalancePaise, 100_000);

    // If the guard compared the target to the BALANCE, it would now claim
    // ₹14,000 is still to be collected — from members who paid in full.
    eq('raised still shows the full demand', fund.raisedPaise, 1_500_000);
    ok('NOTHING more is asked of members after spending', fund.remainingToRaisePaise === 0,
      `it wants another ${rupees(fund.remainingToRaisePaise)} — the guard is reading the balance, not what was raised`);

    const afterSpend = await projectRunFundImpact(SID, { chargeHeadIds: [String(head._id)] }, actor);
    eq('a fresh run is still judged against what was raised', afterSpend[0]?.raisedPaise, 1_500_000);
    ok('...so billing again is correctly flagged as over-collection',
      (afterSpend[0]?.overByPaise || 0) > 0, JSON.stringify(afterSpend[0]));

    // ==================================================== confirmed override
    console.log('\nAn acknowledged over-collection is allowed through');
    const confirmed = mockRes();
    await generateCtrl(mockReq({
      period: '2026-05', chargeHeadIds: [String(over._id)], confirmOverTarget: true,
    }), confirmed);
    eq('with the tick, it bills', confirmed.statusCode, 200);
    eq('...all three flats', confirmed.body?.created, 3);

    fund = await fundNamed('Painting Fund 2026');
    eq('the fund now shows it was over-raised', fund.overRaisedPaise, 300_000);
    eq('...by exactly the extra round', fund.raisedPaise, 1_800_000);

    // ==================================================== a fund with no target
    console.log('\nA fund with no target is never nagged');
    await createFund(SID, { name: 'General Reserve', category: 'GENERAL' }, actor);
    const general = await fundNamed('General Reserve');
    eq('no target means nothing to raise', general.remainingToRaisePaise, 0);
    eq('...and nothing can be over-raised', general.overRaisedPaise, 0);

    const noTargetHead = await createChargeHead(SID, {
      code: 'GEN', name: 'General contribution', category: 'ADHOC',
      pricingMode: 'UNIFORM', uniformAmountPaise: 50_000, fundId: general._id,
    }, actor);
    const noTargetImpact = await projectRunFundImpact(SID, { chargeHeadIds: [String(noTargetHead._id)] }, actor);
    eq('a targetless fund raises no warning at all', noTargetImpact.length, 0);

    const free = mockRes();
    await generateCtrl(mockReq({ period: '2026-06', chargeHeadIds: [String(noTargetHead._id)] }), free);
    eq('...and bills without a confirmation', free.statusCode, 200);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
