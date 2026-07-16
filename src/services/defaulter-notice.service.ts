import mongoose from 'mongoose';
import { DefaulterNotice, IDefaulterNotice, NoticeStage, DeliveryChannel } from '../models/defaulter-notice.model';
import { Society } from '../models/society.model';
import { defaulters } from './reports.service';
import { ExportDoc, money } from './report-export.service';

export interface Actor { userId: string; userName: string }

/** Thrown for a caller mistake — the controller maps these to 4xx, not 500. */
export class NoticeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * The statutory escalation ladder, in order.
 *
 * Recovery under co-operative law follows written demand: a society that files
 * for recovery without having served the notices before it has a case its own
 * paperwork defeats. The order is enforced by the service rather than left to
 * the screen, because the screen is not the only door.
 */
export const STAGES: NoticeStage[] = ['FIRST', 'SECOND', 'FINAL', 'RECOVERY_101'];
const rankOf = (s: NoticeStage) => STAGES.indexOf(s);

const STAGE_LABEL: Record<NoticeStage, string> = {
  FIRST: 'First Reminder',
  SECOND: 'Second Reminder',
  FINAL: 'Final Notice',
  RECOVERY_101: 'Recovery Application Filed',
};

/** Days a member is given to pay, by stage — each demand is more urgent than the last. */
const DEFAULT_DUE_DAYS: Record<NoticeStage, number> = { FIRST: 15, SECOND: 15, FINAL: 7, RECOVERY_101: 0 };

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * The notices that make up the flat's CURRENT escalation chain.
 *
 * Notices up to and including the last resolved one are history: once a member
 * has cleared their dues, a fresh default starts the ladder again at FIRST. Left
 * unbroken, a flat that defaulted, paid, and defaulted again years later would
 * be one step from a recovery filing on the strength of notices about a debt
 * that no longer exists.
 */
async function currentChain(societyId: string, flatId: string): Promise<IDefaulterNotice[]> {
  const all = await DefaulterNotice.find({ societyId: oid(societyId), flatId: oid(flatId) })
    .sort({ issuedOn: 1, createdAt: 1 });
  const lastResolved = all.map(n => !!n.resolvedOn).lastIndexOf(true);
  return lastResolved === -1 ? all : all.slice(lastResolved + 1);
}

/** The stage a flat's next notice should carry, given what has already been served. */
export function nextStageFor(chain: { stage: NoticeStage }[]): NoticeStage {
  const highest = chain.reduce((max, n) => Math.max(max, rankOf(n.stage)), -1);
  return STAGES[Math.min(highest + 1, STAGES.length - 1)];
}

export interface IssueNoticeInput {
  flatId: string;
  /** Omit to serve the next stage due. Passing one that skips a step is refused. */
  stage?: NoticeStage;
  issuedOn?: string;
  dueByOn?: string;
  deliveredVia?: DeliveryChannel[];
  notes?: string;
  /** Required for RECOVERY_101 — the application/certificate reference. */
  recoveryRef?: string;
}

/**
 * Serve a notice on a defaulting flat, freezing what it demands.
 *
 * The outstanding is read from the defaulters register AT ISSUE TIME and stored
 * on the notice. Everything else in this system derives its figures live, which
 * is right for a report and wrong for a notice: a notice is a document that was
 * served on a date, and re-deriving it later would silently rewrite the demand
 * as more bills are raised — leaving the society unable to show what it actually
 * asked for. The amount on the paper is the amount on the record.
 */
export async function issueNotice(societyId: string, input: IssueNoticeInput, actor: Actor): Promise<IDefaulterNotice> {
  const issuedOn = input.issuedOn ? new Date(input.issuedOn) : new Date();
  if (Number.isNaN(issuedOn.getTime())) throw new NoticeError('Invalid issue date');

  // As-of the issue date, so a back-dated notice demands what was owed then.
  const register = await defaulters(societyId, { asOf: issuedOn.toISOString() });
  const row = register.rows.find(r => String(r.flatId) === String(input.flatId));
  if (!row) throw new NoticeError('That flat has nothing outstanding — there is nothing to demand', 409);

  const chain = await currentChain(societyId, input.flatId);
  const next = nextStageFor(chain);
  const stage = input.stage || next;
  const highest = chain.reduce((max, n) => Math.max(max, rankOf(n.stage)), -1);

  // Repeating the stage already served is allowed (a second copy of the same
  // demand is ordinary practice); jumping ahead of it is not.
  if (rankOf(stage) > highest + 1) {
    const missing = STAGES[highest + 1];
    throw new NoticeError(
      `${STAGE_LABEL[stage]} cannot be served before ${STAGE_LABEL[missing]}. Recovery follows written notice — serve the ${STAGE_LABEL[missing].toLowerCase()} first.`,
      409,
    );
  }
  if (stage === 'RECOVERY_101' && !input.recoveryRef?.trim()) {
    throw new NoticeError('A recovery filing needs its application/certificate reference');
  }

  const dueByOn = input.dueByOn ? new Date(input.dueByOn) : addDays(issuedOn, DEFAULT_DUE_DAYS[stage]);
  if (Number.isNaN(dueByOn.getTime())) throw new NoticeError('Invalid due-by date');
  if (dueByOn < issuedOn) throw new NoticeError('A notice cannot fall due before it was issued');

  return DefaulterNotice.create({
    societyId,
    flatId: row.flatId,
    blockName: row.blockName,
    flatNumber: row.flatNumber,
    memberName: row.ownerName || 'The Member',
    stage,
    outstandingPaise: row.outstandingPaise,
    buckets: row.buckets,
    issuedOn,
    dueByOn,
    deliveredVia: input.deliveredVia || [],
    notes: input.notes?.trim() || undefined,
    recoveryRef: input.recoveryRef?.trim() || undefined,
    issuedBy: actor.userId,
    issuedByName: actor.userName,
  });
}

/**
 * The notice register, joined to what each flat owes TODAY.
 *
 * Both figures matter and they are not the same: `outstandingPaise` is what the
 * notice demanded, `currentOutstandingPaise` is what is still owed. The gap
 * between them is how the committee sees whether a notice worked.
 */
export async function listNotices(societyId: string, opts: { flatId?: string; stage?: NoticeStage; openOnly?: boolean } = {}) {
  const q: any = { societyId: oid(societyId) };
  if (opts.flatId) q.flatId = oid(opts.flatId);
  if (opts.stage) q.stage = opts.stage;
  if (opts.openOnly) q.resolvedOn = { $exists: false };

  const [rows, register] = await Promise.all([
    DefaulterNotice.find(q).sort({ issuedOn: -1, createdAt: -1 }).lean(),
    defaulters(societyId),
  ]);
  const liveByFlat = new Map(register.rows.map(r => [String(r.flatId), r.outstandingPaise]));

  return {
    rows: rows.map(n => ({
      _id: String(n._id),
      flatId: String(n.flatId),
      flat: `${n.blockName} ${n.flatNumber}`.trim(),
      blockName: n.blockName,
      flatNumber: n.flatNumber,
      memberName: n.memberName,
      stage: n.stage,
      stageLabel: STAGE_LABEL[n.stage],
      outstandingPaise: n.outstandingPaise,
      currentOutstandingPaise: liveByFlat.get(String(n.flatId)) || 0,
      buckets: n.buckets,
      issuedOn: n.issuedOn,
      dueByOn: n.dueByOn,
      deliveredVia: n.deliveredVia,
      notes: n.notes,
      recoveryRef: n.recoveryRef,
      resolvedOn: n.resolvedOn,
      issuedByName: n.issuedByName,
    })),
    total: rows.length,
    openCount: rows.filter(n => !n.resolvedOn).length,
  };
}

/**
 * The next stage due for each flat, so the screen never has to guess.
 *
 * Keyed by flat: the escalation rule lives here, and a client that reimplemented
 * it would drift out of step with the service that enforces it.
 */
export async function noticeStatusByFlat(societyId: string) {
  const notices = await DefaulterNotice.find({ societyId: oid(societyId) })
    .sort({ issuedOn: 1, createdAt: 1 })
    .select('flatId stage issuedOn resolvedOn')
    .lean();

  const byFlat = new Map<string, { stage: NoticeStage; issuedOn: Date; resolvedOn?: Date }[]>();
  for (const n of notices) {
    const key = String(n.flatId);
    byFlat.set(key, [...(byFlat.get(key) || []), { stage: n.stage, issuedOn: n.issuedOn, resolvedOn: n.resolvedOn }]);
  }

  const out: Record<string, { noticeCount: number; lastStage?: NoticeStage; lastIssuedOn?: Date; nextStage: NoticeStage }> = {};
  for (const [flatId, all] of byFlat) {
    const lastResolved = all.map(n => !!n.resolvedOn).lastIndexOf(true);
    const chain = lastResolved === -1 ? all : all.slice(lastResolved + 1);
    const last = chain[chain.length - 1];
    out[flatId] = {
      noticeCount: all.length,
      lastStage: last?.stage,
      lastIssuedOn: all[all.length - 1].issuedOn,
      nextStage: nextStageFor(chain),
    };
  }
  return out;
}

/** Close a notice — the dues behind it were settled, or it was withdrawn. */
export async function resolveNotice(
  societyId: string,
  noticeId: string,
  input: { resolvedOn?: string; notes?: string } = {},
): Promise<IDefaulterNotice> {
  const notice = await DefaulterNotice.findOne({ _id: noticeId, societyId });
  if (!notice) throw new NoticeError('Notice not found', 404);
  if (notice.resolvedOn) throw new NoticeError('That notice is already resolved', 409);

  const resolvedOn = input.resolvedOn ? new Date(input.resolvedOn) : new Date();
  if (Number.isNaN(resolvedOn.getTime())) throw new NoticeError('Invalid resolution date');
  if (resolvedOn < notice.issuedOn) throw new NoticeError('A notice cannot be resolved before it was issued');

  notice.resolvedOn = resolvedOn;
  if (input.notes?.trim()) notice.notes = input.notes.trim();
  await notice.save();
  return notice;
}

/** What the member is told happens next if they ignore this notice. */
const WHAT_HAPPENS_NEXT: Record<NoticeStage, string> = {
  FIRST: 'Please clear the amount above by the due date. If payment is not received, a second reminder will follow and interest on arrears may be charged as per the society\'s bye-laws.',
  SECOND: 'This is the second reminder for the same dues. If the amount is not cleared by the due date, the society will serve a final notice before initiating recovery proceedings.',
  FINAL: 'This is the FINAL notice. If the amount is not cleared by the due date, the society will file a recovery application with the Registrar of Co-operative Societies. Costs of recovery may be charged to the member.',
  RECOVERY_101: 'A recovery application has been filed with the Registrar of Co-operative Societies. The reference is shown above. The dues remain payable and recovery costs may be added.',
};

/**
 * The notice as a printable document.
 *
 * Built from the SNAPSHOT on the record, not from a fresh read of the register —
 * reprinting a served notice must reproduce the notice that was served, down to
 * the paise. An ExportDoc rather than a PDF: the same builder the statutory
 * reports use, so one change to the letterhead reaches every document.
 */
export async function noticePdf(societyId: string, noticeId: string): Promise<ExportDoc> {
  const notice = await DefaulterNotice.findOne({ _id: noticeId, societyId }).lean();
  if (!notice) throw new NoticeError('Notice not found', 404);

  const society = await Society.findById(societyId).select('name address registrationNumber').lean();
  const asDate = (d: Date) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const b = notice.buckets;

  const meta = [
    society?.address,
    society?.registrationNumber ? `Reg. No. ${society.registrationNumber}` : undefined,
    `Notice dated ${asDate(notice.issuedOn)}`,
  ].filter(Boolean) as string[];

  const doc: ExportDoc = {
    title: `${STAGE_LABEL[notice.stage]} — Outstanding Dues`,
    subtitle: `${notice.blockName} ${notice.flatNumber}`.trim(),
    societyName: society?.name || 'Society',
    meta,
    sections: [
      {
        title: 'To',
        columns: ['Member', 'Flat'],
        rows: [[notice.memberName, `${notice.blockName} ${notice.flatNumber}`.trim()]],
      },
      {
        title: 'Amount outstanding',
        columns: ['Particulars', 'Amount'],
        moneyColumns: [1],
        rows: [
          ['Total dues outstanding as on the date of this notice', money(notice.outstandingPaise)],
          ['To be paid on or before', asDate(notice.dueByOn)],
        ],
      },
      {
        // The aging is the notice's justification: a committee demanding money
        // must be able to show which of it is stale and which is this month's.
        title: 'How these dues have aged',
        columns: ['Period past due', 'Amount'],
        moneyColumns: [1],
        rows: [
          ['Current / not yet 30 days overdue', money(b.current)],
          ['31 – 60 days overdue', money(b.d31_60)],
          ['61 – 90 days overdue', money(b.d61_90)],
          ['More than 90 days overdue', money(b.d90plus)],
        ],
        footer: ['Total', money(notice.outstandingPaise)],
      },
      {
        title: 'What happens next',
        columns: ['', ''],
        rows: [
          [WHAT_HAPPENS_NEXT[notice.stage], ''],
          ...(notice.recoveryRef ? [[`Recovery application reference: ${notice.recoveryRef}`, '']] : []),
          ...(notice.notes ? [[notice.notes, '']] : []),
          ...(notice.deliveredVia.length ? [[`Served by: ${notice.deliveredVia.join(', ').toLowerCase()}`, '']] : []),
          ['', ''],
          [`Issued by ${notice.issuedByName} for and on behalf of the Managing Committee.`, ''],
        ],
      },
    ],
  };
  return doc;
}