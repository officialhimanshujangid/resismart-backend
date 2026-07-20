/**
 * Finance module toggles. Real database, THROWAWAY societyIds, self-cleaning.
 * Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-modules.ts
 *
 * The dangerous behaviour here is the inference: get it wrong and a society that
 * has been using a screen for a year finds it gone.
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { FinancePolicy } from '../models/finance-policy.model';
import { FinanceFund } from '../models/finance-fund.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { ShareCertificate } from '../models/share-certificate.model';
import { FixedAsset } from '../models/fixed-asset.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { OPS_MODULES } from '../models/society-ops-policy.model';
import { DEFAULT_MODULES as DEFAULT_OPS_MODULES } from '../services/ops-policy.service';
import { Flat, FlatStatus } from '../models/flat.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { postJournal } from '../services/ledger.service';
import { createFund } from '../services/funds.service';
import { issueShares } from '../services/share-capital.service';
import {
  resolveModules, hasModule, DEFAULT_MODULES, MODULE_CATALOG, FINANCE_MODULES,
} from '../services/finance-modules.service';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Read the finance nav out of the frontend's sidebar as text.
 *
 * The backend can't import a .tsx, but this contract is worth asserting anyway:
 * a typo in a `financeModule` key is invisible to both compilers and means a
 * screen a society switched ON never appears. Parsing the source is ugly; a
 * silently missing menu item is uglier.
 */
function getSidebarFinanceModules(): { tagged: string[]; untagged: string[] } {
  const file = path.resolve(__dirname, '../../../frontend/src/components/layout/sidebarContent.tsx');
  const src = fs.readFileSync(file, 'utf8');
  const tagged: string[] = [];
  const untagged: string[] = [];
  for (const line of src.split('\n')) {
    if (!line.includes("href: '/dashboard/finance/")) continue;
    const label = /label:\s*'([^']+)'/.exec(line)?.[1];
    const mod = /financeModule:\s*'([^']+)'/.exec(line)?.[1];
    if (!label) continue;
    if (mod) tagged.push(mod); else untagged.push(label);
  }
  return { tagged, untagged };
}

/**
 * The same scrape, for the OPERATIONS side of the menu.
 *
 * Written after a real fault: Staff, Complaints and Equipment were all built,
 * verified and shipped, and an admin signing in could not find any of them —
 * their modules were off by default and the sidebar filtered them away. The
 * finance half of this file had an equivalent assertion; the ops half did not,
 * so nothing noticed.
 */
function getSidebarOpsModules(): { tagged: string[]; ungated: string[] } {
  const file = path.resolve(__dirname, '../../../frontend/src/components/layout/sidebarContent.tsx');
  const src = fs.readFileSync(file, 'utf8');
  // Scanned across the WHOLE file rather than line by line: the finance
  // entries happen to be one-liners, but Complaints, Staff and Equipment are
  // multi-line objects with `label` and `opsModule` several lines apart. A
  // per-line scraper silently sees none of them — and an assertion that
  // silently checks nothing is worse than no assertion, because it reads as
  // coverage.
  const tagged = [...src.matchAll(/opsModule:\s*'([^']+)'/g)].map(m => m[1]);

  // Ungated: an ops screen whose own line carries no opsModule. Only used for
  // the settings door, which is deliberately a one-liner so this stays simple.
  const ungated: string[] = [];
  for (const line of src.split('\n')) {
    const label = /label:\s*'([^']+)'/.exec(line)?.[1];
    if (!label || /opsModule:/.test(line)) continue;
    if (/href:\s*'\/dashboard\/(gate|staff|complaints|assets)/.test(line)) ungated.push(label);
  }
  return { tagged, ungated };
}

const userId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const societies: mongoose.Types.ObjectId[] = [];

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/** A fresh throwaway society with a seeded chart, tracked for cleanup. */
async function newSociety() {
  const id = new mongoose.Types.ObjectId();
  societies.push(id);
  await seedChartOfAccounts(id.toString(), actor.userId, actor.userName);
  await getOrCreatePolicy(id.toString(), actor.userId, actor.userName);
  return id.toString();
}

async function cleanup() {
  const q = { societyId: { $in: societies } };
  await Promise.all([
    FinancePolicy.deleteMany(q), FinanceFund.deleteMany(q), LedgerAccount.deleteMany(q),
    JournalEntry.deleteMany(q), ShareCertificate.deleteMany(q), FixedAsset.deleteMany(q),
    SequenceCounter.deleteMany(q), Flat.deleteMany(q),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log('Connected.\n');

  try {
    // ------------------------------------------------- a brand-new society
    console.log('A brand-new society');
    const fresh = await newSociety();
    const freshModules = await resolveModules(fresh);
    eq('gets the basic set, nothing more', JSON.stringify([...freshModules].sort()), JSON.stringify([...DEFAULT_MODULES].sort()));
    ok('…which does not include shares', !freshModules.includes('SHARES'));
    ok('…or bank reconciliation', !freshModules.includes('BANKING'));
    ok('…or the full accounting tools', !freshModules.includes('ACCOUNTING'));
    ok('expenses are on — every society spends', freshModules.includes('EXPENSES'));

    // The answer is persisted, so it is stable rather than recomputed each read.
    const persisted = await FinancePolicy.findOne({ societyId: fresh }).select('modules').lean();
    eq('the choice is written down once', JSON.stringify(persisted?.modules?.sort()), JSON.stringify([...DEFAULT_MODULES].sort()));
    eq('and reading again gives the same answer', JSON.stringify((await resolveModules(fresh)).sort()), JSON.stringify([...DEFAULT_MODULES].sort()));

    // ------------------------------------------------- an existing society
    // This is the one that matters: shipping this must not hide screens from a
    // society already using them.
    console.log('\nA society already using things');
    const inUse = await newSociety();
    const blockId = new mongoose.Types.ObjectId();
    const [flat] = await Flat.create([{
      number: '101', blockName: 'A', blockId, societyId: inUse, status: FlatStatus.OWNER_OCCUPIED,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    }]);
    await issueShares(inUse, { flatId: String(flat._id), memberName: 'Asha Rao', shareCount: 5, faceValuePaise: 5_000 }, actor);
    await FixedAsset.create({
      societyId: inUse, name: 'Lift', assetAccountCode: '1510', purchaseDate: new Date(),
      costPaise: 100_000, salvageValuePaise: 0, method: 'SLM', ratePercent: 10,
      createdBy: userId, createdByName: actor.userName,
    });
    await postJournal(inUse, {
      voucherType: 'JOURNAL', entryDate: new Date(), narration: 'verify: a manual voucher',
      lines: [{ accountCode: '1100', debitPaise: 100 }, { accountCode: '4200', creditPaise: 100 }],
      postedBy: actor.userId, postedByName: actor.userName,
    });

    const inferred = await resolveModules(inUse);
    ok('shares stay visible — they have a share register', inferred.includes('SHARES'));
    ok('fixed assets stay visible — they own a lift', inferred.includes('ASSETS'));
    ok('the accounting tools stay visible — someone posts manual vouchers', inferred.includes('ACCOUNTING'));
    ok('funds stay on by default', inferred.includes('FUNDS'));
    ok('but bank reconciliation is still off — they have never used it', !inferred.includes('BANKING'));
    ok('and post-dated cheques too', !inferred.includes('PDC'));

    // A fund created later is data, but the module was already on by default —
    // check the inference reads real fund data rather than only the default.
    const withFund = await newSociety();
    await createFund(withFund, { name: 'Sinking Fund', category: 'SINKING' }, actor);
    ok('a society with a fund keeps funds on', (await resolveModules(withFund)).includes('FUNDS'));

    // ------------------------------------------------- an explicit choice
    console.log('\nOnce the society chooses');
    await FinancePolicy.updateOne({ societyId: inUse }, { $set: { modules: ['EXPENSES'] } });
    const chosen = await resolveModules(inUse);
    eq('their choice wins over what the data suggests', JSON.stringify(chosen), JSON.stringify(['EXPENSES']));
    ok('…so a screen they switched off really is off', !chosen.includes('SHARES'));
    ok('hasModule agrees', await hasModule(inUse, 'EXPENSES'));
    eq('…and for the ones that are off', await hasModule(inUse, 'SHARES'), false);

    // Switching it back on is just a list edit — no migration, no data touched.
    await FinancePolicy.updateOne({ societyId: inUse }, { $set: { modules: ['EXPENSES', 'SHARES'] } });
    ok('turning a module back on restores it', (await resolveModules(inUse)).includes('SHARES'));
    eq('…and the data was never touched', await ShareCertificate.countDocuments({ societyId: inUse }), 1);

    // Garbage in the field must not reach the sidebar as a phantom item.
    await FinancePolicy.updateOne({ societyId: inUse }, { $set: { modules: ['EXPENSES', 'NONSENSE'] } });
    eq('an unknown module name is ignored', JSON.stringify(await resolveModules(inUse)), JSON.stringify(['EXPENSES']));

    // ------------------------------------------------- the catalog
    console.log('\nThe settings catalog');
    eq('every module is offered in the UI', MODULE_CATALOG.length, FINANCE_MODULES.length);
    ok('…each with a name and an explanation',
      MODULE_CATALOG.every(m => m.label.trim() && m.blurb.trim() && m.pages.length));
    ok('…and every catalog key is a real module',
      MODULE_CATALOG.every(m => (FINANCE_MODULES as readonly string[]).includes(m.key)));

    // ------------------------------------------------- the sidebar contract
    // The nav is where this is felt, and it is the one place a wrong key means a
    // screen a society uses simply never appears.
    console.log('\nThe sidebar');
    const nav = getSidebarFinanceModules();
    ok('every finance nav item names a real module',
      nav.tagged.every(k => (FINANCE_MODULES as readonly string[]).includes(k)),
      JSON.stringify(nav.tagged.filter(k => !(FINANCE_MODULES as readonly string[]).includes(k))));
    // The core is what a society cannot bill without. If one of these ever gets a
    // module tag, a society could switch off its own ability to raise a bill.
    for (const core of ['Overview', 'Invoices', 'Collections', 'Confirmations', 'Charge Heads', 'Reports', 'Settings']) {
      ok(`"${core}" is core and can never be hidden`, nav.untagged.includes(core), JSON.stringify(nav.untagged));
    }
    ok('every optional module has at least one screen behind it',
      FINANCE_MODULES.every(m => nav.tagged.includes(m)),
      `unused: ${FINANCE_MODULES.filter(m => !nav.tagged.includes(m)).join(', ')}`);

    // ------------------------------------------------- the operations menu
    console.log('\nThe operations menu');
    const opsNav = getSidebarOpsModules();
    ok('every ops nav tag names a real module',
      opsNav.tagged.every(k => (OPS_MODULES as readonly string[]).includes(k)),
      JSON.stringify(opsNav.tagged.filter(k => !(OPS_MODULES as readonly string[]).includes(k))));

    /**
     * The one that would have caught it. Every module must have a screen, or
     * the toggle switches nothing; and every module must be ON for a fresh
     * society, or the screen exists and nobody can find it.
     */
    for (const m of OPS_MODULES) {
      ok(`"${m}" has at least one screen behind it`, opsNav.tagged.includes(m),
        JSON.stringify(opsNav.tagged));
      ok(`...and a new society gets it`, (DEFAULT_OPS_MODULES as readonly string[]).includes(m),
        JSON.stringify(DEFAULT_OPS_MODULES));
    }

    /**
     * And the door back in.
     *
     * The settings screen is where modules are switched on and off. If it were
     * itself behind a module, an admin could switch that module off and lose
     * the only way to switch it back on. So it must be ungated, forever.
     */
    ok('Operations Settings is never behind a module',
      opsNav.ungated.includes('Operations Settings'), JSON.stringify(opsNav.ungated));
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
