import mongoose from 'mongoose';
import { Vendor, IVendor } from '../models/vendor.model';
import { Expense } from '../models/expense.model';
import { JournalEntry } from '../models/journal-entry.model';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';
import { encryptSecret } from '../utils/finance-crypto.util';
import { getFinancialYear } from '../utils/financial-year.util';
import { getFyStartMonth } from './finance-policy.service';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class VendorError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export interface Actor { userId: string; userName: string }

/**
 * What a vendor looks like to a screen.
 *
 * The bank account number never appears — only `last4`, enough to confirm you are
 * paying the right account without putting the number on anyone's monitor.
 */
export interface VendorView {
  _id: string;
  name: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  gstin?: string;
  pan?: string;
  tdsApplicable: boolean;
  tdsSection?: string;
  tdsRatePercent?: number;
  tdsThresholdSinglePaise: number;
  tdsThresholdAnnualPaise: number;
  bank?: { accountName?: string; last4?: string; ifsc?: string; bankName?: string; upiId?: string } | null;
  notes?: string;
  isActive: boolean;
  createdByName: string;
  updatedByName?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const toView = (v: IVendor | any): VendorView => ({
  _id: String(v._id),
  name: v.name,
  contactPerson: v.contactPerson,
  phone: v.phone,
  email: v.email,
  gstin: v.gstin,
  pan: v.pan,
  tdsApplicable: !!v.tdsApplicable,
  tdsSection: v.tdsSection,
  tdsRatePercent: v.tdsRatePercent,
  tdsThresholdSinglePaise: v.tdsThresholdSinglePaise ?? 0,
  tdsThresholdAnnualPaise: v.tdsThresholdAnnualPaise ?? 0,
  bank: v.bank?.last4 || v.bank?.upiId || v.bank?.accountName
    ? { accountName: v.bank.accountName, last4: v.bank.last4, ifsc: v.bank.ifsc, bankName: v.bank.bankName, upiId: v.bank.upiId }
    : null,
  notes: v.notes,
  isActive: v.isActive !== false,
  createdByName: v.createdByName,
  updatedByName: v.updatedByName,
  createdAt: v.createdAt,
  updatedAt: v.updatedAt,
});

/** Fields a client may set. Anything else — societyId, audit columns, the
 *  encrypted bank triplet — is server-owned and silently ignored. */
const WRITABLE = [
  'name', 'contactPerson', 'phone', 'email', 'gstin', 'pan',
  'tdsApplicable', 'tdsSection', 'tdsRatePercent',
  'tdsThresholdSinglePaise', 'tdsThresholdAnnualPaise',
  'notes', 'isActive',
] as const;

/**
 * Apply the bank block.
 *
 * A blank account number means "leave what is stored alone" — the number is
 * never sent back to the browser, so a form round-trip would otherwise wipe it.
 */
function applyBank(vendor: IVendor, body: any): void {
  const b = body.bank;
  if (!b) return;
  vendor.bank = vendor.bank || {};
  if (b.accountName !== undefined) vendor.bank.accountName = b.accountName;
  if (b.ifsc !== undefined) vendor.bank.ifsc = b.ifsc;
  if (b.bankName !== undefined) vendor.bank.bankName = b.bankName;
  if (b.upiId !== undefined) vendor.bank.upiId = b.upiId;
  if (b.accountNumber) {
    const e = encryptSecret(String(b.accountNumber));
    vendor.bank.accountNumberEnc = e.ct;
    vendor.bank.accountNumberIv = e.iv;
    vendor.bank.accountNumberTag = e.tag;
    vendor.bank.last4 = String(b.accountNumber).slice(-4);
  }
}

export async function listVendors(
  societyId: string,
  opts: { search?: string; isActive?: boolean; page?: number; pageSize?: number } = {},
) {
  const q: any = { societyId: oid(societyId) };
  if (opts.isActive !== undefined) q.isActive = opts.isActive;
  if (opts.search?.trim()) {
    // Escaped: an operator pasting "C++ Services" should search for it, not hand
    // the regex engine a quantifier to choke on.
    const safe = opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    q.$or = [{ name: rx }, { contactPerson: rx }, { phone: rx }, { pan: rx }, { gstin: rx }];
  }

  const page = Math.max(1, opts.page || 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize || 25));
  const [rows, total] = await Promise.all([
    Vendor.find(q).sort({ name: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Vendor.countDocuments(q),
  ]);
  return { vendors: rows.map(toView), pagination: { page, pageSize, total } };
}

export async function createVendor(societyId: string, body: any, actor: Actor): Promise<VendorView> {
  const vendor = new Vendor({
    societyId: oid(societyId),
    createdBy: oid(actor.userId),
    createdByName: actor.userName,
    updatedBy: oid(actor.userId),
    updatedByName: actor.userName,
  });
  for (const k of WRITABLE) if (body[k] !== undefined) (vendor as any)[k] = body[k];
  applyBank(vendor, body);
  if (!vendor.name?.trim()) throw new VendorError('A vendor needs a name');
  await vendor.save();
  return toView(vendor);
}

export async function updateVendor(societyId: string, vendorId: string, body: any, actor: Actor): Promise<VendorView> {
  const vendor = await Vendor.findOne({ _id: vendorId, societyId: oid(societyId) });
  if (!vendor) throw new VendorError('Vendor not found', 404);

  // Whitelisted, not `$set: req.body` — a blind spread would let a caller
  // rewrite societyId or the audit columns.
  for (const k of WRITABLE) if (body[k] !== undefined) (vendor as any)[k] = body[k];
  applyBank(vendor, body);
  if (!vendor.name?.trim()) throw new VendorError('A vendor needs a name');

  vendor.updatedBy = oid(actor.userId);
  vendor.updatedByName = actor.userName;
  await vendor.save();
  return toView(vendor);
}

/**
 * Remove a vendor, or retire it if its history would be orphaned.
 *
 * A vendor named on a posted expense or a journal line cannot be deleted — the
 * ledger is immutable and those documents snapshot the name, so deleting the
 * master would leave a TDS register pointing at nothing. Deactivating keeps the
 * history readable and takes the vendor out of the pickers, which is what the
 * treasurer actually wanted. Same rule charge heads already follow.
 */
export async function deleteVendor(societyId: string, vendorId: string, actor: Actor):
  Promise<{ deleted: boolean; message: string }> {
  const sid = oid(societyId);
  const vendor = await Vendor.findOne({ _id: vendorId, societyId: sid });
  if (!vendor) throw new VendorError('Vendor not found', 404);

  const [usedInExpense, usedInLedger] = await Promise.all([
    Expense.exists({ societyId: sid, vendorId: vendor._id }),
    JournalEntry.exists({ societyId: sid, 'lines.vendorId': vendor._id }),
  ]);

  if (usedInExpense || usedInLedger) {
    if (vendor.isActive === false) {
      return { deleted: false, message: `${vendor.name} is already inactive.` };
    }
    vendor.isActive = false;
    vendor.updatedBy = oid(actor.userId);
    vendor.updatedByName = actor.userName;
    await vendor.save();
    return { deleted: false, message: `${vendor.name} has bills against it, so it was deactivated instead of deleted. Its history stays intact.` };
  }

  await Vendor.deleteOne({ _id: vendor._id, societyId: sid });
  return { deleted: true, message: `${vendor.name} was removed.` };
}

/**
 * One vendor's account with the society: what we still owe, and every movement
 * behind it.
 *
 * Derived from the journal rather than from expense documents, because the
 * journal is what the Balance Sheet reports. Σ of every vendor's payable here
 * therefore reconciles to the `2200 Sundry Creditors` control balance — if the
 * two ever disagreed, this figure would be the fiction.
 */
export async function vendorLedger(
  societyId: string,
  vendorId: string,
  opts: { from?: Date; to?: Date } = {},
) {
  const sid = oid(societyId);
  const vid = oid(vendorId);
  const vendor = await Vendor.findOne({ _id: vid, societyId: sid }).lean();
  if (!vendor) throw new VendorError('Vendor not found', 404);

  const match: any = { societyId: sid, 'lines.vendorId': vid };
  if (opts.from || opts.to) {
    match.entryDate = {};
    if (opts.from) match.entryDate.$gte = opts.from;
    if (opts.to) match.entryDate.$lte = opts.to;
  }

  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    // Only the Creditors leg. An expense also debits 5xxx with the same vendor
    // tag; counting both would double every bill and the running balance would
    // be meaningless.
    { $match: { 'lines.vendorId': vid, 'lines.accountCode': ACCOUNT_CODES.CREDITORS } },
    {
      $project: {
        _id: 0,
        entryId: '$_id',
        voucherNumber: 1,
        voucherType: 1,
        entryDate: 1,
        narration: 1,
        description: '$lines.description',
        debitPaise: '$lines.debitPaise',
        creditPaise: '$lines.creditPaise',
      },
    },
    { $sort: { entryDate: 1, voucherNumber: 1 } },
  ]);

  // Creditors is a liability: a credit increases what we owe, a debit settles it.
  let running = 0;
  const entries = rows.map((r: any) => {
    running += (r.creditPaise || 0) - (r.debitPaise || 0);
    return { ...r, balancePaise: running };
  });

  const billedPaise = rows.reduce((s: number, r: any) => s + (r.creditPaise || 0), 0);
  const paidPaise = rows.reduce((s: number, r: any) => s + (r.debitPaise || 0), 0);

  // This financial year's activity, for the header tiles.
  const startMonth = await getFyStartMonth(societyId);
  const { fyStart, fyEnd, fyString } = getFinancialYear(new Date(), startMonth);
  const fyAgg = await Expense.aggregate([
    { $match: { societyId: sid, vendorId: vid, status: { $nin: ['REJECTED', 'CANCELLED'] }, expenseDate: { $gte: fyStart, $lte: fyEnd } } },
    { $group: { _id: null, gross: { $sum: '$grossPaise' }, tds: { $sum: '$tdsPaise' } } },
  ]);

  return {
    vendor: toView(vendor),
    entries,
    outstandingPayablePaise: running,
    billedPaise,
    paidPaise,
    financialYear: fyString,
    fyGrossPaise: fyAgg[0]?.gross || 0,
    fyTdsPaise: fyAgg[0]?.tds || 0,
  };
}

/** Outstanding payable for every vendor at once, for the list screen. */
export async function vendorPayables(societyId: string): Promise<Map<string, number>> {
  const rows = await JournalEntry.aggregate([
    // $elemMatch is required: on an array `$ne: null` means "no element is null",
    // which threw away every voucher that had even one line without a vendor —
    // the bank leg of a payment, the TDS leg of an accrual. The tie-back test
    // still passed, because the discarded accrual and its discarded payment
    // cancelled out. Only asserting a vendor's PAID figure exposed it.
    { $match: { societyId: oid(societyId), lines: { $elemMatch: { vendorId: { $exists: true, $ne: null } } } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountCode': ACCOUNT_CODES.CREDITORS, 'lines.vendorId': { $ne: null } } },
    {
      $group: {
        _id: '$lines.vendorId',
        payablePaise: { $sum: { $subtract: ['$lines.creditPaise', '$lines.debitPaise'] } },
      },
    },
  ]);
  return new Map(rows.map((r: any) => [String(r._id), r.payablePaise || 0]));
}
