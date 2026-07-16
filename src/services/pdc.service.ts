import mongoose from 'mongoose';
import { PostDatedCheque, IPostDatedCheque, PdcStatus } from '../models/pdc.model';
import { Flat } from '../models/flat.model';
import { recordClearedReceipt, clearCheque, bounceReceipt } from './collections.service';

export interface Actor { userId: string; userName: string; role?: string }

/** Thrown for a caller mistake — the controller maps these to 4xx, not 500. */
export class PdcError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

export interface RegisterPdcInput {
  flatId?: string;
  payerName: string;
  chequeNo: string;
  bankName: string;
  chequeDate: string;
  amountPaise: number;
  notes?: string;
}

/**
 * Take a post-dated cheque into the register.
 *
 * Posts NOTHING to the ledger. A cheque dated three months out is a promise, not
 * money — recognising it now would inflate the bank by the whole drawer and show
 * a society solvent on paper that cannot meet a bill today. The accounting
 * happens on deposit, and not one day earlier.
 */
export async function registerPdc(societyId: string, input: RegisterPdcInput, actor: Actor): Promise<IPostDatedCheque> {
  if (input.amountPaise < 1) throw new PdcError('A cheque must be for a positive amount');
  const chequeDate = new Date(input.chequeDate);
  if (Number.isNaN(chequeDate.getTime())) throw new PdcError('Invalid cheque date');

  let flat = null;
  if (input.flatId) {
    flat = await Flat.findOne({ _id: input.flatId, societyId }).lean();
    if (!flat) throw new PdcError('Flat not found', 404);
  }
  const payerName = input.payerName?.trim();
  if (!payerName) throw new PdcError('Who is the cheque from? Name the payer.');

  try {
    return await PostDatedCheque.create({
      societyId,
      flatId: flat?._id,
      blockName: flat?.blockName,
      flatNumber: flat?.number,
      payerName,
      chequeNo: input.chequeNo.trim(),
      bankName: input.bankName.trim(),
      chequeDate,
      amountPaise: input.amountPaise,
      status: 'HELD',
      notes: input.notes?.trim() || undefined,
      createdBy: actor.userId,
      createdByName: actor.userName,
    });
  } catch (e: any) {
    // The unique index is the guard, not a pre-check: two clerks entering the
    // same cheque at once would both pass a `findOne` and both insert.
    if (e?.code === 11000) {
      throw new PdcError(`Cheque ${input.chequeNo} on ${input.bankName} dated ${chequeDate.toLocaleDateString('en-IN')} is already in the register`, 409);
    }
    throw e;
  }
}

/**
 * The register, with the cheques that have come due called out.
 *
 * "Due this week" is the whole reason a PDC register exists: a cheque banked
 * late is a cheque the society chose not to collect, and one banked early
 * bounces.
 */
export async function listPdcs(societyId: string, opts: { status?: PdcStatus; flatId?: string } = {}) {
  const q: any = { societyId: oid(societyId) };
  if (opts.status) q.status = opts.status;
  if (opts.flatId) q.flatId = oid(opts.flatId);

  const rows = await PostDatedCheque.find(q).sort({ chequeDate: 1, createdAt: 1 }).lean();
  const today = startOfDay(new Date());
  const weekEnd = new Date(today.getTime() + 7 * 86_400_000);

  const decorated = rows.map(r => {
    const due = startOfDay(new Date(r.chequeDate));
    return {
      _id: String(r._id),
      flatId: r.flatId ? String(r.flatId) : undefined,
      flat: r.flatNumber ? `${r.blockName || ''} ${r.flatNumber}`.trim() : undefined,
      blockName: r.blockName,
      flatNumber: r.flatNumber,
      payerName: r.payerName,
      chequeNo: r.chequeNo,
      bankName: r.bankName,
      chequeDate: r.chequeDate,
      amountPaise: r.amountPaise,
      status: r.status,
      receiptId: r.receiptId ? String(r.receiptId) : undefined,
      notes: r.notes,
      // Only a HELD cheque can be due — one already banked is nobody's action.
      dueThisWeek: r.status === 'HELD' && due >= today && due <= weekEnd,
      overdue: r.status === 'HELD' && due < today,
      bankableFrom: r.chequeDate,
    };
  });

  const held = decorated.filter(r => r.status === 'HELD');
  return {
    rows: decorated,
    // Held value is what the register is worth as a promise — deliberately NOT
    // on the balance sheet, which is the point of the whole model.
    heldPaise: held.reduce((s, r) => s + r.amountPaise, 0),
    heldCount: held.length,
    dueThisWeekPaise: decorated.filter(r => r.dueThisWeek).reduce((s, r) => s + r.amountPaise, 0),
    dueThisWeekCount: decorated.filter(r => r.dueThisWeek).length,
    overdueCount: decorated.filter(r => r.overdue).length,
  };
}

/**
 * Bank a held cheque: this is the moment it becomes money.
 *
 * Delegates to `recordClearedReceipt` rather than posting anything itself — that
 * is the one place that knows how to allocate a payment FIFO across open
 * invoices, raise advance credit from the surplus and number the receipt. A
 * second implementation here would be a second set of rules for the same event.
 * Mode CHEQUE lands it in Undeposited Cheques, where it belongs until the bank
 * says otherwise.
 */
export async function depositPdc(
  societyId: string,
  pdcId: string,
  input: { depositedOn?: string } = {},
  actor: Actor,
): Promise<IPostDatedCheque> {
  const pdc = await PostDatedCheque.findOne({ _id: pdcId, societyId });
  if (!pdc) throw new PdcError('Cheque not found', 404);
  if (pdc.status !== 'HELD') throw new PdcError(`This cheque is already ${pdc.status.toLowerCase()}`, 409);
  // A receipt is raised against a flat's dues; a cheque from nobody in
  // particular has no invoices to settle.
  if (!pdc.flatId) throw new PdcError('Link this cheque to a flat before depositing it — a receipt has to be raised against someone\'s dues');

  const receipt = await recordClearedReceipt(societyId, {
    flatId: String(pdc.flatId),
    blockName: pdc.blockName || '',
    flatNumber: pdc.flatNumber || '',
    mode: 'CHEQUE',
    amountPaise: pdc.amountPaise,
    instrument: { chequeNo: pdc.chequeNo, bankName: pdc.bankName, chequeDate: pdc.chequeDate.toISOString() },
    referenceNote: `Post-dated cheque ${pdc.chequeNo} deposited`,
    receiptDate: input.depositedOn || new Date().toISOString(),
    source: 'ADMIN_WALKIN',
    actor: { userId: actor.userId, userName: actor.userName, role: actor.role || 'SOCIETY_ADMIN' },
  });

  pdc.status = 'DEPOSITED';
  pdc.receiptId = receipt._id as mongoose.Types.ObjectId;
  await pdc.save();
  return pdc;
}

/**
 * Move a cheque on to its outcome.
 *
 * Each transition is an accounting event, not a label:
 *  - CLEARED  — the bank honoured it; the money moves Undeposited → Bank.
 *  - BOUNCED  — it did not; the receipt is reversed and the dues reopen.
 *  - RETURNED — handed back to the payer undeposited. Nothing was ever posted,
 *               so nothing is unposted.
 * Transitions not listed here are refused rather than quietly recorded: a status
 * that does not match the ledger is worse than no status at all.
 */
export async function updatePdcStatus(
  societyId: string,
  pdcId: string,
  input: { status: PdcStatus; reason?: string },
  actor: Actor,
): Promise<IPostDatedCheque> {
  const pdc = await PostDatedCheque.findOne({ _id: pdcId, societyId });
  if (!pdc) throw new PdcError('Cheque not found', 404);
  const { status } = input;
  if (status === pdc.status) return pdc;

  if (status === 'DEPOSITED') throw new PdcError('Use the deposit action — it raises the receipt', 400);

  if (status === 'RETURNED') {
    if (pdc.status !== 'HELD') throw new PdcError('Only a cheque still being held can be handed back — this one has been banked', 409);
    pdc.status = 'RETURNED';
    if (input.reason?.trim()) pdc.notes = input.reason.trim();
    await pdc.save();
    return pdc;
  }

  if (status === 'CLEARED') {
    if (pdc.status !== 'DEPOSITED') throw new PdcError('A cheque has to be deposited before the bank can clear it', 409);
    if (!pdc.receiptId) throw new PdcError('This cheque has no receipt to clear', 409);
    await clearCheque(societyId, String(pdc.receiptId), actor);
    pdc.status = 'CLEARED';
    await pdc.save();
    return pdc;
  }

  if (status === 'BOUNCED') {
    if (pdc.status !== 'DEPOSITED' && pdc.status !== 'CLEARED') {
      throw new PdcError('Only a cheque that went to the bank can bounce', 409);
    }
    if (!pdc.receiptId) throw new PdcError('This cheque has no receipt to reverse', 409);
    await bounceReceipt(societyId, String(pdc.receiptId), actor, input.reason || `PDC ${pdc.chequeNo} bounced`);
    pdc.status = 'BOUNCED';
    if (input.reason?.trim()) pdc.notes = input.reason.trim();
    await pdc.save();
    return pdc;
  }

  if (status === 'HELD') throw new PdcError('A cheque cannot go back to being held once it has left the drawer', 409);
  throw new PdcError(`Unknown status '${status}'`);
}