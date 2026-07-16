import mongoose from 'mongoose';
import { ShareCertificate, IShareCertificate } from '../models/share-certificate.model';
import { Flat } from '../models/flat.model';
import { postJournal } from './ledger.service';
import { nextDocNumber } from './finance-sequence.service';
import { getOrCreatePolicy } from './finance-policy.service';
import { getFinancialYear } from '../utils/financial-year.util';
import { ACCOUNT_CODES } from './chart-of-accounts.seed';

export interface Actor { userId: string; userName: string }

/** Thrown for a caller mistake — the controller maps these to 4xx, not 500. */
export class ShareError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/** The next unused distinctive share number for the society. */
async function nextDistinctiveFrom(societyId: string): Promise<number> {
  const last = await ShareCertificate.findOne({ societyId }).sort({ distinctiveTo: -1 }).select('distinctiveTo').lean();
  return (last?.distinctiveTo || 0) + 1;
}

export interface IssueInput {
  flatId: string;
  memberName: string;
  memberUserId?: string;
  shareCount: number;
  faceValuePaise: number;
  issuedOn?: string;
  /** Where the share money was received. Cash and bank are the realistic options. */
  receivedIn?: 'BANK' | 'CASH';
}

/**
 * Issue shares to a member and take the money in.
 *
 * Posts Dr Bank/Cash / Cr Share Capital — share money is capital contributed to
 * the society, not income, so it must never touch the Income & Expenditure.
 */
export async function issueShares(societyId: string, input: IssueInput, actor: Actor): Promise<IShareCertificate> {
  const flat = await Flat.findOne({ _id: input.flatId, societyId }).lean();
  if (!flat) throw new ShareError('Flat not found', 404);
  if (input.shareCount < 1) throw new ShareError('A certificate needs at least one share');
  if (input.faceValuePaise < 0) throw new ShareError('Face value cannot be negative');

  const existing = await ShareCertificate.findOne({ societyId, flatId: input.flatId, status: 'ACTIVE' }).lean();
  if (existing) {
    throw new ShareError(`${flat.blockName} ${flat.number} already holds certificate ${existing.certificateNumber}. Transfer it instead of issuing a second one.`, 409);
  }

  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const startMonth = policy.financialYear?.startMonth ?? 4;
  const issuedOn = input.issuedOn ? new Date(input.issuedOn) : new Date();
  const { fyString } = getFinancialYear(issuedOn, startMonth);
  const amountPaise = input.shareCount * input.faceValuePaise;

  const from = await nextDistinctiveFrom(societyId);
  const { number: certificateNumber } = await nextDocNumber(societyId, 'SHARE', fyString, { prefix: 'SC', padding: 4 });

  const session = await mongoose.startSession();
  try {
    let cert!: IShareCertificate;
    await session.withTransaction(async () => {
      const [created] = await ShareCertificate.create([{
        societyId,
        flatId: flat._id,
        blockName: flat.blockName,
        flatNumber: flat.number,
        memberName: input.memberName.trim(),
        memberUserId: input.memberUserId || undefined,
        certificateNumber,
        distinctiveFrom: from,
        distinctiveTo: from + input.shareCount - 1,
        shareCount: input.shareCount,
        faceValuePaise: input.faceValuePaise,
        amountPaise,
        issuedOn,
        status: 'ACTIVE',
        createdBy: actor.userId,
        createdByName: actor.userName,
      }], { session });

      if (amountPaise > 0) {
        const je = await postJournal(societyId, {
          voucherType: 'RECEIPT',
          entryDate: issuedOn,
          narration: `Share capital — ${certificateNumber} to ${input.memberName} (${flat.blockName} ${flat.number})`,
          lines: [
            { accountCode: input.receivedIn === 'CASH' ? ACCOUNT_CODES.CASH : ACCOUNT_CODES.BANK, debitPaise: amountPaise, description: 'Share money received' },
            { accountCode: ACCOUNT_CODES.SHARE_CAPITAL, creditPaise: amountPaise, flatId: flat._id, description: `Shares ${from}-${from + input.shareCount - 1}` },
          ],
          postedBy: actor.userId,
          postedByName: actor.userName,
          fyStartMonth: startMonth,
        }, session);
        created.journalEntryId = je._id;
        await created.save({ session });
      }
      cert = created;
    });
    return cert;
  } finally { session.endSession(); }
}

/**
 * Transfer a flat's shares to a new member.
 *
 * The old certificate is retired and a new one issued over the SAME distinctive
 * share numbers — the shares themselves don't change, only who holds them. No
 * journal is posted: share capital hasn't moved, it has changed hands.
 */
export async function transferShares(
  societyId: string,
  certificateId: string,
  input: { toMemberName: string; toMemberUserId?: string; transferredOn?: string },
  actor: Actor,
): Promise<IShareCertificate> {
  const old = await ShareCertificate.findOne({ _id: certificateId, societyId });
  if (!old) throw new ShareError('Certificate not found', 404);
  if (old.status !== 'ACTIVE') throw new ShareError('Only an active certificate can be transferred');

  const policy = await getOrCreatePolicy(societyId, actor.userId, actor.userName);
  const transferredOn = input.transferredOn ? new Date(input.transferredOn) : new Date();
  const { fyString } = getFinancialYear(transferredOn, policy.financialYear?.startMonth ?? 4);
  const { number: certificateNumber } = await nextDocNumber(societyId, 'SHARE', fyString, { prefix: 'SC', padding: 4 });

  const session = await mongoose.startSession();
  try {
    let next!: IShareCertificate;
    await session.withTransaction(async () => {
      old.status = 'TRANSFERRED';
      old.transferredOn = transferredOn;
      await old.save({ session });

      const [created] = await ShareCertificate.create([{
        societyId,
        flatId: old.flatId,
        blockName: old.blockName,
        flatNumber: old.flatNumber,
        memberName: input.toMemberName.trim(),
        memberUserId: input.toMemberUserId || undefined,
        certificateNumber,
        distinctiveFrom: old.distinctiveFrom,
        distinctiveTo: old.distinctiveTo,
        shareCount: old.shareCount,
        faceValuePaise: old.faceValuePaise,
        amountPaise: old.amountPaise,
        issuedOn: transferredOn,
        status: 'ACTIVE',
        supersedesId: old._id,
        createdBy: actor.userId,
        createdByName: actor.userName,
      }], { session });
      next = created;
    });
    return next;
  } finally { session.endSession(); }
}

/**
 * The register of members — the statutory list of who holds which shares.
 *
 * Named generically on purpose: this is the "J Form" in Maharashtra, but the
 * form and its name differ by state, so the data is kept neutral and the
 * presentation left to the export.
 */
export async function memberRegister(societyId: string, opts: { includeHistory?: boolean } = {}) {
  const q: any = { societyId: oid(societyId) };
  if (!opts.includeHistory) q.status = 'ACTIVE';
  const rows = await ShareCertificate.find(q).sort({ blockName: 1, flatNumber: 1, distinctiveFrom: 1 }).lean();

  const flatsTotal = await Flat.countDocuments({ societyId: oid(societyId) });
  const active = rows.filter(r => r.status === 'ACTIVE');
  return {
    rows: rows.map(r => ({
      _id: String(r._id), // the transfer action needs it
      certificateNumber: r.certificateNumber,
      flat: `${r.blockName} ${r.flatNumber}`.trim(),
      memberName: r.memberName,
      shares: `${r.distinctiveFrom}–${r.distinctiveTo}`,
      shareCount: r.shareCount,
      amountPaise: r.amountPaise,
      issuedOn: r.issuedOn,
      status: r.status,
    })),
    totalMembers: active.length,
    totalSharesIssued: active.reduce((s, r) => s + r.shareCount, 0),
    totalShareCapitalPaise: active.reduce((s, r) => s + r.amountPaise, 0),
    // Flats with no certificate aren't members yet — a gap the committee should see.
    flatsWithoutShares: flatsTotal - active.length,
  };
}
