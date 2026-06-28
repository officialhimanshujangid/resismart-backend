import PDFDocument from 'pdfkit';
import { IInvoice } from '../models/invoice.model';
import { ISubscription } from '../models/subscription.model';
import { IPlan } from '../models/plan.model';
import { appConfig } from '../config/appConfig';
import { logger } from '../utils/logger.util';
import { formatMoney } from '../utils/currency.util';
import s3Service from './s3.service';
import EmailService from './email.service';

interface InvoiceContext {
  societyName: string;
  recipientEmail?: string;
  tenure: string;
  collectedByName?: string;
  recordedByName?: string;
  creditApplied?: number; // paise
  currency?: string;
}

// Palette
const BLUE = '#0a5bd7';
const DARK = '#0f172a';
const GREY = '#64748b';
const LIGHT = '#94a3b8';
const LINE = '#e2e8f0';
const SOFT = '#f8fafc';

export class InvoiceService {
  /**
   * Renders a polished PDF invoice for an offline/cash payment, stores it on S3,
   * persists the URL and emails the recipient.
   */
  static async generateCustomInvoice(
    invoice: IInvoice,
    subscription: ISubscription,
    plan: IPlan,
    ctx: InvoiceContext
  ): Promise<string> {
    const pdfBuffer = await this.buildPdf(invoice, plan, ctx);
    const pdfUrl = await s3Service.uploadBuffer(pdfBuffer, 'invoices', 'pdf', 'application/pdf');

    invoice.customPdfUrl = pdfUrl;
    await invoice.save();

    if (ctx.recipientEmail) {
      EmailService.sendInvoiceEmail(ctx.recipientEmail, ctx.societyName, invoice.customInvoiceNumber || '', pdfUrl);
    }

    logger.info(`Custom invoice generated: ${invoice.customInvoiceNumber} -> ${pdfUrl}`);
    return pdfUrl;
  }

  private static buildPdf(invoice: IInvoice, plan: IPlan, ctx: InvoiceContext): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 0 });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const currency = ctx.currency || plan.currency || 'INR';
        const money = (paise: number) => formatMoney(paise, currency);
        const fmtDate = (d?: Date) => (d ? new Date(d).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' }) : '-');

        const M = 50; // content margin
        const right = 545;
        const credit = ctx.creditApplied || 0;
        const planPrice = invoice.amount + credit;

        // ── Header band ───────────────────────────────────────────────
        doc.rect(0, 0, 595, 130).fill(BLUE);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(26).text(appConfig.appName, M, 40);
        doc.font('Helvetica').fontSize(10).fillColor('#dbeafe').text('Society & Shop Management Platform', M, 72);
        doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff').text('INVOICE', M, 40, { width: right - M, align: 'right' });
        doc.font('Helvetica').fontSize(9).fillColor('#dbeafe')
          .text(`No. ${invoice.customInvoiceNumber || invoice._id}`, M, 70, { width: right - M, align: 'right' })
          .text(`Date: ${fmtDate(invoice.paidAt || invoice.createdAt)}`, M, 84, { width: right - M, align: 'right' });

        // PAID stamp
        doc.roundedRect(right - 92, 96, 92, 22, 6).fill('#16a34a');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text('PAID', right - 92, 101, { width: 92, align: 'center' });

        // ── From / Billed To ──────────────────────────────────────────
        let y = 160;
        doc.font('Helvetica-Bold').fontSize(9).fillColor(LIGHT).text('FROM', M, y);
        doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK).text(appConfig.appName, M, y + 14);
        doc.font('Helvetica').fontSize(9).fillColor(GREY).text(appConfig.supportEmail, M, y + 31);

        doc.font('Helvetica-Bold').fontSize(9).fillColor(LIGHT).text('BILLED TO', 320, y);
        doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK).text(ctx.societyName || 'Society', 320, y + 14, { width: right - 320 });
        if (ctx.recipientEmail) doc.font('Helvetica').fontSize(9).fillColor(GREY).text(ctx.recipientEmail, 320, y + 31, { width: right - 320 });

        // ── Line items table ──────────────────────────────────────────
        y = 250;
        doc.rect(M, y, right - M, 26).fill(SOFT);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(GREY);
        doc.text('DESCRIPTION', M + 14, y + 9);
        doc.text('TENURE', 330, y + 9, { width: 90 });
        doc.text('AMOUNT', M, y + 9, { width: right - M - 14, align: 'right' });

        y += 26;
        doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(`${plan.name} Subscription`, M + 14, y + 12, { width: 300 });
        doc.font('Helvetica').fontSize(11).fillColor(DARK).text(ctx.tenure, 330, y + 12, { width: 90 });
        doc.text(money(planPrice), M, y + 12, { width: right - M - 14, align: 'right' });
        if (plan.description) doc.font('Helvetica').fontSize(8).fillColor(LIGHT).text(plan.description, M + 14, y + 30, { width: 300 });
        doc.moveTo(M, y + 50).lineTo(right, y + 50).strokeColor(LINE).stroke();

        // ── Totals ────────────────────────────────────────────────────
        let ty = y + 64;
        const labelX = 330;
        const valOpts = { width: right - M - 14, align: 'right' as const };
        if (credit > 0) {
          doc.font('Helvetica').fontSize(10).fillColor(GREY).text('Subtotal', labelX, ty);
          doc.text(money(planPrice), M, ty, valOpts);
          ty += 18;
          doc.fillColor('#16a34a').text('Credit applied', labelX, ty);
          doc.text(`- ${money(credit)}`, M, ty, valOpts);
          ty += 18;
        }
        doc.moveTo(labelX, ty + 2).lineTo(right, ty + 2).strokeColor(LINE).stroke();
        ty += 12;
        doc.roundedRect(labelX, ty, right - labelX, 34, 8).fill(SOFT);
        doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('Total Paid', labelX + 12, ty + 10);
        doc.fillColor(BLUE).text(money(invoice.amount), M, ty + 10, { width: right - M - 12, align: 'right' });

        // ── Payment details ───────────────────────────────────────────
        const pd = ty + 70;
        doc.roundedRect(M, pd, right - M, 90, 10).fillAndStroke(SOFT, LINE);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(LIGHT).text('PAYMENT DETAILS', M + 16, pd + 14);
        const row = (label: string, value: string, idx: number) => {
          const ry = pd + 32 + idx * 16;
          doc.font('Helvetica').fontSize(10).fillColor(GREY).text(label, M + 16, ry, { width: 130 });
          doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(value, M + 150, ry);
        };
        row('Method', invoice.invoiceType === 'OFFLINE_CASH' ? 'Cash / Offline' : 'Online (Razorpay)', 0);
        row('Collected by', ctx.collectedByName || '—', 1);
        row('Recorded by', ctx.recordedByName || '—', 2);

        // ── Footer ────────────────────────────────────────────────────
        doc.font('Helvetica').fontSize(8.5).fillColor(LIGHT).text(
          `This is a system-generated invoice. For any queries, contact ${appConfig.supportEmail}.`,
          M, 760, { width: right - M, align: 'center' }
        );
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GREY).text(`Thank you for choosing ${appConfig.appName}.`, M, 775, { width: right - M, align: 'center' });

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

export default InvoiceService;
