/**
 * Every rupee sign on every PDF this backend generates.
 *
 * pdfkit's default font is Helvetica, one of the fourteen standard PDF fonts,
 * which carry no glyph data and are encoded in WinAnsi — 256 single-byte slots,
 * none of them '₹'. Handed U+20B9, pdfkit wrote the codepoint's two raw bytes
 * (0x20 0xB9) instead of one encoded glyph, and WinAnsi reads those back as a
 * space and a superscript one. Every amount on every invoice, receipt,
 * statement and defaulter notice a society sent its members therefore read
 * " ¹1,000.00" — including the Total Payable.
 *
 * Nothing about the bug is visible from the code: `money()` returns a correct
 * '₹1,000.00' and pdfkit accepts it without complaint. It only exists in the
 * bytes of the finished document. So the assertions read the finished document:
 * `pdfTextLines` inflates the content streams and puts the glyph ids back
 * through the font's own ToUnicode CMap — the same table a viewer uses when the
 * resident selects the amount and copies it.
 *
 * Four generators, because they were four separate copies of the same mistake:
 *
 *   1. the maintenance invoice a resident downloads,
 *   2. the payment receipt they get back,
 *   3. the platform's own subscription invoice to the society, and
 *   4. the statutory report renderer — which is also the Defaulter Notice, the
 *      AGM pack and every statement, since all of them are ExportDocs.
 *
 *   npx tsx src/scripts/verify-pdf-rupee.ts
 */
import '../config/timezone'; // MUST stay first
import { PassThrough } from 'stream';
import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import { pdfTextLines } from './lib/pdf-text';
import { registerPdfFonts, PDF_FONT } from '../utils/pdf-font.util';
import { buildInvoicePdf, INVOICE_COLUMNS } from '../services/society-invoice.service';
import { buildReceiptPdf } from '../services/receipt.service';
import InvoiceService from '../services/invoice.service';
import { sendPdf, money, ExportDoc } from '../services/report-export.service';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean | undefined, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};

const RUPEE = '₹';
/** What WinAnsi turned U+20B9 into: a space, then a superscript one. */
const MANGLED = ' ¹';

/** Assert a document renders its money as money, and says so out of the bytes. */
const assertRupees = (what: string, lines: string[], expected: string[]) => {
  const amounts = lines.filter(l => l.includes(RUPEE));
  ok(`${what}: the rupee sign survives to the page`, amounts.length > 0,
    `no line contains ₹ — sample: ${JSON.stringify(lines.slice(0, 12))}`);
  ok(`${what}: ...and nothing was mangled into ' ¹'`,
    !lines.some(l => l.includes(MANGLED)),
    JSON.stringify(lines.filter(l => l.includes(MANGLED))));
  for (const want of expected) {
    ok(`${what}: ...${want} is drawn as one unbroken figure`,
      lines.some(l => l.includes(want)),
      `not found — money lines: ${JSON.stringify(amounts)}`);
  }
};

/** A maintenance invoice, as the resident downloads it. */
const invoice = {
  invoiceNumber: 'INV/2026-27/00042',
  invoiceDate: new Date('2026-06-01'),
  dueDate: new Date('2026-06-10'),
  billingPeriod: '2026-06',
  flatNumber: 'A-101',
  blockName: 'A Wing',
  flatSizeLabel: '2BHK · 1200 sqft',
  primaryOwnerName: 'Anita Deshmukh',
  lineItems: [
    { code: 'MAINT', name: 'Maintenance Charges', category: 'MAINTENANCE', baseAmountPaise: 100_000, gstPaise: 18_000, lineTotalPaise: 118_000 },
    // A lakh-sized base in the narrowest column on the page: the figure has to
    // fit its box, or it wraps mid-number and reads as a typo.
    { code: 'SINK', name: 'Sinking Fund (special demand)', category: 'SINKING_FUND', baseAmountPaise: 10_000_000, gstPaise: 0, lineTotalPaise: 10_000_000 },
    { code: 'PARKING', name: 'Parking', category: 'PARKING', quantity: 2, ratePaise: 50_000, pricingMode: 'PER_QUANTITY', baseAmountPaise: 100_000, gstPaise: 0, lineTotalPaise: 100_000 },
  ],
  subTotalPaise: 10_200_000,
  gstPaise: 18_000,
  interestPaise: 5_000,
  openingArrearsPaise: 200_000,
  advanceAppliedPaise: 50_000,
  roundingPaise: 0,
  outstandingPaise: 10_373_000,
} as any;

/** The receipt that comes back when they pay it. */
const receipt = {
  receiptNumber: 'RCP/2026-27/00017',
  receiptDate: new Date('2026-06-08'),
  flatNumber: 'A-101',
  blockName: 'A Wing',
  amountPaise: 10_373_000,
  mode: 'UPI',
  status: 'CLEARED',
  referenceNote: 'UPI/412233445566',
  allocations: [
    { invoiceNumber: 'INV/2026-27/00042', billingPeriod: '2026-06', appliedPaise: 10_173_000 },
    { invoiceNumber: 'INV/2026-27/00031', billingPeriod: '2026-05', appliedPaise: 200_000 },
  ],
  advanceCreatedPaise: 50_000,
} as any;

/** A statutory report — the shape the notices, statements and AGM pack all take. */
const report: ExportDoc = {
  title: 'Defaulter Register',
  subtitle: 'Outstanding dues by age',
  societyName: 'Throwaway Society',
  meta: [`Total outstanding ${money(10_373_000)}`],
  sections: [{
    title: 'Outstanding Dues · Summary by age',
    columns: ['Age of the dues', 'Flats', 'Amount'],
    moneyColumns: [2],
    rows: [
      ['Not yet due / up to 30 days', 4, money(100_000)],
      ['Over 90 days', 1, money(10_273_000)],
    ],
    footer: ['Total outstanding', 5, money(10_373_000)],
  }],
};

/** `sendPdf` streams to an express Response; collect it instead of serving it. */
const renderReport = (doc: ExportDoc): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', c => chunks.push(c));
    sink.on('end', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    sendPdf(Object.assign(sink, { setHeader: () => undefined }) as unknown as Response, doc);
  });

async function main() {
  console.log('\nThe maintenance invoice a resident downloads');
  const invoiceLines = pdfTextLines(await buildInvoicePdf(invoice, 'Throwaway Society'));
  assertRupees('invoice', invoiceLines, [
    `${RUPEE}1,00,000.00`,   // the sinking-fund base, in the narrowest column
    `${RUPEE}1,03,730.00`,   // Total Payable
    `2 × ${RUPEE}500.00`,    // the working under the parking line
  ]);
  // The totals block was its own copy of the defect: a resident could see the
  // symbol on the line items and still find ' ¹' against the amount they owe.
  ok('invoice: the totals block carries the symbol too',
    invoiceLines.some(l => l.includes(`- ${RUPEE}500.00`)),
    JSON.stringify(invoiceLines.filter(l => l.startsWith('-'))));

  /**
   * ...and the figures fit the columns they are drawn in.
   *
   * The embedded font is about a sixth wider than the Helvetica the templates
   * were laid out against, and pdfkit will not wrap a number — there is no
   * space in '₹1,00,000.00' to break at — so an amount too wide for its box
   * runs straight over the next column instead of failing visibly. Nothing in
   * the extracted text shows it: the two figures come back as two clean
   * strings that happen to be drawn on top of each other. Measured, then.
   */
  const ruler = new PDFDocument({ size: 'A4', margin: 0 });
  registerPdfFonts(ruler);
  ruler.font(PDF_FONT).fontSize(INVOICE_COLUMNS.FONT_SIZE);
  const widest = `${RUPEE}1,00,000.00`;
  const drawn = ruler.widthOfString(widest);
  ok(`invoice: a lakh fits the BASE column (${drawn.toFixed(1)}pt of ${INVOICE_COLUMNS.BASE_W}pt)`,
    drawn <= INVOICE_COLUMNS.BASE_W);
  ok(`invoice: ...and the GST column (${drawn.toFixed(1)}pt of ${INVOICE_COLUMNS.GST_W}pt)`,
    drawn <= INVOICE_COLUMNS.GST_W);
  ok('invoice: ...and the charge name cannot reach the BASE column',
    50 + 12 + INVOICE_COLUMNS.NAME_W <= INVOICE_COLUMNS.BASE_X);
  ok('invoice: ...nor BASE reach GST',
    INVOICE_COLUMNS.BASE_X + INVOICE_COLUMNS.BASE_W <= INVOICE_COLUMNS.GST_X);

  console.log('\nThe receipt that comes back when they pay');
  assertRupees('receipt', pdfTextLines(await buildReceiptPdf(receipt, 'Throwaway Society')), [
    `${RUPEE}1,03,730.00`,   // the amount received, in the 18pt headline
    `${RUPEE}1,01,730.00`,   // an allocation line
    `Advance credit created: ${RUPEE}500.00`,
  ]);

  console.log("\nThe platform's own subscription invoice to the society");
  const platform = await (InvoiceService as any).buildPdf(
    { customInvoiceNumber: 'RS-2026-0007', amount: 1_180_000, invoiceType: 'OFFLINE_CASH', paidAt: new Date('2026-06-01'), createdAt: new Date('2026-06-01') },
    { name: 'Growth', description: 'Up to 200 flats', currency: 'INR' },
    { societyName: 'Throwaway Society', tenure: 'Yearly', creditApplied: 20_000, collectedByName: 'Field Rep' },
  );
  assertRupees('platform invoice', pdfTextLines(platform), [
    `${RUPEE}12,000.00`,     // subtotal before the credit
    `${RUPEE}11,800.00`,     // Total Paid
    `- ${RUPEE}200.00`,      // credit applied
  ]);

  console.log('\nThe statutory reports — notices, statements and the AGM pack');
  assertRupees('report', pdfTextLines(await renderReport(report)), [
    `${RUPEE}1,03,730.00`,   // the tie-out line under the heading
    `${RUPEE}1,02,730.00`,   // an aged bucket
  ]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
