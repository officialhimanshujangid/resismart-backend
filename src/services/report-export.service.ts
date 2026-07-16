import { Response } from 'express';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

/**
 * Exports for the statutory reports.
 *
 * Streamed straight to the client as an attachment rather than parked in S3 and
 * handed back as a presigned URL (the pattern invoices/receipts use): a report is
 * regenerated from the ledger every time and has no identity worth storing, so
 * uploading one would leave a bucket full of stale statements nobody can trust.
 */

export type Cell = string | number | null | undefined;

export interface ExportSection {
  title?: string;
  columns: string[];
  /** Column indexes (0-based) holding money, so they right-align and format. */
  moneyColumns?: number[];
  rows: Cell[][];
  /** Emphasised final row (totals). */
  footer?: Cell[];
}

export interface ExportDoc {
  title: string;
  subtitle?: string;
  societyName: string;
  /** Free-text lines under the heading — period, as-at date, tie-out note. */
  meta?: string[];
  sections: ExportSection[];
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Money arrives as paise; render as rupees for humans, keep 2dp for spreadsheets. */
export const money = (p?: number | null): Cell => (p === null || p === undefined ? '' : rupees(p));
const safeFile = (s: string) => s.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

/** Stream `doc` to the response as a PDF attachment. */
export function sendPdf(res: Response, doc: ExportDoc): void {
  const pdf = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFile(doc.title)}.pdf"`);
  pdf.pipe(res);

  pdf.fontSize(16).font('Helvetica-Bold').text(doc.societyName, { align: 'center' });
  pdf.moveDown(0.2);
  pdf.fontSize(13).text(doc.title, { align: 'center' });
  if (doc.subtitle) pdf.fontSize(9).font('Helvetica').text(doc.subtitle, { align: 'center' });
  for (const m of doc.meta || []) pdf.fontSize(8).font('Helvetica').fillColor('#555').text(m, { align: 'center' });
  pdf.fillColor('#000').moveDown(1);

  const left = pdf.page.margins.left;
  const width = pdf.page.width - left - pdf.page.margins.right;

  for (const section of doc.sections) {
    if (section.title) {
      pdf.moveDown(0.5).fontSize(10).font('Helvetica-Bold').text(section.title);
      pdf.moveDown(0.3);
    }
    const cols = section.columns.length;
    // First column carries the label and needs the room; the rest share what's left.
    const firstW = Math.max(width * 0.34, width - (cols - 1) * 90);
    const otherW = cols > 1 ? (width - firstW) / (cols - 1) : 0;
    const xOf = (i: number) => left + (i === 0 ? 0 : firstW + (i - 1) * otherW);
    const wOf = (i: number) => (i === 0 ? firstW : otherW);

    const writeRow = (cells: Cell[], bold: boolean) => {
      if (pdf.y > pdf.page.height - pdf.page.margins.bottom - 30) pdf.addPage();
      const y = pdf.y;
      pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      cells.forEach((c, i) => {
        pdf.text(c === null || c === undefined ? '' : String(c), xOf(i), y, {
          width: wOf(i) - 4,
          align: i === 0 ? 'left' : 'right',
          lineBreak: false,
          ellipsis: true,
        });
      });
      pdf.y = y + 13;
    };

    writeRow(section.columns, true);
    pdf.moveTo(left, pdf.y - 2).lineTo(left + width, pdf.y - 2).strokeColor('#cccccc').stroke();
    for (const r of section.rows) writeRow(r, false);
    if (section.footer) {
      pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).strokeColor('#999999').stroke();
      pdf.y += 2;
      writeRow(section.footer, true);
    }
    pdf.moveDown(0.5);
  }

  if (!doc.sections.some(s => s.rows.length)) {
    pdf.moveDown(2).fontSize(10).font('Helvetica').fillColor('#777').text('No transactions in this period.', { align: 'center' });
  }

  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(i);
    pdf.fontSize(7).fillColor('#888').text(
      `Page ${i + 1} of ${range.count}  ·  Generated ${new Date().toLocaleString('en-IN')}`,
      left, pdf.page.height - 30, { width, align: 'center' },
    );
  }
  pdf.end();
}

/** Stream `doc` to the response as an .xlsx attachment. */
export async function sendXlsx(res: Response, doc: ExportDoc): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = doc.societyName;
  const ws = wb.addWorksheet(doc.title.slice(0, 30) || 'Report');

  ws.addRow([doc.societyName]).font = { bold: true, size: 14 };
  ws.addRow([doc.title]).font = { bold: true, size: 12 };
  if (doc.subtitle) ws.addRow([doc.subtitle]).font = { italic: true, size: 9 };
  for (const m of doc.meta || []) ws.addRow([m]).font = { size: 9, color: { argb: 'FF666666' } };
  ws.addRow([]);

  for (const section of doc.sections) {
    if (section.title) ws.addRow([section.title]).font = { bold: true, size: 11 };
    const header = ws.addRow(section.columns);
    header.font = { bold: true };
    header.eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    });
    for (const r of section.rows) ws.addRow(r);
    if (section.footer) {
      const f = ws.addRow(section.footer);
      f.font = { bold: true };
      f.eachCell(c => { c.border = { top: { style: 'thin', color: { argb: 'FF94A3B8' } } }; });
    }
    ws.addRow([]);
  }

  ws.columns.forEach((col, i) => {
    let max = 12;
    col.eachCell?.({ includeEmpty: false }, c => { max = Math.max(max, String(c.value ?? '').length + 2); });
    col.width = Math.min(max, i === 0 ? 46 : 22);
    if (i > 0) col.alignment = { horizontal: 'right' };
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFile(doc.title)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}
