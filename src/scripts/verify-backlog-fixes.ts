/**
 * The four backlog fixes (#10–#13). Real database, THROWAWAY societyId,
 * self-cleaning. Never touches existing data.
 *
 * Controller logic is exercised through real handler calls with a mock req/res,
 * not re-implemented here — #10 and #11 live entirely in controllers, and a test
 * that only checked the services underneath would have passed before the fix.
 *
 *   npx ts-node src/scripts/verify-backlog-fixes.ts
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
import { SequenceCounter } from '../models/sequence-counter.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Block } from '../models/block.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { recordClearedReceipt } from '../services/collections.service';
import { postManualJournal } from '../controllers/ledger.controller';
import { getFlatOutstanding } from '../controllers/collections.controller';
import { reportOffline } from '../controllers/resident-finance.controller';

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

/** Minimal Express double — enough to capture status + body from a real handler. */
const mockRes = () => {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
};
const mockReq = (over: any = {}) => ({
  user: { activeTenantId: SID, userId: actor.userId, userName: actor.userName, activeRole: 'SOCIETY_ADMIN', ...over.user },
  body: over.body || {},
  params: over.params || {},
  query: over.query || {},
}) as any;

async function cleanup() {
  await Promise.all([
    LedgerAccount.deleteMany({ societyId }), JournalEntry.deleteMany({ societyId }),
    FinancePolicy.deleteMany({ societyId }), ChargeHead.deleteMany({ societyId }),
    MaintenanceInvoice.deleteMany({ societyId }), Receipt.deleteMany({ societyId }),
    Block.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }),
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
    const [flatA, flatB] = await Flat.create([1, 2].map(n => ({
      number: `10${n}`, blockName: 'A', blockId, societyId, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    })));

    // ============================================ #13 PLATFORM_ROUTE retirement
    console.log('#13 — the retired settlement mode heals itself');
    // Write the legacy value straight past Mongoose validation, exactly as an
    // existing society's document would already hold it.
    await FinancePolicy.collection.updateOne(
      { societyId }, { $set: { 'settlement.mode': 'PLATFORM_ROUTE', 'settlement.routeAccountId': 'acc_LEGACY' } },
    );
    const stale = await FinancePolicy.findOne({ societyId }).lean();
    eq('a legacy society really is on the old mode', (stale?.settlement as any)?.mode, 'PLATFORM_ROUTE');

    const healed = await getOrCreatePolicy(SID, actor.userId, actor.userName);
    eq('reading the policy migrates it', healed.settlement.mode, 'PLATFORM_COLLECT_PAYOUT');

    // The real point: the document must now survive a save. Before the fix this
    // threw a Mongoose enum ValidationError, and ordinary paths save the policy
    // (TDS resolution, module inference) — so expenses would have broken with an
    // error nobody could trace back to a settlement mode.
    let saved = true;
    try { healed.set('advance.autoApply', true); await healed.save(); }
    catch { saved = false; }
    ok('...and the policy saves cleanly afterwards', saved,
      'a stale enum value would fail validation on the very next save');

    const reread = await FinancePolicy.findOne({ societyId }).lean();
    eq('...the migration is persisted, not just in memory', (reread?.settlement as any)?.mode, 'PLATFORM_COLLECT_PAYOUT');

    // ================================================ #12 manual voucher FY
    console.log('\n#12 — a manual voucher lands in the society\'s own financial year');
    // January start: a January-dated entry belongs to FY 2026-2027 here, but to
    // 2025-2026 under the April default the controller used to fall back to.
    const p = await FinancePolicy.findOne({ societyId });
    p!.set('financialYear.startMonth', 1);
    await p!.save();

    const jvRes = mockRes();
    await postManualJournal(mockReq({
      body: {
        voucherType: 'JOURNAL',
        entryDate: new Date(2026, 0, 15).toISOString(), // 15 Jan 2026
        narration: 'Bank charges',
        lines: [
          { accountCode: '5180', debitPaise: 23_600 },
          { accountCode: '1100', creditPaise: 23_600 },
        ],
      },
    }), jvRes);
    eq('the voucher posts', jvRes.statusCode, 200);
    eq('...stamped with the January-start FY, not April', jvRes.body?.financialYear, '2026-2027');
    ok('...and numbered from that FY\'s own sequence', /2026-27/.test(jvRes.body?.voucherNumber || ''),
      `voucher number was ${jvRes.body?.voucherNumber}`);

    p!.set('financialYear.startMonth', 4);
    await p!.save();

    // ================================================== #11 advance on the dialog
    console.log('\n#11 — the refund screen can see the advance it is refunding');
    await createChargeHead(SID, {
      code: 'M1', name: 'Maintenance', category: 'MAINTENANCE', pricingMode: 'UNIFORM', uniformAmountPaise: 100_000,
    } as any, actor);
    await generateInvoicesForSociety(SID, { period: '2026-04', triggeredByUserId: actor.userId, triggeredByName: actor.userName });

    // ₹1,500 against a ₹1,000 bill leaves ₹500 of advance.
    await recordClearedReceipt(SID, {
      flatId: String(flatA._id), blockName: 'A', flatNumber: '101',
      mode: 'CASH', amountPaise: 150_000, source: 'ADMIN_WALKIN',
      actor: { ...actor, role: 'SOCIETY_ADMIN' },
    } as any);

    const outRes = mockRes();
    await getFlatOutstanding(mockReq({ params: { flatId: String(flatA._id) } }), outRes);
    eq('the endpoint answers', outRes.statusCode, 200);
    ok('advanceBalancePaise is returned at all', outRes.body?.advanceBalancePaise !== undefined,
      'the key was missing entirely, so the dialog always showed ₹0');
    eq('...and it is the real figure', outRes.body?.advanceBalancePaise, 50_000);
    eq('...dues still reported alongside', outRes.body?.totalOutstandingPaise, 0);

    // A flat with no advance must read exactly zero, not undefined.
    const outB = mockRes();
    await getFlatOutstanding(mockReq({ params: { flatId: String(flatB._id) } }), outB);
    eq('a flat holding nothing reports 0, not undefined', outB.body?.advanceBalancePaise, 0);

    // ============================================ #10 resident pays in advance
    console.log('\n#10 — a member can pay ahead from their own portal');
    const residentReq = (body: any) => mockReq({
      user: { activeUnitId: String(flatB._id), activeRole: 'RESIDENT_OWNER' },
      body,
    });

    // Flat B owes ₹1,000 from the April run.
    const bInv = await MaintenanceInvoice.findOne({ societyId, flatId: flatB._id }).lean();
    eq('flat B owes this month\'s bill', bInv?.outstandingPaise, 100_000);

    // Overpaying without saying so is refused — far more likely a typo.
    const typo = mockRes();
    await reportOffline(residentReq({ mode: 'UPI', amountPaise: 600_000 }), typo);
    eq('paying over the dues by accident is refused', typo.statusCode, 400);
    ok('...with an error that explains the tick', /advance/i.test(typo.body?.error || ''), typo.body?.error);

    // Same amount, declared as advance, is accepted.
    const ahead = mockRes();
    await reportOffline(residentReq({ mode: 'UPI', amountPaise: 600_000, payAdvance: true }), ahead);
    eq('declaring it as advance is accepted', ahead.statusCode, 200);
    eq('...and the full amount is recorded', ahead.body?.receipt?.amountPaise, 600_000);
    eq('...pending the committee, as before', ahead.body?.receipt?.status, 'PENDING_CONFIRMATION');

    // The over-reporting guard must still bite on the dues portion: that ₹6,000
    // is now pending, so a second claim against the same bill has no room left.
    const twice = mockRes();
    await reportOffline(residentReq({ mode: 'CASH', amountPaise: 100_000 }), twice);
    eq('a second claim on the same bill is still refused', twice.statusCode, 400);
    ok('...because the pending amount already covers it',
      /fully paid|awaiting confirmation|advance/i.test(twice.body?.error || ''), twice.body?.error);

    // Paying purely in advance with nothing owed must work — the case that was
    // impossible before, when zero dues meant "nothing outstanding to pay".
    const zeroDues = mockRes();
    await reportOffline(residentReq({ mode: 'BANK_TRANSFER', amountPaise: 250_000, payAdvance: true }), zeroDues);
    eq('paying ahead with no dues left is allowed', zeroDues.statusCode, 200);
    eq('...for the amount asked', zeroDues.body?.receipt?.amountPaise, 250_000);

    // Zero and negative are still rejected outright.
    const zero = mockRes();
    await reportOffline(residentReq({ mode: 'CASH', amountPaise: 0, payAdvance: true }), zero);
    ok('zero is still refused', zero.statusCode === 400, `got ${zero.statusCode}`);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
