/**
 * Template dropdowns — the values a treasurer must not have to guess.
 * Real database, THROWAWAY societyId, self-cleaning.
 *
 * Asserts the workbook that comes OUT, by reading it back with a different
 * library than the one that wrote it. Checking that we called `dataValidation`
 * would only prove we called it; reading the file back proves Excel will show a
 * dropdown.
 *
 *   npx ts-node src/scripts/verify-template-dropdowns.ts
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import { appConfig } from '../config/appConfig';
import { Block } from '../models/block.model';
import { FlatSize } from '../models/flat-size.model';
import { Vendor } from '../models/vendor.model';
import { FinanceFund } from '../models/finance-fund.model';
import { LedgerAccount } from '../models/ledger-account.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { FlatStatus } from '../models/flat.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { createFund } from '../services/funds.service';
import { templateFor as importTemplate } from '../services/bulk-import.service';
import { templateFor as expenseTemplate } from '../services/bulk-expense.service';

const societyId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const SID = societyId.toString();

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/** Read a workbook back and report what a person would actually see. */
async function openBook(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets.find(w => w.state !== 'veryHidden')!;
  const headers = (ws.getRow(1).values as any[]).slice(1).map(v => String(v ?? ''));

  /** The list a given column's dropdown offers, resolved through the hidden sheet. */
  const optionsFor = (header: string): string[] => {
    const col = headers.indexOf(header) + 1;
    if (col <= 0) return [];
    const dv: any = ws.getCell(2, col).dataValidation;
    if (!dv || dv.type !== 'list') return [];
    const formula = String(dv.formulae?.[0] || '');
    const m = formula.match(/^_lists!\$([A-Z]+)\$(\d+):\$[A-Z]+\$(\d+)$/);
    if (!m) return [];
    const lists = wb.getWorksheet('_lists');
    if (!lists) return [];
    const out: string[] = [];
    for (let r = Number(m[2]); r <= Number(m[3]); r++) {
      const v = lists.getCell(`${m[1]}${r}`).value;
      if (v != null) out.push(String(v));
    }
    return out;
  };

  return { wb, ws, headers, optionsFor };
}

async function cleanup() {
  await Promise.all([
    Block.deleteMany({ societyId }), FlatSize.deleteMany({ societyId }),
    Vendor.deleteMany({ societyId }), FinanceFund.deleteMany({ societyId }),
    LedgerAccount.deleteMany({ societyId }), FinancePolicy.deleteMany({ societyId }),
  ]);
}

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    await getOrCreatePolicy(SID, actor.userId, actor.userName);

    const mk = (name: string) => ({
      name, societyId,
      createdBy: userId, createdByName: actor.userName,
      updatedBy: userId, updatedByName: actor.userName,
    });
    await Block.create([mk('A Wing'), mk('B Wing'), mk('C Wing')]);
    await FlatSize.create([
      { ...mk('1BHK 1200'), carpetAreaSqft: 1200 },
      { ...mk('2BHK 1600'), carpetAreaSqft: 1600 },
    ]);
    await Vendor.create([
      { ...mk('MSEB'), phone: '9000000001', isActive: true },
      { ...mk('Acme Lifts'), phone: '9000000002', isActive: true },
    ]);
    await createFund(SID, { name: 'Repair Fund', category: 'REPAIR' }, actor);

    // ================================================================== FLATS
    console.log('The flats template asks nothing a treasurer has to remember');
    const flats = await openBook(await importTemplate('FLATS', {
      blocks: ['A Wing', 'B Wing', 'C Wing'],
      flatSizes: ['1BHK 1200', '2BHK 1600'],
    }));

    const statuses = flats.optionsFor('Status');
    ok('Status has a dropdown', statuses.length > 0, `${statuses.length} options`);
    eq('...offering every occupancy state', statuses.length, Object.values(FlatStatus).length);
    ok('...including RENTED', statuses.includes('RENTED'), statuses.join(','));

    const wings = flats.optionsFor('Block');
    eq('Block offers this society\'s own wings', wings.length, 3);
    ok('...by name', wings.includes('B Wing'), wings.join(','));

    const sizes = flats.optionsFor('Size');
    eq('Size offers this society\'s own layouts', sizes.length, 2);
    ok('...by name', sizes.includes('2BHK 1600'), sizes.join(','));

    // A dropdown on row 2 only would be useless — people paste 200 rows.
    const headers = flats.headers;
    const statusCol = headers.indexOf('Status') + 1;
    const deepRow: any = flats.ws.getCell(400, statusCol).dataValidation;
    ok('the dropdown reaches far enough down for a real import', deepRow?.type === 'list');

    // The list sheet must not be something a user can wander into and edit.
    const listSheet = flats.wb.getWorksheet('_lists');
    ok('the options live on a very hidden sheet', listSheet?.state === 'veryHidden', String(listSheet?.state));

    // ============================================================ other kinds
    console.log('\nEvery kind that names a wing offers the wing list');
    for (const kind of ['MEMBERS', 'OPENING_DUES'] as const) {
      const book = await openBook(await importTemplate(kind, { blocks: ['A Wing', 'B Wing', 'C Wing'] }));
      eq(`${kind}: Block has the three wings`, book.optionsFor('Block').length, 3);
    }

    // A society with no wings yet must still get a usable template — an empty
    // dropdown that refuses every value would be worse than none.
    const bare = await openBook(await importTemplate('FLATS', {}));
    eq('a society with no wings gets no Block dropdown, not a broken one', bare.optionsFor('Block').length, 0);
    ok('...but Status still works, because it comes from the enum', bare.optionsFor('Status').length > 0);

    // ================================================================ expenses
    console.log('\nThe expense template offers this society\'s own heads');
    const exp = await openBook(await expenseTemplate(SID));

    const heads = exp.optionsFor('Head');
    ok('Head has a dropdown — the commonest reason a row fails', heads.length > 0, `${heads.length}`);
    ok('...listing real expense heads', heads.includes('Electricity'), heads.slice(0, 4).join(','));
    ok('...including the new staff account', heads.includes('Staff Payments'));
    ok('...and NOT income or asset accounts', !heads.includes('Maintenance Income'));

    eq('Vendor offers the society\'s vendors', exp.optionsFor('Vendor').length, 2);
    eq('Block offers its wings', exp.optionsFor('Block').length, 3);
    eq('Fund offers its funds', exp.optionsFor('Fund').length, 1);

    // Amount and Note are free text — a dropdown there would be nonsense.
    eq('Amount has no dropdown', exp.optionsFor('Amount').length, 0);
    eq('Note has no dropdown', exp.optionsFor('Note').length, 0);

    // ============================================ the file is still importable
    console.log('\nThe template is still a file our own importer accepts');
    const { preview } = await import('../services/bulk-import.service');
    const round = await preview(SID, 'FLATS', {
      fileBuffer: await importTemplate('FLATS', { blocks: ['A Wing'], flatSizes: ['2BHK 1600'] }),
    });
    ok('the example row parses back cleanly', round.rows.length > 0, `${round.rows.length} rows`);
    ok('...and the hidden list sheet is not read as data',
      round.rows.every(r => !JSON.stringify(r.data).includes('_lists')));

  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
