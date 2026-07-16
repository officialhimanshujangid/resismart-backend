/**
 * Phase C (fixed assets & depreciation) verification — real database, THROWAWAY
 * societyId, cleans up after itself. Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-phase-c-assets.ts
 *
 * Proves the register a Balance Sheet actually needs: SLM and WDV both compute to
 * a hand-checked figure, the voucher balances, a re-run of the same period
 * charges nothing, salvage is a floor nothing falls through, net book value ties
 * to cost − accumulated, and the ledger still ties afterwards.
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { FixedAsset } from '../models/fixed-asset.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createAsset, updateAsset, listAssets, depreciationPreview, runDepreciation } from '../services/fixed-assets.service';
import { trialBalance } from '../services/reports.service';

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

/** Run an operation expected to fail, returning its message ('' if it wrongly succeeded). */
const refuses = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return ''; } catch (e: any) { return e.message || 'error'; }
};

const iso = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();

async function cleanup() {
  await Promise.all([
    LedgerAccount.deleteMany({ societyId }), JournalEntry.deleteMany({ societyId }),
    FinancePolicy.deleteMany({ societyId }), FixedAsset.deleteMany({ societyId }),
    SequenceCounter.deleteMany({ societyId }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    await getOrCreatePolicy(SID, actor.userId, actor.userName);

    // ------------------------------------------------------ the golden case
    // Hand-calculated, deliberately over exactly 365 days so the day-fraction is
    // 1.0 and the arithmetic can be checked without a calculator.
    //
    //   Lift  — SLM, cost ₹10,00,000, salvage ₹1,00,000, 10% p.a.
    //           (1,00,00,000 − 10,00,000) × 10% × 365/365 = 9,00,000 paise = ₹9,000
    //   Pumps — WDV, cost ₹10,00,000, salvage ₹0, 10% p.a.
    //           (1,00,00,000 − 0) × 10% × 365/365 = 10,00,000 paise = ₹10,000
    //           ...and the NEXT 365 days charge on the written-down value:
    //           (1,00,00,000 − 10,00,000) × 10% = 9,00,000 paise = ₹9,000
    const PURCHASE = iso(2025, 4, 1);
    const YEAR_1 = iso(2026, 4, 1);   // exactly 365 days after purchase
    const YEAR_2 = iso(2027, 4, 1);   // a further 365 days

    console.log('Create the register');
    const lift = await createAsset(SID, {
      name: 'Lift — A Wing', assetAccountCode: '1510', purchaseDate: PURCHASE,
      costPaise: 100_000_000, salvageValuePaise: 10_000_000, method: 'SLM', ratePercent: 10, usefulLifeYears: 10,
    }, actor);
    const pumps = await createAsset(SID, {
      name: 'Water Pumps', assetAccountCode: '1520', purchaseDate: PURCHASE,
      costPaise: 100_000_000, salvageValuePaise: 0, method: 'WDV', ratePercent: 10,
    }, actor);
    eq('an asset starts with nothing written off', lift.accumulatedDepreciationPaise, 0);
    eq('...so its net book value is its cost', lift.netBookValuePaise, 100_000_000);
    eq('the asset account name is snapshotted', lift.assetAccountName, 'Lift & Elevators');

    const badAcct = await refuses(() => createAsset(SID, {
      name: 'Bad', assetAccountCode: '1590', costPaise: 1_000, method: 'SLM', ratePercent: 10,
    }, actor));
    ok('cost cannot be booked to the Accumulated Depreciation contra', /Asset account must be one of/.test(badAcct), badAcct);
    const badSalvage = await refuses(() => createAsset(SID, {
      name: 'Bad', assetAccountCode: '1500', costPaise: 1_000, salvageValuePaise: 1_000, method: 'SLM', ratePercent: 10,
    }, actor));
    ok('salvage at or above cost is rejected', /Salvage value must be less than cost/.test(badSalvage), badSalvage);

    // ------------------------------------------------------ preview
    console.log('\nDepreciation preview (year 1)');
    const pre = await depreciationPreview(SID, { upToDate: YEAR_1 });
    const preLift = pre.rows.find(r => r.assetId === lift._id)!;
    const prePumps = pre.rows.find(r => r.assetId === pumps._id)!;
    eq('the span is exactly 365 days', preLift.days, 365);
    eq('SLM: (cost − salvage) × 10% × 365/365 = ₹9,000', preLift.depreciationPaise, 9_000_000);
    eq('WDV: (cost − accumulated) × 10% × 365/365 = ₹10,000', prePumps.depreciationPaise, 10_000_000);
    eq('the preview totals both assets', pre.totalPaise, 19_000_000);
    eq('both assets are chargeable', pre.chargeable, 2);
    eq('the preview closes each asset at cost − this charge', preLift.closingNetBookValuePaise, 91_000_000);

    const beforeJournal = await JournalEntry.countDocuments({ societyId });
    eq('a preview posts nothing', beforeJournal, 0);
    eq('...and writes nothing to the asset',
      (await FixedAsset.findById(lift._id))!.accumulatedDepreciationPaise, 0);

    // ------------------------------------------------------ the run
    console.log('\nDepreciation run (year 1)');
    const run1 = await runDepreciation(SID, { upToDate: YEAR_1 }, actor);
    eq('the run posts', run1.posted, true);
    eq('the run charges what the preview promised', run1.totalPaise, pre.totalPaise);
    eq('both assets are charged', run1.assetsCharged, 2);

    const je = await JournalEntry.findById(run1.journalEntryId!);
    eq('ONE voucher for the whole run', await JournalEntry.countDocuments({ societyId }), 1);
    eq('the voucher balances', je!.totalDebitPaise, je!.totalCreditPaise);
    eq('...at the run total', je!.totalDebitPaise, 19_000_000);
    eq('Dr 5190 Depreciation', je!.lines.find(l => l.accountCode === '5190')?.debitPaise, 19_000_000);
    eq('Cr 1590 Accumulated Depreciation', je!.lines.find(l => l.accountCode === '1590')?.creditPaise, 19_000_000);

    const afterRun = await listAssets(SID);
    const liftA = afterRun.assets.find(a => a._id === lift._id)!;
    const pumpsA = afterRun.assets.find(a => a._id === pumps._id)!;
    eq('the lift carries its charge', liftA.accumulatedDepreciationPaise, 9_000_000);
    eq('the pumps carry theirs', pumpsA.accumulatedDepreciationPaise, 10_000_000);
    eq('net book value = cost − accumulated (lift)', liftA.netBookValuePaise, 100_000_000 - 9_000_000);
    eq('net book value = cost − accumulated (pumps)', pumpsA.netBookValuePaise, 100_000_000 - 10_000_000);
    eq('the register totals net book value across assets', afterRun.totals.netBookValuePaise, 181_000_000);
    eq('...and cost', afterRun.totals.costPaise, 200_000_000);
    eq('...and accumulated depreciation', afterRun.totals.accumulatedDepreciationPaise, 19_000_000);
    eq('the register ties to the 1590 ledger balance',
      afterRun.totals.accumulatedDepreciationPaise,
      (await trialBalance(SID)).rows.find(r => r.code === '1590')?.creditPaise);

    // ------------------------------------------------------ idempotency
    // The whole point. A committee member who clicks twice must not halve the
    // society's surplus.
    console.log('\nRunning the same period twice');
    const run2 = await runDepreciation(SID, { upToDate: YEAR_1 }, actor);
    eq('the second run charges nothing', run2.totalPaise, 0);
    eq('...posts no voucher', run2.posted, false);
    eq('...and no voucher appeared', await JournalEntry.countDocuments({ societyId }), 1);
    eq('...leaving accumulated depreciation untouched',
      (await FixedAsset.findById(lift._id))!.accumulatedDepreciationPaise, 9_000_000);
    const rePre = await depreciationPreview(SID, { upToDate: YEAR_1 });
    eq('the preview agrees there is nothing left to charge', rePre.totalPaise, 0);
    ok('...and says why in plain English',
      rePre.rows.every(r => r.skipReason === 'Already charged up to this date'),
      JSON.stringify(rePre.rows.map(r => r.skipReason)));

    // ------------------------------------------------------ year 2: WDV tapers
    console.log('\nDepreciation run (year 2)');
    const run3 = await runDepreciation(SID, { upToDate: YEAR_2 }, actor);
    const y2 = await listAssets(SID);
    const liftY2 = y2.assets.find(a => a._id === lift._id)!;
    const pumpsY2 = y2.assets.find(a => a._id === pumps._id)!;
    eq('SLM charges the same ₹9,000 again', liftY2.accumulatedDepreciationPaise, 18_000_000);
    // The taper is the whole difference between the two methods — if this equals
    // 10,00,000 again, WDV has silently become SLM.
    eq('WDV charges 10% of the written-down ₹9,00,000 = ₹9,000', pumpsY2.accumulatedDepreciationPaise, 19_000_000);
    eq('the second voucher balances', run3.totalPaise, 18_000_000);
    eq('only the un-charged span is charged (365 days, not 730)',
      run3.rows.find(r => r.assetId === lift._id)?.days, 365);

    // ------------------------------------------------------ the salvage floor
    console.log('\nSalvage floor');
    // A tiny asset left un-charged long enough to blow straight past salvage in
    // one run: cost ₹1,000, salvage ₹200, 100% p.a., never charged since it was
    // bought two years ago. Uncapped that is ₹800 × 730/365 = ₹1,600 — more than
    // the asset is worth, handing the society a negative asset.
    const stool = await createAsset(SID, {
      name: 'Office Stool', assetAccountCode: '1530', purchaseDate: PURCHASE,
      costPaise: 100_000, salvageValuePaise: 20_000, method: 'SLM', ratePercent: 100,
    }, actor);
    const floorPre = await depreciationPreview(SID, { upToDate: YEAR_2 });
    const stoolPre = floorPre.rows.find(r => r.assetId === stool._id)!;
    eq('the charge is capped at cost − salvage, not the raw formula', stoolPre.depreciationPaise, 80_000);
    eq('...leaving the asset at exactly its salvage value', stoolPre.closingNetBookValuePaise, 20_000);
    await runDepreciation(SID, { upToDate: YEAR_2 }, actor);
    const stoolAfter = (await listAssets(SID)).assets.find(a => a._id === stool._id)!;
    eq('the posted charge honours the floor', stoolAfter.accumulatedDepreciationPaise, 80_000);
    eq('...and the asset rests at salvage, never below', stoolAfter.netBookValuePaise, 20_000);
    ok('accumulated never exceeds cost − salvage',
      stoolAfter.accumulatedDepreciationPaise <= stoolAfter.costPaise - stoolAfter.salvageValuePaise);

    const exhausted = await runDepreciation(SID, { upToDate: iso(2030, 4, 1) }, actor);
    const stoolRow = exhausted.rows.find(r => r.assetId === stool._id)!;
    eq('a fully-depreciated asset charges nothing thereafter', stoolRow.depreciationPaise, 0);
    eq('...and says so', stoolRow.skipReason, 'Fully depreciated');
    const stoolFinal = (await listAssets(SID)).assets.find(a => a._id === stool._id)!;
    eq('...and stays at salvage however long the run', stoolFinal.netBookValuePaise, 20_000);

    // ------------------------------------------------------ edits
    console.log('\nEditing an asset');
    // Read the lift's accumulated rather than hard-coding it: the runs above have
    // moved it on, and an edit test should assert that editing changes nothing,
    // not restate a figure the earlier runs own.
    const liftBeforeEdit = (await listAssets(SID)).assets.find(a => a._id === lift._id)!;
    const shrink = await refuses(() => updateAsset(SID, lift._id, { costPaise: 20_000_000 }));
    ok('cost cannot be revised below what is already written off',
      /has already been charged/.test(shrink), shrink);
    const renamed = await updateAsset(SID, lift._id, { name: 'Lift — A Wing (Otis)' });
    eq('an asset can be renamed', renamed.name, 'Lift — A Wing (Otis)');
    eq('...without disturbing its accumulated depreciation',
      renamed.accumulatedDepreciationPaise, liftBeforeEdit.accumulatedDepreciationPaise);

    // ------------------------------------------------------ the ledger still ties
    // Depreciation is the only entry here that touches the GL, so if the register
    // can break the books, it breaks them on this line.
    console.log('\nLedger integrity');
    const tb = await trialBalance(SID);
    eq('the trial balance is balanced', tb.balanced, true);
    eq('...with no cache drift', tb.drift.length, 0);
    eq('...and no drift value', tb.driftTotalPaise, 0);
    const dep = tb.rows.find(r => r.code === '5190');
    const acc = tb.rows.find(r => r.code === '1590');
    eq('total depreciation expense = total accumulated depreciation', dep?.debitPaise, acc?.creditPaise);
    const register = await listAssets(SID);
    eq('the register still ties to the ledger after every run',
      register.totals.accumulatedDepreciationPaise, acc?.creditPaise);

    // ------------------------------------------------------ FE⇄BE contract
    // The assets page consumes these payloads as `any`, so a renamed field would
    // surface as a blank column in front of a treasurer, not as a type error.
    console.log('\nFrontend contract');
    const has = (o: any, path: string) => path.split('.').every((p, i, a) => {
      const v = a.slice(0, i + 1).reduce((x: any, k) => x?.[k], o);
      return v !== undefined;
    });
    const listPaths = ['assets', 'totals.costPaise', 'totals.accumulatedDepreciationPaise', 'totals.netBookValuePaise', 'totals.count'];
    ok('the register returns every field the page reads',
      listPaths.every(p => has(register, p)), `missing: ${listPaths.filter(p => !has(register, p)).join(', ')}`);
    ok('asset rows carry name/cost/accumulated/NBV/method/rate', register.assets.every((a: any) =>
      a.name !== undefined && a.costPaise !== undefined && a.accumulatedDepreciationPaise !== undefined
      && a.netBookValuePaise !== undefined && a.method !== undefined && a.ratePercent !== undefined));
    const previewPaths = ['upToDate', 'rows', 'chargeable', 'skipped', 'totalPaise'];
    ok('the preview returns every field the dialog reads',
      previewPaths.every(p => has(rePre, p)), `missing: ${previewPaths.filter(p => !has(rePre, p)).join(', ')}`);
    ok('preview rows carry name/days/charge/closing NBV', rePre.rows.every((r: any) =>
      r.name !== undefined && r.days !== undefined && r.depreciationPaise !== undefined
      && r.closingNetBookValuePaise !== undefined));
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
