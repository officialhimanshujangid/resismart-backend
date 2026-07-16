import { ExportDoc, ExportSection, Cell, money } from './report-export.service';
import { buildExportDoc } from './report-doc.builder';
import { balanceSheet, incomeExpenditure, receiptsAndPayments, fundStatement, defaulters } from './reports.service';
import { budgetVsActual } from './budget.service';
import { resolveFinancialYear } from './reporting-period.service';
import { Society } from '../models/society.model';

/**
 * The AGM pack — every statement a society must lay before its annual general
 * meeting, in one document.
 *
 * Societies were exporting six PDFs one at a time and stapling them, which is
 * how a pack goes out with the Balance Sheet from one run and the Income &
 * Expenditure from another — two statements that no longer tie. Building them in
 * a single pass off the same ledger read makes that impossible.
 *
 * Nothing here is recomputed: every figure comes from the report services and is
 * rendered by `buildExportDoc`, so a statement in the pack is character-for-
 * character the statement the treasurer downloaded on its own. A total assembled
 * a second time here would eventually disagree with the first.
 */

const date = (d?: string | Date) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

/**
 * Re-title a statement's sections so each one names the statement it belongs to.
 *
 * On its own a section reads 'Assets' — unambiguous in a Balance Sheet PDF, but
 * meaningless in a forty-page pack where six statements follow each other.
 */
const statement = (name: string, doc: ExportDoc): ExportSection[] =>
  doc.sections.map(s => ({ ...s, title: s.title ? `${name} · ${s.title}` : name }));

export interface AgmPackOptions {
  fy?: string;
  fyStartMonth?: number;
}

export async function buildAgmPack(societyId: string, opts: AgmPackOptions = {}): Promise<ExportDoc> {
  const startMonth = opts.fyStartMonth ?? 4;
  // Resolve once and pass the resolved year to every statement. Letting each
  // call default to "the FY containing now" would tear the pack across midnight
  // on 31 March — half the statements in one year, half in the next.
  const fy = resolveFinancialYear(opts.fy, startMonth);

  const [society, bs, ie, rp, funds, budget, dues] = await Promise.all([
    Society.findById(societyId).select('name registrationNumber city state').lean(),
    balanceSheet(societyId, { fy: fy.fyString, fyStartMonth: startMonth }),
    incomeExpenditure(societyId, { fy: fy.fyString, fyStartMonth: startMonth }),
    receiptsAndPayments(societyId, fy.fyStart.toISOString(), fy.fyEnd.toISOString()),
    fundStatement(societyId, { asOf: fy.fyEnd.toISOString() }),
    budgetVsActual(societyId, { fy: fy.fyString, fyStartMonth: startMonth }),
    // Deliberately as at TODAY, not as at the year end. `defaulters` reads each
    // invoice's live `outstandingPaise`, so an as-of date would age those live
    // figures against a historical date — a register whose ageing claims one
    // date and whose amounts mean another. One consistent basis is worth more
    // than a year-end label the data cannot support.
    defaulters(societyId),
  ]);

  const societyName = society?.name || 'Society';

  const contents: Cell[][] = [
    ['Balance Sheet', `As at ${date(bs.asOf)}`],
    ['Income & Expenditure Account', `FY ${fy.fyString}`],
    ['Receipts & Payments Account', `${date(fy.fyStart)} to ${date(fy.fyEnd)}`],
    ['Fund Statement', `As at ${date(fy.fyEnd)}`],
    ...(budget.hasBudget ? [['Budget vs Actual', `FY ${fy.fyString}`] as Cell[]] : []),
    ['Outstanding Dues (summary)', `As at ${date(dues.asOf)}`],
  ];

  const sections: ExportSection[] = [
    {
      title: 'What this pack contains',
      columns: ['Statement', 'Period'],
      rows: contents,
    },
    ...statement('Balance Sheet', buildExportDoc('balance-sheet', bs, societyName)),
    ...statement('Income & Expenditure', buildExportDoc('income-expenditure', ie, societyName)),
    ...statement('Receipts & Payments', buildExportDoc('receipts-payments', rp, societyName)),
    ...statement('Fund Statement', buildExportDoc('fund-statement', funds, societyName)),
    // Omitted rather than shown empty: a society that never set a budget would
    // otherwise get a page of 100%-shortfall rows implying it missed targets it
    // never set.
    ...(budget.hasBudget ? statement('Budget vs Actual', buildExportDoc('budget-vs-actual', budget, societyName)) : []),
    duesSummary(dues),
  ];

  const meta = [
    ...(society?.registrationNumber ? [`Reg. No. ${society.registrationNumber}`] : []),
    ...(society?.city ? [[society.city, society.state].filter(Boolean).join(', ')] : []),
    `Financial year ${fy.fyString} · ${date(fy.fyStart)} to ${date(fy.fyEnd)}`,
    bs.balanced ? 'Balance Sheet balances' : `Balance Sheet is out by ${money(Math.abs(bs.differencePaise))} — post the society's opening balances`,
  ];

  return {
    title: 'Annual General Meeting Pack',
    subtitle: `Annual accounts for the financial year ${fy.fyString}`,
    societyName,
    meta,
    sections,
  };
}

/**
 * Outstanding dues by age — the summary, not the register.
 *
 * The full flat-by-flat list runs to hundreds of rows and names individual
 * members; what the meeting needs is how much is owed and how stale it is. The
 * committee can pull the Defaulter Register itself for the detail.
 */
function duesSummary(dues: Awaited<ReturnType<typeof defaulters>>): ExportSection {
  const flatsIn = (pick: (b: typeof dues.buckets) => number) => dues.rows.filter(r => pick(r.buckets) > 0).length;
  return {
    title: 'Outstanding Dues · Summary by age',
    columns: ['Age of the dues', 'Flats', 'Amount'],
    moneyColumns: [2],
    rows: [
      ['Not yet due / up to 30 days', flatsIn(b => b.current), money(dues.buckets.current)],
      ['31 to 60 days', flatsIn(b => b.d31_60), money(dues.buckets.d31_60)],
      ['61 to 90 days', flatsIn(b => b.d61_90), money(dues.buckets.d61_90)],
      ['Over 90 days', flatsIn(b => b.d90plus), money(dues.buckets.d90plus)],
    ],
    footer: ['Total outstanding', dues.rows.length, money(dues.totalPaise)],
  };
}
