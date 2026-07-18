import { ExportDoc, ExportSection, Cell, money } from './report-export.service';

/**
 * Turns each report's payload into a printable document. Kept apart from the
 * PDF/XLSX renderers so both formats show identical figures — if a total were
 * computed per-format they could drift, and an auditor comparing the PDF against
 * the spreadsheet would find two different statements.
 */

const date = (d?: string | Date) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

/** Rows with a previous-year comparative column. */
const comparative = (title: string, rows: any[], totalLabel: string, totalPaise: number, previousTotalPaise: number, prevLabel: string): ExportSection => ({
  title,
  columns: ['Particulars', 'Amount', prevLabel],
  rows: rows.map(r => [r.name, money(r.amountPaise), money(r.previousAmountPaise)] as Cell[]),
  footer: [totalLabel, money(totalPaise), money(previousTotalPaise)],
});

/**
 * Balance-sheet rows, flattening a heading's children beneath it so the export
 * shows the same schedule the screen does — Fixed Assets net of depreciation,
 * with the accounts indented under it.
 */
const scheduleRows = (rows: any[]): Cell[][] =>
  rows.flatMap(r => [
    [r.name, money(r.amountPaise), money(r.previousAmountPaise)] as Cell[],
    ...(r.children || []).map((c: any) => [`    ${c.name}`, money(c.amountPaise), money(c.previousAmountPaise)] as Cell[]),
  ]);

export const REPORT_TITLES: Record<string, string> = {
  'trial-balance': 'Trial Balance',
  'income-expenditure': 'Income & Expenditure Statement',
  'wing-wise': 'Wing-wise Income & Expenditure',
  'balance-sheet': 'Balance Sheet',
  'receipts-payments': 'Receipts & Payments Account',
  defaulters: 'Defaulter Register',
  'collection-register': 'Collection Register',
  'fund-statement': 'Fund Statement',
  'gst-register': 'GST Output Register',
  'vendor-register': 'Vendor Register',
  'tds-register': 'TDS Register',
  'budget-vs-actual': 'Budget vs Actual',
};

/** '—' rather than a bare 0%: nothing was budgeted, which is not the same as 0% off. */
const variancePct = (v: number | null): Cell => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);

/**
 * One Budget vs Actual section. The variance column is `actual − budget` on
 * every row, and `over` / `under` names the direction in words — the sign alone
 * reads as good news in the income section and bad news in the expenditure
 * section, and the export has no colour to lean on.
 */
export const budgetSection = (title: string, section: any): ExportSection => ({
  title,
  columns: ['Particulars', 'Budgeted', 'Actual', 'Variance', 'Variance %'],
  moneyColumns: [1, 2, 3],
  rows: section.rows.map((r: any) => [
    `${r.name}${r.unbudgeted ? ' (not budgeted)' : ''}`,
    money(r.budgetedPaise),
    money(r.actualPaise),
    `${money(Math.abs(r.variancePaise))} ${r.variancePaise === 0 ? '' : r.variancePaise > 0 ? 'over' : 'under'}`.trim(),
    variancePct(r.variancePercent),
  ] as Cell[]),
  footer: [
    'Total',
    money(section.budgetedPaise),
    money(section.actualPaise),
    `${money(Math.abs(section.variancePaise))} ${section.variancePaise === 0 ? '' : section.variancePaise > 0 ? 'over' : 'under'}`.trim(),
    variancePct(section.variancePercent),
  ],
});

export function buildExportDoc(key: string, data: any, societyName: string): ExportDoc {
  const title = REPORT_TITLES[key] || key;
  const base = { title, societyName } as ExportDoc;

  switch (key) {
    case 'trial-balance': {
      const sections: ExportSection[] = [{
        columns: ['Account', 'Debit', 'Credit'],
        rows: data.rows.map((r: any) => [`${r.code} · ${r.name}`, money(r.debitPaise), money(r.creditPaise)]),
        footer: ['Total', money(data.totalDebitPaise), money(data.totalCreditPaise)],
      }];
      if (data.drift?.length) {
        sections.push({
          title: 'Accounts drifted from the ledger',
          columns: ['Account', 'Shown', 'Per ledger', 'Drift'],
          rows: data.drift.map((d: any) => [`${d.code} · ${d.name}`, money(d.cachedBalancePaise), money(d.ledgerBalancePaise), money(d.driftPaise)]),
        });
      }
      return { ...base, meta: [data.drift?.length ? `${data.drift.length} account(s) drifted from the ledger` : 'All balances match the posted entries'], sections };
    }

    case 'income-expenditure': {
      const prev = data.period?.previousFinancialYear || 'Previous';
      const surplus = data.surplusPaise >= 0 ? 'Surplus' : 'Deficit';
      return {
        ...base,
        subtitle: `For the financial year ${data.period?.financialYear}`,
        meta: [`Comparatives: ${prev}`],
        sections: [
          comparative('Income', data.income, 'Total Income', data.totalIncomePaise, data.previousTotalIncomePaise, prev),
          comparative('Expenditure', data.expenses, 'Total Expenditure', data.totalExpensePaise, data.previousTotalExpensePaise, prev),
          {
            columns: ['', 'Amount', prev],
            rows: [],
            footer: [`${surplus} for the year`, money(Math.abs(data.surplusPaise)), money(Math.abs(data.previousTotalIncomePaise - data.previousTotalExpensePaise))],
          },
        ],
      };
    }

    case 'wing-wise': {
      const columns = [...(data.wings || []), data.common].filter(Boolean);
      return {
        ...base,
        subtitle: `For the financial year ${data.period?.financialYear}`,
        meta: ['Common costs are shown separately, not apportioned across wings.'],
        sections: [
          {
            title: 'Summary',
            columns: ['Wing', 'Income', 'Expenditure', 'Surplus / (Deficit)'],
            rows: columns.map((c: any) => [c.label, money(c.totalIncomePaise), money(c.totalExpensePaise), money(c.surplusPaise)]),
            footer: ['Total', money(data.totals?.totalIncomePaise || 0), money(data.totals?.totalExpensePaise || 0), money(data.totals?.surplusPaise || 0)],
          },
          ...columns.flatMap((c: any) => {
            const rows = [
              ...c.income.map((l: any) => ['Income', l.name, money(l.amountPaise)]),
              ...c.expenses.map((l: any) => ['Expenditure', l.name, money(l.amountPaise)]),
            ];
            if (!rows.length) return [];
            return [{
              title: c.label,
              columns: ['', 'Head', 'Amount'],
              rows,
              footer: ['', 'Surplus / (Deficit)', money(c.surplusPaise)],
            }];
          }),
        ],
      };
    }

    case 'vendor-register': {
      return {
        ...base,
        meta: [
          data.missingPanCount
            ? `${data.missingPanCount} TDS vendor(s) have no PAN — Form 26Q cannot be filed for them`
            : 'Every TDS vendor has a PAN on record',
          'Outstanding is the balance owed today, not a figure for the period.',
        ],
        sections: [{
          columns: ['Vendor', 'PAN', 'TDS', 'Bills', 'Billed', 'TDS withheld', 'Paid', 'Outstanding'],
          moneyColumns: [4, 5, 6, 7],
          rows: data.rows.map((r: any) => [
            `${r.name}${r.isActive ? '' : ' (inactive)'}`,
            r.pan || (r.missingPan ? 'MISSING' : '—'),
            r.tds || '—',
            String(r.bills),
            money(r.billedPaise),
            money(r.tdsPaise),
            money(r.paidPaise),
            money(r.outstandingPaise),
          ] as Cell[]),
          footer: [
            'Total', '', '', '',
            money(data.totals.billedPaise),
            money(data.totals.tdsPaise),
            money(data.totals.paidPaise),
            money(data.totals.outstandingPaise),
          ],
        }],
      };
    }

    case 'balance-sheet': {
      const prev = data.previous?.financialYear || 'Previous';
      const funding = [...data.liabilities, ...data.funds, ...data.equity];
      return {
        ...base,
        subtitle: `As at ${date(data.asOf)}`,
        meta: [`Financial year ${data.financialYear}`, data.balanced ? 'Balanced' : `Out of balance by ${money(Math.abs(data.differencePaise))}`],
        sections: [
          {
            title: 'Assets',
            columns: ['Particulars', 'Amount', prev],
            rows: scheduleRows(data.assets),
            footer: ['Total Assets', money(data.assetsTotalPaise), money(data.previous?.assetsTotalPaise || 0)],
          },
          {
            title: 'Liabilities, Funds & Surplus',
            columns: ['Particulars', 'Amount', prev],
            rows: [
              ...scheduleRows(funding),
              ['Accumulated Surplus (brought forward)', money(data.accumulatedSurplusPaise), ''],
              [`Surplus for ${data.financialYear}`, money(data.currentSurplusPaise), ''],
            ],
            footer: ['Total', money(data.liabilitiesPlusFundsPlusEquityPaise), money(data.previous?.liabilitiesPlusFundsPlusEquityPaise || 0)],
          },
        ],
      };
    }

    case 'receipts-payments':
      return {
        ...base,
        meta: [`Opening cash & bank ${money(data.openingPaise)} · Closing ${money(data.closingPaise)}`],
        sections: [
          { title: 'Receipts', columns: ['Head', 'Amount'], rows: data.receipts.map((r: any) => [r.name, money(r.amountPaise)]), footer: ['Total Receipts', money(data.totalReceiptsPaise)] },
          { title: 'Payments', columns: ['Head', 'Amount'], rows: data.payments.map((r: any) => [r.name, money(r.amountPaise)]), footer: ['Total Payments', money(data.totalPaymentsPaise)] },
        ],
      };

    case 'defaulters':
      return {
        ...base,
        subtitle: `As at ${date(data.asOf)}`,
        sections: [{
          columns: ['Flat', 'Owner', 'Not due / ≤30d', '31-60d', '61-90d', '90d+', 'Total'],
          rows: data.rows.map((r: any) => [
            `${r.blockName} ${r.flatNumber}`, r.ownerName || '—',
            money(r.buckets.current), money(r.buckets.d31_60), money(r.buckets.d61_90), money(r.buckets.d90plus),
            money(r.outstandingPaise),
          ]),
          footer: ['Total', '', money(data.buckets.current), money(data.buckets.d31_60), money(data.buckets.d61_90), money(data.buckets.d90plus), money(data.totalPaise)],
        }],
      };

    case 'collection-register':
      return {
        ...base,
        sections: [{
          columns: ['Receipt', 'Date', 'Flat', 'Mode', 'Amount'],
          rows: data.rows.map((r: any) => [r.receiptNumber, date(r.receiptDate), `${r.blockName || ''} ${r.flatNumber || ''}`.trim(), r.mode, money(r.amountPaise)]),
          footer: ['Total', '', '', '', money(data.totalPaise)],
        }],
      };

    case 'budget-vs-actual': {
      const surplusVariance = data.actualSurplusPaise - data.budgetedSurplusPaise;
      return {
        ...base,
        subtitle: `For the financial year ${data.period?.financialYear}`,
        meta: [
          data.hasBudget
            ? `Budget ${data.status === 'APPROVED' ? `approved by ${data.approvedByName || 'the committee'} on ${date(data.approvedAt)}` : 'not yet approved (draft)'}`
            : `No budget was set for ${data.period?.financialYear}`,
          ...(data.unbudgetedSpendPaise ? [`${money(data.unbudgetedSpendPaise)} spent on heads that were never budgeted`] : []),
        ],
        sections: [
          budgetSection('Income', data.income),
          budgetSection('Expenditure', data.expenses),
          {
            columns: ['', 'Budgeted', 'Actual', 'Variance', ''],
            rows: [],
            footer: [
              'Surplus / (deficit) for the year',
              money(data.budgetedSurplusPaise),
              money(data.actualSurplusPaise),
              `${money(Math.abs(surplusVariance))} ${surplusVariance === 0 ? '' : surplusVariance > 0 ? 'better' : 'worse'}`.trim(),
              '',
            ],
          },
        ],
      };
    }

    case 'fund-statement':
      return {
        ...base,
        sections: [{
          columns: ['Fund', 'Balance'],
          rows: data.rows.map((r: any) => [`${r.code} · ${r.name}`, money(r.balancePaise)]),
          footer: ['Total Funds', money(data.totalPaise)],
        }],
      };

    case 'gst-register':
      return {
        ...base,
        meta: [`Taxable value ${money(data.totalTaxableValuePaise)} · GST ${money(data.totalGstPaise)}`],
        sections: [
          {
            title: 'Month-wise summary',
            columns: ['Month', 'Invoices', 'Taxable value', 'CGST', 'SGST', 'Total GST'],
            rows: data.months.map((m: any) => [m.month, m.invoices, money(m.taxableValuePaise), money(m.cgstPaise), money(m.sgstPaise), money(m.gstPaise)]),
            footer: ['Total', data.rows.length, money(data.totalTaxableValuePaise), '', '', money(data.totalGstPaise)],
          },
          {
            title: 'Invoice-wise detail',
            columns: ['Invoice', 'Date', 'Flat', 'SAC', 'Rate %', 'Taxable value', 'CGST', 'SGST'],
            rows: data.rows.map((r: any) => [r.invoiceNumber, date(r.invoiceDate), r.flat, r.sacCode || '', r.ratePercent ?? '', money(r.taxableValuePaise), money(r.cgstPaise), money(r.sgstPaise)]),
          },
        ],
      };

    case 'tds-register':
      return {
        ...base,
        meta: [
          `${data.deductions} deduction(s) · TDS ${money(data.totalTdsPaise)}`,
          ...(data.missingPan?.length ? [`PAN missing for: ${data.missingPan.join(', ')}`] : []),
        ],
        sections: [
          {
            title: 'Deductee-wise (Form 26Q)',
            columns: ['Deductee', 'PAN', 'Section', 'Deductions', 'Gross paid', 'TDS'],
            rows: data.deductees.map((d: any) => [d.vendorName, d.pan || '— missing —', d.section || '—', d.deductions, money(d.grossPaise), money(d.tdsPaise)]),
            footer: ['Total', '', '', data.deductions, money(data.totalGrossPaise), money(data.totalTdsPaise)],
          },
          {
            title: 'Quarter-wise',
            columns: ['Quarter', 'Deductions', 'TDS'],
            rows: data.quarters.map((q: any) => [q.quarter, q.deductions, money(q.tdsPaise)]),
          },
          {
            title: 'Voucher-wise detail',
            columns: ['Voucher', 'Date', 'Deductee', 'Gross', 'TDS'],
            rows: data.rows.map((r: any) => [r.voucherNumber, date(r.expenseDate), r.vendorName, money(r.grossPaise), money(r.tdsPaise)]),
          },
        ],
      };

    default:
      throw new Error(`Invalid report '${key}'`);
  }
}
