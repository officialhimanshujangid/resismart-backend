import PDFDocument from 'pdfkit';
import { IReceipt } from '../models/receipt.model';
import { formatMoney } from '../utils/currency.util';
import s3Service from './s3.service';

const GREEN = '#16a34a';
const DARK = '#0f172a';
const GREY = '#64748b';
const LIGHT = '#94a3b8';
const LINE = '#e2e8f0';
const SOFT = '#f8fafc';

const money = (p: number) => formatMoney(p, 'INR');
const fmtDate = (d?: Date) => (d ? new Date(d).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' }) : '-');
const MODE_LABEL: Record<string, string> = { CASH: 'Cash', CHEQUE: 'Cheque', UPI: 'UPI', BANK_TRANSFER: 'Bank Transfer', RAZORPAY: 'Online (Razorpay)', OTHER: 'Other' };

export function buildReceiptPdf(receipt: IReceipt, societyName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const M = 50, right = 545;

      doc.rect(0, 0, 595, 120).fill(GREEN);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(20).text(societyName || 'Society', M, 38, { width: 340 });
      doc.font('Helvetica').fontSize(9).fillColor('#dcfce7').text('Payment Receipt', M, 66);
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#fff').text('RECEIPT', M, 38, { width: right - M, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor('#dcfce7')
        .text(`No. ${receipt.receiptNumber}`, M, 66, { width: right - M, align: 'right' })
        .text(`Date: ${fmtDate(receipt.receiptDate)}`, M, 80, { width: right - M, align: 'right' });

      let y = 150;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(LIGHT).text('RECEIVED FROM', M, y);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK).text(`Flat ${receipt.flatNumber}, ${receipt.blockName}`, M, y + 14);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(LIGHT).text('AMOUNT', 340, y, { width: right - 340, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(18).fillColor(GREEN).text(money(receipt.amountPaise), 340, y + 12, { width: right - 340, align: 'right' });

      y = 210;
      doc.roundedRect(M, y, right - M, 60, 10).fillAndStroke(SOFT, LINE);
      const cell = (label: string, value: string, x: number) => {
        doc.font('Helvetica').fontSize(8.5).fillColor(LIGHT).text(label, x, y + 12);
        doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(value, x, y + 28);
      };
      cell('MODE', MODE_LABEL[receipt.mode] || receipt.mode, M + 16);
      cell('REFERENCE', receipt.instrument?.chequeNo || receipt.referenceNote || receipt.razorpayPaymentId || '—', 220);
      cell('STATUS', receipt.status, 400);

      // Allocations
      y = 300;
      if (receipt.allocations?.length) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(LIGHT).text('APPLIED TO', M, y); y += 18;
        doc.rect(M, y, right - M, 22).fill(SOFT);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GREY).text('INVOICE', M + 12, y + 7);
        doc.text('PERIOD', 320, y + 7); doc.text('AMOUNT', M, y + 7, { width: right - M - 12, align: 'right' });
        y += 22;
        doc.font('Helvetica').fontSize(9.5);
        for (const a of receipt.allocations) {
          doc.fillColor(DARK).text(a.invoiceNumber, M + 12, y + 6, { width: 260 });
          doc.fillColor(GREY).text(a.billingPeriod, 320, y + 6);
          doc.fillColor(DARK).text(money(a.appliedPaise), M, y + 6, { width: right - M - 12, align: 'right' });
          y += 20;
        }
      }
      if (receipt.advanceCreatedPaise > 0) {
        doc.font('Helvetica').fontSize(10).fillColor(GREEN).text(`Advance credit created: ${money(receipt.advanceCreatedPaise)}`, M + 12, y + 6);
        y += 20;
      }

      doc.font('Helvetica').fontSize(8.5).fillColor(LIGHT).text(
        `This is a system-generated receipt from ${societyName || 'your society'}.`,
        M, 770, { width: right - M, align: 'center' },
      );
      doc.end();
    } catch (err) { reject(err); }
  });
}

export async function generateAndStoreReceiptPdf(receipt: IReceipt, societyName: string): Promise<string> {
  const buffer = await buildReceiptPdf(receipt, societyName);
  const url = await s3Service.uploadBuffer(buffer, 'society-receipts', 'pdf', 'application/pdf');
  receipt.pdfUrl = url;
  receipt.pdfKey = s3Service.keyFromUrl(url) || undefined;
  await receipt.save();
  const key = receipt.pdfKey;
  if (key) return s3Service.getSignedDownloadUrl(key, { expiresIn: 5 * 60, downloadName: `${receipt.receiptNumber.replace(/\//g, '-')}.pdf` });
  return url;
}
