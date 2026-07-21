import zlib from 'zlib';

/**
 * The lines of text a reader actually sees on a generated PDF.
 *
 * Worth the machinery. A value sitting on a document in the database is only
 * half the job — the template has to draw it — and a field the template forgets
 * looks identical, from the database, to a field the generator never filled in.
 * This is the assertion that tells those two apart.
 *
 * pdfkit writes pages as Flate-compressed content streams, so: inflate every
 * stream, then pull the strings back out of the `[<hex> 20 <hex>] TJ` show-text
 * operators (the bare numbers between the hex runs are kerning, not characters).
 * One `TJ` is one drawn string, so one line of the returned text.
 *
 * The hex is NOT the text, though. Since the PDFs embed a subset of DejaVu Sans
 * (Helvetica cannot render '₹' — see utils/pdf-font.util.ts), each two bytes are
 * a subset glyph id, numbered per font in the order the glyphs were first used.
 * The bytes are turned back into characters through the font's own ToUnicode
 * CMap — the very table a viewer consults when the resident selects the text and
 * copies it. So an assertion here that '₹1,000.00' is on the page is an
 * assertion about what a human and a text extractor both see, not about bytes.
 */
export function pdfTextLines(buf: Buffer): string[] {
  // latin1 keeps index === byte offset, so string scanning stays byte-exact.
  const raw = buf.toString('latin1');

  const objects = new Map<number, { body: string; stream: string | null }>();
  const objRe = /(\d+)\s+0\s+obj\b/g;
  for (let m = objRe.exec(raw); m; m = objRe.exec(raw)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endobj', start);
    if (end < 0) continue;
    const body = raw.slice(start, end);
    objects.set(Number(m[1]), { body, stream: streamOf(body) });
  }

  // /F1 -> font object -> its ToUnicode CMap. Resource names are document-wide
  // in pdfkit, so one lookup serves every page.
  const cmapOfName = new Map<string, Map<number, string>>();
  for (const { body } of objects.values()) {
    const res = body.match(/\/Font\s*<<([^>]*)>>/);
    if (!res) continue;
    const refRe = /\/(F\d+)\s+(\d+)\s+0\s+R/g;
    for (let m = refRe.exec(res[1]); m; m = refRe.exec(res[1])) {
      const font = objects.get(Number(m[2]));
      const toUnicode = font?.body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
      const cmap = toUnicode && objects.get(Number(toUnicode[1]))?.stream;
      if (cmap) cmapOfName.set(m[1], parseCmap(cmap));
    }
  }

  // Read only what the pages point at. Sniffing every stream for show-text
  // operators would also sniff the embedded font programs, and a megabyte of
  // glyph outlines will eventually contain bytes that look like one.
  const contents = new Set<number>();
  for (const { body } of objects.values()) {
    const re = /\/Contents\s+(\d+)\s+0\s+R/g;
    for (let m = re.exec(body); m; m = re.exec(body)) contents.add(Number(m[1]));
  }

  const lines: string[] = [];
  for (const num of contents) {
    const stream = objects.get(num)?.stream;
    if (!stream) continue;
    let cmap: Map<number, string> | undefined;
    const opRe = /\/(F\d+)[\s\d.]+Tf|((?:\[[^\]]*\]|<[0-9a-fA-F\s]*>)\s*T[Jj])/g;
    for (let m = opRe.exec(stream); m; m = opRe.exec(stream)) {
      if (m[1]) { cmap = cmapOfName.get(m[1]); continue; }
      const bytes = (m[2].match(/<[0-9a-fA-F\s]*>/g) || [])
        .map(h => h.slice(1, -1).replace(/\s+/g, ''))
        .join('');
      lines.push(decode(bytes, cmap));
    }
  }
  return lines;
}

/** The inflated bytes of an object's stream, or null if it has none. */
function streamOf(body: string): string | null {
  const s = body.indexOf('stream');
  if (s < 0) return null;
  let a = s + 'stream'.length;
  if (body[a] === '\r') a++;
  if (body[a] === '\n') a++;
  const e = body.indexOf('endstream', a);
  if (e < 0) return null;
  const data = Buffer.from(body.slice(a, e), 'latin1');
  try { return zlib.inflateSync(data).toString('latin1'); } catch { /* not Flate */ }
  return data.toString('latin1'); // an uncompressed stream is already the text
}

/**
 * Subset glyph id -> the characters it stands for, from a ToUnicode CMap.
 *
 * pdfkit writes one `<first> <last> [<uni> <uni> ...]` range per 256 glyphs; an
 * entry can carry more than one code unit, for a ligature or an astral glyph
 * written as a surrogate pair.
 */
function parseCmap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of text.match(/beginbfrange[\s\S]*?endbfrange/g) || []) {
    const rangeRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
    for (let m = rangeRe.exec(block); m; m = rangeRe.exec(block)) {
      const first = parseInt(m[1], 16);
      (m[3].match(/<[0-9a-fA-F\s]*>/g) || []).forEach((entry, i) => {
        const hex = entry.slice(1, -1).replace(/\s+/g, '');
        let out = '';
        for (let j = 0; j + 4 <= hex.length; j += 4) out += String.fromCharCode(parseInt(hex.slice(j, j + 4), 16));
        map.set(first + i, out);
      });
    }
  }
  return map;
}

/**
 * Two bytes per glyph through the CMap for an embedded font; one byte per
 * character for a standard one, which is single-byte WinAnsi — and the reason
 * the rupee sign was coming out as ' ¹' before the fonts were embedded.
 */
function decode(hex: string, cmap?: Map<number, string>): string {
  if (!cmap) return Buffer.from(hex, 'hex').toString('latin1');
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += cmap.get(parseInt(hex.slice(i, i + 4), 16)) ?? '';
  return out;
}
