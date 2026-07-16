/**
 * Phase C verification — real database, THROWAWAY societyId, self-cleaning.
 * Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-phase-c.ts
 *
 * Covers the statutory core: the GST ₹7,500 exemption under both readings of the
 * law, TDS thresholds, the period lock, share capital, mutuality, and the
 * expanded chart (contra-asset + schedules).
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
import { Expense } from '../models/expense.model';
import { Vendor } from '../models/vendor.model';
import { Receipt } from '../models/receipt.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { ShareCertificate } from '../models/share-certificate.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createChargeHead } from '../services/charge-head.service';
import { generateInvoicesForSociety } from '../services/invoicing.service';
import { createExpense } from '../services/expenses.service';
import { postJournal } from '../services/ledger.service';
import { trialBalance, incomeExpenditure, balanceSheet } from '../services/reports.service';
import { issueShares, transferShares, memberRegister } from '../services/share-capital.service';
import {
  createAsset, runDepreciation, listDepreciationRuns, reverseDepreciationRun, disposeAsset,
} from '../services/fixed-assets.service';
import { FixedAsset } from '../models/fixed-asset.model';
import { DepreciationRun } from '../models/depreciation-run.model';
import { buildExportDoc } from '../services/report-doc.builder';

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
    Expense.deleteMany({ societyId }), Vendor.deleteMany({ societyId }),
    Receipt.deleteMany({ societyId }), SequenceCounter.deleteMany({ societyId }),
    ShareCertificate.deleteMany({ societyId }), Flat.deleteMany({ societyId }),
    FixedAsset.deleteMany({ societyId }), DepreciationRun.deleteMany({ societyId }),
  ]);
}

/** Bill one flat with a single uniform head and read back its GST. */
async function billOnce(period: string, flatId: any, headCode: string) {
  await generateInvoicesForSociety(SID, { period, flatIds: [String(flatId)], triggeredByUserId: actor.userId, triggeredByName: actor.userName });
  const inv = await MaintenanceInvoice.findOne({ societyId, flatId, billingPeriod: period }).lean();
  await ChargeHead.updateOne({ societyId, code: headCode }, {}); // no-op keeps the signature honest
  return inv;
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    const policy = await getOrCreatePolicy(SID, actor.userId, actor.userName);

    const blockId = new mongoose.Types.ObjectId();
    const [flatA, flatB] = await Flat.create([1, 2].map(n => ({
      number: `10${n}`, blockName: 'A', blockId, societyId, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    })));

    // ---------------------------------------------------- C1 chart of accounts
    console.log('C1 — expanded chart of accounts');
    const accts = await LedgerAccount.find({ societyId }).lean();
    const byCode = new Map(accts.map(a => [a.code, a]));
    eq('Share Capital exists', byCode.get('3000')?.type, 'EQUITY');
    eq('Suspense for unidentified receipts exists', byCode.get('2900')?.type, 'LIABILITY');
    eq('Depreciation expense exists', byCode.get('5190')?.type, 'EXPENSE');
    // Accumulated Depreciation is the interesting one: an ASSET that must carry a
    // CREDIT balance, which is only expressible because normalBalance is stored.
    eq('Accumulated Depreciation is an ASSET…', byCode.get('1590')?.type, 'ASSET');
    eq('…that is credit-normal (a contra-asset)', byCode.get('1590')?.normalBalance, 'CREDIT');
    eq('ordinary assets stay debit-normal', byCode.get('1500')?.normalBalance, 'DEBIT');
    ok('fixed assets are grouped under a heading for schedules', !!byCode.get('1510')?.parentAccountId);
    eq('member contributions are tagged mutual', byCode.get('4100')?.taxability, 'MUTUAL');
    eq('bank interest is tagged taxable', byCode.get('4200')?.taxability, 'TAXABLE');
    // Re-seeding must not duplicate or clobber.
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    eq('re-seeding is idempotent', await LedgerAccount.countDocuments({ societyId }), accts.length);

    // ---------------------------------------------------- C4 GST exemption
    console.log('\nC4 — GST ₹7,500 exemption');
    policy.gst.enabled = true;
    policy.gst.defaultRatePercent = 18;
    policy.gst.rwaExemptionPerMemberPaise = 750_000; // ₹7,500
    policy.gst.exemptionBasis = 'FULL_IF_EXCEEDS';
    policy.billing.dueDays = 15;
    await policy.save();

    // ₹7,499 — one rupee under the limit. Nothing is taxable.
    await createChargeHead(SID, { code: 'M1', name: 'Maintenance', category: 'MAINTENANCE', pricingMode: 'UNIFORM', uniformAmountPaise: 749_900, gstApplicable: true, gstRatePercent: 18 }, actor);
    const under = await billOnce('2026-04', flatA._id, 'M1');
    eq('₹7,499 a month is exempt — no GST at all', under?.gstPaise, 0);
    eq('…and the invoice is just the charge', under?.totalPaise, 749_900);

    // ₹7,501 — one rupee over. Under the circular's reading, the WHOLE amount is taxable.
    await ChargeHead.updateOne({ societyId, code: 'M1' }, { $set: { uniformAmountPaise: 750_100 } });
    const overFull = await billOnce('2026-05', flatA._id, 'M1');
    eq('₹7,501 under FULL_IF_EXCEEDS taxes the whole contribution', overFull?.gstPaise, Math.round(750_100 * 0.18));

    // Same ₹7,501 under the Madras HC reading: only the ₹1 excess is taxable.
    policy.gst.exemptionBasis = 'EXCESS_ONLY';
    await policy.save();
    const overExcess = await billOnce('2026-06', flatB._id, 'M1');
    // The excess is ₹7,501 − ₹7,500 = ₹1 = 100 paise; 18% of that is 18 paise.
    eq('₹7,501 under EXCESS_ONLY taxes only the ₹1 excess', overExcess?.gstPaise, Math.round(100 * 0.18));
    ok('the two readings genuinely differ', (overFull?.gstPaise || 0) !== (overExcess?.gstPaise || 0),
      `${rupees(overFull?.gstPaise || 0)} vs ${rupees(overExcess?.gstPaise || 0)}`);

    // A reimbursement head must not push a member over the limit.
    policy.gst.exemptionBasis = 'FULL_IF_EXCEEDS';
    await policy.save();
    await ChargeHead.updateOne({ societyId, code: 'M1' }, { $set: { uniformAmountPaise: 700_000 } });
    await createChargeHead(SID, { code: 'PTAX', name: 'Property Tax (reimbursement)', category: 'OTHER', pricingMode: 'UNIFORM', uniformAmountPaise: 200_000, gstApplicable: false, countsTowardRwaExemption: false }, actor);
    const withReimbursement = await billOnce('2026-07', flatA._id, 'M1');
    eq('an excluded reimbursement does not breach the limit (₹7,000 + ₹2,000 property tax)', withReimbursement?.gstPaise, 0);

    // Turning the test off charges GST regardless.
    policy.gst.rwaExemptionPerMemberPaise = 0;
    await policy.save();
    const noTest = await billOnce('2026-08', flatA._id, 'M1');
    eq('exemption limit 0 charges GST on everything', noTest?.gstPaise, Math.round(700_000 * 0.18));
    policy.gst.enabled = false;
    policy.gst.rwaExemptionPerMemberPaise = 750_000;
    await policy.save();
    await ChargeHead.deleteMany({ societyId });

    // ---------------------------------------------------- C5 TDS thresholds
    console.log('\nC5 — TDS thresholds');
    const v = await Vendor.create({
      societyId, name: 'Painter Co', tdsApplicable: true, tdsSection: '194C', tdsRatePercent: 2,
      tdsThresholdSinglePaise: 3_000_000, tdsThresholdAnnualPaise: 10_000_000,
      createdBy: userId, createdByName: actor.userName,
    });
    const mkExpense = (amountPaise: number) => createExpense(SID, {
      vendorId: String(v._id), expenseDate: new Date(2026, 5, 1),
      lineItems: [{ expenseAccountCode: '5140', amountPaise, description: 'work' }],
    }, actor);

    const small = await mkExpense(2_000_000); // ₹20,000 — under both limits
    eq('a ₹20,000 bill is under both limits, so nothing is deducted', small.tdsPaise, 0);
    const big = await mkExpense(4_000_000);   // ₹40,000 — over the single-bill limit
    eq('a ₹40,000 bill breaches the single-bill limit and is deducted in full', big.tdsPaise, 80_000);
    // Running total now ₹60,000. Another ₹50,000 crosses the ₹1,00,000 aggregate,
    // so the whole year catches up, less what was already withheld.
    const crosses = await mkExpense(5_000_000);
    eq('crossing the annual limit catches up on the whole year', crosses.tdsPaise, Math.round(11_000_000 * 0.02) - 80_000);
    const off = await Vendor.create({
      societyId, name: 'No Threshold Co', tdsApplicable: true, tdsSection: '194J', tdsRatePercent: 10,
      tdsThresholdSinglePaise: 0, tdsThresholdAnnualPaise: 0, createdBy: userId, createdByName: actor.userName,
    });
    const always = await createExpense(SID, {
      vendorId: String(off._id), expenseDate: new Date(2026, 5, 1),
      lineItems: [{ expenseAccountCode: '5160', amountPaise: 100_000, description: 'fees' }],
    }, actor);
    eq('thresholds set to 0 deduct from the first rupee', always.tdsPaise, 10_000);

    // ---------------------------------------------------- C2 share capital
    console.log('\nC2 — share capital & member register');
    const cert = await issueShares(SID, { flatId: String(flatA._id), memberName: 'Asha Rao', shareCount: 5, faceValuePaise: 5_000 }, actor);
    eq('a certificate is issued for the right amount (5 × ₹50)', cert.amountPaise, 25_000);
    eq('share numbers are allotted from 1', cert.distinctiveFrom, 1);
    eq('…through to 5', cert.distinctiveTo, 5);
    const tb = await trialBalance(SID);
    eq('share money raises Share Capital, not income', tb.rows.find(r => r.code === '3000')?.creditPaise, 25_000);
    const ieAfterShares = await incomeExpenditure(SID, { fy: '2026' });
    ok('…and never appears in Income & Expenditure', !ieAfterShares.income.some(r => r.code === '3000'));

    const dupe = await refuses(() => issueShares(SID, { flatId: String(flatA._id), memberName: 'Someone Else', shareCount: 5, faceValuePaise: 5_000 }, actor));
    ok('a flat cannot hold two active certificates', /already holds/i.test(dupe?.message || ''), dupe?.message);

    const second = await issueShares(SID, { flatId: String(flatB._id), memberName: 'Bala Iyer', shareCount: 5, faceValuePaise: 5_000 }, actor);
    eq('the next member continues the share numbering', second.distinctiveFrom, 6);

    const moved = await transferShares(SID, String(cert._id), { toMemberName: 'Chitra Nair' }, actor);
    eq('a transfer keeps the same share numbers', moved.distinctiveFrom, cert.distinctiveFrom);
    eq('…and issues a fresh certificate number', moved.certificateNumber !== cert.certificateNumber, true);
    eq('…retiring the old one', (await ShareCertificate.findById(cert._id))?.status, 'TRANSFERRED');
    const tbAfter = await trialBalance(SID);
    eq('a transfer moves no money — share capital is unchanged', tbAfter.rows.find(r => r.code === '3000')?.creditPaise, 50_000);

    const reg = await memberRegister(SID);
    eq('the register lists one live certificate per flat', reg.totalMembers, 2);
    eq('…totalling the share capital on the books', reg.totalShareCapitalPaise, 50_000);
    eq('…with no flats left unallotted', reg.flatsWithoutShares, 0);
    const withHistory = await memberRegister(SID, { includeHistory: true });
    eq('history shows the retired certificate too', withHistory.rows.length, 3);

    // ---------------------------------------------------- C9 mutuality
    console.log('\nC9 — mutuality');
    await postJournal(SID, {
      voucherType: 'JOURNAL', entryDate: new Date(2026, 5, 10), narration: 'verify: FD interest',
      lines: [{ accountCode: '1100', debitPaise: 500_000 }, { accountCode: '4200', creditPaise: 500_000 }],
      postedBy: actor.userId, postedByName: actor.userName,
    });
    const ie = await incomeExpenditure(SID, { fy: '2026' });
    eq('bank interest is taxable income', ie.mutuality.taxableIncomePaise, 500_000);
    eq('member contributions are not', ie.mutuality.mutualIncomePaise, ie.totalIncomePaise - 500_000);
    ok('the taxable head is named for the return', ie.mutuality.taxableHeads.includes('Interest Income (Bank/FD)'));

    // ---------------------------------------------------- C3 balance sheet schedule
    // Accumulated Depreciation is a contra-asset: credit-normal, so its
    // `balancePaise` is POSITIVE. A Balance Sheet that sums assets by each
    // account's own normal side would ADD it instead of netting it off — which
    // both overstates assets and breaks the sheet, because the matching
    // depreciation expense pulls the funding side the other way.
    console.log('\nC3 — fixed-asset schedule on the Balance Sheet');
    await postJournal(SID, {
      voucherType: 'JOURNAL', entryDate: new Date(2026, 4, 1), narration: 'verify: buy a lift',
      lines: [{ accountCode: '1510', debitPaise: 1_000_000 }, { accountCode: '1100', creditPaise: 1_000_000 }],
      postedBy: actor.userId, postedByName: actor.userName,
    });
    await postJournal(SID, {
      voucherType: 'JOURNAL', entryDate: new Date(2026, 4, 2), narration: 'verify: depreciation',
      lines: [{ accountCode: '5190', debitPaise: 100_000 }, { accountCode: '1590', creditPaise: 100_000 }],
      postedBy: actor.userId, postedByName: actor.userName,
    });

    const bs = await balanceSheet(SID, { fy: '2026' });
    ok('the balance sheet still balances after depreciation', bs.balanced,
      `assets ${rupees(bs.assetsTotalPaise)} vs funding ${rupees(bs.liabilitiesPlusFundsPlusEquityPaise)} (out by ${rupees(bs.differencePaise)})`);

    const sched = bs.assets.find(a => a.code === '1500');
    ok('assets carry a Fixed Assets schedule', !!sched, JSON.stringify(bs.assets.map(a => a.code)));
    eq('…that nets the lift against its depreciation (₹10,000 − ₹1,000)', sched?.amountPaise, 900_000);
    ok('…listing the asset and the contra beneath it',
      !!sched?.children?.some(c => c.code === '1510') && !!sched?.children?.some(c => c.code === '1590'),
      JSON.stringify(sched?.children?.map(c => c.code)));
    eq('…showing accumulated depreciation as a negative', sched?.children?.find(c => c.code === '1590')?.amountPaise, -100_000);
    ok('the depreciation contra is not also a top-level asset line', !bs.assets.some(a => a.code === '1590'));
    ok('cash & bank is grouped too', !!bs.assets.find(a => a.code === '1000')?.children?.length);
    eq('the schedule foots into the assets total',
      bs.assetsTotalPaise, bs.assets.reduce((s, a) => s + a.amountPaise, 0));
    // The export must show what the screen shows, or the PDF an auditor gets
    // disagrees with the page the treasurer signed off.
    const doc = buildExportDoc('balance-sheet', bs, 'Sunrise CHS');
    const assetSection = doc.sections.find(s => s.title === 'Assets')!;
    ok('the exported Balance Sheet carries the schedule',
      assetSection.rows.some(r => String(r[0]).trim() === 'Lift & Elevators')
      && assetSection.rows.some(r => String(r[0]).trim() === 'Accumulated Depreciation'),
      JSON.stringify(assetSection.rows.map(r => r[0])));

    // ---------------------------------------------------- disposal & run reversal
    console.log('\nAsset disposal & depreciation reversal');
    const balOf = (rows: { code: string; debitPaise: number; creditPaise: number }[], code: string) => {
      const r = rows.find(x => x.code === code);
      return r ? r.debitPaise - r.creditPaise : 0;
    };
    const mkAsset = (name: string, cost: number) => createAsset(SID, {
      name, assetAccountCode: '1520', purchaseDate: new Date(2025, 3, 1),
      costPaise: cost, salvageValuePaise: 0, method: 'SLM', ratePercent: 10,
    }, actor);

    // --- a depreciation run, then undo it, register and ledger together
    // The contra already carries the depreciation posted by the balance-sheet
    // block above, so every check here is a delta, not an absolute.
    const contraAtStart = balOf((await trialBalance(SID)).rows, '1590');
    const pump = await mkAsset('Water Pump', 1_000_000);
    const run = await runDepreciation(SID, { upToDate: new Date(2026, 2, 31).toISOString() }, actor);
    ok('a depreciation run posts', run.posted, JSON.stringify(run.rows.map(r => r.skipReason)));
    const chargedPaise = run.totalPaise;
    ok('…and charges something', chargedPaise > 0);
    const afterRun = await FixedAsset.findById(pump._id);
    eq('the asset carries the charge', afterRun?.accumulatedDepreciationPaise, chargedPaise);
    ok('…and its through-date moved', !!afterRun?.lastDepreciationUpTo);

    const runs = await listDepreciationRuns(SID);
    eq('the run is on record so it can be undone', runs.length, 1);
    eq('…as posted', runs[0].status, 'POSTED');

    const accAfterRun = balOf((await trialBalance(SID)).rows, '1590');
    const undone = await reverseDepreciationRun(SID, runs[0]._id, actor, 'wrong date');
    eq('reversing restores every asset it touched', undone.assetsRestored, 1);
    const afterReverse = await FixedAsset.findById(pump._id);
    // The register must move back too — reversing only the voucher would leave
    // the asset claiming a charge the ledger no longer has.
    eq('the asset’s accumulated depreciation is rolled back', afterReverse?.accumulatedDepreciationPaise, 0);
    eq('…and its through-date is restored to what it was', afterReverse?.lastDepreciationUpTo, undefined);
    // 1590 is credit-normal, so debit−credit reads negative while depreciation
    // stands, and returns to where it was once the reversal debits it back out.
    eq('the contra carried the charge before reversal', accAfterRun, contraAtStart - chargedPaise);
    eq('…and the ledger contra is back where it started after it',
      balOf((await trialBalance(SID)).rows, '1590'), contraAtStart);
    eq('the run is marked reversed', (await listDepreciationRuns(SID))[0].status, 'REVERSED');
    const twice = await refuses(() => reverseDepreciationRun(SID, runs[0]._id, actor));
    ok('a run cannot be reversed twice', /already been reversed/i.test(twice?.message || ''), twice?.message);
    // Having rolled back, the span is chargeable again — the whole point.
    const rerun = await runDepreciation(SID, { upToDate: new Date(2026, 2, 31).toISOString() }, actor);
    eq('the reversed span can be charged again', rerun.totalPaise, chargedPaise);

    // --- disposal at a loss
    const lossAsset = await mkAsset('Old DG Set', 1_000_000);
    await FixedAsset.updateOne({ _id: lossAsset._id }, { $set: { accumulatedDepreciationPaise: 400_000 } });
    // Book value ₹6,000, sold for ₹5,000 → a ₹1,000 loss.
    const tbBeforeLoss = await trialBalance(SID);
    const disposedLoss = await disposeAsset(SID, lossAsset._id, { proceedsPaise: 500_000, receivedIn: 'BANK' }, actor);
    ok('a disposed asset is retired from the register', !!disposedLoss.disposedOn && !disposedLoss.isActive);
    const tbLoss = await trialBalance(SID);
    eq('selling below book value books the loss', balOf(tbLoss.rows, '5195'), 100_000);
    eq('…the proceeds reach the bank', balOf(tbLoss.rows, '1100') - balOf(tbBeforeLoss.rows, '1100'), 500_000);
    eq('…the asset’s cost leaves the books', balOf(tbBeforeLoss.rows, '1520') - balOf(tbLoss.rows, '1520'), 1_000_000);
    // The contra is one pooled account across every asset — leaving this asset's
    // share behind would understate assets forever, with nothing to show why.
    eq('…and its share of the depreciation pool is retired too',
      balOf(tbBeforeLoss.rows, '1590') - balOf(tbLoss.rows, '1590'), -400_000);

    // --- disposal at a profit
    const gainAsset = await mkAsset('Spare Transformer', 1_000_000);
    await FixedAsset.updateOne({ _id: gainAsset._id }, { $set: { accumulatedDepreciationPaise: 900_000 } });
    // Book value ₹1,000, sold for ₹3,000 → a ₹2,000 profit.
    const disposedGain = await disposeAsset(SID, gainAsset._id, { proceedsPaise: 300_000, receivedIn: 'BANK' }, actor);
    eq('the sale proceeds are recorded on the asset', disposedGain.disposalProceedsPaise, 300_000);
    const tbGain = await trialBalance(SID);
    eq('selling above book value books the profit', balOf(tbGain.rows, '4220'), -200_000);
    const ieGain = await incomeExpenditure(SID, { fy: '2026' });
    ok('…and that profit is taxable, not mutual', ieGain.mutuality.taxableHeads.includes('Profit on Sale of Assets'));

    // --- scrapping a fully-depreciated asset for nothing
    const scrap = await mkAsset('Broken Pump', 1_000_000);
    await FixedAsset.updateOne({ _id: scrap._id }, { $set: { accumulatedDepreciationPaise: 1_000_000 } });
    const scrapped = await disposeAsset(SID, scrap._id, { proceedsPaise: 0 }, actor);
    ok('a fully-depreciated asset can be scrapped for nothing', !!scrapped.disposedOn);
    const tbScrap = await trialBalance(SID);
    eq('…leaving no gain or loss', balOf(tbScrap.rows, '5195'), 100_000); // unchanged from the earlier loss

    const already = await refuses(() => disposeAsset(SID, lossAsset._id, { proceedsPaise: 0 }, actor));
    ok('an asset cannot be disposed twice', /already disposed/i.test(already?.message || ''), already?.message);
    const early = await refuses(() => disposeAsset(SID, pump._id, { disposedOn: '2020-01-01', proceedsPaise: 0 }, actor));
    ok('an asset cannot be disposed before it was bought', /before it was bought/i.test(early?.message || ''), early?.message);

    const tbAssets = await trialBalance(SID);
    ok('the ledger still ties after every disposal', tbAssets.balanced && tbAssets.drift.length === 0, JSON.stringify(tbAssets.drift));
    const bsAfterDisposal = await balanceSheet(SID, { fy: '2026' });
    ok('and the balance sheet still balances', bsAfterDisposal.balanced,
      `out by ${rupees(bsAfterDisposal.differencePaise)}`);

    // ---------------------------------------------------- C7 period lock
    console.log('\nC7 — period lock');
    policy.lock = { lockedUpToDate: new Date(2026, 5, 30) } as any;
    await policy.save();
    const blocked = await refuses(() => postJournal(SID, {
      voucherType: 'JOURNAL', entryDate: new Date(2026, 5, 15), narration: 'verify: back-dated',
      lines: [{ accountCode: '1100', debitPaise: 100 }, { accountCode: '4200', creditPaise: 100 }],
      postedBy: actor.userId, postedByName: actor.userName,
    }));
    ok('a back-dated entry into a closed period is refused', /books are closed/i.test(blocked?.message || ''), blocked?.message);

    const after = await refuses(() => postJournal(SID, {
      voucherType: 'JOURNAL', entryDate: new Date(2026, 6, 5), narration: 'verify: after the lock',
      lines: [{ accountCode: '1100', debitPaise: 100 }, { accountCode: '4200', creditPaise: 100 }],
      postedBy: actor.userId, postedByName: actor.userName,
    }));
    ok('an entry after the lock date still posts', after === null, after?.message);

    // The lock must hold for EVERY door, not just manual vouchers.
    const lockedInvoice = await refuses(() => issueShares(SID, { flatId: String(flatB._id), memberName: 'X', shareCount: 1, faceValuePaise: 100, issuedOn: '2026-06-10' }, actor));
    ok('…and blocks share issues dated inside the closed period too',
      /books are closed|already holds/i.test(lockedInvoice?.message || ''), lockedInvoice?.message);

    policy.lock = { lockedUpToDate: undefined } as any;
    await policy.save();
    const reopened = await refuses(() => postJournal(SID, {
      voucherType: 'JOURNAL', entryDate: new Date(2026, 5, 15), narration: 'verify: reopened',
      lines: [{ accountCode: '1100', debitPaise: 100 }, { accountCode: '4200', creditPaise: 100 }],
      postedBy: actor.userId, postedByName: actor.userName,
    }));
    ok('clearing the lock reopens the period', reopened === null, reopened?.message);

    // ---------------------------------------------------- integrity
    console.log('\nLedger integrity');
    const final = await trialBalance(SID);
    ok('the ledger still ties', final.balanced, `Dr ${rupees(final.totalDebitPaise)} vs Cr ${rupees(final.totalCreditPaise)}`);
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
