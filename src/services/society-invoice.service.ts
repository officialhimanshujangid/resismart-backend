import PDFDocument from 'pdfkit';
import { IMaintenanceInvoice } from '../models/maintenance-invoice.model';
import { appConfig } from '../config/appConfig';
import { formatMoney } from '../utils/currency.util';
import s3Service from './s3.service';

const BLUE = '#0a5bd7';
const DARK = '#0f172a';
const GREY = '#64748b';
const LIGHT = '#94a3b8';
const LINE = '#e2e8f0';
const SOFT = '#f8fafc';

const money = (paise: number) => formatMoney(paise, 'INR');
const fmtDate = (d?: Date) => (d ? new Date(d).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' }) : '-');

/** Render a maintenance invoice to a PDF buffer. */
export function buildInvoicePdf(invoice: IMaintenanceInvoice, societyName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const M = 50, right = 545;

      // Header
      doc.rect(0, 0, 595, 120).fill(BLUE);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(20).text(societyName || 'Society', M, 38, { width: 340 });
      doc.font('Helvetica').fontSize(9).fillColor('#dbeafe').text('Maintenance Invoice', M, 66);
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#fff').text('INVOICE', M, 38, { width: right - M, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor('#dbeafe')
        .text(`No. ${invoice.invoiceNumber}`, M, 66, { width: right - M, align: 'right' })
        .text(`Date: ${fmtDate(invoice.invoiceDate)}`, M, 80, { width: right - M, align: 'right' });

      // Billed-to
      let y = 150;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(LIGHT).text('BILLED TO', M, y);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK).text(invoice.primaryOwnerName || `Flat ${invoice.flatNumber}`, M, y + 14);
      doc.font('Helvetica').fontSize(9).fillColor(GREY)
        .text(`Flat ${invoice.flatNumber}, ${invoice.blockName}${invoice.flatSizeLabel ? ` · ${invoice.flatSizeLabel}` : ''}`, M, y + 31);

      doc.font('Helvetica-Bold').fontSize(9).fillColor(LIGHT).text('PERIOD', 340, y, { width: right - 340, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK).text(invoice.billingPeriod, 340, y + 14, { width: right - 340, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(GREY).text(`Due: ${fmtDate(invoice.dueDate)}`, 340, y + 31, { width: right - 340, align: 'right' });

      // Line items table
      y = 210;
      doc.rect(M, y, right - M, 24).fill(SOFT);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GREY);
      doc.text('CHARGE', M + 12, y + 8);
      doc.text('BASE', 330, y + 8, { width: 60, align: 'right' });
      doc.text('GST', 400, y + 8, { width: 55, align: 'right' });
      doc.text('AMOUNT', M, y + 8, { width: right - M - 12, align: 'right' });
      y += 24;

      doc.font('Helvetica').fontSize(9.5);
      for (const li of invoice.lineItems) {
        if (li.category === 'ARREARS_BF') continue; // shown in totals section
        doc.fillColor(DARK).text(li.name, M + 12, y + 7, { width: 260 });
        doc.fillColor(GREY).text(money(li.baseAmountPaise), 330, y + 7, { width: 60, align: 'right' });
        doc.text(li.gstPaise ? money(li.gstPaise) : '-', 400, y + 7, { width: 55, align: 'right' });
        doc.fillColor(DARK).text(money(li.lineTotalPaise), M, y + 7, { width: right - M - 12, align: 'right' });
        y += 22;
        if (y > 680) { doc.addPage(); y = 60; }
      }
      doc.moveTo(M, y + 2).lineTo(right, y + 2).strokeColor(LINE).stroke();

      // Totals
      let ty = y + 14;
      const labelX = 330;
      const valOpts = { width: right - M - 12, align: 'right' as const };
      const totalRow = (label: string, val: string, bold = false, color = DARK) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor(bold ? color : GREY).text(label, labelX, ty);
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? color : DARK).text(val, M, ty, valOpts);
        ty += bold ? 22 : 17;
      };
      totalRow('Current charges', money(invoice.subTotalPaise));
      if (invoice.gstPaise) totalRow('GST', money(invoice.gstPaise));
      if (invoice.interestPaise) totalRow('Interest on arrears', money(invoice.interestPaise));
      if (invoice.roundingPaise) totalRow('Rounding', money(invoice.roundingPaise));
      if (invoice.openingArrearsPaise) totalRow('Arrears brought forward', money(invoice.openingArrearsPaise));
      if (invoice.advanceAppliedPaise) totalRow('Advance adjusted', `- ${money(invoice.advanceAppliedPaise)}`, false, '#16a34a');
      doc.moveTo(labelX, ty + 2).lineTo(right, ty + 2).strokeColor(LINE).stroke();
      ty += 12;
      doc.roundedRect(labelX, ty, right - labelX, 34, 8).fill(SOFT);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK).text('Total Payable', labelX + 12, ty + 10);
      doc.fillColor(BLUE).text(money(invoice.outstandingPaise), M, ty + 10, { width: right - M - 12, align: 'right' });

      // Footer
      doc.font('Helvetica').fontSize(8.5).fillColor(LIGHT).text(
        `This is a system-generated invoice from ${societyName || 'your society'}. For queries contact your managing committee.`,
        M, 770, { width: right - M, align: 'center' },
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Build the PDF, store on S3, cache key/url on the invoice, and return a presigned download URL. */
export async function generateAndStoreInvoicePdf(invoice: IMaintenanceInvoice, societyName: string): Promise<string> {
  const buffer = await buildInvoicePdf(invoice, societyName);
  const url = await s3Service.uploadBuffer(buffer, 'society-invoices', 'pdf', 'application/pdf');
  invoice.pdfUrl = url;
  invoice.pdfKey = s3Service.keyFromUrl(url) || undefined;
  await invoice.save();

  const key = invoice.pdfKey;
  if (key) {
    return s3Service.getSignedDownloadUrl(key, { expiresIn: 5 * 60, downloadName: `${invoice.invoiceNumber.replace(/\//g, '-')}.pdf` });
  }
  return url;
}
