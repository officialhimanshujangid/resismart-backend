/**
 * Phase 1 — the setup gate and vendor opening balances.
 * Real database, THROWAWAY societyIds, self-cleaning. Never touches existing data.
 *
 * The load-bearing assertion is the FIRST one: a society that was already
 * trading before this feature existed must NOT be locked out of its own finance
 * module on the day it ships. Everything else here is secondary to that.
 *
 *   npx ts-node src/scripts/verify-finance-setup.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Expense } from '../models/expense.model';
import { Vendor } from '../models/vendor.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { Block } from '../models/block.model';
import { seedChartOfAccounts, ACCOUNT_CODES } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { postJournal, reverseJournal } from '../services/ledger.service';
import {
  resolveSetup, completeSetup, reopenSetup, isSetupComplete, composeOpening, SetupError,
} from '../services/finance-setup.service';
import { requireSetupComplete } from '../middlewares/finance-setup.middleware';
import { vendorLedger, vendorPayables } from '../services/vendor.service';
import { balanceSheet } from '../services/reports.service';
// Pulls in the `Request.user` global augmentation, which lives in the auth
// middleware. Without it ts-node compiles this entry point without ever seeing
// the declaration and every `req.user` fails to type.
import '../middlewares/auth.middleware';

// Three separate throwaway societies — the whole point of several assertions is
// that these do not see each other.
const freshId = new mongoose.Types.ObjectId();      // never traded
const tradingId = new mongoose.Types.ObjectId();    // was already trading
const otherId = new mongoose.Types.ObjectId();      // somebody else entirely
const noPolicyId = new mongoose.Types.ObjectId();   // no FinancePolicy row at all
const userId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const FRESH = freshId.toString();
const TRADING = tradingId.toString();
const OTHER = otherId.toString();
const NOPOLICY = noPolicyId.toString();
/** Filled in mid-run by the concurrency check, so cleanup can find them. */
const raceIds: mongoose.Types.ObjectId[] = [];
const allIds = [freshId, tradingId, otherId, noPolicyId];

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;

/** Drive the middleware without an HTTP server. */
const gate = async (societyId: string, method: string, path: string) => {
  let nexted = false;
  let status = 0;
  let body: any = null;
  const req: any = { method, path, user: { activeTenantId: societyId, userId: actor.userId } };
  const res: any = {
    status(c: number) { status = c; return res; },
    json(b: any) { body = b; return res; },
  };
  await requireSetupComplete(req, res, () => { nexted = true; });
  return { allowed: nexted, status, code: body?.code };
};

async function cleanup() {
  await Promise.all([...allIds, ...raceIds].map(societyId => Promise.all([
    LedgerAccount.deleteMany({ societyId }), JournalEntry.deleteMany({ societyId }),
    FinancePolicy.deleteMany({ societyId }), MaintenanceInvoice.deleteMany({ societyId }),
    Expense.deleteMany({ societyId }), Vendor.deleteMany({ societyId }),
    SequenceCounter.deleteMany({ societyId }), Flat.deleteMany({ societyId }),
    Block.deleteMany({ societyId }),
  ])));
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societies:\n  fresh=${FRESH}\n  trading=${TRADING}\n  other=${OTHER}\n`);

  try {
    // ======================================== the society with NO policy document
    // This is the shape a brand new society really has: the policy row is
    // created lazily and nothing in the setup flow used to create it. The whole
    // feature silently no-opped and reported success — the original test missed
    // it precisely because it called getOrCreatePolicy up front, making the
    // fixture easier than reality.
    console.log('A society with no FinancePolicy row yet');
    await seedChartOfAccounts(NOPOLICY, actor.userId, actor.userName);
    ok('it genuinely has no policy document',
      !(await FinancePolicy.findOne({ societyId: noPolicyId })));

    await completeSetup(NOPOLICY, actor.userId, actor.userName, {
      declaredEmpty: ['BANK_CASH', 'FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
    });
    ok('completing setup creates the policy it needs to write to',
      Boolean(await FinancePolicy.findOne({ societyId: noPolicyId })));
    ok('...and the answer actually sticks — it was silently discarded before',
      await isSetupComplete(NOPOLICY));
    ok('...so the gate opens', (await gate(NOPOLICY, 'POST', '/expenses')).allowed);

    for (const id of [FRESH, TRADING, OTHER]) {
      await seedChartOfAccounts(id, actor.userId, actor.userName);
      await getOrCreatePolicy(id, actor.userId, actor.userName);
    }

    // ============================================ THE assertion this phase exists for
    console.log('A society already trading is never locked out by this feature');

    // It has been running for months. Nobody ever answered a setup question,
    // because there was no question to answer.
    const backThen = new Date('2026-01-15T00:00:00Z');
    await postJournal(TRADING, {
      voucherType: 'JOURNAL',
      entryDate: backThen,
      narration: 'Business as usual, months before the gate existed',
      lines: [
        { accountCode: ACCOUNT_CODES.BANK, debitPaise: 500_000 },
        { accountCode: ACCOUNT_CODES.MAINTENANCE_INCOME, creditPaise: 500_000 },
      ],
      postedBy: actor.userId, postedByName: actor.userName,
    });

    const traded = await resolveSetup(TRADING);
    ok('its setup resolves as complete without anyone answering', traded.complete);
    ok('...dated from its own first entry, not today', traded.completedAt?.getTime() === backThen.getTime(),
      `got ${traded.completedAt?.toISOString()}, want ${backThen.toISOString()}`);
    ok('...and it admits the answer was inferred, not given', Boolean(traded.inferredFrom));
    ok('...so it may still state its real opening position later', traded.canReopen);

    const tradingWrite = await gate(TRADING, 'POST', '/expenses');
    ok('the gate lets it keep working — this is the whole point', tradingWrite.allowed);

    // The inference must persist, or every request re-derives it.
    const persisted = await FinancePolicy.findOne({ societyId: tradingId }).select('setup').lean();
    ok('the inference is written down, not recomputed forever', Boolean(persisted?.setup?.completedAt));

    // ================================================================ the fresh society
    console.log('\nA brand new society is asked before it can record anything');
    const fresh = await resolveSetup(FRESH);
    ok('setup starts unanswered', !fresh.complete);
    eq('...with nothing declared', fresh.declaredEmpty.length, 0);

    const blocked = await gate(FRESH, 'POST', '/expenses');
    ok('recording an expense is refused', !blocked.allowed);
    eq('...with 403', blocked.status, 403);
    eq('...and a code the screen can act on', blocked.code, 'FINANCE_SETUP_INCOMPLETE');

    ok('but reading is always allowed', (await gate(FRESH, 'GET', '/reports/balance-sheet')).allowed);
    ok('...and so is the setup flow itself', (await gate(FRESH, 'POST', '/setup/complete')).allowed);
    ok('...and settings, which come first', (await gate(FRESH, 'PUT', '/settings')).allowed);
    ok('...and the import, which IS the setup', (await gate(FRESH, 'POST', '/import/FLATS/commit')).allowed);
    ok('...and adding an account, which comes before stating what is in it',
      (await gate(FRESH, 'POST', '/ledger/accounts')).allowed);
    ok('a path merely starting with the same letters is NOT open',
      !(await gate(FRESH, 'POST', '/settlement')).allowed);

    // ============================================================ answering "nothing"
    console.log('\n"We have nothing" is a real answer, and it opens the module');
    await completeSetup(FRESH, actor.userId, actor.userName, {
      declaredEmpty: ['BANK_CASH', 'FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
    });
    const declared = await resolveSetup(FRESH);
    ok('setup is complete', declared.complete);
    ok('...without inventing a voucher out of nothing', !declared.openingVoucherId);
    eq('...and records that it was asked and said no', declared.declaredEmpty.length, 5);
    ok('...it is a stated answer now, not an inferred one', !declared.inferredFrom);
    ok('the gate opens', (await gate(FRESH, 'POST', '/expenses')).allowed);

    const noVoucher = await JournalEntry.countDocuments({ societyId: freshId, voucherType: 'OPENING' });
    eq('no OPENING voucher was posted', noVoucher, 0);

    // ======================================================== a half answer is refused
    console.log('\nA half-answered setup is refused — it would look finished');
    await reopenSetup(FRESH, actor.userId, actor.userName);
    let halfErr = '';
    try {
      await completeSetup(FRESH, actor.userId, actor.userName, {
        bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 100_000 }],
        declaredEmpty: ['FLAT_DUES'],
      });
    } catch (e: any) { halfErr = e.message; }
    ok('it names what is missing', halfErr.includes('VENDOR_DUES') && halfErr.includes('FUNDS'), halfErr);
    ok('...and nothing was posted', await isSetupComplete(FRESH) === false);

    // ==================================================== the balancing figure is ours
    console.log('\nThe balancing figure is computed, not demanded from the user');
    const composed = composeOpening({
      bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 500_000 }],
      funds: [{ accountCode: ACCOUNT_CODES.CORPUS_FUND, amountPaise: 200_000 }],
    });
    eq('debits equal credits', composed.debitPaise, composed.creditPaise);
    const balancing = composed.lines.find(l => l.accountCode === ACCOUNT_CODES.SURPLUS);
    eq('the difference lands on 3900', balancing?.creditPaise, 300_000);
    ok('zero-value lines are dropped, not posted',
      !composeOpening({ bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 0 }] }).lines.length);

    // =============================================== vendor opening balances (the gap)
    console.log('\nVendor opening balances — missing entirely until now');
    const acme = await Vendor.create({
      societyId: freshId, name: 'Acme Lifts', phone: '9876500001', isActive: true,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    const bolt = await Vendor.create({
      societyId: freshId, name: 'Bolt Plumbing', phone: '9876500002', isActive: true,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });

    const done = await completeSetup(FRESH, actor.userId, actor.userName, {
      entryDate: new Date('2026-04-01T00:00:00Z'),
      bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 1_000_000 }],
      vendorDues: [
        { vendorId: String(acme._id), amountPaise: 5_000_00 },
        { vendorId: String(bolt._id), amountPaise: 1_500_00 },
      ],
      declaredEmpty: ['FLAT_DUES', 'FUNDS', 'DEPOSITS'],
    });
    ok('an OPENING voucher was posted', Boolean(done.openingVoucherId));

    const ob = await JournalEntry.findById(done.openingVoucherId).lean();
    eq('...of the right type', ob?.voucherType, 'OPENING');
    ok('...on the OB numbering series', String(ob?.voucherNumber || '').startsWith('OB/'),
      String(ob?.voucherNumber));
    const obDebits = (ob?.lines || []).reduce((s: number, l: any) => s + (l.debitPaise || 0), 0);
    const obCredits = (ob?.lines || []).reduce((s: number, l: any) => s + (l.creditPaise || 0), 0);
    eq('...and it balances', obDebits, obCredits);

    // Each vendor now has a real position, which was impossible before.
    const acmeLedger = await vendorLedger(FRESH, String(acme._id), {});
    ok('Acme has an opening payable in its own ledger', acmeLedger.entries.length > 0,
      `${acmeLedger.entries.length} rows`);
    eq('...of the right amount', acmeLedger.outstandingPayablePaise, 5_000_00);

    const payables = await vendorPayables(FRESH);
    const acmeRow = payables.get(String(acme._id));
    const boltRow = payables.get(String(bolt._id));
    eq('the payables list shows Acme', acmeRow, 5_000_00);
    eq('...and Bolt separately', boltRow, 1_500_00);

    // The $elemMatch trap: a voucher carrying TWO vendor lines must not vanish
    // from either vendor's view. `{'lines.vendorId': {$ne: null}}` means "no
    // element is null", which excludes exactly this voucher — and the bug hides
    // because the halves cancel in any total.
    const bothVisible = acmeLedger.entries.length > 0 && (await vendorLedger(FRESH, String(bolt._id), {})).entries.length > 0;
    ok('a voucher with two vendor lines is visible to BOTH — the $elemMatch trap', bothVisible);

    // And it must reach the statutory report, not just the vendor screen.
    const bs = await balanceSheet(FRESH, { asOf: '2026-04-02' });
    const creditors = JSON.stringify(bs).includes('2200');
    ok('Creditors appears on the balance sheet', creditors);

    // ================================================================== cross-society
    console.log('\nOne society cannot reach into another');
    const stranger = await Vendor.create({
      societyId: otherId, name: 'Someone Else Ltd', phone: '9876500003', isActive: true,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    await completeSetup(OTHER, actor.userId, actor.userName, {
      declaredEmpty: ['BANK_CASH', 'FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
    });
    await reopenSetup(OTHER, actor.userId, actor.userName);

    let crossErr = '';
    try {
      await completeSetup(OTHER, actor.userId, actor.userName, {
        vendorDues: [{ vendorId: String(acme._id), amountPaise: 100_000 }],
        declaredEmpty: ['BANK_CASH', 'FLAT_DUES', 'FUNDS', 'DEPOSITS'],
      });
    } catch (e: any) { crossErr = e.message; }
    ok('a vendor from another society is refused', crossErr.includes('unknown to this society'), crossErr);

    let badAcct = '';
    try {
      await completeSetup(OTHER, actor.userId, actor.userName, {
        bankCash: [{ accountCode: '9999', amountPaise: 100 }],
        declaredEmpty: ['FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
      });
    } catch (e: any) { badAcct = e.message; }
    ok('a typo\'d account code fails loudly instead of posting to nothing',
      badAcct.includes('Unknown or inactive account code'), badAcct);

    ok('...and after both refusals the society is still unanswered',
      await isSetupComplete(OTHER) === false);

    // ================================================================ reopening rules
    console.log('\nReopening: allowed while nothing has been posted, refused after');
    ok('the fresh society cannot reopen — it has an opening voucher on the books',
      (await resolveSetup(FRESH)).canReopen === false);

    let reopenErr = '';
    try { await reopenSetup(FRESH, actor.userId, actor.userName); }
    catch (e: any) { reopenErr = e.message; }
    ok('...and says so, pointing at the correction route', reopenErr.includes('journal'), reopenErr);

    await completeSetup(OTHER, actor.userId, actor.userName, {
      declaredEmpty: ['BANK_CASH', 'FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
    });
    ok('a society that posted nothing may reopen', (await resolveSetup(OTHER)).canReopen);
    await reopenSetup(OTHER, actor.userId, actor.userName);
    ok('...and is unanswered again', !(await resolveSetup(OTHER)).complete);

    // ============================================================ no double-answering
    console.log('\nThe question cannot be answered twice');
    let twiceErr = '';
    try {
      await completeSetup(FRESH, actor.userId, actor.userName, {
        bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 999_999 }],
        declaredEmpty: ['FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
      });
    } catch (e: any) { twiceErr = e.message; }
    ok('a second completion is refused', twiceErr.includes('already complete'), twiceErr);

    const openingCount = await JournalEntry.countDocuments({ societyId: freshId, voucherType: 'OPENING' });
    eq('...so exactly one OPENING voucher exists', openingCount, 1);

    // An inferred society is the exception: it never really answered, so it may.
    const inferredOverride = await completeSetup(TRADING, actor.userId, actor.userName, {
      bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 250_000 }],
      declaredEmpty: ['FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
    });
    ok('the trading society CAN state its real position over the inferred one',
      Boolean(inferredOverride.openingVoucherId));
    const nowStated = await resolveSetup(TRADING);
    ok('...and the inferred marker is cleared', !nowStated.inferredFrom);
    ok('...leaving a stated answer', nowStated.complete);

    // ==================================================== reversal reopens the door
    console.log('\nReversing the opening voucher is what reopens the question');
    await reverseJournal(FRESH, done.openingVoucherId!, {
      postedBy: actor.userId, postedByName: actor.userName,
      narration: 'Opening bank balance was wrong',
    });
    ok('once reversed, the society may answer again', (await resolveSetup(FRESH)).canReopen);
    await reopenSetup(FRESH, actor.userId, actor.userName);
    ok('...and it is unanswered', !(await resolveSetup(FRESH)).complete);
    ok('...and it does NOT re-infer itself from its own opening voucher',
      (await resolveSetup(FRESH)).complete === false);

    const corrected = await completeSetup(FRESH, actor.userId, actor.userName, {
      bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 2_000_000 }],
      declaredEmpty: ['FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
    });
    ok('a corrected opening position posts', Boolean(corrected.openingVoucherId));

    // The books must still tie: original + its reversal + the correction.
    const freshJournals = await JournalEntry.find({ societyId: freshId }).lean();
    const totalDr = freshJournals.reduce((s, j: any) =>
      s + j.lines.reduce((t: number, l: any) => t + (l.debitPaise || 0), 0), 0);
    const totalCr = freshJournals.reduce((s, j: any) =>
      s + j.lines.reduce((t: number, l: any) => t + (l.creditPaise || 0), 0), 0);
    eq('the books still balance after error, reversal and correction', totalDr, totalCr);

    const acmeAfter = await vendorLedger(FRESH, String(acme._id), {});
    eq('...and the reversed vendor payable is back to nil', acmeAfter.outstandingPayablePaise, 0);

    // ================================================= what the review caught
    console.log('\nGuards the first pass missed');

    // The gate must not leave the most powerful write in the module wide open.
    ok('raw journal posting is NOT open before setup',
      !(await gate(OTHER, 'POST', '/ledger/journal')).allowed);
    ok('...but adding an account still is — you need one to bank into',
      (await gate(OTHER, 'POST', '/ledger/accounts')).allowed);
    ok('Express routes case-insensitively, so the allowlist must too',
      (await gate(OTHER, 'POST', '/Setup/complete')).allowed);

    // An account that exists but sits on the wrong side of the balance sheet.
    // This used to post happily: 3900 absorbed the difference, the voucher
    // balanced, and the balance sheet was quietly wrong from day one.
    let wrongSide = '';
    try {
      await completeSetup(OTHER, actor.userId, actor.userName, {
        bankCash: [{ accountCode: ACCOUNT_CODES.CREDITORS, amountPaise: 200_000 }],
        declaredEmpty: ['FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
      });
    } catch (e: any) { wrongSide = e.message; }
    ok('a liability cannot hold a bank balance', wrongSide.includes('LIABILITY'), wrongSide);

    // Declaring a section empty AND filling it in.
    let contradiction = '';
    try {
      await completeSetup(OTHER, actor.userId, actor.userName, {
        bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 100_000 }],
        declaredEmpty: ['BANK_CASH', 'FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
      });
    } catch (e: any) { contradiction = e.message; }
    ok('"nothing here" plus figures is refused, not silently reconciled',
      contradiction.includes('contradict'), contradiction);

    // Two payables for the same vendor is ordinary — two unpaid bills.
    const dup = await Vendor.create({
      societyId: otherId, name: 'Twice Billed Ltd', phone: '9876500009', isActive: true,
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    const dupRun = await completeSetup(OTHER, actor.userId, actor.userName, {
      vendorDues: [
        { vendorId: String(dup._id), amountPaise: 100_000 },
        { vendorId: String(dup._id), amountPaise: 50_000 },
      ],
      declaredEmpty: ['BANK_CASH', 'FLAT_DUES', 'FUNDS', 'DEPOSITS'],
    });
    ok('two opening bills for the same vendor are allowed', Boolean(dupRun.openingVoucherId));
    const dupLedger = await vendorLedger(OTHER, String(dup._id), {});
    eq('...and both land on its ledger', dupLedger.outstandingPayablePaise, 150_000);

    // An inactive vendor should not receive a live opening balance.
    await Vendor.updateOne({ _id: dup._id }, { $set: { isActive: false } });
    await reverseJournal(OTHER, dupRun.openingVoucherId!, {
      postedBy: actor.userId, postedByName: actor.userName, narration: 'redo',
    });
    await reopenSetup(OTHER, actor.userId, actor.userName);
    let inactiveErr = '';
    try {
      await completeSetup(OTHER, actor.userId, actor.userName, {
        vendorDues: [{ vendorId: String(dup._id), amountPaise: 1_000 }],
        declaredEmpty: ['BANK_CASH', 'FLAT_DUES', 'FUNDS', 'DEPOSITS'],
      });
    } catch (e: any) { inactiveErr = e.message; }
    ok('a deactivated vendor is refused', inactiveErr.includes('inactive'), inactiveErr);

    // An unreadable date used to reach the financial-year calculation that keys
    // the voucher sequence, producing a NaN counter.
    let badDate = '';
    try {
      await completeSetup(OTHER, actor.userId, actor.userName, {
        entryDate: new Date('not-a-date'),
        declaredEmpty: ['BANK_CASH', 'FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
      });
    } catch (e: any) { badDate = e.message; }
    ok('an unreadable opening date is caught before it reaches the ledger',
      badDate.includes('could not be read'), badDate);

    // Reopening must not leave the old voucher id behind: its stale reversal
    // would satisfy canReopen forever, waving through every future reopen.
    await completeSetup(OTHER, actor.userId, actor.userName, {
      declaredEmpty: ['BANK_CASH', 'FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
    });
    const afterRedo = await resolveSetup(OTHER);
    ok('a completion with no lines leaves no stale voucher id behind',
      !afterRedo.openingVoucherId, String(afterRedo.openingVoucherId));

    // ============================================== two clicks on "Finish"
    console.log('\nA double-click cannot double the opening balances');
    const raceId = new mongoose.Types.ObjectId();
    const RACE = raceId.toString();
    raceIds.push(raceId);
    await seedChartOfAccounts(RACE, actor.userId, actor.userName);
    await getOrCreatePolicy(RACE, actor.userId, actor.userName);

    const both = await Promise.allSettled([
      completeSetup(RACE, actor.userId, actor.userName, {
        bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 700_000 }],
        declaredEmpty: ['FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
      }),
      completeSetup(RACE, actor.userId, actor.userName, {
        bankCash: [{ accountCode: ACCOUNT_CODES.BANK, amountPaise: 700_000 }],
        declaredEmpty: ['FLAT_DUES', 'VENDOR_DUES', 'FUNDS', 'DEPOSITS'],
      }),
    ]);
    const won = both.filter(r => r.status === 'fulfilled').length;
    eq('exactly one of the two requests wins', won, 1);

    const raceVouchers = await JournalEntry.countDocuments({ societyId: raceId, voucherType: 'OPENING' });
    eq('...so exactly one OPENING voucher exists, not two', raceVouchers, 1);

    const raceBank = await LedgerAccount.findOne({ societyId: raceId, code: ACCOUNT_CODES.BANK }).lean();
    eq('...and the bank balance is not doubled', raceBank?.currentBalancePaise, 700_000);

    console.log(`\n  (Acme opening payable ${rupees(5_000_00)}, Bolt ${rupees(1_500_00)})`);

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
