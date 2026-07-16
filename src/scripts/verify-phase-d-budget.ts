/**
 * Phase D verification — real database, THROWAWAY societyId, self-cleaning.
 * Never touches existing data.
 *
 *   npx ts-node src/scripts/verify-phase-d-budget.ts
 *
 * Covers the budget (upsert, approval, variance maths on a hand-calculated
 * golden case, unbudgeted spend, FY scoping) and the single-file AGM pack.
 */
import '../config/timezone'; // MUST stay first
import mongoose from 'mongoose';
import { Writable } from 'stream';
import { appConfig } from '../config/appConfig';
import { LedgerAccount } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';
import { FinanceFund } from '../models/finance-fund.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { SequenceCounter } from '../models/sequence-counter.model';
import { Budget } from '../models/budget.model';
import { Society } from '../models/society.model';
import { seedChartOfAccounts } from '../services/chart-of-accounts.seed';
import { getOrCreatePolicy } from '../services/finance-policy.service';
import { postJournal } from '../services/ledger.service';
import { trialBalance, incomeExpenditure } from '../services/reports.service';
import {
  upsertBudget, approveBudget, getBudget, listBudgets, budgetVsActual, budgetWorkspace,
} from '../services/budget.service';
import { buildAgmPack } from '../services/agm-pack.service';
import { buildExportDoc } from '../services/report-doc.builder';
import { sendPdf, ExportDoc } from '../services/report-export.service';

const societyId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const actor = { userId: userId.toString(), userName: 'Verifier' };
const SID = societyId.toString();
/**
 * `societies.name` carries a unique index, so the throwaway society's name has to
 * be throwaway too. A fixed name would wedge this script permanently the first
 * time a run was interrupted before its cleanup — and would collide with a real
 * society that happened to share it.
 */
const SOCIETY_NAME = `Verify Gardens CHS ${SID.slice(-8)}`;

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
    SequenceCounter.deleteMany({ societyId }), Budget.deleteMany({ societyId }),
    Society.deleteOne({ _id: societyId }),
  ]);
}

/** Render an ExportDoc exactly the way the route does, without an Express response. */
function renderPdf(doc: ExportDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    }) as any;
    res.setHeader = () => { /* the PDF stream doesn't care what the headers were */ };
    res.on('finish', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
    sendPdf(res, doc);
  });
}

/** Dr an expense / Cr bank, or Dr bank / Cr income — whichever the code calls for. */
const post = (code: string, amountPaise: number, when: Date, narration: string) =>
  postJournal(SID, {
    voucherType: 'JOURNAL', entryDate: when, narration: `verify: ${narration}`,
    lines: code.startsWith('4')
      ? [{ accountCode: '1100', debitPaise: amountPaise }, { accountCode: code, creditPaise: amountPaise }]
      : [{ accountCode: code, debitPaise: amountPaise }, { accountCode: '1100', creditPaise: amountPaise }],
    postedBy: actor.userId, postedByName: actor.userName,
  });

async function main() {
  await mongoose.connect(appConfig.mongoUri);
  console.log(`Connected. Throwaway societyId = ${SID}\n`);

  try {
    await Society.create({
      _id: societyId, name: SOCIETY_NAME, registrationNumber: 'TNA/VER/2026',
      address: '1 Verify Street', city: 'Chennai', state: 'Tamil Nadu',
      createdBy: userId, createdByName: actor.userName, updatedBy: userId, updatedByName: actor.userName,
    });
    await seedChartOfAccounts(SID, actor.userId, actor.userName);
    await getOrCreatePolicy(SID, actor.userId, actor.userName);

    // ---------------------------------------------------- D1 budget upsert
    console.log('D1 — setting a budget');
    const draft = await upsertBudget(SID, {
      fy: '2026',
      lines: [
        { accountCode: '4100', budgetedPaise: 100_000_000 }, // ₹10,00,000 maintenance
        { accountCode: '5100', budgetedPaise: 40_000_000 },  // ₹4,00,000 security
        { accountCode: '5140', budgetedPaise: 20_000_000 },  // ₹2,00,000 repairs
        { accountCode: '5150', budgetedPaise: 10_000_000 },  // ₹1,00,000 lift AMC — never spent
      ],
    }, actor);
    eq('a budget is stored against the resolved financial year', draft.financialYear, '2026-2027');
    eq('…with every line', draft.lines.length, 4);
    eq('…starting as a draft', draft.status, 'DRAFT');
    // The name is taken off the ledger, never from the caller, so a budget can't
    // print a head the chart of accounts has never had.
    eq('…naming each head from the chart of accounts', draft.lines.find(l => l.accountCode === '5100')?.accountName, 'Security / Guard Charges');

    // Idempotency: the same input twice must leave ONE budget, unchanged.
    const again = await upsertBudget(SID, {
      fy: '2026',
      lines: [
        { accountCode: '4100', budgetedPaise: 100_000_000 },
        { accountCode: '5100', budgetedPaise: 40_000_000 },
        { accountCode: '5140', budgetedPaise: 20_000_000 },
        { accountCode: '5150', budgetedPaise: 10_000_000 },
      ],
    }, actor);
    eq('re-saving the same budget is idempotent — still one document', await Budget.countDocuments({ societyId }), 1);
    eq('…the same document', String(again._id), String(draft._id));
    eq('…with the same lines', again.lines.length, 4);
    eq('…and the same figures', again.lines.reduce((s, l) => s + l.budgetedPaise, 0), 170_000_000);
    // '2026' and '2026-2027' are the same year — resolving them differently would
    // silently give the society two budgets for one year.
    await upsertBudget(SID, { fy: '2026-2027', lines: [{ accountCode: '4100', budgetedPaise: 100_000_000 }] }, actor);
    eq("…and '2026-2027' means the same year as '2026'", await Budget.countDocuments({ societyId }), 1);

    // Editing replaces the line set — a removed row must actually go.
    const trimmed = await getBudget(SID, '2026');
    eq('editing replaces the lines rather than merging them', trimmed?.lines.length, 1);

    // Put the real budget back for the golden case.
    await upsertBudget(SID, {
      fy: '2026',
      lines: [
        { accountCode: '4100', budgetedPaise: 100_000_000 },
        { accountCode: '5100', budgetedPaise: 40_000_000 },
        { accountCode: '5140', budgetedPaise: 20_000_000 },
        { accountCode: '5150', budgetedPaise: 10_000_000 },
      ],
    }, actor);

    const dupe = await refuses(() => upsertBudget(SID, {
      fy: '2026', lines: [{ accountCode: '5100', budgetedPaise: 1 }, { accountCode: '5100', budgetedPaise: 2 }],
    }, actor));
    ok('an account cannot be budgeted twice in one budget', /listed twice/i.test(dupe?.message || ''), dupe?.message);

    // Only revenue accounts have an actual to compare against.
    const notRevenue = await refuses(() => upsertBudget(SID, { fy: '2026', lines: [{ accountCode: '1100', budgetedPaise: 100 }] }, actor));
    ok('a balance-sheet account cannot be budgeted', /not an income or expense account/i.test(notRevenue?.message || ''), notRevenue?.message);
    const nonsense = await refuses(() => upsertBudget(SID, { fy: '2026', lines: [{ accountCode: '9999', budgetedPaise: 100 }] }, actor));
    ok('…nor can an account that does not exist', /cannot be budgeted/i.test(nonsense?.message || ''), nonsense?.message);

    // ---------------------------------------------------- D2 unknown FY
    console.log('\nD2 — an unknown financial year is rejected, not guessed');
    // `new Date(26, ...)` is 1926 under JS's two-digit-year rule, so a lenient
    // parse here would answer with an all-zero budget labelled 1926-1927.
    const shortFy = await refuses(() => upsertBudget(SID, { fy: '26', lines: [] }, actor));
    ok("'26' is rejected rather than read as 1926", /invalid financial year/i.test(shortFy?.message || ''), shortFy?.message);
    eq('…as a caller error, not a server fault', (shortFy as any)?.status, 400);
    const banana = await refuses(() => budgetVsActual(SID, { fy: 'banana' }));
    ok('Budget vs Actual rejects a nonsense year too', /invalid financial year/i.test(banana?.message || ''), banana?.message);
    eq('…also as a 400', (banana as any)?.status, 400);
    const packFy = await refuses(() => buildAgmPack(SID, { fy: 'banana' }));
    ok('…and so does the AGM pack', /invalid financial year/i.test(packFy?.message || ''), packFy?.message);

    // ---------------------------------------------------- D3 the golden case
    // Hand-calculated. FY 2026-2027 runs 1 Apr 2026 – 31 Mar 2027.
    //
    //   Income
    //     4100 Maintenance    budget ₹10,00,000  actual ₹12,00,000  → ₹2,00,000 over,  +20.00%  favourable
    //   Expenditure
    //     5100 Security       budget ₹4,00,000   actual ₹3,00,000   → ₹1,00,000 under, −25.00%  favourable
    //     5120 Electricity    budget —           actual ₹50,000     → ₹50,000 over,    n/a      UNBUDGETED
    //     5140 Repairs        budget ₹2,00,000   actual ₹2,50,000   → ₹50,000 over,    +25.00%  adverse
    //     5150 Lift AMC       budget ₹1,00,000   actual ₹0          → ₹1,00,000 under, −100.00% favourable
    //
    //   Income totals      budget ₹10,00,000  actual ₹12,00,000  variance +₹2,00,000  +20.00%
    //   Expenditure totals budget ₹7,00,000   actual ₹6,00,000    variance −₹1,00,000  −14.29%
    //   Planned surplus ₹3,00,000 · actual surplus ₹6,00,000
    console.log('\nD3 — variance maths on a hand-calculated golden case');
    await post('4100', 120_000_000, new Date(2026, 5, 10), 'maintenance collected');
    await post('5100', 30_000_000, new Date(2026, 6, 5), 'security');
    await post('5140', 25_000_000, new Date(2026, 7, 20), 'repairs');
    await post('5120', 5_000_000, new Date(2026, 8, 1), 'electricity — never budgeted');

    const bva = await budgetVsActual(SID, { fy: '2026' });
    ok('the report knows a budget exists', bva.hasBudget);
    eq('…for the right year', bva.period.financialYear, '2026-2027');

    const income = bva.income.rows.find(r => r.code === '4100')!;
    eq('income: the budget is what was set', income.budgetedPaise, 100_000_000);
    eq('income: the actual comes off the ledger', income.actualPaise, 120_000_000);
    eq('income: variance is actual − budget', income.variancePaise, 20_000_000);
    eq('income: …as a percentage of the budget', income.variancePercent, 20);
    ok('income: earning more than budgeted is good news', income.favourable);

    const byCode = new Map(bva.expenses.rows.map(r => [r.code, r]));
    eq('spend: coming in under budget is a negative variance', byCode.get('5100')?.variancePaise, -10_000_000);
    eq('spend: …at −25%', byCode.get('5100')?.variancePercent, -25);
    ok('spend: …and that is good news', !!byCode.get('5100')?.favourable);
    eq('spend: overspending is a positive variance', byCode.get('5140')?.variancePaise, 5_000_000);
    eq('spend: …at +25%', byCode.get('5140')?.variancePercent, 25);
    // The same sign means opposite things by section — this is the whole reason
    // `favourable` exists rather than leaving the reader to infer it.
    ok('spend: …and that is NOT good news, though the sign matches income’s', !byCode.get('5140')?.favourable);
    ok('the identical +variance sign reads differently by section',
      income.variancePaise > 0 && byCode.get('5140')!.variancePaise > 0
      && income.favourable && !byCode.get('5140')!.favourable);
    eq('spend: a budgeted head with nothing spent is 100% under', byCode.get('5150')?.variancePercent, -100);
    eq('…which is the whole budget unspent', byCode.get('5150')?.variancePaise, -10_000_000);

    // An unbudgeted spend is exactly what a committee needs to see.
    const unbudgeted = byCode.get('5120');
    ok('an account with actuals but no budget still appears', !!unbudgeted, JSON.stringify([...byCode.keys()]));
    eq('…flagged as unbudgeted', unbudgeted?.unbudgeted, true);
    eq('…with nothing budgeted', unbudgeted?.budgetedPaise, 0);
    eq('…and the spend shown in full', unbudgeted?.actualPaise, 5_000_000);
    // A percentage of a zero budget is a division by zero, not "0%" or "∞%".
    eq('…and no percentage, because a percentage of nothing means nothing', unbudgeted?.variancePercent, null);
    ok('…while a budgeted head is not flagged', !byCode.get('5140')?.unbudgeted);
    eq('the unbudgeted spend is totalled for the committee', bva.unbudgetedSpendPaise, 5_000_000);

    eq('income totals foot', bva.income.budgetedPaise, 100_000_000);
    eq('…to the actual as well', bva.income.actualPaise, 120_000_000);
    eq('expenditure budget totals foot (₹4L + ₹2L + ₹1L)', bva.expenses.budgetedPaise, 70_000_000);
    eq('…and include the unbudgeted spend in the actual (₹3L + ₹0.5L + ₹2.5L)', bva.expenses.actualPaise, 60_000_000);
    eq('expenditure came in ₹1,00,000 under overall', bva.expenses.variancePaise, -10_000_000);
    eq('…which is −14.29%, rounded to two places', bva.expenses.variancePercent, -14.29);
    eq('the planned surplus is budgeted income less budgeted spend', bva.budgetedSurplusPaise, 30_000_000);
    eq('the actual surplus is what really happened', bva.actualSurplusPaise, 60_000_000);
    // The pack prints Budget vs Actual next to the Income & Expenditure; if they
    // read the ledger differently the two pages would contradict each other.
    const ie = await incomeExpenditure(SID, { fy: '2026' });
    eq('the actuals tie to the Income & Expenditure’s income', bva.income.actualPaise, ie.totalIncomePaise);
    eq('…and to its expenditure', bva.expenses.actualPaise, ie.totalExpensePaise);
    eq('…so the surplus agrees too', bva.actualSurplusPaise, ie.surplusPaise);

    // A head with neither a budget nor a rupee through it is noise.
    ok('untouched, unbudgeted heads are left off', !byCode.has('5110') && !bva.income.rows.some(r => r.code === '4210'));

    // ---------------------------------------------------- D4 the FY window
    console.log('\nD4 — the financial year actually scopes the actuals');
    // Post to the SAME account in the PREVIOUS FY. If the window were ignored
    // (or cached balances read), this would land in 2026-27's actual.
    await post('5100', 99_999_900, new Date(2025, 6, 5), 'security in the previous FY');
    const scoped = await budgetVsActual(SID, { fy: '2026' });
    eq('a prior-year entry does not leak into this year’s actual',
      scoped.expenses.rows.find(r => r.code === '5100')?.actualPaise, 30_000_000);
    eq('…so the variance is unchanged', scoped.expenses.rows.find(r => r.code === '5100')?.variancePaise, -10_000_000);
    eq('…and the section total is unchanged', scoped.expenses.actualPaise, 60_000_000);

    // …and the money really is on the books, just in the other year.
    const prior = await budgetVsActual(SID, { fy: '2025' });
    eq('the prior year reports the prior year’s spend', prior.expenses.rows.find(r => r.code === '5100')?.actualPaise, 99_999_900);
    ok('…where no budget was ever set', !prior.hasBudget);
    eq('…so it counts as unbudgeted there', prior.expenses.rows.find(r => r.code === '5100')?.unbudgeted, true);
    const tbAll = await trialBalance(SID);
    eq('both years together are what the ledger holds',
      tbAll.rows.find(r => r.code === '5100')?.debitPaise, 30_000_000 + 99_999_900);

    // ---------------------------------------------------- D5 approval
    console.log('\nD5 — approving the budget');
    const approved = await approveBudget(SID, '2026', actor);
    eq('approving marks it approved', approved.status, 'APPROVED');
    eq('…recording who', approved.approvedByName, 'Verifier');
    ok('…and when', !!approved.approvedAt);
    const twice = await refuses(() => approveBudget(SID, '2026', actor));
    ok('a budget cannot be approved twice', /already approved/i.test(twice?.message || ''), twice?.message);
    eq('…as a conflict', (twice as any)?.status, 409);
    const missing = await refuses(() => approveBudget(SID, '2030', actor));
    ok('a year with no budget cannot be approved', /no budget/i.test(missing?.message || ''), missing?.message);
    eq('…which is a 404', (missing as any)?.status, 404);

    eq('the variance report carries the approval through', (await budgetVsActual(SID, { fy: '2026' })).status, 'APPROVED');

    // Editing an approved budget must not leave it claiming an approval the
    // general body never gave to those figures.
    await upsertBudget(SID, {
      fy: '2026',
      lines: [
        { accountCode: '4100', budgetedPaise: 100_000_000 },
        { accountCode: '5100', budgetedPaise: 40_000_000 },
        { accountCode: '5140', budgetedPaise: 20_000_000 },
        { accountCode: '5150', budgetedPaise: 10_000_000 },
      ],
    }, actor);
    const edited = await getBudget(SID, '2026');
    eq('editing an approved budget puts it back into draft', edited?.status, 'DRAFT');
    eq('…and clears the stale approver', edited?.approvedByName, undefined);
    ok('…and the stale approval date', !edited?.approvedAt);
    await approveBudget(SID, '2026', actor); // re-approve for the pack below

    const list = await listBudgets(SID);
    eq('the year is listed for the picker', list.length, 1);
    eq('…with its total', list[0].totalBudgetedPaise, 170_000_000);
    const ws = await budgetWorkspace(SID, { fy: '2026' });
    eq('the page loads the year in one call', ws.financialYear, '2026-2027');
    ok('…with every budgetable head to seed from', ws.accounts.length > 10);
    eq('…and last year named for the seed button', ws.previousFinancialYear, '2025-2026');
    // Societies budget off last year's actuals — that is what the seed offers.
    eq('…carrying last year’s actual for each head',
      ws.accounts.find(a => a.accountCode === '5100')?.previousActualPaise, 99_999_900);

    // ---------------------------------------------------- D6 the AGM pack
    console.log('\nD6 — the AGM pack');
    const pack = await buildAgmPack(SID, { fy: '2026' });
    eq('the pack is one document', pack.title, 'Annual General Meeting Pack');
    eq('…for the society', pack.societyName, SOCIETY_NAME);
    ok('…carrying its registration number', (pack.meta || []).some(m => /TNA\/VER\/2026/.test(m)), JSON.stringify(pack.meta));
    ok('…and the financial year', (pack.meta || []).some(m => /2026-2027/.test(m)), JSON.stringify(pack.meta));

    const titles = pack.sections.map(s => s.title || '');
    const has = (name: string) => titles.some(t => t.startsWith(name));
    ok('it opens with a cover listing what is inside', titles[0] === 'What this pack contains');
    ok('…a Balance Sheet', has('Balance Sheet'), JSON.stringify(titles));
    ok('…an Income & Expenditure', has('Income & Expenditure'), JSON.stringify(titles));
    ok('…a Receipts & Payments', has('Receipts & Payments'), JSON.stringify(titles));
    ok('…a Fund Statement', has('Fund Statement'), JSON.stringify(titles));
    ok('…a Budget vs Actual', has('Budget vs Actual'), JSON.stringify(titles));
    ok('…and a defaulter summary', has('Outstanding Dues'), JSON.stringify(titles));
    // Every section must name its statement — 'Assets' alone is meaningless when
    // six statements follow one another in a single document.
    ok('every section names the statement it belongs to', pack.sections.every(s => !!s.title), JSON.stringify(titles));

    // The Balance Sheet's schedules must survive into the pack, or the pack's
    // sheet is not the sheet the treasurer signed off.
    const assets = pack.sections.find(s => s.title === 'Balance Sheet · Assets')!;
    ok('the pack’s Balance Sheet keeps its schedules',
      assets.rows.some(r => String(r[0]).startsWith('    ')), JSON.stringify(assets.rows.map(r => r[0])));

    // Nothing is recomputed: the pack's figures must be the standalone report's.
    const standalone = buildExportDoc('budget-vs-actual', await budgetVsActual(SID, { fy: '2026' }), SOCIETY_NAME);
    const packBudget = pack.sections.find(s => s.title === 'Budget vs Actual · Expenditure')!;
    eq('…and the pack shows exactly what the standalone report shows',
      JSON.stringify(packBudget.rows), JSON.stringify(standalone.sections.find(s => s.title === 'Expenditure')!.rows));

    const pdf = await renderPdf(pack);
    eq('the pack renders as a real PDF', pdf.subarray(0, 4).toString('latin1'), '%PDF');
    ok('…of a plausible size for six statements', pdf.length > 5000, `${pdf.length} bytes`);

    // A society with no budget gets a pack without that statement, not a page of
    // 100%-shortfall rows against targets it never set.
    await Budget.deleteMany({ societyId });
    const bare = await buildAgmPack(SID, { fy: '2026' });
    ok('a society with no budget gets a pack without the budget statement',
      !bare.sections.some(s => (s.title || '').startsWith('Budget vs Actual')));
    ok('…but every other statement is still there',
      ['Balance Sheet', 'Income & Expenditure', 'Receipts & Payments', 'Fund Statement', 'Outstanding Dues']
        .every(n => bare.sections.some(s => (s.title || '').startsWith(n))));
    eq('…and it still renders', (await renderPdf(bare)).subarray(0, 4).toString('latin1'), '%PDF');
    ok('…and the cover no longer promises it',
      !bare.sections[0].rows.some(r => String(r[0]) === 'Budget vs Actual'));

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
