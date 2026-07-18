/**
 * Bulk import verification — real database, THROWAWAY societyId, self-cleaning.
 * Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-phase-c-import.ts
 *
 * Covers the promise the feature makes: preview tells the truth, commit is
 * all-or-nothing, re-running changes nothing, and opening dues cannot be posted
 * twice by accident.
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import * as xlsx from 'xlsx';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinanceFund } from '../models/finance-fund.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { ShareCertificate } from '../models/share-certificate.model';
import { Flat } from '../models/flat.model';
import { Block } from '../models/block.model';
import { FlatSize } from '../models/flat-size.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { trialBalance } from '../services/reports.service';
import { preview, commit, templateFor, columnsFor, parseRows } from '../services/bulk-import.service';

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
    SequenceCounter.deleteMany({ societyId }), ShareCertificate.deleteMany({ societyId }),
    Flat.deleteMany({ societyId }), Block.deleteMany({ societyId }), FlatSize.deleteMany({ societyId }),
  ]);
}

const csv = (lines: string[]) => lines.join('\n');

const FLATS_CSV = csv([
  'Block,Flat Number,Status,Size',
  'A Wing,101,OWNER_OCCUPIED,2BHK 1600',
  'A Wing,102,RENTED,2BHK 1600',
  'B Wing,201,VACANT,',
]);

const MEMBERS_CSV = csv([
  'Block,Flat Number,Member Name,Shares,Face Value',
  'A Wing,101,Asha Rao,5,50',
  'A Wing,102,Bala Iyer,5,50',
]);

const DUES_CSV = csv([
  'Block,Flat Number,Amount Due',
  'A Wing,101,12500.50',
  'A Wing,102,7300',
  'B Wing,201,0',
]);

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    await getOrCreatePolicy(SID, actor.userId, actor.userName);

    // ---------------------------------------------------- I1 flats
    console.log('I1 — flats import');
    // The import names a size; the area itself lives on that size.
    const [sizeDoc] = await FlatSize.create([{
      name: '2BHK 1600', carpetAreaSqft: 1600, builtUpAreaSqft: 1850, societyId,
      createdBy: userId, updatedBy: userId,
    }]);
    const sizeId = sizeDoc._id;

    const badSize = await preview(SID, 'FLATS', {
      csvText: ['Block,Flat Number,Status,Size', 'A Wing,999,VACANT,No Such Size'].join('\n'),
    });
    eq('a size that does not exist is an ERROR, not a silent skip', badSize.totals.error, 1);
    ok('…naming what to fix', /No flat size named/.test(badSize.rows[0].message || ''), badSize.rows[0].message);

    const p1 = await preview(SID, 'FLATS', { csvText: FLATS_CSV });
    eq('a clean file previews every row as CREATE', p1.totals.create, 3);
    eq('…with nothing to skip', p1.totals.skip, 0);
    eq('…and no errors', p1.totals.error, 0);
    ok('preview writes nothing', (await Flat.countDocuments({ societyId })) === 0);
    ok('the summary speaks plain English', /Will add 3 flats/.test(p1.summary), p1.summary);

    const c1 = await commit(SID, 'FLATS', { csvText: FLATS_CSV }, actor);
    eq('commit creates the flats', c1.created, 3);
    eq('…and they are really there', await Flat.countDocuments({ societyId }), 3);
    eq('blocks named in the file are created', await Block.countDocuments({ societyId }), 2);
    const f101 = await Flat.findOne({ societyId, number: '101' }).lean();
    eq('…and the flat is wired to its block', String(f101?.blockId), String((await Block.findOne({ societyId, name: 'A Wing' }).lean())?._id));
    eq('status comes across', f101?.status, 'OWNER_OCCUPIED');
    // The size is named in the file and resolved to its id — the area itself
    // lives on that size, so it is never typed per flat.
    eq('the named size is wired up', String(f101?.size), String(sizeId));
    const vacant = await Flat.findOne({ societyId, number: '201' }).lean();
    eq('a VACANT flat with no size named is fine', vacant?.status, 'VACANT');
    ok('…and simply has no size', vacant?.size === undefined, String(vacant?.size));

    // Idempotency: the same file again must add nothing.
    const p1again = await preview(SID, 'FLATS', { csvText: FLATS_CSV });
    eq('re-previewing the same file reports every row as SKIP', p1again.totals.skip, 3);
    eq('…and nothing to create', p1again.totals.create, 0);
    const c1again = await commit(SID, 'FLATS', { csvText: FLATS_CSV }, actor);
    eq('re-committing creates nothing', c1again.created, 0);
    eq('…so the flat count is unchanged', await Flat.countDocuments({ societyId }), 3);
    eq('…and no duplicate blocks appear', await Block.countDocuments({ societyId }), 2);

    // ---------------------------------------------------- I2 validation
    console.log('\nI2 — validation is the feature');
    const badStatus = await preview(SID, 'FLATS', { csvText: csv([
      'Block,Flat Number,Status',
      'C Wing,301,OWNER_OCCUPIED',
      'C Wing,302,SUBLET',
    ]) });
    eq('a bad status is one ERROR row', badStatus.totals.error, 1);
    eq('…and the good row above it still reads CREATE', badStatus.totals.create, 1);
    eq('…the error names the row', badStatus.rows.find(r => r.status === 'ERROR')?.rowNumber, 3);
    ok('…and says what is wrong in plain English',
      /not valid/.test(badStatus.rows.find(r => r.status === 'ERROR')?.message || ''),
      badStatus.rows.find(r => r.status === 'ERROR')?.message);

    // The headline assertion: ONE bad row means NOTHING is written.
    const before = await Flat.countDocuments({ societyId });
    const refused = await refuses(() => commit(SID, 'FLATS', { csvText: csv([
      'Block,Flat Number,Status',
      'C Wing,301,OWNER_OCCUPIED',
      'C Wing,302,SUBLET',
    ]) }, actor));
    ok('commit is refused when any row is an ERROR', /problems/.test(refused?.message || ''), refused?.message);
    eq('…and the GOOD row is not written either — all or nothing', await Flat.countDocuments({ societyId }), before);
    ok('…and the block from the refused file was not created', !(await Block.findOne({ societyId, name: 'C Wing' })));

    const dupes = await preview(SID, 'FLATS', { csvText: csv([
      'Block,Flat Number,Status',
      'D Wing,401,VACANT',
      'D Wing,401,VACANT',
    ]) });
    eq('a row duplicated inside the file is an ERROR', dupes.totals.error, 1);
    ok('…pointing at the row it clashes with', /row 2/.test(dupes.rows[1].message || ''), dupes.rows[1].message);

    const missingCol = await refuses(async () => preview(SID, 'FLATS', { csvText: 'Block,Status\nA Wing,VACANT' }));
    ok('a missing required column stops the file dead', /Flat Number/.test(missingCol?.message || ''), missingCol?.message);

    const blank = await refuses(async () => preview(SID, 'FLATS', { csvText: '' }));
    ok('an empty paste is refused kindly', /Paste your spreadsheet/.test(blank?.message || ''), blank?.message);

    // Headers are matched loosely — a treasurer's "FLAT NO" is still a flat number.
    const loose = await preview(SID, 'FLATS', { csvText: 'wing,flat no,occupancy\nA Wing,101,OWNER_OCCUPIED' });
    eq('untidy headers still parse', loose.totals.skip, 1);

    // ---------------------------------------------------- I3 members & shares
    console.log('\nI3 — members & shares import');
    const pM = await preview(SID, 'MEMBERS', { csvText: MEMBERS_CSV });
    eq('members preview as CREATE', pM.totals.create, 2);
    const cM = await commit(SID, 'MEMBERS', { csvText: MEMBERS_CSV }, actor);
    eq('two certificates are issued', cM.created, 2);
    eq('…for the right money (2 × 5 × ₹50)', cM.totalAmountPaise, 50_000);
    eq('…and share capital is on the books', (await trialBalance(SID)).rows.find(r => r.code === '3000')?.creditPaise, 50_000);
    eq('…via real certificates', await ShareCertificate.countDocuments({ societyId, status: 'ACTIVE' }), 2);

    const pMagain = await preview(SID, 'MEMBERS', { csvText: MEMBERS_CSV });
    eq('a flat that already holds a certificate is a SKIP, not an error', pMagain.totals.skip, 2);
    eq('…with nothing left to create', pMagain.totals.create, 0);
    const cMagain = await commit(SID, 'MEMBERS', { csvText: MEMBERS_CSV }, actor);
    eq('re-committing members issues nothing', cMagain.created, 0);
    eq('…so share capital is unchanged', (await trialBalance(SID)).rows.find(r => r.code === '3000')?.creditPaise, 50_000);

    const unknownFlat = await preview(SID, 'MEMBERS', { csvText: csv([
      'Block,Flat Number,Member Name,Shares,Face Value',
      'Z Wing,999,Ghost,5,50',
    ]) });
    eq('shares for a flat that does not exist is an ERROR', unknownFlat.totals.error, 1);
    ok('…and says to import the flats first', /import the flats first/.test(unknownFlat.rows[0].message || ''), unknownFlat.rows[0].message);

    // ---------------------------------------------------- I4 opening dues
    console.log('\nI4 — opening dues');
    const pD = await preview(SID, 'OPENING_DUES', { csvText: DUES_CSV });
    eq('two flats owe money', pD.totals.create, 2);
    eq('…and the flat owing nothing is skipped, not errored', pD.totals.skip, 1);
    // ₹12,500.50 + ₹7,300 — the .50 is the point: it must be exactly 1250050 paise.
    eq('the total is exact integer paise, with no float drift', pD.totalAmountPaise, 1_250_050 + 730_000);
    ok('opening dues are not yet flagged as a repeat', !pD.requiresForce);

    const cD = await commit(SID, 'OPENING_DUES', { csvText: DUES_CSV }, actor);
    eq('the dues post', cD.created, 2);
    ok('…as a voucher with a number', !!cD.voucherNumber, cD.voucherNumber);
    eq('…and exactly ONE opening voucher exists', await JournalEntry.countDocuments({ societyId, voucherType: 'OPENING' }), 1);

    const je = await JournalEntry.findOne({ societyId, voucherType: 'OPENING' }).lean();
    const drTotal = (je?.lines || []).reduce((s: number, l: any) => s + (l.debitPaise || 0), 0);
    const crTotal = (je?.lines || []).reduce((s: number, l: any) => s + (l.creditPaise || 0), 0);
    eq('the voucher is balanced', drTotal, crTotal);
    eq('…debiting Sundry Debtors for the total', drTotal, 1_980_050);
    eq('…across one line per flat', (je?.lines || []).filter((l: any) => l.debitPaise > 0).length, 2);
    ok('…every debtor line is tagged with its flat, so the sub-ledger still works',
      (je?.lines || []).filter((l: any) => l.debitPaise > 0).every((l: any) => !!l.flatId));
    const crLines = (je?.lines || []).filter((l: any) => l.creditPaise > 0);
    eq('…and ONE credit to Accumulated Surplus', crLines.length, 1);
    eq('…for the whole total', crLines[0]?.creditPaise, 1_980_050);

    const tb = await trialBalance(SID);
    ok('the ledger still ties after the opening entry', tb.balanced,
      `Dr ${rupees(tb.totalDebitPaise)} vs Cr ${rupees(tb.totalCreditPaise)}`);
    ok('…and no account has drifted from its entries', tb.drift.length === 0, JSON.stringify(tb.drift));
    eq('Sundry Debtors carries the dues', tb.rows.find(r => r.code === '1200')?.debitPaise, 1_980_050);
    eq('…funded by Accumulated Surplus, not income', tb.rows.find(r => r.code === '3900')?.creditPaise, 1_980_050);

    // The one that matters: opening dues must not be postable twice by accident.
    const pDagain = await preview(SID, 'OPENING_DUES', { csvText: DUES_CSV });
    ok('a second opening import is flagged in preview', pDagain.requiresForce === true);
    ok('…with a warning that says why', /owe twice|twice/.test(pDagain.warning || ''), pDagain.warning);

    const twice = await refuses(() => commit(SID, 'OPENING_DUES', { csvText: DUES_CSV }, actor));
    ok('committing opening dues twice without force is refused', /already been posted/.test(twice?.message || ''), twice?.message);
    eq('…and says so with a 409', (twice as any)?.status, 409);
    eq('…leaving exactly one opening voucher', await JournalEntry.countDocuments({ societyId, voucherType: 'OPENING' }), 1);
    eq('…and the debtors balance untouched', (await trialBalance(SID)).rows.find(r => r.code === '1200')?.debitPaise, 1_980_050);

    // force exists as a deliberate escape hatch, and must actually work.
    const forced = await commit(SID, 'OPENING_DUES', { csvText: DUES_CSV }, actor, { force: true });
    ok('force posts a second voucher for the rare genuine case', !!forced.voucherNumber);
    eq('…making two opening vouchers', await JournalEntry.countDocuments({ societyId, voucherType: 'OPENING' }), 2);
    const tbForced = await trialBalance(SID);
    ok('…and the ledger still ties even then', tbForced.balanced && tbForced.drift.length === 0);

    const badAmount = await preview(SID, 'OPENING_DUES', { csvText: csv([
      'Block,Flat Number,Amount Due',
      'A Wing,101,abc',
      'A Wing,102,-500',
    ]) });
    eq('a non-numeric amount is an ERROR', badAmount.rows[0].status, 'ERROR');
    ok('…named clearly', /not a valid amount/.test(badAmount.rows[0].message || ''), badAmount.rows[0].message);
    eq('a negative amount is an ERROR', badAmount.rows[1].status, 'ERROR');
    ok('…named clearly too', /cannot be negative/.test(badAmount.rows[1].message || ''), badAmount.rows[1].message);

    // ---------------------------------------------------- I5 template round-trip
    console.log('\nI5 — the template parses back');
    for (const kind of ['FLATS', 'MEMBERS', 'OPENING_DUES'] as const) {
      const buf = await templateFor(kind);
      ok(`${kind}: the template is a real workbook`, buf.length > 0);
      const wb = xlsx.read(buf, { type: 'buffer' });
      const grid = xlsx.utils.sheet_to_json<any[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
      const headers = (grid[0] || []).map(h => String(h).trim());
      eq(`${kind}: …with exactly the headers we document`, headers.join('|'), columnsFor(kind).join('|'));
      // The example row must survive our own parser, or the template teaches a lie.
      const rows = parseRows(kind, { fileBuffer: buf });
      eq(`${kind}: …and its example row parses back as one row`, rows.length, 1);
    }
    // The FLATS example must be genuinely importable, not just parseable.
    const tmplPreview = await preview(SID, 'FLATS', { fileBuffer: await templateFor('FLATS') });
    eq('the template example row is a valid import, not an error', tmplPreview.totals.error, 0);

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
