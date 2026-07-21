import fs from 'fs';
import path from 'path';
import { logger } from './logger.util';

/**
 * The font every PDF this backend generates is drawn in.
 *
 * pdfkit's default — Helvetica and the other thirteen "standard" PDF fonts —
 * carries no embedded glyph data. The viewer supplies the glyphs, and the text
 * is encoded in WinAnsi, a 256-slot single-byte encoding with no rupee sign in
 * it. Handed '₹' (U+20B9), pdfkit writes the codepoint's two raw bytes rather
 * than one encoded glyph: 0x20 0xB9, which WinAnsi reads back as a space
 * followed by a superscript one. Every amount on every invoice, receipt,
 * statement and defaulter notice a society sent out therefore read " ¹1,000.00".
 *
 * So the font is embedded instead. DejaVu Sans has the rupee sign (and the ×,
 * ·, — and en/em dashes the templates also use), and pdfkit subsets it on
 * embed, so the fonts being ~700 KB on disk costs a PDF only the glyphs it
 * actually draws.
 *
 * Call `registerPdfFonts(doc)` once per document and then refer to the two
 * families by `PDF_FONT` / `PDF_FONT_BOLD` instead of 'Helvetica'.
 */

export const PDF_FONT = 'Body';
export const PDF_FONT_BOLD = 'Body-Bold';

/**
 * Resolved against this file rather than the process cwd, and identical under
 * both `tsc` output and ts-node: `dist/utils/../assets` and `src/utils/../assets`
 * both land on the assets directory beside the compiled/served code. The build
 * copies the directory across (see scripts/copy-assets.js) because tsc emits
 * only .js.
 */
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');

const FILES: Record<string, string> = {
  [PDF_FONT]: 'DejaVuSans.ttf',
  [PDF_FONT_BOLD]: 'DejaVuSans-Bold.ttf',
};

/** Read once. Re-reading 1.4 MB per invoice would be a needless tax on a bulk run. */
let cache: Record<string, Buffer> | null = null;
let warned = false;

const load = (): Record<string, Buffer> | null => {
  if (cache) return cache;
  try {
    const loaded: Record<string, Buffer> = {};
    for (const [name, file] of Object.entries(FILES)) loaded[name] = fs.readFileSync(path.join(FONT_DIR, file));
    cache = loaded;
    return cache;
  } catch (err) {
    // A deploy that dropped the assets directory must not take every invoice
    // download down with it — a bill with a mangled currency symbol is bad, no
    // bill at all is worse. Fall back to Helvetica and say so, loudly, once.
    if (!warned) {
      warned = true;
      logger.error(`PDF fonts missing from ${FONT_DIR} — PDFs will fall back to Helvetica and the rupee sign will not render: ${(err as Error).message}`);
    }
    return null;
  }
};

/**
 * Register the embedded families on `doc` and select the regular weight.
 *
 * Registers under our own names, so a template asks for `PDF_FONT` and gets
 * whatever is available: the embedded face normally, or Helvetica aliased to
 * the same name if the files are missing. Templates never branch on it.
 */
export function registerPdfFonts(doc: PDFKit.PDFDocument): void {
  const fonts = load();
  doc.registerFont(PDF_FONT, fonts ? fonts[PDF_FONT] : 'Helvetica');
  doc.registerFont(PDF_FONT_BOLD, fonts ? fonts[PDF_FONT_BOLD] : 'Helvetica-Bold');
  doc.font(PDF_FONT);
}
