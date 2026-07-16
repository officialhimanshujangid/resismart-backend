/**
 * Phase D — waivers/write-offs/rebates and refunds. Real database, THROWAWAY
 * societyId, self-cleaning. Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-phase-d-adjustments.ts
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
import { Refund } from '../models/refund.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { recordClearedReceipt, bounceReceipt } from '../services/collections.service';
import { trialBalance } from '../services/reports.service';
import {
  adjustInvoice, rebateSuggestion, requestRefund, payRefund, rejectRefund,
  flatAdvanceBalance, listRefunds,
} from '../services/adjustments.service';

const societyId = new mongoose.Types.ObjectId();
/** Interest needs its own books — a clean arrears history the other blocks don't disturb. */
const extraSocieties: mongoose.Types.ObjectId[] = [];
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
const refuses = async (fn: () => Promise<unknown>): Promise<Error | null> => {
  try { await fn(); return null; } catch (e: any) { return e; }
};
const balOf = (rows: { code: string; debitPaise: number; creditPaise: number }[], code: string) => {
  const r = rows.find(x => x.code === code);
  return r ? r.debitPaise - r.creditPaise : 0;
};

async function cleanup() {
  const all = { $in: [societyId, ...extraSocieties] };
  await Promise.all([
    LedgerAccount.deleteMany({ societyId: all }), JournalEntry.deleteMany({ societyId: all }),
    FinancePolicy.deleteMany({ societyId: all }), ChargeHead.deleteMany({ societyId: all }),
    MaintenanceInvoice.deleteMany({ societyId: all }), Receipt.deleteMany({ societyId: all }),
    Refund.deleteMany({ societyId: all }), SequenceCounter.deleteMany({ societyId: all }),
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
    const [flatA, flatB, flatC] = await Flat.create([1, 2, 3].map(n => ({
      number: `10${n}`, blockName: 'A', blockId, societyId, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    })));
    await createChargeHead(SID, {
      code: 'M1', name: 'Maintenance', category: 'MAINTENANCE', pricingMode: 'UNIFORM', uniformAmountPaise: 100_000,
    }, actor);
    await generateInvoicesForSociety(SID, { period: '2026-04', triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const invA = await MaintenanceInvoice.findOne({ societyId, flatId: flatA._id }).lean();

    // ---------------------------------------------------- adjustments
    console.log('Waivers, write-offs & rebates');
    const debtorsBefore = balOf((await trialBalance(SID)).rows, '1200');
    const adj = await adjustInvoice(SID, String(invA!._id), {
      kind: 'WAIVER', amountPaise: 30_000, reason: 'Committee resolution 14/2026',
    }, actor);
    eq('the waived amount is recorded on the bill', adj.waivedPaise, 30_000);
    eq('…and comes off what is owed', adj.outstandingPaise, 70_000);
    const tb1 = await trialBalance(SID);
    eq('debtors fall by the waived amount', debtorsBefore - balOf(tb1.rows, '1200'), 30_000);
    eq('…and the cost lands in Rebates & Waivers', balOf(tb1.rows, '5900'), 30_000);
    // The bill must keep its face value — a bill that silently shrinks can't be audited.
    const invAfter = await MaintenanceInvoice.findById(invA!._id).lean();
    eq('the bill keeps its full value', invAfter?.totalPaise, invA!.totalPaise);

    const tooMuch = await refuses(() => adjustInvoice(SID, String(invA!._id), { kind: 'WAIVER', amountPaise: 999_999, reason: 'x' }, actor));
    ok('you cannot adjust more than is outstanding', /cannot adjust more than is owed/i.test(tooMuch?.message || ''), tooMuch?.message);
    const noReason = await refuses(() => adjustInvoice(SID, String(invA!._id), { kind: 'WAIVER', amountPaise: 100, reason: '  ' }, actor));
    ok('a reason is required', /reason is required/i.test(noReason?.message || ''), noReason?.message);

    // Waiving the rest of an untouched bill marks it WAIVED, not PAID.
    const invB = await MaintenanceInvoice.findOne({ societyId, flatId: flatB._id }).lean();
    const full = await adjustInvoice(SID, String(invB!._id), { kind: 'WRITE_OFF', amountPaise: invB!.outstandingPaise, reason: 'Unrecoverable — flat vacant' }, actor);
    eq('a bill nothing was ever paid on becomes WAIVED', full.status, 'WAIVED');
    const restA = await adjustInvoice(SID, String(invA!._id), { kind: 'WAIVER', amountPaise: 70_000, reason: 'Remainder waived' }, actor);
    eq('…as does one forgiven in stages with nothing collected', restA.status, 'WAIVED');

    // …but a bill that WAS part-paid and then forgiven the rest is PAID, not
    // WAIVED — calling that "waived" would misread what actually happened.
    await recordClearedReceipt(SID, {
      flatId: String(flatC._id), blockName: 'A', flatNumber: '103',
      mode: 'BANK_TRANSFER', amountPaise: 40_000, source: 'ADMIN_WALKIN',
      actor: { ...actor, role: 'SOCIETY_ADMIN' },
    });
    const invC = await MaintenanceInvoice.findOne({ societyId, flatId: flatC._id }).lean();
    eq('the part payment landed on the bill', invC?.outstandingPaise, 60_000);
    const restC = await adjustInvoice(SID, String(invC!._id), { kind: 'WAIVER', amountPaise: 60_000, reason: 'Balance waived' }, actor);
    eq('a part-paid bill forgiven the rest is PAID', restC.status, 'PAID');

    // ---------------------------------------------------- rebate suggestion
    console.log('\nEarly-payment rebate');
    policy.rebate = { enabled: true, percent: 5, withinDays: 15 } as any;
    await policy.save();
    await generateInvoicesForSociety(SID, { period: '2026-05', flatIds: [String(flatA._id)], triggeredByUserId: actor.userId, triggeredByName: actor.userName });
    const invMay = await MaintenanceInvoice.findOne({ societyId, flatId: flatA._id, billingPeriod: '2026-05' }).lean();
    const sug = await rebateSuggestion(SID, String(invMay!._id), actor);
    eq('a rebate is offered inside the window', sug.eligible, true);
    eq('…at 5% of the bill', sug.amountPaise, 5_000);
    // Out of the window, nothing is offered.
    await MaintenanceInvoice.updateOne({ _id: invMay!._id }, { $set: { invoiceDate: new Date(2020, 0, 1) } });
    const late = await rebateSuggestion(SID, String(invMay!._id), actor);
    eq('…and not offered once the window closes', late.eligible, false);
    policy.rebate = { enabled: false, percent: 5, withinDays: 15 } as any;
    await policy.save();
    const offNow = await rebateSuggestion(SID, String(invMay!._id), actor);
    eq('switching rebates off withdraws the offer', offNow.eligible, false);
    // A rebate is never applied on its own — a discount nobody approved is one
    // nobody can explain. It only exists once someone posts it.
    const stillOwed = await MaintenanceInvoice.findById(invMay!._id).lean();
    eq('no rebate is applied automatically', stillOwed?.waivedPaise, 0);

    // ---------------------------------------------------- refunds
    console.log('\nRefunds');
    // Overpay to create advance credit.
    await recordClearedReceipt(SID, {
      flatId: String(flatB._id), blockName: 'A', flatNumber: '102',
      mode: 'BANK_TRANSFER', amountPaise: 250_000, source: 'ADMIN_WALKIN',
      actor: { ...actor, role: 'SOCIETY_ADMIN' },
    });
    const advance = await flatAdvanceBalance(SID, String(flatB._id));
    ok('overpaying leaves advance credit', advance > 0, `advance ${rupees(advance)}`);

    const overAsk = await refuses(() => requestRefund(SID, { flatId: String(flatB._id), amountPaise: advance + 1, reason: 'too much' }, actor));
    ok('you cannot refund more advance than the flat holds', /nothing more to refund/i.test(overAsk?.message || ''), overAsk?.message);

    // With approval required, a refund waits for someone else.
    policy.approvals.refundRequiresApproval = true;
    await policy.save();
    const req1 = await requestRefund(SID, { flatId: String(flatB._id), amountPaise: 50_000, reason: 'Member moving out' }, actor);
    eq('a refund waits for approval when policy says so', req1.status, 'PENDING_APPROVAL');
    ok('…and posts nothing yet', !req1.journalEntryId);

    const selfApprove = await refuses(() => payRefund(SID, String(req1._id), actor));
    ok('the requester cannot approve their own refund',
      /different person to approve/i.test(selfApprove?.message || ''), selfApprove?.message);

    const bankBefore = balOf((await trialBalance(SID)).rows, '1100');
    const paid = await payRefund(SID, String(req1._id), approver);
    eq('someone else can approve it', paid.status, 'PAID');
    eq('…recording who', paid.approvedByName, 'Approver');
    const tb2 = await trialBalance(SID);
    eq('the money leaves the bank', bankBefore - balOf(tb2.rows, '1100'), 50_000);
    eq('…and the advance held falls by the same', await flatAdvanceBalance(SID, String(flatB._id)), advance - 50_000);

    const twice = await refuses(() => payRefund(SID, String(req1._id), approver));
    ok('a refund cannot be paid twice', /already paid/i.test(twice?.message || ''), twice?.message);

    const req2 = await requestRefund(SID, { flatId: String(flatB._id), amountPaise: 10_000, reason: 'Second thoughts' }, actor);
    const rejected = await rejectRefund(SID, String(req2._id), approver, 'Member changed their mind');
    eq('a refund can be rejected', rejected.status, 'REJECTED');
    eq('…with the reason kept', rejected.rejectionReason, 'Member changed their mind');
    const payRejected = await refuses(() => payRefund(SID, String(req2._id), approver));
    ok('a rejected refund cannot then be paid', /already rejected/i.test(payRejected?.message || ''), payRejected?.message);

    // With approval switched off, a refund pays out immediately rather than
    // leaving a pending row nobody will look at.
    policy.approvals.refundRequiresApproval = false;
    await policy.save();
    const direct = await requestRefund(SID, { flatId: String(flatB._id), amountPaise: 20_000, reason: 'Small balance returned' }, actor);
    eq('with approval off, a refund pays out at once', direct.status, 'PAID');
    ok('…and posts its voucher', !!direct.journalEntryId);

    eq('every refund is on the list', (await listRefunds(SID)).length, 3);

    // ---------------------------------------------------- simple vs compound interest
    // `lateFee.compounding` was declared, validated and shown in Settings, but
    // `computeInterest` never read it: interest was charged on total arrears,
    // which include the interest already levied. So the books compounded whatever
    // the policy said, while bye-laws commonly cap interest at 21% a year SIMPLE.
    console.log('\nSimple vs compound interest');
    const iSociety = new mongoose.Types.ObjectId();
    const iSid = iSociety.toString();
    extraSocieties.push(iSociety);
    await seedChartOfAccounts(iSid, actor.userId, actor.userName);
    const iPolicy = await getOrCreatePolicy(iSid, actor.userId, actor.userName);
    iPolicy.lateFee = { enabled: true, mode: 'PERCENT_PER_ANNUM', ratePercent: 12, graceDays: 0, compounding: 'SIMPLE', chargeHeadCode: '4140' } as any;
    iPolicy.billing.dueDays = 0;
    await iPolicy.save();
    const iBlock = new mongoose.Types.ObjectId();
    const [iFlat] = await Flat.create([{
      number: '901', blockName: 'Z', blockId: iBlock, societyId: iSociety, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    }]);
    await createChargeHead(iSid, { code: 'M', name: 'Maintenance', category: 'MAINTENANCE', pricingMode: 'UNIFORM', uniformAmountPaise: 100_000 }, actor);

    /** Bill one month and back-date it, so the next run sees it as overdue. */
    const billMonth = async (period: string, raisedOn: Date) => {
      await generateInvoicesForSociety(iSid, { period, flatIds: [String(iFlat._id)], triggeredByUserId: actor.userId, triggeredByName: actor.userName });
      await MaintenanceInvoice.updateOne({ societyId: iSociety, billingPeriod: period }, { $set: { invoiceDate: raisedOn, dueDate: raisedOn } });
      return MaintenanceInvoice.findOne({ societyId: iSociety, billingPeriod: period }).lean();
    };

    const apr = await billMonth('2026-04', new Date(2026, 3, 1));
    eq('month 1 is just the charge — nothing overdue yet', apr?.interestPaise, 0);
    eq('…and none of it is interest', apr?.interestOutstandingPaise, 0);

    const may = await billMonth('2026-05', new Date(2026, 4, 1));
    eq('month 2 charges 1% on the ₹1,000 owed', may?.interestPaise, 1_000);
    eq('…and the bill knows that ₹10 of it is penalty', may?.interestOutstandingPaise, 1_000);

    // By June two months are unpaid: April ₹1,000 and May ₹1,010 (₹1,000 dues +
    // ₹10 penalty). Arrears ₹2,010, of which ₹2,000 is dues.
    //   SIMPLE   → 1% of ₹2,000 = ₹20.00
    //   COMPOUND → 1% of ₹2,010 = ₹20.10   ← what the old code always charged
    const jun = await billMonth('2026-06', new Date(2026, 5, 1));
    eq('month 3 SIMPLE charges on the dues only, not on the penalty', jun?.interestPaise, 2_000);
    ok('…so it is NOT charging interest on interest', jun?.interestPaise !== 2_010,
      `charged ${rupees(jun?.interestPaise || 0)} — ₹20.10 would mean the penalty earned a penalty`);

    // Same books, same arrears, switched to COMPOUND: the number must move.
    iPolicy.lateFee.compounding = 'COMPOUND';
    await iPolicy.save();
    const jul = await billMonth('2026-07', new Date(2026, 6, 1));
    // Arrears by now: 1000 + 1000(may int) + 1000(jun charge) + 1000(jun int) = ₹40 → 4000 paise principal-ish;
    // the point is only that COMPOUND includes the penalty and SIMPLE does not.
    const julSimpleBase = await MaintenanceInvoice.find({ societyId: iSociety, billingPeriod: { $in: ['2026-04', '2026-05', '2026-06'] } }).lean();
    const totalArrears = julSimpleBase.reduce((s, i) => s + i.outstandingPaise, 0);
    const principalArrears = julSimpleBase.reduce((s, i) => s + (i.outstandingPaise - (i.interestOutstandingPaise || 0)), 0);
    ok('there is penalty sitting in the arrears', totalArrears > principalArrears, `${rupees(totalArrears)} vs ${rupees(principalArrears)}`);
    eq('COMPOUND charges on the whole arrears', jul?.interestPaise, Math.round(totalArrears * 12 / 100 / 12));
    ok('…which is more than SIMPLE would have charged', (jul?.interestPaise || 0) > Math.round(principalArrears * 12 / 100 / 12));

    // The switch has to actually move the number, or it is decoration.
    iPolicy.lateFee.compounding = 'SIMPLE';
    await iPolicy.save();
    const aug = await billMonth('2026-08', new Date(2026, 7, 1));
    const augRows = await MaintenanceInvoice.find({ societyId: iSociety, billingPeriod: { $in: ['2026-04', '2026-05', '2026-06', '2026-07'] } }).lean();
    const augPrincipal = augRows.reduce((s, i) => s + (i.outstandingPaise - (i.interestOutstandingPaise || 0)), 0);
    eq('back on SIMPLE, it charges on dues only again', aug?.interestPaise, Math.round(augPrincipal * 12 / 100 / 12));

    // ---------------------------------------------------- appropriation order
    console.log('\nWhich part a payment settles');
    const mayNow = await MaintenanceInvoice.findOne({ societyId: iSociety, billingPeriod: '2026-05' }).lean();
    // May: ₹1,000 dues + ₹10 penalty = ₹1,010 outstanding.
    eq('the May bill is dues plus penalty', mayNow?.outstandingPaise, 101_000);
    eq('…of which the penalty is ₹10', mayNow?.interestOutstandingPaise, 1_000);

    const { splitPayment } = await import('../services/allocation.util');
    const pf = splitPayment('PRINCIPAL_FIRST', 100_000, 101_000, 1_000);
    eq('paying ₹1,000 dues-first clears no penalty', pf.toInterestPaise, 0);
    eq('…and ₹1,000 of dues', pf.toPrincipalPaise, 100_000);
    const if_ = splitPayment('INTEREST_FIRST', 100_000, 101_000, 1_000);
    eq('paying ₹1,000 penalty-first clears the ₹10 penalty', if_.toInterestPaise, 1_000);
    eq('…and ₹990 of dues', if_.toPrincipalPaise, 99_000);
    const over = splitPayment('PRINCIPAL_FIRST', 200_000, 101_000, 1_000);
    eq('a payment bigger than the bill only takes what is owed', over.applyPaise, 101_000);
    eq('…and clears the penalty once the dues are gone', over.toInterestPaise, 1_000);

    // A real receipt must reduce both, and a bounce must put both back.
    const beforePay = await MaintenanceInvoice.findOne({ societyId: iSociety, billingPeriod: '2026-04' }).lean();
    const rec = await recordClearedReceipt(iSid, {
      flatId: String(iFlat._id), blockName: 'Z', flatNumber: '901',
      mode: 'CHEQUE', amountPaise: 50_000, source: 'ADMIN_WALKIN',
      instrument: { chequeNo: '9001', bankName: 'HDFC' },
      actor: { ...actor, role: 'SOCIETY_ADMIN' },
    });
    eq('the receipt records how much went to penalty', rec.allocations[0].appliedToInterestPaise, 0); // April has none
    await bounceReceipt(iSid, String(rec._id), actor, 'insufficient funds');
    const afterBounce = await MaintenanceInvoice.findOne({ societyId: iSociety, billingPeriod: '2026-04' }).lean();
    eq('a bounce restores the bill exactly', afterBounce?.outstandingPaise, beforePay?.outstandingPaise);
    eq('…including its penalty split', afterBounce?.interestOutstandingPaise, beforePay?.interestOutstandingPaise);

    const iTb = await trialBalance(iSid);
    ok('the interest ledger ties', iTb.balanced && iTb.drift.length === 0, JSON.stringify(iTb.drift));

    // ---------------------------------------------------- integrity
    console.log('\nLedger integrity');
    const final = await trialBalance(SID);
    ok('the ledger still ties', final.balanced, `Dr ${rupees(final.totalDebitPaise)} vs Cr ${rupees(final.totalCreditPaise)}`);
    ok('no account has drifted', final.drift.length === 0, JSON.stringify(final.drift));
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
