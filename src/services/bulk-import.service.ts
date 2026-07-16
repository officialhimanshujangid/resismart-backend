import mongoose from 'mongoose';
import * as xlsx from 'xlsx';
import ExcelJS from 'exceljs';
import { Flat, FlatStatus } from '../models/flat.model';
import { Block } from '../models/block.model';
import { ShareCertificate } from '../models/share-certificate.model';
import { JournalEntry } from '../models/journal-entry.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { postJournal } from './ledger.service';
import { getOrCreatePolicy } from './finance-policy.service';
import { nextDocNumber } from './finance-sequence.service';
import { getFinancialYear } from '../utils/financial-year.util';
import { issueShares, Actor } from './share-capital.service';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';

/**
 * Bulk onboarding from a spreadsheet.
 *
 * Typing 200 flats and their opening dues by hand is the last thing standing
 * between a society and its first bill run, so the import has to be trusted
 * blind. That trust comes from one rule: `preview` and `commit` run the SAME
 * validation over the SAME parse, so what the screen promised is what happens.
 *
 * Every kind is `parse` → `preview` → `commit`, and every commit is idempotent:
 * a treasurer who is unsure whether the first click worked WILL click again, and
 * the second click must be a no-op rather than a second set of flats or a second
 * helping of dues.
 */

export type ImportKind = 'FLATS' | 'MEMBERS' | 'OPENING_DUES';
export const IMPORT_KINDS: ImportKind[] = ['FLATS', 'MEMBERS', 'OPENING_DUES'];

/** Thrown for a caller mistake — the controller maps these to 4xx, not 500. */
export class ImportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type RowStatus = 'CREATE' | 'SKIP' | 'ERROR';

export interface PreviewRow {
  rowNumber: number;
  /** The row as it was read, echoed back so the screen can show the source. */
  data: Record<string, string>;
  status: RowStatus;
  message?: string;
}

export interface PreviewResult {
  kind: ImportKind;
  columns: string[];
  rows: PreviewRow[];
  totals: { rows: number; create: number; skip: number; error: number };
  /** Money the import would post, in paise. Only meaningful for OPENING_DUES. */
  totalAmountPaise: number;
  /** Plain-English headline for the screen — what will happen if they commit. */
  summary: string;
  /** True when committing is refused because an OPENING voucher already exists. */
  requiresForce?: boolean;
  warning?: string;
}

export interface CommitResult {
  kind: ImportKind;
  created: number;
  skipped: number;
  totalAmountPaise: number;
  voucherNumber?: string;
  summary: string;
}

export interface ImportSource {
  /** Pasted CSV text. */
  csvText?: string;
  /** An uploaded .csv/.xls/.xlsx file. */
  fileBuffer?: Buffer;
}

// --------------------------------------------------------------- column spec

interface ColumnSpec { header: string; required: boolean }

const COLUMNS: Record<ImportKind, ColumnSpec[]> = {
  FLATS: [
    { header: 'Block', required: true },
    { header: 'Flat Number', required: true },
    { header: 'Status', required: true },
    { header: 'Carpet Area Sqft', required: false },
    { header: 'Built-up Area Sqft', required: false },
  ],
  MEMBERS: [
    { header: 'Block', required: true },
    { header: 'Flat Number', required: true },
    { header: 'Member Name', required: true },
    { header: 'Shares', required: true },
    { header: 'Face Value', required: true },
  ],
  OPENING_DUES: [
    { header: 'Block', required: true },
    { header: 'Flat Number', required: true },
    { header: 'Amount Due', required: true },
  ],
};

const EXAMPLE_ROW: Record<ImportKind, Record<string, string | number>> = {
  FLATS: { 'Block': 'A Wing', 'Flat Number': '101', 'Status': 'OWNER_OCCUPIED', 'Carpet Area Sqft': 620, 'Built-up Area Sqft': 750 },
  MEMBERS: { 'Block': 'A Wing', 'Flat Number': '101', 'Member Name': 'Asha Rao', 'Shares': 5, 'Face Value': 50 },
  OPENING_DUES: { 'Block': 'A Wing', 'Flat Number': '101', 'Amount Due': 12500.5 },
};

export const columnsFor = (kind: ImportKind): string[] => COLUMNS[kind].map(c => c.header);

/**
 * Headers are matched loosely — case, spaces, underscores and punctuation are
 * ignored. A treasurer who types "flat no" or "FLAT_NUMBER" meant "Flat Number",
 * and failing the whole file over a hyphen would be pure pedantry.
 */
const normalizeHeader = (h: string) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Aliases we accept beyond the canonical header, keyed by normalized form. */
const HEADER_ALIASES: Record<string, string> = {
  block: 'Block',
  blockname: 'Block',
  wing: 'Block',
  tower: 'Block',
  flatnumber: 'Flat Number',
  flatno: 'Flat Number',
  flat: 'Flat Number',
  unitnumber: 'Flat Number',
  status: 'Status',
  occupancy: 'Status',
  occupancystatus: 'Status',
  carpetareasqft: 'Carpet Area Sqft',
  carpetarea: 'Carpet Area Sqft',
  builtupareasqft: 'Built-up Area Sqft',
  builtuparea: 'Built-up Area Sqft',
  membername: 'Member Name',
  member: 'Member Name',
  name: 'Member Name',
  ownername: 'Member Name',
  shares: 'Shares',
  sharecount: 'Shares',
  numberofshares: 'Shares',
  facevalue: 'Face Value',
  facevaluepershare: 'Face Value',
  amountdue: 'Amount Due',
  amount: 'Amount Due',
  outstanding: 'Amount Due',
  duesoutstanding: 'Amount Due',
};

// --------------------------------------------------------------------- parse

/**
 * Read a pasted CSV or an uploaded workbook into plain header→value rows.
 *
 * `xlsx.read` handles CSV and xlsx alike, so both doors land on one code path
 * and there is no second parser to drift out of step with the first.
 */
export function parseRows(kind: ImportKind, source: ImportSource): Record<string, string>[] {
  const text = source.csvText?.trim();
  if (!text && !source.fileBuffer?.length) {
    throw new ImportError('Paste your spreadsheet as CSV, or choose a file to upload.');
  }

  let wb: xlsx.WorkBook;
  try {
    wb = text
      ? xlsx.read(text, { type: 'string', raw: true })
      : xlsx.read(source.fileBuffer, { type: 'buffer', raw: true });
  } catch {
    throw new ImportError('That file could not be read. Save it as .xlsx or .csv and try again.');
  }

  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new ImportError('That file has no sheets in it.');
  const sheet = wb.Sheets[sheetName];

  // `header: 1` gives raw arrays so we can normalize the header row ourselves
  // rather than let the parser invent keys like "__EMPTY_1" for blank columns.
  const grid = xlsx.utils.sheet_to_json<any[]>(sheet, { header: 1, blankrows: false, defval: '' });
  if (!grid.length) throw new ImportError('That file is empty — there is nothing to import.');

  const rawHeaders = (grid[0] || []).map(h => String(h ?? '').trim());
  const mapped = rawHeaders.map(h => {
    const n = normalizeHeader(h);
    return HEADER_ALIASES[n] || h;
  });

  const missing = COLUMNS[kind]
    .filter(c => c.required && !mapped.includes(c.header))
    .map(c => c.header);
  if (missing.length) {
    throw new ImportError(
      `Your file is missing the ${missing.length > 1 ? 'columns' : 'column'} ${missing.map(m => `"${m}"`).join(', ')}. ` +
      `Expected: ${columnsFor(kind).join(', ')}. Download the template to see the exact format.`,
    );
  }

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i] || [];
    const row: Record<string, string> = {};
    mapped.forEach((h, c) => { if (h) row[h] = String(cells[c] ?? '').trim(); });
    // A wholly blank line is trailing whitespace in the sheet, not a row the
    // treasurer meant to import — reporting it as an error would be noise.
    if (Object.values(row).some(v => v !== '')) rows.push(row);
  }
  if (!rows.length) throw new ImportError('That file has headers but no rows to import.');
  return rows;
}

// ------------------------------------------------------------- row utilities

/** Signals a bad cell. Caught per row so one bad row never sinks the preview. */
class RowError extends Error {}

/**
 * Rupees (as typed) → integer paise, without ever touching a float.
 *
 * `parseFloat('12500.50') * 100` is 1250049.999… on some inputs, and money that
 * is a rupee light on 200 flats is a reconciliation the treasurer will never
 * win. The decimal string is split and scaled with integer maths instead.
 */
/**
 * A cell that was never in the file at all reads as `undefined`, and
 * `String(undefined)` is the string "undefined" — which sails past a blank check
 * and fails as a number. Every cell goes through here first.
 */
const cell = (raw: unknown): string => (raw === null || raw === undefined ? '' : String(raw).trim());

function toPaise(raw: string, label: string): number {
  const s = cell(raw).replace(/[₹,\s]/g, '');
  if (!s) throw new RowError(`${label} is blank`);
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new RowError(`${label} "${raw}" is not a valid amount — use plain numbers like 12500.50`);
  }
  const negative = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (negative) throw new RowError(`${label} cannot be negative`);
  return paise;
}

function toCount(raw: string, label: string): number {
  const s = cell(raw).replace(/,/g, '');
  if (!s) throw new RowError(`${label} is blank`);
  if (!/^\d+$/.test(s)) throw new RowError(`${label} "${raw}" must be a whole number`);
  return Number(s);
}

/** Blank, or the column missing entirely, both mean "not measured" — not an error. */
function toOptionalArea(raw: string, label: string): number | undefined {
  const s = cell(raw).replace(/,/g, '');
  if (!s) return undefined;
  if (!/^\d+(\.\d+)?$/.test(s)) throw new RowError(`${label} "${raw}" must be a number`);
  return Number(s);
}

function requireText(raw: string, label: string): string {
  const s = cell(raw);
  if (!s) throw new RowError(`${label} is required`);
  return s;
}

/** Flats are keyed on block + number, compared case- and space-insensitively. */
const flatKey = (block: string, number: string) =>
  `${block.trim().toLowerCase().replace(/\s+/g, ' ')}|${number.trim().toLowerCase()}`;

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

// ------------------------------------------------------------------ preview

/** One validated row, carrying the parsed values commit will act on. */
interface Planned<T> extends PreviewRow { parsed?: T }

interface FlatRow { blockName: string; number: string; status: FlatStatus; carpetAreaSqft?: number; builtUpAreaSqft?: number }
interface MemberRow { flatId: string; memberName: string; shareCount: number; faceValuePaise: number }
interface DuesRow { flatId: string; blockName: string; number: string; amountPaise: number }

/**
 * Validate every row and decide its verdict, without writing anything.
 *
 * Shared by `preview` and `commit` on purpose — if commit re-derived its own
 * plan, the preview would become a decorative promise rather than a contract.
 */
async function plan(societyId: string, kind: ImportKind, rows: Record<string, string>[]) {
  if (kind === 'FLATS') return planFlats(societyId, rows);
  if (kind === 'MEMBERS') return planMembers(societyId, rows);
  return planDues(societyId, rows);
}

async function planFlats(societyId: string, rows: Record<string, string>[]): Promise<Planned<FlatRow>[]> {
  const existing = await Flat.find({ societyId: oid(societyId) }).select('number blockName').lean();
  const existingKeys = new Set(existing.map(f => flatKey(f.blockName, f.number)));
  const seen = new Map<string, number>();
  const validStatuses = Object.values(FlatStatus);

  return rows.map((data, i) => {
    const rowNumber = i + 2; // row 1 is the header
    try {
      const blockName = requireText(data['Block'], 'Block');
      const number = requireText(data['Flat Number'], 'Flat Number');
      const rawStatus = cell(data['Status']).toUpperCase().replace(/[\s-]+/g, '_');
      // Blank status means "we don't know yet", which is exactly VACANT — the
      // model's own default. A wrong value is a typo and must be caught.
      const status = (rawStatus ? rawStatus : FlatStatus.VACANT) as FlatStatus;
      if (!validStatuses.includes(status)) {
        throw new RowError(`Status "${data['Status']}" is not valid — use ${validStatuses.join(', ')}`);
      }
      const carpetAreaSqft = toOptionalArea(data['Carpet Area Sqft'], 'Carpet Area Sqft');
      const builtUpAreaSqft = toOptionalArea(data['Built-up Area Sqft'], 'Built-up Area Sqft');

      const key = flatKey(blockName, number);
      const dupOf = seen.get(key);
      if (dupOf) throw new RowError(`${blockName} ${number} is already on row ${dupOf} of this file`);
      seen.set(key, rowNumber);

      if (existingKeys.has(key)) {
        return { rowNumber, data, status: 'SKIP' as const, message: `${blockName} ${number} already exists — leaving it alone` };
      }
      return {
        rowNumber, data, status: 'CREATE' as const,
        message: `Add ${blockName} ${number}`,
        parsed: { blockName, number, status, carpetAreaSqft, builtUpAreaSqft },
      };
    } catch (e: any) {
      return { rowNumber, data, status: 'ERROR' as const, message: e.message };
    }
  });
}

async function planMembers(societyId: string, rows: Record<string, string>[]): Promise<Planned<MemberRow>[]> {
  const flats = await Flat.find({ societyId: oid(societyId) }).select('number blockName').lean();
  const byKey = new Map(flats.map(f => [flatKey(f.blockName, f.number), f]));
  const certified = new Set(
    (await ShareCertificate.find({ societyId: oid(societyId), status: 'ACTIVE' }).select('flatId').lean())
      .map(c => String(c.flatId)),
  );
  const seen = new Map<string, number>();

  return rows.map((data, i) => {
    const rowNumber = i + 2;
    try {
      const blockName = requireText(data['Block'], 'Block');
      const number = requireText(data['Flat Number'], 'Flat Number');
      const memberName = requireText(data['Member Name'], 'Member Name');
      const shareCount = toCount(data['Shares'], 'Shares');
      if (shareCount < 1) throw new RowError('Shares must be at least 1');
      const faceValuePaise = toPaise(data['Face Value'], 'Face Value');

      const key = flatKey(blockName, number);
      const dupOf = seen.get(key);
      if (dupOf) throw new RowError(`${blockName} ${number} is already on row ${dupOf} of this file`);
      seen.set(key, rowNumber);

      const flat = byKey.get(key);
      if (!flat) throw new RowError(`No flat "${blockName} ${number}" in this society — import the flats first`);

      if (certified.has(String(flat._id))) {
        return { rowNumber, data, status: 'SKIP' as const, message: `${blockName} ${number} already holds a share certificate` };
      }
      return {
        rowNumber, data, status: 'CREATE' as const,
        message: `Issue ${shareCount} shares to ${memberName}`,
        parsed: { flatId: String(flat._id), memberName, shareCount, faceValuePaise },
      };
    } catch (e: any) {
      return { rowNumber, data, status: 'ERROR' as const, message: e.message };
    }
  });
}

async function planDues(societyId: string, rows: Record<string, string>[]): Promise<Planned<DuesRow>[]> {
  const flats = await Flat.find({ societyId: oid(societyId) }).select('number blockName').lean();
  const byKey = new Map(flats.map(f => [flatKey(f.blockName, f.number), f]));
  const seen = new Map<string, number>();

  return rows.map((data, i) => {
    const rowNumber = i + 2;
    try {
      const blockName = requireText(data['Block'], 'Block');
      const number = requireText(data['Flat Number'], 'Flat Number');
      const amountPaise = toPaise(data['Amount Due'], 'Amount Due');

      const key = flatKey(blockName, number);
      const dupOf = seen.get(key);
      if (dupOf) throw new RowError(`${blockName} ${number} is already on row ${dupOf} of this file`);
      seen.set(key, rowNumber);

      const flat = byKey.get(key);
      if (!flat) throw new RowError(`No flat "${blockName} ${number}" in this society — import the flats first`);

      // A flat that owes nothing needs no debtor line; posting a zero would just
      // clutter the ledger with entries that say nothing.
      if (amountPaise === 0) {
        return { rowNumber, data, status: 'SKIP' as const, message: `${blockName} ${number} owes nothing` };
      }
      return {
        rowNumber, data, status: 'CREATE' as const,
        message: `${blockName} ${number} owes ₹${(amountPaise / 100).toFixed(2)}`,
        parsed: { flatId: String(flat._id), blockName, number, amountPaise },
      };
    } catch (e: any) {
      return { rowNumber, data, status: 'ERROR' as const, message: e.message };
    }
  });
}

const tally = (rows: PreviewRow[]) => ({
  rows: rows.length,
  create: rows.filter(r => r.status === 'CREATE').length,
  skip: rows.filter(r => r.status === 'SKIP').length,
  error: rows.filter(r => r.status === 'ERROR').length,
});

/** Has this society already had its opening dues posted? */
async function existingOpeningVoucher(societyId: string) {
  return JournalEntry.findOne({
    societyId: oid(societyId), voucherType: 'OPENING', status: 'POSTED',
  }).select('voucherNumber entryDate').lean();
}

/**
 * Dry run — check every row and report exactly what commit would do.
 *
 * Nothing is written. This is the whole point of the feature: 200 rows of
 * someone else's spreadsheet are unknowable until something has read them all
 * and said so out loud.
 */
export async function preview(societyId: string, kind: ImportKind, source: ImportSource): Promise<PreviewResult> {
  const raw = parseRows(kind, source);
  const planned = await plan(societyId, kind, raw);
  const totals = tally(planned);
  const totalAmountPaise = kind === 'OPENING_DUES'
    ? planned.reduce((s, r) => s + ((r as Planned<DuesRow>).parsed?.amountPaise || 0), 0)
    : 0;

  const result: PreviewResult = {
    kind,
    columns: columnsFor(kind),
    rows: planned.map(({ rowNumber, data, status, message }) => ({ rowNumber, data, status, message })),
    totals,
    totalAmountPaise,
    summary: summarize(kind, totals, totalAmountPaise),
  };

  if (kind === 'OPENING_DUES') {
    const already = await existingOpeningVoucher(societyId);
    if (already) {
      result.requiresForce = true;
      result.warning =
        `Opening balances were already posted for this society (voucher ${already.voucherNumber}). ` +
        `Importing again will ADD these dues on top of what is already there — members will appear to owe twice. ` +
        `If you are certain this is a different set of dues, tick the confirmation to proceed.`;
    }
  }
  return result;
}

function summarize(kind: ImportKind, t: { rows: number; create: number; skip: number; error: number }, amountPaise: number): string {
  if (t.error) {
    return `${t.error} of ${t.rows} rows have problems. Fix them in your spreadsheet and preview again — nothing will be imported until every row is clean.`;
  }
  const noun = kind === 'FLATS' ? 'flats' : kind === 'MEMBERS' ? 'share certificates' : 'flats with dues';
  const skipNote = t.skip ? `, and skip ${t.skip} already on the system` : '';
  const money = kind === 'OPENING_DUES' ? ` totalling ₹${(amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '';
  if (!t.create) return `Nothing to do — all ${t.rows} rows are already on the system.`;
  return `Will add ${t.create} ${noun}${money}${skipNote}.`;
}

// ------------------------------------------------------------------- commit

/**
 * Refuse the whole import if any row is broken.
 *
 * Half an import is worse than none: the treasurer cannot tell which rows landed,
 * and the fix is to hand-diff a spreadsheet against the database. All or nothing.
 */
function assertNoErrors(planned: PreviewRow[]): void {
  const bad = planned.filter(r => r.status === 'ERROR');
  if (bad.length) {
    const sample = bad.slice(0, 3).map(b => `row ${b.rowNumber}: ${b.message}`).join('; ');
    throw new ImportError(
      `${bad.length} row${bad.length > 1 ? 's have' : ' has'} problems, so nothing was imported. ` +
      `${sample}${bad.length > 3 ? `; …and ${bad.length - 3} more` : ''}`,
    );
  }
}

export async function commit(
  societyId: string,
  kind: ImportKind,
  source: ImportSource,
  actor: Actor,
  opts: { force?: boolean } = {},
): Promise<CommitResult> {
  const raw = parseRows(kind, source);
  const planned = await plan(societyId, kind, raw);
  assertNoErrors(planned);

  if (kind === 'FLATS') return commitFlats(societyId, planned as Planned<FlatRow>[], actor);
  if (kind === 'MEMBERS') return commitMembers(societyId, planned as Planned<MemberRow>[], actor);
  return commitDues(societyId, planned as Planned<DuesRow>[], actor, opts);
}

/**
 * Create the flats, and any block named in the file that doesn't exist yet.
 *
 * Idempotent by natural key: a flat is identified by society + block + number
 * (the same unique index the model carries), so a re-run finds every row already
 * present and skips it. Blocks are matched by name for the same reason.
 */
async function commitFlats(societyId: string, planned: Planned<FlatRow>[], actor: Actor): Promise<CommitResult> {
  const todo = planned.filter(r => r.status === 'CREATE' && r.parsed).map(r => r.parsed!);
  const skipped = planned.filter(r => r.status === 'SKIP').length;
  if (!todo.length) {
    return { kind: 'FLATS', created: 0, skipped, totalAmountPaise: 0, summary: `Nothing to add — all ${planned.length} flats were already on the system.` };
  }

  const blocks = await Block.find({ societyId: oid(societyId) }).select('name').lean();
  const blockByName = new Map(blocks.map(b => [b.name.trim().toLowerCase(), b._id]));

  // Create the missing blocks first — a flat cannot exist without its blockId.
  const wantedBlocks = new Map<string, string>();
  for (const f of todo) {
    const k = f.blockName.trim().toLowerCase();
    if (!blockByName.has(k) && !wantedBlocks.has(k)) wantedBlocks.set(k, f.blockName.trim());
  }
  for (const [k, name] of wantedBlocks) {
    // upsert, not create: two admins importing at once must not race into a
    // duplicate-key error on the society+name unique index.
    const b = await Block.findOneAndUpdate(
      { societyId: oid(societyId), name },
      {
        $setOnInsert: {
          societyId: oid(societyId), name,
          createdBy: oid(actor.userId), createdByName: actor.userName,
          updatedBy: oid(actor.userId), updatedByName: actor.userName,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    blockByName.set(k, b._id as mongoose.Types.ObjectId);
  }

  const docs = todo.map(f => ({
    number: f.number,
    blockName: f.blockName.trim(),
    blockId: blockByName.get(f.blockName.trim().toLowerCase()),
    societyId: oid(societyId),
    status: f.status,
    carpetAreaSqft: f.carpetAreaSqft,
    builtUpAreaSqft: f.builtUpAreaSqft,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  }));

  // `ordered: false` so a flat created by someone else between preview and
  // commit trips its unique index without taking the rest of the batch down.
  let created = 0;
  try {
    const made = await Flat.insertMany(docs, { ordered: false });
    created = made.length;
  } catch (e: any) {
    if (e?.code !== 11000 && !Array.isArray(e?.writeErrors)) throw e;
    created = (e.insertedDocs?.length ?? docs.length - (e.writeErrors?.length ?? 0));
  }

  return {
    kind: 'FLATS', created, skipped: skipped + (docs.length - created), totalAmountPaise: 0,
    summary: `Added ${created} flat${created === 1 ? '' : 's'}${wantedBlocks.size ? ` and ${wantedBlocks.size} new block${wantedBlocks.size === 1 ? '' : 's'}` : ''}.`,
  };
}

/**
 * Issue a share certificate per row.
 *
 * The posting is left entirely to `issueShares` — it reserves the distinctive
 * share numbers, draws the certificate number and posts Dr Bank / Cr Share
 * Capital in one transaction. Reimplementing any of that here would give the
 * import its own subtly different idea of what a share is.
 *
 * Idempotent because a flat holding an ACTIVE certificate is skipped, and
 * `issueShares` refuses a second one anyway — the guard is belt and braces.
 */
async function commitMembers(societyId: string, planned: Planned<MemberRow>[], actor: Actor): Promise<CommitResult> {
  const todo = planned.filter(r => r.status === 'CREATE' && r.parsed);
  const skipped = planned.filter(r => r.status === 'SKIP').length;

  let created = 0, totalAmountPaise = 0;
  for (const row of todo) {
    const p = row.parsed!;
    const cert = await issueShares(societyId, {
      flatId: p.flatId, memberName: p.memberName,
      shareCount: p.shareCount, faceValuePaise: p.faceValuePaise,
    }, actor);
    created++;
    totalAmountPaise += cert.amountPaise;
  }

  return {
    kind: 'MEMBERS', created, skipped, totalAmountPaise,
    summary: created
      ? `Issued ${created} share certificate${created === 1 ? '' : 's'} worth ₹${(totalAmountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}.`
      : 'Nothing to issue — every flat in the file already holds a certificate.',
  };
}

/**
 * Post the opening dues as ONE balanced voucher, plus an opening INVOICE per flat.
 *
 * Dr Sundry Debtors per flat and a single Cr Accumulated Surplus for the total:
 * the dues are wealth the society carried in from before the books started, not
 * income it earned. One voucher rather than one per flat, because they are one
 * event.
 *
 * The invoices are not decoration. Tagging the GL line with `flatId` is NOT a
 * sub-ledger — every path that settles member dues (`allocateFifo`,
 * `getFlatArrears`, the defaulters report) reads open `MaintenanceInvoice` rows
 * and never looks at the journal. Without an invoice the member's payment finds
 * nothing to settle, becomes an advance, and the Debtors debit is stranded
 * forever with nothing able to credit it — while the Balance Sheet still foots
 * and drift still reports clean, because both sides were posted faithfully.
 *
 * Idempotency here cannot lean on a natural key — nothing about a debtor line
 * makes it unique — so it leans on the voucher type instead: a society gets one
 * OPENING voucher, and a second is refused outright unless `force` is passed.
 * Double-posted opening dues are silent (the ledger still balances perfectly),
 * serious (every member appears to owe twice) and hard to unpick months later.
 */
async function commitDues(
  societyId: string,
  planned: Planned<DuesRow>[],
  actor: Actor,
  opts: { force?: boolean },
): Promise<CommitResult> {
  const todo = planned.filter(r => r.status === 'CREATE' && r.parsed).map(r => r.parsed!);
  const skipped = planned.filter(r => r.status === 'SKIP').length;
  if (!todo.length) {
    throw new ImportError('None of these flats owe anything, so there is no opening entry to post.');
  }

  const already = await existingOpeningVoucher(societyId);
  if (already && !opts.force) {
    throw new ImportError(
      `Opening balances have already been posted for this society (voucher ${already.voucherNumber}). ` +
      `Importing these dues again would make every member owe twice, and that is very hard to unpick later. ` +
      `If you are certain these are different dues, re-submit with the confirmation ticked.`,
      409,
    );
  }

  const totalAmountPaise = todo.reduce((s, r) => s + r.amountPaise, 0);
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const openingDate = new Date();
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const { fyString } = getFinancialYear(openingDate, startMonth);

  // Invoices and voucher are one event, so they commit or fail together. Posting
  // the journal first and creating invoices after would, on a mid-way failure,
  // leave debtors nobody can ever pay — and the retry would be refused by the
  // idempotency guard, which only knows about the voucher.
  const session = await mongoose.startSession();
  let je: any;
  try {
    await session.withTransaction(async () => {
      for (const r of todo) {
        // `OPENING` rather than a real 'YYYY-MM': these dues predate the books,
        // and parking them in a live month would collide with that month's
        // actual bill on the unique {society, flat, period} index. The field is
        // only ever displayed or matched exactly, never parsed as a date.
        const existing = await MaintenanceInvoice.findOne({
          societyId, flatId: r.flatId, billingPeriod: 'OPENING',
        }).session(session);

        // A forced re-import adds to the flat's opening position rather than
        // minting a second one. A flat has one opening balance by definition —
        // and `force` means "these are further dues", not "this flat gets a
        // duplicate identity".
        if (existing) {
          existing.totalPaise += r.amountPaise;
          existing.grandTotalDuePaise += r.amountPaise;
          existing.outstandingPaise += r.amountPaise;
          existing.lineItems.push({
            code: 'OPENING',
            name: 'Opening dues brought forward',
            category: 'OTHER',
            baseAmountPaise: r.amountPaise,
            lineTotalPaise: r.amountPaise,
            isPostable: false,
          } as any);
          existing.status = existing.outstandingPaise > 0 ? 'OVERDUE' : 'PAID';
          await existing.save({ session });
          continue;
        }

        const { number } = await nextDocNumber(societyId, 'INVOICE', fyString, {
          prefix: policy.numbering.invoice.prefix,
          padding: policy.numbering.invoice.padding,
          template: policy.numbering.invoice.template,
        }, session);
        // Marked OVERDUE and dated today: these are arrears by definition — the
        // society was already owed them before the books opened — so FIFO, which
        // orders on `dueDate`, settles them ahead of this month's bill.
        await MaintenanceInvoice.create([{
          societyId,
          flatId: r.flatId,
          blockName: r.blockName,
          flatNumber: r.number,
          invoiceNumber: number,
          financialYear: fyString,
          billingPeriod: 'OPENING',
          invoiceDate: openingDate,
          dueDate: openingDate,
          lineItems: [{
            code: 'OPENING',
            name: 'Opening dues brought forward',
            category: 'OTHER',
            baseAmountPaise: r.amountPaise,
            lineTotalPaise: r.amountPaise,
            isPostable: false, // the OPENING voucher below books these; a line that
                              // posted again would double the debtor.
          }],
          totalPaise: r.amountPaise,
          grandTotalDuePaise: r.amountPaise,
          outstandingPaise: r.amountPaise,
          // None of this is penalty — interest, if any, was already baked into the
          // figure the society typed. Claiming otherwise would change the base
          // next month's interest is charged on.
          interestOutstandingPaise: 0,
          status: 'OVERDUE',
          generatedBy: 'MANUAL',
          generatedByUserId: actor.userId,
        }], { session });
      }

      je = await postJournal(societyId, {
        voucherType: 'OPENING',
        entryDate: openingDate,
        narration: `Opening dues imported for ${todo.length} flat${todo.length === 1 ? '' : 's'}`,
        sourceType: 'OPENING',
        lines: [
          ...todo.map(r => ({
            accountCode: ACCOUNT_CODES.DEBTORS,
            debitPaise: r.amountPaise,
            flatId: r.flatId,
            description: `Opening dues — ${r.blockName} ${r.number}`,
          })),
          {
            accountCode: ACCOUNT_CODES.SURPLUS,
            creditPaise: totalAmountPaise,
            description: 'Opening balance equity',
          },
        ],
        postedBy: actor.userId,
        postedByName: actor.userName,
        fyStartMonth: startMonth,
      }, session);
    });
  } finally {
    session.endSession();
  }

  return {
    kind: 'OPENING_DUES', created: todo.length, skipped, totalAmountPaise,
    voucherNumber: je.voucherNumber,
    summary: `Posted ₹${(totalAmountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} of opening dues across ${todo.length} flat${todo.length === 1 ? '' : 's'} as voucher ${je.voucherNumber}.`,
  };
}

// ----------------------------------------------------------------- template

/**
 * A blank workbook with the right headers and one worked example.
 *
 * The example row is the documentation — nobody reads a column spec, but
 * everybody copies the row above theirs.
 */
export async function templateFor(kind: ImportKind): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ResiSmart';
  const ws = wb.addWorksheet(kind === 'OPENING_DUES' ? 'Opening Dues' : kind === 'MEMBERS' ? 'Members & Shares' : 'Flats');

  const headers = columnsFor(kind);
  const header = ws.addRow(headers);
  header.font = { bold: true };
  header.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  });

  const example = EXAMPLE_ROW[kind];
  const row = ws.addRow(headers.map(h => example[h] ?? ''));
  row.font = { italic: true, color: { argb: 'FF94A3B8' } };

  ws.columns.forEach((col, i) => {
    let max = 12;
    col.eachCell?.({ includeEmpty: false }, c => { max = Math.max(max, String(c.value ?? '').length + 2); });
    col.width = Math.min(max, i === 0 ? 24 : 20);
  });

  // Written as a note rather than an extra row: a stray row would be parsed back
  // as data and reported as a broken row by our own validator.
  ws.getCell('A1').note = 'Replace the grey example row with your own data. Do not rename these headers.';

  // Copied into a real Buffer: exceljs hands back its own Buffer-ish type, and
  // callers (multer's parser, res.send) want the genuine article.
  return Buffer.from(await wb.xlsx.writeBuffer());
}
