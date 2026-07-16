import mongoose from 'mongoose';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { Refund, IRefund } from '../models/refund.model';
import { Flat } from '../models/flat.model';
import { JournalEntry } from '../models/journal-entry.model';
import { postJournal } from './ledger.service';
import { getOrCreatePolicy } from './finance-policy.service';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';
import { splitPayment } from './allocation.util';

export interface Actor { userId: string; userName: string }

/** Thrown for a caller mistake — the controller maps these to 4xx, not 500. */
export class AdjustmentError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * Why an amount was taken off a member's bill. The accounting is identical in
 * every case — the society gives up income it had already booked — so what
 * separates them is the reason, and the reason is the whole point when a member
 * asks why their neighbour paid less.
 */
export type AdjustmentKind = 'WAIVER' | 'WRITE_OFF' | 'REBATE';

const KIND_LABEL: Record<AdjustmentKind, string> = {
  WAIVER: 'Waiver',
  WRITE_OFF: 'Write-off',
  REBATE: 'Early-payment rebate',
};

/** A member's advance credit — what the society is holding that isn't theirs. */
export async function flatAdvanceBalance(societyId: string, flatId: string): Promise<number> {
  const agg = await JournalEntry.aggregate([
    { $match: { societyId: oid(societyId) } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountCode': ACCOUNT_CODES.MEMBERS_ADVANCE, 'lines.flatId': oid(flatId) } },
    { $group: { _id: null, net: { $sum: { $subtract: ['$lines.creditPaise', '$lines.debitPaise'] } } } },
  ]);
  return Math.max(0, agg[0]?.net || 0);
}

/**
 * What an early-payment rebate on this invoice would come to, per policy.
 *
 * A suggestion only — the committee still has to apply it. Rebates are not
 * granted automatically at allocation time: a discount that appears by itself is
 * a discount nobody approved and nobody can account for.
 */
export async function rebateSuggestion(societyId: string, invoiceId: string, actor: Actor) {
  const [policy, invoice] = await Promise.all([
    getOrCreatePolicy(societyId, actor.userId, actor.userName),
    MaintenanceInvoice.findOne({ _id: invoiceId, societyId }).lean(),
  ]);
  if (!invoice) throw new AdjustmentError('Invoice not found', 404);
  const r = policy.rebate;
  if (!r?.enabled) return { eligible: false, reason: 'Early-payment rebates are switched off', amountPaise: 0 };

  const deadline = new Date(invoice.invoiceDate);
  deadline.setDate(deadline.getDate() + (r.withinDays || 0));
  const today = new Date();
  if (today > deadline) {
    return { eligible: false, reason: `The rebate window closed on ${deadline.toLocaleDateString('en-IN')}`, amountPaise: 0, deadline };
  }
  // On the invoice's own charges, not on arrears carried onto it.
  const amountPaise = Math.round(invoice.totalPaise * (r.percent || 0) / 100);
  return { eligible: amountPaise > 0, amountPaise, percent: r.percent, deadline, reason: `${r.percent}% if settled by ${deadline.toLocaleDateString('en-IN')}` };
}

/**
 * Take an amount off a member's bill — waived, written off, or rebated.
 *
 * Posts Dr 5900 Rebates & Waivers / Cr 1200 Debtors: the society is giving up
 * income it has already recognised, so the cost belongs in this year's accounts
 * rather than quietly erasing the original invoice. The invoice keeps its full
 * value and carries `waivedPaise` alongside — a bill that silently shrinks is a
 * bill nobody can audit.
 *
 * NOTE: GST already charged on the invoice is NOT reversed here. Relieving GST
 * on a forgiven amount needs a formal credit note filed within the statutory
 * window — a tax document, not a book entry, and out of scope for this action.
 */
export async function adjustInvoice(
  societyId: string,
  invoiceId: string,
  input: { kind: AdjustmentKind; amountPaise: number; reason: string; adjustedOn?: string },
  actor: Actor,
): Promise<{ invoiceNumber: string; waivedPaise: number; outstandingPaise: number; status: string; voucherNumber: string }> {
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const amountPaise = Math.round(input.amountPaise);
  if (amountPaise <= 0) throw new AdjustmentError('An adjustment must be more than zero');
  if (!input.reason?.trim()) throw new AdjustmentError('A reason is required — this is money the society is giving up');

  const session = await mongoose.startSession();
  try {
    let out!: { invoiceNumber: string; waivedPaise: number; outstandingPaise: number; status: string; voucherNumber: string };
    await session.withTransaction(async () => {
      const invoice = await MaintenanceInvoice.findOne({ _id: invoiceId, societyId }).session(session);
      if (!invoice) throw new AdjustmentError('Invoice not found', 404);
      if (invoice.status === 'CANCELLED') throw new AdjustmentError('This invoice is cancelled');
      if (amountPaise > invoice.outstandingPaise) {
        throw new AdjustmentError(`${invoice.invoiceNumber} only has ${(invoice.outstandingPaise / 100).toFixed(2)} outstanding — you cannot adjust more than is owed`);
      }

      const je = await postJournal(societyId, {
        voucherType: 'JOURNAL',
        entryDate: input.adjustedOn ? new Date(input.adjustedOn) : new Date(),
        narration: `${KIND_LABEL[input.kind]} on ${invoice.invoiceNumber} — ${input.reason.trim()}`,
        lines: [
          { accountCode: ACCOUNT_CODES.REBATES_WAIVERS, debitPaise: amountPaise, flatId: invoice.flatId, description: KIND_LABEL[input.kind] },
          { accountCode: ACCOUNT_CODES.DEBTORS, creditPaise: amountPaise, flatId: invoice.flatId, description: `${KIND_LABEL[input.kind]} — ${invoice.invoiceNumber}` },
        ],
        postedBy: actor.userId,
        postedByName: actor.userName,
        fyStartMonth: startMonth,
      }, session);

      // A waiver reduces the bill just as a payment does, so it clears dues and
      // penalty in the same order — otherwise forgiving ₹500 could leave the
      // penalty standing and keep charging interest on it.
      const { toInterestPaise } = splitPayment(
        policy.allocation?.interestOrder || 'PRINCIPAL_FIRST',
        amountPaise, invoice.outstandingPaise, invoice.interestOutstandingPaise || 0,
      );
      invoice.waivedPaise += amountPaise;
      invoice.outstandingPaise -= amountPaise;
      invoice.interestOutstandingPaise = Math.max(0, (invoice.interestOutstandingPaise || 0) - toInterestPaise);
      // WAIVED only when nothing was ever collected — otherwise it was part-paid
      // and part-forgiven, and calling that "waived" would misread the history.
      if (invoice.outstandingPaise <= 0) {
        invoice.status = invoice.allocatedPaise + invoice.advanceAppliedPaise > 0 ? 'PAID' : 'WAIVED';
      }
      await invoice.save({ session });

      out = {
        invoiceNumber: invoice.invoiceNumber,
        waivedPaise: invoice.waivedPaise,
        outstandingPaise: invoice.outstandingPaise,
        status: invoice.status,
        voucherNumber: je.voucherNumber,
      };
    });
    return out;
  } finally { session.endSession(); }
}

// ---------------------------------------------------------------- refunds

export async function listRefunds(societyId: string, opts: { status?: string } = {}) {
  const q: any = { societyId: oid(societyId) };
  if (opts.status) q.status = opts.status;
  return Refund.find(q).sort({ createdAt: -1 }).lean();
}

/**
 * Ask for a member's advance to be paid back.
 *
 * Honours `approvals.refundRequiresApproval`, which the policy has carried
 * unenforced since it was written: when set, the refund waits for someone other
 * than the requester. Money leaving the society on one person's say-so is the
 * exact thing separation of duties exists to stop.
 */
export async function requestRefund(
  societyId: string,
  input: { flatId: string; amountPaise: number; mode?: 'BANK' | 'CASH'; reason: string },
  actor: Actor,
): Promise<IRefund> {
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const amountPaise = Math.round(input.amountPaise);
  if (amountPaise <= 0) throw new AdjustmentError('A refund must be more than zero');
  if (!input.reason?.trim()) throw new AdjustmentError('A reason is required');

  const flat = await Flat.findOne({ _id: input.flatId, societyId }).lean();
  if (!flat) throw new AdjustmentError('Flat not found', 404);

  const available = await flatAdvanceBalance(societyId, input.flatId);
  if (amountPaise > available) {
    throw new AdjustmentError(`${flat.blockName} ${flat.number} only holds ${(available / 100).toFixed(2)} in advance credit — there is nothing more to refund`);
  }

  const refund = await Refund.create({
    societyId,
    flatId: flat._id,
    blockName: flat.blockName,
    flatNumber: flat.number,
    amountPaise,
    mode: input.mode || 'BANK',
    reason: input.reason.trim(),
    status: 'PENDING_APPROVAL',
    requestedBy: actor.userId,
    requestedByName: actor.userName,
  });

  // No approval required by policy — pay it out now rather than leaving a
  // pending row nobody will ever look at.
  if (!policy.approvals?.refundRequiresApproval) {
    return payRefund(societyId, String(refund._id), actor, { skipApproverCheck: true });
  }
  return refund;
}

/** Approve and pay a refund: Dr Members' Advance / Cr Bank or Cash. */
export async function payRefund(
  societyId: string,
  refundId: string,
  actor: Actor,
  opts: { skipApproverCheck?: boolean } = {},
): Promise<IRefund> {
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;

  const session = await mongoose.startSession();
  try {
    let out!: IRefund;
    await session.withTransaction(async () => {
      const refund = await Refund.findOne({ _id: refundId, societyId }).session(session);
      if (!refund) throw new AdjustmentError('Refund not found', 404);
      if (refund.status !== 'PENDING_APPROVAL') throw new AdjustmentError(`This refund is already ${refund.status.toLowerCase()}`);

      if (!opts.skipApproverCheck && policy.approvals?.refundRequiresApproval
        && String(refund.requestedBy) === String(actor.userId)) {
        throw new AdjustmentError('A refund needs a different person to approve it than the one who requested it');
      }

      // Re-check against the live balance: the advance may have been spent on a
      // new bill between the request and the approval.
      const available = await flatAdvanceBalance(societyId, String(refund.flatId));
      if (refund.amountPaise > available) {
        throw new AdjustmentError(`Only ${(available / 100).toFixed(2)} of advance credit is left — it has been used since this refund was requested`);
      }

      const je = await postJournal(societyId, {
        voucherType: 'PAYMENT',
        entryDate: new Date(),
        narration: `Refund of advance to ${refund.blockName} ${refund.flatNumber} — ${refund.reason}`,
        lines: [
          { accountCode: ACCOUNT_CODES.MEMBERS_ADVANCE, debitPaise: refund.amountPaise, flatId: refund.flatId, description: 'Advance refunded' },
          { accountCode: refund.mode === 'CASH' ? ACCOUNT_CODES.CASH : ACCOUNT_CODES.BANK, creditPaise: refund.amountPaise, description: `Refund — ${refund.blockName} ${refund.flatNumber}` },
        ],
        postedBy: actor.userId,
        postedByName: actor.userName,
        fyStartMonth: startMonth,
      }, session);

      refund.status = 'PAID';
      refund.approvedBy = new mongoose.Types.ObjectId(actor.userId);
      refund.approvedByName = actor.userName;
      refund.approvedAt = new Date();
      refund.journalEntryId = je._id;
      refund.paidOn = new Date();
      await refund.save({ session });
      out = refund;
    });
    return out;
  } finally { session.endSession(); }
}

export async function rejectRefund(societyId: string, refundId: string, actor: Actor, reason: string): Promise<IRefund> {
  const refund = await Refund.findOne({ _id: refundId, societyId });
  if (!refund) throw new AdjustmentError('Refund not found', 404);
  if (refund.status !== 'PENDING_APPROVAL') throw new AdjustmentError(`This refund is already ${refund.status.toLowerCase()}`);
  refund.status = 'REJECTED';
  refund.rejectionReason = reason;
  refund.approvedBy = new mongoose.Types.ObjectId(actor.userId);
  refund.approvedByName = actor.userName;
  refund.approvedAt = new Date();
  await refund.save();
  return refund;
}
