import mongoose, { ClientSession } from 'mongoose';
import { Receipt, ReceiptMode, IReceipt } from '../models/receipt.model';
import { MaintenanceInvoice } from '../models/maintenance-invoice.model';
import { postJournal, reverseJournal, PostLineInput } from './ledger.service';
import { nextDocNumber } from './finance-sequence.service';
import { getOrCreatePolicy, getFyStartMonth } from './finance-policy.service';
import { getFinancialYear } from '../utils/financial-year.util';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';

/** Asset account money lands in, per payment mode. */
export function depositAccountForMode(mode: ReceiptMode): string {
  if (mode === 'CASH') return ACCOUNT_CODES.CASH;
  if (mode === 'CHEQUE') return ACCOUNT_CODES.UNDEPOSITED_CHEQUES;
  return ACCOUNT_CODES.BANK; // UPI / BANK_TRANSFER / RAZORPAY / OTHER
}

interface AllocationResult {
  allocations: { invoiceId: any; invoiceNumber: string; billingPeriod: string; appliedPaise: number }[];
  advanceCreatedPaise: number;
}

/**
 * Allocate `amountPaise` across a flat's open invoices oldest-first (FIFO),
 * mutating invoice outstanding/allocated/status in the session. Leftover after
 * all invoices are cleared becomes advance credit.
 */
async function allocateFifo(societyId: any, flatId: any, amountPaise: number, session: ClientSession): Promise<AllocationResult> {
  const open = await MaintenanceInvoice.find({
    societyId, flatId, outstandingPaise: { $gt: 0 },
    status: { $in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
  }).sort({ dueDate: 1, invoiceDate: 1 }).session(session);

  let remaining = amountPaise;
  const allocations: AllocationResult['allocations'] = [];
  for (const inv of open) {
    if (remaining <= 0) break;
    const apply = Math.min(remaining, inv.outstandingPaise);
    if (apply <= 0) continue;
    inv.allocatedPaise += apply;
    inv.outstandingPaise -= apply;
    inv.status = inv.outstandingPaise <= 0 ? 'PAID' : 'PARTIALLY_PAID';
    await inv.save({ session });
    allocations.push({ invoiceId: inv._id, invoiceNumber: inv.invoiceNumber, billingPeriod: inv.billingPeriod, appliedPaise: apply });
    remaining -= apply;
  }
  return { allocations, advanceCreatedPaise: Math.max(0, remaining) };
}

/** Post the RECEIPT voucher: Dr deposit account / Cr Debtors (allocated) + Cr Members' Advance (surplus). */
async function postReceiptJournal(societyId: string, receipt: IReceipt, allocatedPaise: number, actor: { userId: string; userName: string }, startMonth: number, session: ClientSession) {
  const lines: PostLineInput[] = [
    { accountCode: receipt.depositAccountCode, debitPaise: receipt.amountPaise, flatId: receipt.flatId, description: `Receipt ${receipt.receiptNumber} (${receipt.mode})` },
  ];
  if (allocatedPaise > 0) lines.push({ accountCode: ACCOUNT_CODES.DEBTORS, creditPaise: allocatedPaise, flatId: receipt.flatId, description: 'Dues cleared' });
  if (receipt.advanceCreatedPaise > 0) lines.push({ accountCode: ACCOUNT_CODES.MEMBERS_ADVANCE, creditPaise: receipt.advanceCreatedPaise, flatId: receipt.flatId, description: 'Advance received' });

  return postJournal(societyId, {
    voucherType: 'RECEIPT',
    voucherNumber: receipt.receiptNumber,
    entryDate: receipt.receiptDate,
    narration: `Receipt ${receipt.receiptNumber} — flat ${receipt.flatNumber}`,
    lines,
    sourceType: 'RECEIPT',
    sourceId: receipt._id,
    postedBy: actor.userId,
    postedByName: actor.userName,
    fyStartMonth: startMonth,
  }, session);
}

export interface CreateReceiptInput {
  flatId: string;
  blockName: string;
  flatNumber: string;
  mode: ReceiptMode;
  amountPaise: number;
  instrument?: { chequeNo?: string; bankName?: string; chequeDate?: string };
  referenceNote?: string;
  proofImageKey?: string;
  proofImageUrl?: string;
  receiptDate?: string;
  source: 'RESIDENT' | 'ADMIN_WALKIN' | 'GATEWAY';
  actor: { userId: string; userName: string; role: string };
}

/**
 * Create a CLEARED receipt (admin walk-in, or confirming an already-verified
 * payment): allocate FIFO + post the journal in one transaction.
 */
export async function recordClearedReceipt(societyId: string, input: CreateReceiptInput): Promise<IReceipt> {
  const policy = await getOrCreatePolicy(societyId, input.actor.userId, input.actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const receiptDate = input.receiptDate ? new Date(input.receiptDate) : new Date();
  const { fyString } = getFinancialYear(receiptDate, startMonth);

  const session = await mongoose.startSession();
  try {
    let receipt: IReceipt;
    await session.withTransaction(async () => {
      const { number: receiptNumber } = await nextDocNumber(
        societyId, 'RECEIPT', fyString,
        { prefix: policy.numbering.receipt.prefix, padding: policy.numbering.receipt.padding, template: policy.numbering.receipt.template },
        session,
      );
      const { allocations, advanceCreatedPaise } = await allocateFifo(societyId, input.flatId, input.amountPaise, session);
      const allocatedPaise = allocations.reduce((s, a) => s + a.appliedPaise, 0);

      const [r] = await Receipt.create([{
        societyId, flatId: input.flatId, blockName: input.blockName, flatNumber: input.flatNumber,
        receiptNumber, financialYear: fyString, receiptDate,
        mode: input.mode, amountPaise: input.amountPaise,
        allocations, advanceCreatedPaise, depositAccountCode: depositAccountForMode(input.mode),
        instrument: input.instrument ? { ...input.instrument, chequeDate: input.instrument.chequeDate ? new Date(input.instrument.chequeDate) : undefined } : undefined,
        referenceNote: input.referenceNote, proofImageKey: input.proofImageKey, proofImageUrl: input.proofImageUrl,
        status: 'CLEARED', source: input.source,
        recordedBy: input.actor.userId, recordedByName: input.actor.userName, recordedByRole: input.actor.role,
        confirmedBy: input.source === 'ADMIN_WALKIN' ? input.actor.userId : undefined,
        confirmedByName: input.source === 'ADMIN_WALKIN' ? input.actor.userName : undefined,
        confirmedAt: input.source === 'ADMIN_WALKIN' ? new Date() : undefined,
      }], { session });

      const je = await postReceiptJournal(societyId, r, allocatedPaise, input.actor, startMonth, session);
      r.journalEntryId = je._id;
      await r.save({ session });
      receipt = r;
    });
    return receipt!;
  } finally {
    session.endSession();
  }
}

/** Resident/self-reported offline payment awaiting admin confirmation (no posting yet). */
export async function reportPendingReceipt(societyId: string, input: CreateReceiptInput): Promise<IReceipt> {
  const policy = await getOrCreatePolicy(societyId, input.actor.userId, input.actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const receiptDate = input.receiptDate ? new Date(input.receiptDate) : new Date();
  const { fyString } = getFinancialYear(receiptDate, startMonth);

  const { number: receiptNumber } = await nextDocNumber(
    societyId, 'RECEIPT', fyString,
    { prefix: policy.numbering.receipt.prefix, padding: policy.numbering.receipt.padding, template: policy.numbering.receipt.template },
  );
  return Receipt.create({
    societyId, flatId: input.flatId, blockName: input.blockName, flatNumber: input.flatNumber,
    receiptNumber, financialYear: fyString, receiptDate,
    mode: input.mode, amountPaise: input.amountPaise,
    allocations: [], advanceCreatedPaise: 0, depositAccountCode: depositAccountForMode(input.mode),
    instrument: input.instrument ? { ...input.instrument, chequeDate: input.instrument.chequeDate ? new Date(input.instrument.chequeDate) : undefined } : undefined,
    referenceNote: input.referenceNote, proofImageKey: input.proofImageKey, proofImageUrl: input.proofImageUrl,
    status: 'PENDING_CONFIRMATION', source: input.source,
    recordedBy: input.actor.userId, recordedByName: input.actor.userName, recordedByRole: input.actor.role,
  });
}

/** Admin confirms a pending receipt → allocate FIFO + post. */
export async function confirmReceipt(societyId: string, receiptId: string, actor: { userId: string; userName: string }): Promise<IReceipt> {
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const session = await mongoose.startSession();
  try {
    let out: IReceipt;
    await session.withTransaction(async () => {
      const receipt = await Receipt.findOne({ _id: receiptId, societyId }).session(session);
      if (!receipt) throw new Error('Receipt not found');
      if (receipt.status !== 'PENDING_CONFIRMATION') throw new Error('Receipt is not pending confirmation');

      const { allocations, advanceCreatedPaise } = await allocateFifo(societyId, receipt.flatId, receipt.amountPaise, session);
      receipt.allocations = allocations as any;
      receipt.advanceCreatedPaise = advanceCreatedPaise;
      receipt.status = 'CLEARED';
      receipt.confirmedBy = new mongoose.Types.ObjectId(actor.userId);
      receipt.confirmedByName = actor.userName;
      receipt.confirmedAt = new Date();
      await receipt.save({ session });

      const allocatedPaise = allocations.reduce((s, a) => s + a.appliedPaise, 0);
      const je = await postReceiptJournal(societyId, receipt, allocatedPaise, actor, startMonth, session);
      receipt.journalEntryId = je._id;
      await receipt.save({ session });
      out = receipt;
    });
    return out!;
  } finally {
    session.endSession();
  }
}

/**
 * Confirm an online (gateway) receipt from the webhook: allocate FIFO + post,
 * idempotently. Safe to call more than once for the same webhook event.
 */
export async function confirmGatewayReceipt(
  societyId: string,
  receiptId: string,
  opts: { razorpayPaymentId?: string; razorpayWebhookEventId?: string },
  actor: { userId: string; userName: string },
): Promise<IReceipt | null> {
  const startMonth = await getFyStartMonth(societyId);
  const session = await mongoose.startSession();
  try {
    let out: IReceipt | null = null;
    await session.withTransaction(async () => {
      const receipt = await Receipt.findOne({ _id: receiptId, societyId }).session(session);
      if (!receipt) return;
      if (receipt.status === 'CLEARED') { out = receipt; return; } // idempotent

      const { allocations, advanceCreatedPaise } = await allocateFifo(societyId, receipt.flatId, receipt.amountPaise, session);
      receipt.allocations = allocations as any;
      receipt.advanceCreatedPaise = advanceCreatedPaise;
      receipt.status = 'CLEARED';
      receipt.razorpayPaymentId = opts.razorpayPaymentId;
      receipt.razorpayWebhookEventId = opts.razorpayWebhookEventId;
      receipt.confirmedAt = new Date();
      await receipt.save({ session });

      const allocatedPaise = allocations.reduce((s, a) => s + a.appliedPaise, 0);
      const je = await postReceiptJournal(societyId, receipt, allocatedPaise, actor, startMonth, session);
      receipt.journalEntryId = je._id;
      await receipt.save({ session });
      out = receipt;
    });
    return out;
  } finally {
    session.endSession();
  }
}

export async function rejectReceipt(societyId: string, receiptId: string, reason: string, actor: { userId: string; userName: string }): Promise<IReceipt> {
  const receipt = await Receipt.findOne({ _id: receiptId, societyId });
  if (!receipt) throw new Error('Receipt not found');
  if (receipt.status !== 'PENDING_CONFIRMATION') throw new Error('Receipt is not pending confirmation');
  receipt.status = 'REJECTED';
  receipt.rejectionReason = reason;
  receipt.rejectedBy = new mongoose.Types.ObjectId(actor.userId);
  receipt.rejectedByName = actor.userName;
  receipt.rejectedAt = new Date();
  await receipt.save();
  return receipt;
}

/**
 * Bounce/reverse a cleared receipt: reverse its journal, restore the invoices it
 * paid (un-allocate), and mark it BOUNCED. Never edits the original journal.
 */
export async function bounceReceipt(societyId: string, receiptId: string, actor: { userId: string; userName: string }, reason?: string): Promise<IReceipt> {
  const session = await mongoose.startSession();
  try {
    let out: IReceipt;
    await session.withTransaction(async () => {
      const receipt = await Receipt.findOne({ _id: receiptId, societyId }).session(session);
      if (!receipt) throw new Error('Receipt not found');
      if (receipt.status !== 'CLEARED') throw new Error('Only a cleared receipt can be bounced/reversed');

      // Restore each invoice this receipt had paid.
      for (const a of receipt.allocations) {
        const inv = await MaintenanceInvoice.findOne({ _id: a.invoiceId, societyId }).session(session);
        if (!inv) continue;
        inv.allocatedPaise = Math.max(0, inv.allocatedPaise - a.appliedPaise);
        inv.outstandingPaise += a.appliedPaise;
        inv.status = inv.allocatedPaise + inv.advanceAppliedPaise <= 0 ? 'ISSUED' : 'PARTIALLY_PAID';
        await inv.save({ session });
      }

      if (receipt.journalEntryId) {
        const rev = await reverseJournal(societyId, receipt.journalEntryId, { postedBy: actor.userId, postedByName: actor.userName, narration: reason || 'Cheque bounced / payment reversed' }, session);
        receipt.reversalJournalEntryId = rev._id;
      }
      receipt.status = 'BOUNCED';
      receipt.rejectionReason = reason;
      await receipt.save({ session });
      out = receipt;
    });
    return out!;
  } finally {
    session.endSession();
  }
}

/** Move a cleared cheque from Undeposited to Bank (deposit cleared). */
export async function clearCheque(societyId: string, receiptId: string, actor: { userId: string; userName: string }): Promise<IReceipt> {
  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const session = await mongoose.startSession();
  try {
    let out: IReceipt;
    await session.withTransaction(async () => {
      const receipt = await Receipt.findOne({ _id: receiptId, societyId }).session(session);
      if (!receipt) throw new Error('Receipt not found');
      if (receipt.mode !== 'CHEQUE' || receipt.status !== 'CLEARED') throw new Error('Only a cleared cheque receipt can be deposited');
      if (receipt.clearanceJournalEntryId) throw new Error('Cheque already deposited to bank');

      const je = await postJournal(societyId, {
        voucherType: 'CONTRA',
        entryDate: new Date(),
        narration: `Cheque ${receipt.instrument?.chequeNo || ''} deposited (${receipt.receiptNumber})`,
        lines: [
          { accountCode: ACCOUNT_CODES.BANK, debitPaise: receipt.amountPaise },
          { accountCode: ACCOUNT_CODES.UNDEPOSITED_CHEQUES, creditPaise: receipt.amountPaise },
        ],
        sourceType: 'RECEIPT', sourceId: receipt._id,
        postedBy: actor.userId, postedByName: actor.userName, fyStartMonth: startMonth,
      }, session);
      receipt.clearanceJournalEntryId = je._id;
      receipt.depositAccountCode = ACCOUNT_CODES.BANK;
      await receipt.save({ session });
      out = receipt;
    });
    return out!;
  } finally {
    session.endSession();
  }
}
