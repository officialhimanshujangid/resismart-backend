import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import { LedgerAccount } from '../models/ledger-account.model';
import { Vendor } from '../models/vendor.model';
import { Block } from '../models/block.model';
import { FinanceFund } from '../models/finance-fund.model';
import { Expense } from '../models/expense.model';
import { SocietyStaff } from '../models/society-staff.model';
import { FinancePolicy } from '../models/finance-policy.model';
import { createExpense, approveExpense, payExpense } from './expenses.service';
import { Actor } from './share-capital.service';
import { parseGrid, attachDropdown, ImportError, PreviewRow, RowStatus, ImportSource } from './bulk-import.service';
import { logger } from '../utils/logger.util';

/**
 * Recording many expenses at once — from a spreadsheet, or by repeating last
 * month.
 *
 * Almost every cost a society carries repeats: the agency bill, electricity,
 * the water tanker, the lift AMC, the gardener. Entering each one by hand every
 * month is the sort of work that quietly stops getting done, and migrating a
 * year of history one voucher at a time is not realistic at all.
 *
 * This borrows the parsing and preview shape from `bulk-import.service` but not
 * its commit: every other import creates *entities*, and a duplicate flat is an
 * annoyance. This one moves *money*, and a duplicate run leaves the society
 * genuinely poorer. Hence the separate service, and the duplicate warning.
 *
 * It deliberately does NOT reimplement expense posting. `createExpense` already
 * resolves vendors, computes TDS against the society's own thresholds, tags
 * wings, draws the voucher number and enforces the approval threshold. Writing
 * a second path would mean two sets of rules to keep in step.
 */

/** How to read the file. Asked in plain words at upload — see the controller. */
export type BulkExpenseShape = 'ONE_VOUCHER' | 'PER_ROW';

const COLUMNS = ['Date', 'Head', 'Amount', 'Vendor', 'Staff', 'Block', 'Fund', 'Note'] as const;
const REQUIRED = ['Head', 'Amount'];

export interface BulkExpenseOptions {
  shape: BulkExpenseShape;
  /**
   * The money has already left the account and this is the record of it.
   * Runs the existing approve → pay path rather than inventing a second one,
   * so the approval threshold and the ledger postings behave identically to
   * the single-expense screen.
   */
  alreadyPaid?: boolean;
  paymentMode?: 'BANK' | 'CASH' | 'CHEQUE' | 'UPI';
  /** Applies to every row that has no Date of its own, and names the voucher. */
  defaultDate?: string;
  periodLabel?: string;
}

export interface BulkExpensePreview {
  columns: string[];
  rows: PreviewRow[];
  totals: { rows: number; create: number; error: number };
  totalAmountPaise: number;
  summary: string;
  /** Non-blocking: a very similar expense already exists for this period. */
  duplicateWarning?: string;
  /**
   * Non-blocking: "mark as paid" cannot take effect on some or all of these.
   *
   * Whoever uploads the file is its creator, and a society with an approval
   * threshold does not let a creator approve their own expense above it. So
   * above that figure "already paid" always lands in the approval queue — which
   * is correct, and much better said before the upload than discovered after.
   */
  approvalWarning?: string;
}

export interface BulkExpenseResult {
  vouchers: number;
  lines: number;
  totalAmountPaise: number;
  /** Created, approved and paid — the money has moved. */
  posted: number;
  /** Created but left awaiting approval, with the reason. */
  pending: { voucherNumber: string; reason: string }[];
  summary: string;
}

interface ParsedRow {
  rowNumber: number;
  raw: Record<string, string>;
  date?: Date;
  accountCode?: string;
  amountPaise: number;
  vendorId?: string;
  staffId?: string;
  blockId?: string;
  fundId?: string;
  note?: string;
  error?: string;
}

const normalize = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Rupees as typed → integer paise. Accepts "1,200.50", "₹1200", "1200". */
function toPaise(v: string): number {
  const cleaned = String(v ?? '').replace(/[₹,\s]/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

/**
 * Resolve the four name columns in one pass.
 *
 * Names, not codes. A manager knows "Electricity"; almost none of them know
 * that it is 5120, and a form that demands the number is a form they will fill
 * in wrong. Codes still work for anyone who prefers them.
 */
async function buildLookups(societyId: string) {
  const sid = new mongoose.Types.ObjectId(societyId);
  const [accounts, vendors, blocks, funds, staff] = await Promise.all([
    LedgerAccount.find({ societyId: sid, isActive: true, type: 'EXPENSE' }).select('code name').lean(),
    Vendor.find({ societyId: sid, isActive: true }).select('name').lean(),
    Block.find({ societyId: sid }).select('name').lean(),
    FinanceFund.find({ societyId: sid, isActive: true }).select('name').lean(),
    SocietyStaff.find({ societyId: sid, isActive: true }).select('person.name staffCode').lean(),
  ]);

  const accountByKey = new Map<string, string>();
  for (const a of accounts) {
    accountByKey.set(normalize(a.code), a.code);
    accountByKey.set(normalize(a.name), a.code);
  }

  // Staff answer to either their name or their code — a payroll sheet exported
  // from somewhere else is as likely to carry one as the other.
  const staffByName = new Map<string, string>();
  for (const s of staff) {
    staffByName.set(normalize(s.person.name), String(s._id));
    staffByName.set(normalize(s.staffCode), String(s._id));
  }

  return {
    accounts,
    accountByKey,
    staff,
    staffByName,
    vendorByName: new Map(vendors.map(v => [normalize(v.name), String(v._id)])),
    blockByName: new Map(blocks.map(b => [normalize(b.name), String(b._id)])),
    fundByName: new Map(funds.map(f => [normalize(f.name), String(f._id)])),
  };
}

type Lookups = Awaited<ReturnType<typeof buildLookups>>;

/** One row → one validated line, or one row-level error. Never throws. */
function parseOne(raw: Record<string, string>, rowNumber: number, look: Lookups, opts: BulkExpenseOptions): ParsedRow {
  const out: ParsedRow = { rowNumber, raw, amountPaise: 0 };

  const headRaw = (raw['Head'] || '').trim();
  if (!headRaw) { out.error = 'No expense head given.'; return out; }
  const code = look.accountByKey.get(normalize(headRaw));
  if (!code) {
    out.error = `"${headRaw}" is not one of this society's expense heads.`;
    return out;
  }
  out.accountCode = code;

  const paise = toPaise(raw['Amount']);
  if (!Number.isFinite(paise)) { out.error = `"${raw['Amount']}" is not an amount.`; return out; }
  if (paise <= 0) { out.error = 'Amount must be more than zero.'; return out; }
  if (paise > 1e15) { out.error = 'That amount is implausibly large.'; return out; }
  out.amountPaise = paise;

  const dateRaw = (raw['Date'] || '').trim() || opts.defaultDate || '';
  if (dateRaw) {
    const d = new Date(dateRaw);
    if (Number.isNaN(d.getTime())) { out.error = `"${dateRaw}" is not a date.`; return out; }
    out.date = d;
  }

  const vendorRaw = (raw['Vendor'] || '').trim();
  if (vendorRaw) {
    const id = look.vendorByName.get(normalize(vendorRaw));
    if (!id) { out.error = `"${vendorRaw}" is not a vendor of this society.`; return out; }
    out.vendorId = id;
  }

  const staffRaw = (raw['Staff'] || '').trim();
  if (staffRaw) {
    const id = look.staffByName.get(normalize(staffRaw));
    if (!id) { out.error = `"${staffRaw}" is not a staff member of this society.`; return out; }
    out.staffId = id;
  }

  const blockRaw = (raw['Block'] || '').trim();
  if (blockRaw) {
    const id = look.blockByName.get(normalize(blockRaw));
    if (!id) { out.error = `"${blockRaw}" is not a wing of this society.`; return out; }
    out.blockId = id;
  }

  const fundRaw = (raw['Fund'] || '').trim();
  if (fundRaw) {
    const id = look.fundByName.get(normalize(fundRaw));
    if (!id) { out.error = `"${fundRaw}" is not a fund of this society.`; return out; }
    out.fundId = id;
  }

  out.note = (raw['Note'] || '').trim() || undefined;
  return out;
}

/**
 * A row-level error fails only that row.
 *
 * One misspelt vendor in row 40 must not throw away the other 39. This is the
 * behaviour `bulk-import` already established and treasurers already expect.
 */
async function parseAll(societyId: string, source: ImportSource, opts: BulkExpenseOptions) {
  const rows = parseGrid(source, {
    required: REQUIRED,
    expected: [...COLUMNS],
    aliases: {
      date: 'Date', expensedate: 'Date', billdate: 'Date',
      head: 'Head', account: 'Head', expensehead: 'Head', particulars: 'Head',
      amount: 'Amount', amountrs: 'Amount', value: 'Amount',
      vendor: 'Vendor', payee: 'Vendor', supplier: 'Vendor',
      staff: 'Staff', employee: 'Staff', staffcode: 'Staff', staffname: 'Staff',
      block: 'Block', wing: 'Block', tower: 'Block',
      fund: 'Fund',
      note: 'Note', remarks: 'Note', description: 'Note', narration: 'Note',
    },
  });
  const look = await buildLookups(societyId);
  return { look, parsed: rows.map((r, i) => parseOne(r, i + 2, look, opts)) };
}

/**
 * Has something like this already been recorded?
 *
 * A warning, never a block. Paying a vendor twice in a month is ordinary — an
 * advance, an arrear, a bonus — so refusing would be wrong. Doing it silently
 * is what must not happen: the money genuinely leaves twice.
 */
async function duplicateCheck(societyId: string, parsed: ParsedRow[], opts: BulkExpenseOptions): Promise<string | undefined> {
  const good = parsed.filter(p => !p.error);
  if (!good.length) return undefined;

  const total = good.reduce((s, p) => s + p.amountPaise, 0);
  const when = good.find(p => p.date)?.date || (opts.defaultDate ? new Date(opts.defaultDate) : new Date());
  const from = new Date(when.getFullYear(), when.getMonth(), 1);
  const to = new Date(when.getFullYear(), when.getMonth() + 1, 1);

  const existing = await Expense.find({
    societyId: new mongoose.Types.ObjectId(societyId),
    expenseDate: { $gte: from, $lt: to },
    status: { $ne: 'CANCELLED' },
  }).select('voucherNumber grossPaise').lean();

  const match = existing.find(e => e.grossPaise === total);
  if (!match) return undefined;

  return `${match.voucherNumber} for the same month already totals ₹${(total / 100).toLocaleString('en-IN')}. ` +
    `Recording this as well will take the money out twice — check before you commit.`;
}

export async function preview(
  societyId: string,
  source: ImportSource,
  opts: BulkExpenseOptions,
): Promise<BulkExpensePreview> {
  const { parsed } = await parseAll(societyId, source, opts);

  const rows: PreviewRow[] = parsed.map(p => ({
    rowNumber: p.rowNumber,
    data: p.raw,
    status: (p.error ? 'ERROR' : 'CREATE') as RowStatus,
    message: p.error,
  }));

  const create = rows.filter(r => r.status === 'CREATE').length;
  const error = rows.length - create;
  const totalAmountPaise = parsed.filter(p => !p.error).reduce((s, p) => s + p.amountPaise, 0);
  const money = `₹${(totalAmountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  const summary = create === 0
    ? 'Nothing here can be recorded — every row has a problem.'
    : opts.shape === 'ONE_VOUCHER'
      ? `One expense voucher with ${create} line${create > 1 ? 's' : ''}, totalling ${money}` +
        (error ? `. ${error} row${error > 1 ? 's' : ''} will be skipped.` : '.')
      : `${create} separate expense voucher${create > 1 ? 's' : ''}, totalling ${money}` +
        (error ? `. ${error} row${error > 1 ? 's' : ''} will be skipped.` : '.');

  return {
    columns: [...COLUMNS],
    rows,
    totals: { rows: rows.length, create, error },
    totalAmountPaise,
    summary,
    duplicateWarning: await duplicateCheck(societyId, parsed, opts),
    approvalWarning: await approvalCheck(societyId, parsed, opts),
  };
}

/**
 * Will "mark as paid" actually be able to pay these?
 *
 * A warning rather than a refusal: the vouchers are still worth creating, they
 * just wait for a second officer. Saying so up front is the difference between
 * a considered workflow and an unexplained half-result.
 */
async function approvalCheck(
  societyId: string,
  parsed: ParsedRow[],
  opts: BulkExpenseOptions,
): Promise<string | undefined> {
  if (!opts.alreadyPaid) return undefined;
  const policy = await FinancePolicy.findOne({ societyId }).select('approvals.expenseThresholdPaise').lean();
  const threshold = policy?.approvals?.expenseThresholdPaise ?? 0;
  if (threshold <= 0) return undefined;

  const good = parsed.filter(p => !p.error);
  const affected = opts.shape === 'ONE_VOUCHER'
    ? (good.reduce((s, p) => s + p.amountPaise, 0) >= threshold ? 1 : 0)
    : good.filter(p => p.amountPaise >= threshold).length;
  if (!affected) return undefined;

  const limit = `₹${(threshold / 100).toLocaleString('en-IN')}`;
  return opts.shape === 'ONE_VOUCHER'
    ? `This voucher is over your ${limit} approval threshold, so it will be recorded and left for a second officer to approve — you cannot approve your own.`
    : `${affected} of these are over your ${limit} approval threshold and will wait for a second officer. The rest will be paid.`;
}

export async function commit(
  societyId: string,
  source: ImportSource,
  opts: BulkExpenseOptions,
  actor: Actor,
): Promise<BulkExpenseResult> {
  const { parsed } = await parseAll(societyId, source, opts);
  const good = parsed.filter(p => !p.error);
  if (!good.length) throw new ImportError('Nothing here can be recorded — every row has a problem.');

  const pending: BulkExpenseResult['pending'] = [];
  let posted = 0;
  const created: string[] = [];

  const finish = async (expenseId: string, voucherNumber: string) => {
    if (!opts.alreadyPaid) return;
    // Reuse the real path rather than posting the journals here. If the society
    // requires a separate approver above a threshold, that rule must apply to a
    // spreadsheet exactly as it applies to the screen — so a refusal leaves the
    // voucher awaiting approval instead of failing the whole batch.
    try {
      await approveExpense(societyId, expenseId, actor);
      await payExpense(societyId, expenseId, actor, opts.paymentMode);
      posted++;
    } catch (e: any) {
      pending.push({ voucherNumber, reason: e.message || 'Needs approval' });
    }
  };

  if (opts.shape === 'ONE_VOUCHER') {
    // Every line on one voucher. The vendor and date can only come from the
    // first row that names them — a single voucher has one of each.
    const withVendor = good.find(p => p.vendorId);
    const expense = await createExpense(societyId, {
      vendorId: withVendor?.vendorId,
      category: opts.periodLabel,
      description: opts.periodLabel ? `Bulk entry — ${opts.periodLabel}` : 'Bulk entry',
      expenseDate: (good.find(p => p.date)?.date || new Date()).toISOString(),
      paymentMode: opts.paymentMode,
      lineItems: good.map(p => ({
        expenseAccountCode: p.accountCode,
        amountPaise: p.amountPaise,
        description: p.note,
        staffId: p.staffId,
        blockId: p.blockId,
        fundId: p.fundId,
      })),
    }, actor);
    created.push(expense.voucherNumber);
    await finish(String(expense._id), expense.voucherNumber);
  } else {
    for (const p of good) {
      const expense = await createExpense(societyId, {
        vendorId: p.vendorId,
        category: opts.periodLabel,
        description: p.note,
        expenseDate: (p.date || new Date()).toISOString(),
        paymentMode: opts.paymentMode,
        lineItems: [{
          expenseAccountCode: p.accountCode,
          amountPaise: p.amountPaise,
          description: p.note,
          staffId: p.staffId,
          blockId: p.blockId,
          fundId: p.fundId,
        }],
      }, actor);
      created.push(expense.voucherNumber);
      await finish(String(expense._id), expense.voucherNumber);
    }
  }

  const totalAmountPaise = good.reduce((s, p) => s + p.amountPaise, 0);
  const money = `₹${(totalAmountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  logger.info(`Society ${societyId}: bulk expense — ${created.length} voucher(s), ${money}, by ${actor.userName}`);

  return {
    vouchers: created.length,
    lines: good.length,
    totalAmountPaise,
    posted,
    pending,
    summary: opts.alreadyPaid
      ? `${created.length} voucher${created.length > 1 ? 's' : ''} recorded, ${money}. ` +
        `${posted} paid${pending.length ? `, ${pending.length} awaiting approval.` : '.'}`
      : `${created.length} voucher${created.length > 1 ? 's' : ''} recorded, ${money}, awaiting approval.`,
  };
}

/**
 * Last month's voucher, ready to be edited and sent again.
 *
 * This — not the spreadsheet — is the route most societies will actually use
 * after the first month. Nothing changes between January and February except
 * the electricity bill, and re-uploading a file to say so is absurd.
 */
export async function repeatFrom(societyId: string, expenseId: string) {
  const src = await Expense.findOne({ _id: expenseId, societyId }).lean();
  if (!src) throw new ImportError('That expense could not be found.', 404);

  const look = await buildLookups(societyId);
  const nameByCode = new Map(look.accounts.map(a => [a.code, a.name]));

  return {
    from: { voucherNumber: src.voucherNumber, expenseDate: src.expenseDate, grossPaise: src.grossPaise },
    vendorId: src.vendorId ? String(src.vendorId) : undefined,
    paymentMode: (src as any).paymentMode,
    lines: (src.lineItems || []).map(l => ({
      accountCode: l.expenseAccountCode,
      // Re-read the name rather than trusting the snapshot: an account renamed
      // since would otherwise show its old label on a brand new voucher.
      head: nameByCode.get(l.expenseAccountCode) || l.expenseAccountName || l.expenseAccountCode,
      amountPaise: l.amountPaise,
      description: l.description,
      blockId: l.blockId ? String(l.blockId) : undefined,
      fundId: l.fundId ? String(l.fundId) : undefined,
      /** False when the head has since been deactivated — the screen flags it. */
      stillValid: nameByCode.has(l.expenseAccountCode),
    })),
  };
}

/**
 * A template already filled in with this society's own heads and vendors.
 *
 * An empty grid with a "Head" column is a quiz. The society's real expense
 * heads on a second sheet turn it into a lookup, and cut the single largest
 * source of failed rows.
 */
export async function templateFor(societyId: string): Promise<Buffer> {
  const sid = new mongoose.Types.ObjectId(societyId);
  const [look, vendors, blocks, funds] = await Promise.all([
    buildLookups(societyId),
    Vendor.find({ societyId: sid, isActive: true }).select('name').sort({ name: 1 }).lean(),
    Block.find({ societyId: sid }).select('name').sort({ name: 1 }).lean(),
    FinanceFund.find({ societyId: sid, isActive: true }).select('name').sort({ name: 1 }).lean(),
  ]);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ResiSmart';

  const ws = wb.addWorksheet('Expenses');
  const headers = [...COLUMNS];
  const header = ws.addRow(headers);
  header.font = { bold: true };
  header.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  });

  const sampleHead = look.accounts[0]?.name || 'Electricity';
  const example = ws.addRow(['2026-07-31', sampleHead, 45000, '', '', '', '', 'July']);
  example.font = { italic: true, color: { argb: 'FF94A3B8' } };

  ws.columns.forEach(col => {
    let max = 12;
    col.eachCell?.({ includeEmpty: false }, c => { max = Math.max(max, String(c.value ?? '').length + 2); });
    col.width = Math.min(max, 24);
  });

  // Four dropdowns, all drawn from this society's own records. Head is the one
  // that matters most — an unrecognised head is by far the commonest reason a
  // row fails, and it is the one a manager is least able to guess.
  attachDropdown(wb, ws, headers, 'Head', look.accounts.map(a => a.name));
  attachDropdown(wb, ws, headers, 'Vendor', vendors.map(v => v.name));
  attachDropdown(wb, ws, headers, 'Staff', look.staff.map(s => s.person.name));
  attachDropdown(wb, ws, headers, 'Block', blocks.map(b => b.name));
  attachDropdown(wb, ws, headers, 'Fund', funds.map(f => f.name));

  ws.getCell('A1').note =
    'Replace the grey example row with your own data. Head and Amount are required; the rest are optional. ' +
    'Head, Vendor, Staff, Block and Fund have dropdowns — click the cell and pick from the list.';

  return Buffer.from(await wb.xlsx.writeBuffer());
}
