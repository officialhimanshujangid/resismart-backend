import { Request, Response } from 'express';
import * as reports from '../services/reports.service';
import { getFyStartMonth } from '../services/finance-policy.service';
import { Society } from '../models/society.model';
import { sendPdf, sendXlsx } from '../services/report-export.service';
import { buildExportDoc } from '../services/report-doc.builder';
import { financeDashboard } from '../services/finance-dashboard.service';
import { budgetVsActual as runBudgetVsActual } from '../services/budget.service';
import { buildAgmPack } from '../services/agm-pack.service';

const sid = (req: Request) => req.user?.activeTenantId;

/** Query accepted by the report endpoints. `fy` is '2026' or '2026-2027'. */
interface ReportQuery {
  from?: string;
  to?: string;
  fy?: string;
  asOf?: string;
}

/**
 * Express types a query value as `string | string[] | ParsedQs | ParsedQs[]` —
 * `?asOf=a&asOf=b` really does arrive as an array. Casting `req.query` straight
 * to ReportQuery would suppress the compiler error and hand `new Date(['a','b'])`
 * downstream, so read each field deliberately and take the last value.
 */
const str = (v: unknown): string | undefined => {
  const raw = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
};

const parseQuery = (req: Request): ReportQuery => ({
  from: str(req.query.from),
  to: str(req.query.to),
  fy: str(req.query.fy),
  asOf: str(req.query.asOf),
});

const handler = (fn: (societyId: string, q: ReportQuery, fyStartMonth: number, req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const societyId = sid(req);
      if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }
      const q = parseQuery(req);
      if (q.fy && q.asOf) {
        res.status(400).json({ error: 'Pass either fy or asOf, not both' });
        return;
      }
      const fyStartMonth = await getFyStartMonth(societyId);
      res.json(await fn(societyId, q, fyStartMonth, req));
    } catch (e: any) {
      // Bad input is the caller's fault and safe to echo; anything else is ours
      // and must not leak internals (driver errors, account ids) to the client.
      if (/^Invalid /.test(e?.message || '')) { res.status(400).json({ error: e.message }); return; }
      res.status(500).json({ error: 'This report could not be generated.' });
    }
  };

/** One place that knows how to run each report, so JSON and exports can never diverge. */
const RUN: Record<string, (societyId: string, q: ReportQuery, fyStartMonth: number) => Promise<any>> = {
  'trial-balance': (s, q) => reports.trialBalance(s, { asOf: q.asOf }),
  'income-expenditure': (s, q, m) => reports.incomeExpenditure(s, { fy: q.fy, fyStartMonth: m }),
  'wing-wise': (s, q, m) => reports.wingWiseIncomeExpenditure(s, { fy: q.fy, fyStartMonth: m }),
  'balance-sheet': (s, q, m) => reports.balanceSheet(s, { fy: q.fy, asOf: q.asOf, fyStartMonth: m }),
  'receipts-payments': (s, q) => reports.receiptsAndPayments(s, q.from, q.to),
  defaulters: (s, q) => reports.defaulters(s, { asOf: q.asOf }),
  'collection-register': (s, q) => reports.collectionRegister(s, q.from, q.to),
  'fund-statement': (s, q) => reports.fundStatement(s, { asOf: q.asOf }),
  'gst-register': (s, q) => reports.gstRegister(s, q.from, q.to),
  'tds-register': (s, q) => reports.tdsRegister(s, q.from, q.to),
  // Lives in budget.service, but it is a report like any other — registering it
  // here is what gives it the same JSON shape, PDF and Excel as the rest for free.
  'budget-vs-actual': (s, q, m) => runBudgetVsActual(s, { fy: q.fy, fyStartMonth: m }),
};

export const trialBalance = handler((s, q, m) => RUN['trial-balance'](s, q, m));
export const incomeExpenditure = handler((s, q, m) => RUN['income-expenditure'](s, q, m));
export const balanceSheet = handler((s, q, m) => RUN['balance-sheet'](s, q, m));
export const wingWise = handler((s, q, m) => RUN['wing-wise'](s, q, m));
export const receiptsAndPayments = handler((s, q, m) => RUN['receipts-payments'](s, q, m));
export const defaulters = handler((s, q, m) => RUN.defaulters(s, q, m));
export const collectionRegister = handler((s, q, m) => RUN['collection-register'](s, q, m));
export const fundStatement = handler((s, q, m) => RUN['fund-statement'](s, q, m));
export const gstRegister = handler((s, q, m) => RUN['gst-register'](s, q, m));
export const tdsRegister = handler((s, q, m) => RUN['tds-register'](s, q, m));
export const budgetVsActual = handler((s, q, m) => RUN['budget-vs-actual'](s, q, m));

/** GET /reports/financial-years — drives the FY picker. */
export const financialYears = handler((s, _q, m) => reports.availableFinancialYears(s, m));

/** GET /finance/society/dashboard — the finance home. */
export const dashboard = handler((s, _q, m) => financeDashboard(s, m));

/** GET /reports/ledger/:code — the vouchers behind a figure. */
export const accountLedger = handler((s, q, _m, req) =>
  reports.accountLedger(s, { code: String(req.params.code), from: q.from, to: q.to }));

/** The export format, or null once the 400 has been sent. */
const formatOf = (req: Request, res: Response): 'pdf' | 'xlsx' | null => {
  const format = (str(req.query.format) || 'pdf').toLowerCase();
  if (format !== 'pdf' && format !== 'xlsx') {
    res.status(400).json({ error: "Invalid format — use 'pdf' or 'xlsx'" });
    return null;
  }
  return format;
};

/** GET /reports/:key/export?format=pdf|xlsx — the same numbers, as a file. */
export const exportReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = sid(req);
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const key = String(req.params.key);
    const run = RUN[key];
    if (!run) { res.status(400).json({ error: `Invalid report '${key}'` }); return; }

    const format = formatOf(req, res);
    if (!format) return;

    const [fyStartMonth, society] = await Promise.all([
      getFyStartMonth(societyId),
      Society.findById(societyId).select('name registrationNumber').lean(),
    ]);
    const data = await run(societyId, parseQuery(req), fyStartMonth);
    const doc = buildExportDoc(key, data, society?.name || 'Society');
    if (society?.registrationNumber) doc.meta = [`Reg. No. ${society.registrationNumber}`, ...(doc.meta || [])];

    if (format === 'pdf') sendPdf(res, doc);
    else await sendXlsx(res, doc);
  } catch (e: any) {
    // Headers may already be on the wire once streaming has begun.
    if (res.headersSent) { res.end(); return; }
    if (/^Invalid /.test(e?.message || '')) { res.status(400).json({ error: e.message }); return; }
    res.status(500).json({ error: 'This report could not be exported.' });
  }
};

/**
 * GET /reports/agm-pack/export?fy=&format=pdf|xlsx — every AGM statement in one file.
 *
 * Must be routed BEFORE '/reports/:key/export', which would otherwise capture
 * 'agm-pack' as a report key and reject it as unknown.
 */
export const exportAgmPack = async (req: Request, res: Response): Promise<void> => {
  try {
    const societyId = sid(req);
    if (!societyId) { res.status(403).json({ error: 'No society selected' }); return; }

    const format = formatOf(req, res);
    if (!format) return;

    const fyStartMonth = await getFyStartMonth(societyId);
    // buildAgmPack fetches the society itself — it needs the registration number
    // on the cover, not bolted onto meta by the caller as the single reports do.
    const doc = await buildAgmPack(societyId, { fy: parseQuery(req).fy, fyStartMonth });

    if (format === 'pdf') sendPdf(res, doc);
    else await sendXlsx(res, doc);
  } catch (e: any) {
    if (res.headersSent) { res.end(); return; }
    if (/^Invalid /.test(e?.message || '')) { res.status(400).json({ error: e.message }); return; }
    res.status(500).json({ error: 'The AGM pack could not be generated.' });
  }
};
