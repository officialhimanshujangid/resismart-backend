/**
 * Indian financial-year helpers. FY runs from `startMonth` (default April = 4).
 * A date of 2026-07-16 with startMonth 4 belongs to FY '2026-2027'.
 */

export interface FinancialYear {
  fyString: string; // '2026-2027'
  fyStart: Date;
  fyEnd: Date; // last millisecond of the FY
  startYear: number;
}

export function getFinancialYear(date: Date, startMonth = 4): FinancialYear {
  const month = date.getMonth() + 1; // 1-12
  const year = date.getFullYear();
  const startYear = month >= startMonth ? year : year - 1;

  const fyStart = new Date(startYear, startMonth - 1, 1, 0, 0, 0, 0);
  const fyEnd = new Date(startYear + 1, startMonth - 1, 1, 0, 0, 0, 0);
  fyEnd.setMilliseconds(fyEnd.getMilliseconds() - 1);

  return { fyString: `${startYear}-${startYear + 1}`, fyStart, fyEnd, startYear };
}

/** '2026-2027' → '2026-27' for compact document numbers. */
export function fyShort(fyString: string): string {
  const [start, end] = fyString.split('-');
  return end ? `${start}-${end.slice(-2)}` : fyString;
}

/**
 * Build a finance document number from a template.
 * Supported tokens: {PREFIX} {FY} {FYSHORT} {SEQ}. Default: '{PREFIX}/{FYSHORT}/{SEQ}'.
 */
export function formatDocNumber(opts: {
  prefix: string;
  fyString: string;
  seq: number;
  padding?: number;
  template?: string;
}): string {
  const { prefix, fyString, seq, padding = 5, template = '{PREFIX}/{FYSHORT}/{SEQ}' } = opts;
  return template
    .replace('{PREFIX}', prefix)
    .replace('{FYSHORT}', fyShort(fyString))
    .replace('{FY}', fyString)
    .replace('{SEQ}', String(seq).padStart(padding, '0'));
}
