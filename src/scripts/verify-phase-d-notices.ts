/**
 * Phase D verification — real database, THROWAWAY societyId, self-cleaning.
 * Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-phase-d-notices.ts
 *
 * Covers the two things that make this feature worth having: a notice that says
 * what was owed the day it was served (and keeps saying it), an escalation
 * ladder that cannot be skipped, and a PDC register that stays off the ledger
 * until the cheque is actually banked.
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
import { Receipt } from '../models/receipt.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { DefaulterNotice } from '../models/defaulter-notice.model';
import { PostDatedCheque } from '../models/pdc.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Society } from '../models/society.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { trialBalance, defaulters } from '../services/reports.service';
import { issueNotice, listNotices, resolveNotice, noticePdf, noticeStatusByFlat } from '../services/defaulter-notice.service';
import { registerPdc, listPdcs, depositPdc, updatePdcStatus } from '../services/pdc.service';
import { sendPdf } from '../services/report-export.service';

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

async function cleanup() {
  await Promise.all([
    LedgerAccount.deleteMany({ societyId }), JournalEntry.deleteMany({ societyId }),
    FinanceFund.deleteMany({ societyId }), FinancePolicy.deleteMany({ societyId }),
    ChargeHead.deleteMany({ societyId }), MaintenanceInvoice.deleteMany({ societyId }),
    Receipt.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
    DefaulterNotice.deleteMany({ societyId }), PostDatedCheque.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Society.deleteOne({ _id: societyId }),
  ]);
}

/**
 * The PDF is streamed to an Express Response, so hand `sendPdf` the smallest
 * thing that quacks like one and collect the bytes. Asserting on the real
 * stream is the point — a doc object that never renders is not a PDF.
 */
function renderPdf(doc: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const res: any = {
      setHeader: () => undefined,
      on: () => undefined,
      once: () => undefined,
      emit: () => undefined,
      write: (c: any) => { chunks.push(Buffer.from(c)); return true; },
      end: () => resolve(Buffer.concat(chunks)),
    };
    try { sendPdf(res, doc); } catch (e) { reject(e); }
  });
}

/**
 * Bill one flat for a period and return the invoice.
 *
 * `dueOn` back-dates the due date. Invoices are dated when they are generated,
 * not when their period fell, so a freshly-raised bill for January is not yet
 * overdue — and aging is exactly what these notices are about. Only the fixture
 * is moved; the aging itself is left to `defaulters()` to compute.
 */
async function bill(period: string, flatId: any, dueOn?: Date) {
  await generateInvoicesForSociety(SID, { period, flatIds: [String(flatId)], triggeredByUserId: actor.userId, triggeredByName: actor.userName });
  if (dueOn) await MaintenanceInvoice.updateOne({ societyId, flatId, billingPeriod: period }, { $set: { dueDate: dueOn } });
  return MaintenanceInvoice.findOne({ societyId, flatId, billingPeriod: period }).lean();
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await Society.create({
      _id: societyId, name: `Verify Phase D ${SID.slice(-6)}`, address: '1 Test Road, Pune',
      registrationNumber: `TEST/${SID.slice(-6)}`,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    } as any);
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    const policy = await getOrCreatePolicy(SID, actor.userId, actor.userName);
    policy.billing.dueDays = 15;
    policy.gst.enabled = false;
    await policy.save();

    const blockId = new mongoose.Types.ObjectId();
    const [flatA, flatB] = await Flat.create([1, 2].map(n => ({
      number: `20${n}`, blockName: 'A', blockId, societyId, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    })));

    await createChargeHead(SID, {
      code: 'MNT', name: 'Maintenance', category: 'MAINTENANCE',
      pricingMode: 'UNIFORM', uniformAmountPaise: 500_000, gstApplicable: false,
    }, actor);

    // A bill that fell due six months ago, so the flat is a real defaulter whose
    // dues have genuinely aged into the 90-days-plus bucket.
    const longAgo = new Date(Date.now() - 180 * 86_400_000);
    await bill('2026-01', flatA._id, longAgo);
    const reg = await defaulters(SID);
    const rowA = reg.rows.find(r => String(r.flatId) === String(flatA._id));
    eq('the flat owes its first bill', rowA?.outstandingPaise, 500_000);
    ok('…and it has aged past 90 days', (rowA?.buckets.d90plus || 0) > 0, JSON.stringify(rowA?.buckets));

    // ---------------------------------------------------- D1 the snapshot
    console.log('D1 — a notice freezes what it demanded');
    const first = await issueNotice(SID, { flatId: String(flatA._id), deliveredVia: ['EMAIL', 'HAND'] }, actor);
    eq('the first notice served is the FIRST reminder', first.stage, 'FIRST');
    eq('…demanding what the register showed at issue', first.outstandingPaise, 500_000);
    eq('…with the aging frozen alongside it', first.buckets.d90plus, rowA?.buckets.d90plus);
    ok('…and a date to pay by', first.dueByOn > first.issuedOn);

    // Bill more AFTER the notice. This is the whole point: the demand must not move.
    await bill('2026-02', flatA._id);
    const afterMoreBilling = await DefaulterNotice.findById(first._id).lean();
    eq('billing more later does NOT change what the notice demanded', afterMoreBilling?.outstandingPaise, 500_000);
    const live = await defaulters(SID);
    const liveA = live.rows.find(r => String(r.flatId) === String(flatA._id));
    eq('…while the register itself has moved on', liveA?.outstandingPaise, 1_000_000);
    ok('the two genuinely differ — the notice did not drift',
      afterMoreBilling?.outstandingPaise !== liveA?.outstandingPaise,
      `${rupees(afterMoreBilling?.outstandingPaise || 0)} vs ${rupees(liveA?.outstandingPaise || 0)}`);

    const listed = await listNotices(SID);
    eq('the register shows the notice', listed.rows.length, 1);
    eq('…still demanding the frozen amount', listed.rows[0].outstandingPaise, 500_000);
    eq('…next to what is owed today', listed.rows[0].currentOutstandingPaise, 1_000_000);

    // ---------------------------------------------------- D2 escalation order
    console.log('\nD2 — stages must escalate in order');
    const skipFinal = await refuses(() => issueNotice(SID, { flatId: String(flatA._id), stage: 'FINAL' }, actor));
    ok('a FINAL notice is refused before a SECOND has been served',
      /cannot be served before/i.test(skipFinal?.message || ''), skipFinal?.message);

    const skipRecovery = await refuses(() => issueNotice(SID, { flatId: String(flatA._id), stage: 'RECOVERY_101', recoveryRef: 'R/1' }, actor));
    ok('a recovery filing is refused before a FINAL notice',
      /cannot be served before/i.test(skipRecovery?.message || ''), skipRecovery?.message);

    const second = await issueNotice(SID, { flatId: String(flatA._id) }, actor);
    eq('the next notice picks up at SECOND on its own', second.stage, 'SECOND');
    const stillEarly = await refuses(() => issueNotice(SID, { flatId: String(flatA._id), stage: 'RECOVERY_101', recoveryRef: 'R/1' }, actor));
    ok('…and recovery is still refused with only a SECOND served',
      /cannot be served before/i.test(stillEarly?.message || ''), stillEarly?.message);

    const final = await issueNotice(SID, { flatId: String(flatA._id), stage: 'FINAL' }, actor);
    eq('a FINAL notice serves once a SECOND is on record', final.stage, 'FINAL');

    const noRef = await refuses(() => issueNotice(SID, { flatId: String(flatA._id), stage: 'RECOVERY_101' }, actor));
    ok('a recovery filing without its reference is refused',
      /reference/i.test(noRef?.message || ''), noRef?.message);

    const recovery = await issueNotice(SID, { flatId: String(flatA._id), stage: 'RECOVERY_101', recoveryRef: 'REC/2026/17' }, actor);
    eq('recovery is recorded once the ladder is complete', recovery.stage, 'RECOVERY_101');
    eq('…tracking the application reference and nothing more', recovery.recoveryRef, 'REC/2026/17');

    const status = await noticeStatusByFlat(SID);
    eq('the flat is at the top of the ladder', status[String(flatA._id)]?.lastStage, 'RECOVERY_101');
    eq('…and there is nowhere further to escalate', status[String(flatA._id)]?.nextStage, 'RECOVERY_101');

    // A flat with no notices starts at FIRST, not wherever its neighbour got to.
    await bill('2026-01', flatB._id);
    const bFirst = await issueNotice(SID, { flatId: String(flatB._id) }, actor);
    eq('another flat starts its own ladder at FIRST', bFirst.stage, 'FIRST');

    // Resolving closes the chain — a fresh default starts again at FIRST.
    await resolveNotice(SID, String(bFirst._id), { notes: 'paid in full' });
    const resolved = await DefaulterNotice.findById(bFirst._id).lean();
    ok('a resolved notice is closed', !!resolved?.resolvedOn);
    const twice = await refuses(() => resolveNotice(SID, String(bFirst._id)));
    ok('…and cannot be resolved twice', /already resolved/i.test(twice?.message || ''), twice?.message);
    const bAgain = await issueNotice(SID, { flatId: String(flatB._id) }, actor);
    eq('after resolution the ladder restarts at FIRST', bAgain.stage, 'FIRST');

    // ---------------------------------------------------- D3 the notice PDF
    console.log('\nD3 — the notice prints');
    const doc = await noticePdf(SID, String(first._id));
    const bytes = await renderPdf(doc);
    ok('the notice renders a real PDF', bytes.subarray(0, 4).toString() === '%PDF', bytes.subarray(0, 8).toString());
    ok('…on the society\'s letterhead', doc.societyName.startsWith('Verify Phase D'), doc.societyName);
    ok('…naming the stage', /First Reminder/.test(doc.title), doc.title);
    ok('…showing the aging breakdown', doc.sections.some(s => /aged/i.test(s.title || '')), JSON.stringify(doc.sections.map(s => s.title)));
    ok('…and telling the member what happens next',
      doc.sections.some(s => /happens next/i.test(s.title || '')), JSON.stringify(doc.sections.map(s => s.title)));
    const missing = await refuses(() => noticePdf(SID, String(new mongoose.Types.ObjectId())));
    ok('a notice that does not exist is a 404, not a crash', (missing as any)?.status === 404, missing?.message);

    // ---------------------------------------------------- D4 PDC posts nothing
    console.log('\nD4 — a held cheque is not money');
    const tbBefore = await trialBalance(SID);
    const journalsBefore = await JournalEntry.countDocuments({ societyId });
    const held = await registerPdc(SID, {
      flatId: String(flatB._id), payerName: 'Bala Iyer',
      chequeNo: '000123', bankName: 'HDFC Bank',
      chequeDate: new Date(2026, 7, 1).toISOString(), amountPaise: 500_000,
    }, actor);
    eq('a registered cheque is HELD', held.status, 'HELD');
    ok('…with no receipt behind it', !held.receiptId);

    const tbHeld = await trialBalance(SID);
    // The ledger must be byte-for-byte what it was: an undated promise is not
    // money, and booking it would overstate the bank by the whole drawer.
    eq('holding a cheque posts NOTHING to the ledger',
      JSON.stringify(tbHeld.rows), JSON.stringify(tbBefore.rows));
    eq('…so the trial balance totals are untouched', tbHeld.totalDebitPaise, tbBefore.totalDebitPaise);
    eq('…and not one journal was written', await JournalEntry.countDocuments({ societyId }), journalsBefore);

    const dupe = await refuses(() => registerPdc(SID, {
      flatId: String(flatB._id), payerName: 'Bala Iyer',
      chequeNo: '000123', bankName: 'HDFC Bank',
      chequeDate: new Date(2026, 7, 1).toISOString(), amountPaise: 500_000,
    }, actor));
    ok('the same cheque cannot be registered twice', /already in the register/i.test(dupe?.message || ''), dupe?.message);
    // Same number, different bank — a different cheque, and must be allowed.
    const otherBank = await registerPdc(SID, {
      flatId: String(flatB._id), payerName: 'Bala Iyer',
      chequeNo: '000123', bankName: 'ICICI Bank',
      chequeDate: new Date(2026, 7, 1).toISOString(), amountPaise: 100_000,
    }, actor);
    ok('…but the same number at a different bank is a different cheque', !!otherBank._id);

    const register2 = await listPdcs(SID);
    eq('the register carries both cheques', register2.heldCount, 2);
    eq('…and values what is being held', register2.heldPaise, 600_000);

    // ---------------------------------------------------- D5 deposit posts it
    console.log('\nD5 — depositing is when it becomes money');
    const bOutstandingBefore = (await defaulters(SID)).rows.find(r => String(r.flatId) === String(flatB._id))?.outstandingPaise;
    const deposited = await depositPdc(SID, String(held._id), {}, actor);
    eq('the cheque is DEPOSITED', deposited.status, 'DEPOSITED');
    ok('…and now has a real receipt behind it', !!deposited.receiptId);

    const receipt = await Receipt.findById(deposited.receiptId).lean();
    ok('the receipt is a genuine cleared receipt', receipt?.status === 'CLEARED', receipt?.status);
    eq('…for the cheque amount', receipt?.amountPaise, 500_000);
    eq('…recorded as a cheque', receipt?.mode, 'CHEQUE');
    eq('…carrying the instrument details', receipt?.instrument?.chequeNo, '000123');
    ok('…with a journal behind it', !!receipt?.journalEntryId);
    // recordClearedReceipt did the allocation — this service must not have
    // reimplemented any of it.
    ok('…allocated against the flat\'s open invoices', (receipt?.allocations?.length || 0) > 0);

    const tbDeposited = await trialBalance(SID);
    ok('the ledger ties after the deposit', tbDeposited.balanced,
      `Dr ${rupees(tbDeposited.totalDebitPaise)} vs Cr ${rupees(tbDeposited.totalCreditPaise)}`);
    ok('…with no account drifted from its entries', tbDeposited.drift.length === 0, JSON.stringify(tbDeposited.drift));
    // A cheque in hand sits in Undeposited Cheques, not the bank — the bank has
    // not seen it yet.
    eq('the money lands in Undeposited Cheques, not the bank',
      tbDeposited.rows.find(r => r.code === '1120')?.debitPaise, 500_000);
    const bOutstandingAfter = (await defaulters(SID)).rows.find(r => String(r.flatId) === String(flatB._id))?.outstandingPaise;
    eq('…and the flat\'s dues came down by the cheque', (bOutstandingBefore || 0) - (bOutstandingAfter || 0), 500_000);

    const twiceDeposit = await refuses(() => depositPdc(SID, String(held._id), {}, actor));
    ok('a cheque cannot be deposited twice', /already deposited/i.test(twiceDeposit?.message || ''), twiceDeposit?.message);

    // Clearing moves it Undeposited → Bank, via the existing clearCheque.
    await updatePdcStatus(SID, String(held._id), { status: 'CLEARED' }, actor);
    const tbCleared = await trialBalance(SID);
    eq('once the bank clears it, Undeposited Cheques empties',
      tbCleared.rows.find(r => r.code === '1120')?.debitPaise ?? 0, 0);
    eq('…and the money is in the bank', tbCleared.rows.find(r => r.code === '1100')?.debitPaise, 500_000);
    ok('the ledger still ties', tbCleared.balanced && tbCleared.drift.length === 0, JSON.stringify(tbCleared.drift));

    // RETURNED = handed back undeposited. Nothing was posted, nothing is unposted.
    const returned = await updatePdcStatus(SID, String(otherBank._id), { status: 'RETURNED', reason: 'member paid by UPI instead' }, actor);
    eq('an undeposited cheque can be handed back', returned.status, 'RETURNED');
    const tbReturned = await trialBalance(SID);
    eq('…and handing it back posts nothing either',
      JSON.stringify(tbReturned.rows), JSON.stringify(tbCleared.rows));
    const lateReturn = await refuses(() => updatePdcStatus(SID, String(held._id), { status: 'RETURNED' }, actor));
    ok('a banked cheque cannot be "handed back"', /still being held/i.test(lateReturn?.message || ''), lateReturn?.message);

    // ---------------------------------------------------- integrity
    console.log('\nLedger integrity');
    const final2 = await trialBalance(SID);
    ok('the ledger still ties', final2.balanced, `Dr ${rupees(final2.totalDebitPaise)} vs Cr ${rupees(final2.totalCreditPaise)}`);
    ok('no account has drifted from its entries', final2.drift.length === 0, JSON.stringify(final2.drift));
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