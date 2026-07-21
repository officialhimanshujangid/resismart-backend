import mongoose from 'mongoose';
import { Complaint, IComplaint, PAUSE_REASONS, PauseReason, ComplaintStatus } from '../models/complaint.model';
import { ComplaintCategory, IComplaintCategory } from '../models/complaint-category.model';
import { ComplaintEvent, ComplaintEventType } from '../models/complaint-event.model';
import { Asset } from '../models/asset.model';
import { Flat } from '../models/flat.model';
import { SocietyStaff } from '../models/society-staff.model';
import { findAssignee } from './staff.service';
import { WORK_CATEGORIES } from '../models/staff-assignment.model';
import { EffectiveAccess } from './access-role.service';
import { notify } from './notification.service';
import { householdOfFlat, userOfStaff, usersOfCommittee, excluding } from './notify-recipients';
import { nextSequence } from './finance-sequence.service';
import { SequenceCounter } from '../models/sequence-counter.model';
import {
  canTransition, allowedVerbs, PAUSE_LIMITS, ALL_STATUSES,
  ComplaintVerb, TransitionActor, TransitionSubject, PauseLimits, GuardOpts,
} from './complaint-transitions';
import { calendarFor, dueAfter, WorkingCalendar } from './complaint-calendar';
import s3Service from './s3.service';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/**
 * Telling people, without ever putting the complaint at risk.
 *
 * Not awaited by any caller: every one of them has already saved, and a slow
 * mail relay or an unreachable push service must not turn a recorded complaint
 * into a failed request. `notify` swallows its own errors; the catch here is
 * for the recipient lookup that happens before it.
 */
function tell(job: () => Promise<unknown>) {
  job().catch(e => logger.error(`Complaint notification failed: ${e.message}`));
}

export class ComplaintError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Actor { userId: string; userName: string }

/**
 * Complaints, from "the tap is leaking" to somebody actually confirming it stopped.
 *
 * The two rules that shape everything below:
 *
 *   **Nothing is ever quietly nobody's.** Routing that finds no match parks the
 *   ticket unassigned and says so, rather than picking somebody plausible.
 *
 *   **The clock only runs when the delay is ours.** A locked flat is not the
 *   plumber's fault, and scoring it as though it were teaches staff to close
 *   tickets and open new ones — which destroys the history the resident needs.
 */

/**
 * What a society gets before it writes its own.
 *
 * The timings are opinionated on purpose. A blank category list is a screen
 * nobody fills in, and an SLA of "2 days" for everything is a promise that is
 * wrong for a burst pipe and absurd for a garden.
 */
const SEED_CATEGORIES: {
  category: string; subCategory?: string; workCategory: string;
  firstResponseMinutes: number; resolutionMinutes: number; isEmergency?: boolean;
}[] = [
  { category: 'Plumbing', subCategory: 'Water leakage', workCategory: 'PLUMBING', firstResponseMinutes: 30, resolutionMinutes: 240, isEmergency: true },
  { category: 'Plumbing', subCategory: 'Tap or fitting', workCategory: 'PLUMBING', firstResponseMinutes: 240, resolutionMinutes: 2880 },
  { category: 'Plumbing', subCategory: 'Drainage blocked', workCategory: 'PLUMBING', firstResponseMinutes: 60, resolutionMinutes: 720 },
  { category: 'Electrical', subCategory: 'Power failure', workCategory: 'ELECTRICAL', firstResponseMinutes: 15, resolutionMinutes: 240, isEmergency: true },
  { category: 'Electrical', subCategory: 'Common area light', workCategory: 'ELECTRICAL', firstResponseMinutes: 240, resolutionMinutes: 2880 },
  { category: 'Lift', subCategory: 'Someone stuck', workCategory: 'LIFT', firstResponseMinutes: 5, resolutionMinutes: 60, isEmergency: true },
  { category: 'Lift', subCategory: 'Not working', workCategory: 'LIFT', firstResponseMinutes: 15, resolutionMinutes: 360 },
  { category: 'Housekeeping', workCategory: 'CLEANING', firstResponseMinutes: 240, resolutionMinutes: 1440 },
  { category: 'Garden', workCategory: 'GARDEN', firstResponseMinutes: 1440, resolutionMinutes: 10080 },
  { category: 'Security', workCategory: 'SECURITY', firstResponseMinutes: 30, resolutionMinutes: 720 },
  { category: 'Water supply', workCategory: 'PLUMBING', firstResponseMinutes: 60, resolutionMinutes: 720 },
  { category: 'Carpentry', workCategory: 'CARPENTRY', firstResponseMinutes: 480, resolutionMinutes: 4320 },
  { category: 'Other', workCategory: 'OTHER', firstResponseMinutes: 480, resolutionMinutes: 4320 },
];

export async function seedCategories(societyId: string, userId: string, userName: string): Promise<number> {
  const existing = await ComplaintCategory.countDocuments({ societyId: oid(societyId) });
  if (existing > 0) return 0;

  await ComplaintCategory.insertMany(SEED_CATEGORIES.map((c, i) => ({
    societyId: oid(societyId), ...c, sortOrder: i, isActive: true,
    createdBy: oid(userId), createdByName: userName,
    updatedBy: oid(userId), updatedByName: userName,
  })), { ordered: false }).catch((e: any) => { if (e?.code !== 11000) throw e; });
  return SEED_CATEGORIES.length;
}

export async function listCategories(societyId: string, userId: string, userName: string) {
  await seedCategories(societyId, userId, userName);
  return ComplaintCategory.find({ societyId: oid(societyId), isActive: true })
    .sort({ sortOrder: 1, category: 1 }).lean();
}

/** Manage-side: every category including the switched-off ones. */
export async function listAllCategories(societyId: string) {
  return ComplaintCategory.find({ societyId: oid(societyId) })
    .sort({ isActive: -1, sortOrder: 1, category: 1 }).lean();
}

export interface CategoryInput {
  category: string;
  subCategory?: string;
  workCategory: string;
  firstResponseMinutes?: number;
  resolutionMinutes?: number;
  isEmergency?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

/**
 * Create or edit a complaint category.
 *
 * This exists because there was no way to. Every SLA field was writable on the
 * model and had no writer — no service, no route, no screen — so a society was
 * frozen with the thirteen seeded rows and their timings forever. A committee
 * that wanted "garden complaints answered in a week, not a fortnight" had no
 * lever to pull.
 *
 * `workCategory` is validated against the trades staff can actually be assigned
 * to. A category routing to a trade no assignment uses is a category whose
 * complaints always fall to "nobody" — accepting a free string would rebuild
 * exactly that silent failure.
 */
export async function saveCategory(societyId: string, input: CategoryInput, actor: Actor, id?: string): Promise<IComplaintCategory> {
  if (!input.category?.trim()) throw new ComplaintError('A category needs a name.');
  if (!(WORK_CATEGORIES as readonly string[]).includes(input.workCategory)) {
    throw new ComplaintError('That is not a trade staff can be assigned to.');
  }
  if (input.firstResponseMinutes && input.resolutionMinutes
      && input.firstResponseMinutes > input.resolutionMinutes) {
    throw new ComplaintError('The first-reply promise cannot be slower than the fix promise.');
  }

  const fields = {
    category: input.category.trim(),
    subCategory: input.subCategory?.trim() || undefined,
    workCategory: input.workCategory,
    firstResponseMinutes: input.firstResponseMinutes,
    resolutionMinutes: input.resolutionMinutes,
    isEmergency: input.isEmergency,
    isActive: input.isActive,
    sortOrder: input.sortOrder,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  };

  try {
    if (id) {
      const cat = await ComplaintCategory.findOneAndUpdate(
        { _id: oid(id), societyId: oid(societyId) },
        { $set: clean(fields) },
        { new: true },
      );
      if (!cat) throw new ComplaintError('That category could not be found.', 404);
      return cat;
    }
    return await ComplaintCategory.create({
      societyId: oid(societyId), ...clean(fields),
      createdBy: oid(actor.userId), createdByName: actor.userName,
    });
  } catch (e: any) {
    // The unique (society, category, subCategory) index.
    if (e?.code === 11000) throw new ComplaintError('A category with that name already exists.');
    throw e;
  }
}

/** Drop undefined keys so a partial edit does not overwrite fields with null. */
const clean = (o: Record<string, any>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ---------------------------------------------------------------- photographs

/**
 * The one prefix a complaint photograph may live under.
 *
 * `photoKeys` was on both the complaint and its events, validated by the
 * schema, and written by this service — with no uploader and no viewer anywhere
 * in the product. So a resident reporting a leak had to describe it in prose,
 * which OPERATIONS_V2 §IV-1 names as the single biggest reason filing "feels
 * lengthy". The bytes now go through `POST /complaints/photos`, which is the
 * only thing that mints a key under this prefix.
 */
export const COMPLAINT_PHOTO_PREFIX = 'complaint-photos/';
/** Six is the schema's limit too. A gallery, not an album. */
export const MAX_PHOTOS = 6;

/**
 * Refuse a key this product did not mint.
 *
 * Without this, the key is just a string the caller chose, and the presigned
 * download below would happily sign ANY object in the bucket — including
 * another society's flat documents and another society's visitor face photos.
 * The same lock `flat-document.service` puts on `flat-documents/`, for exactly
 * the same reason.
 */
function ourPhotoKeys(keys: string[] | undefined): string[] {
  const list = (keys || []).filter(k => typeof k === 'string' && k.trim());
  if (!list.length) return [];
  if (list.length > MAX_PHOTOS) {
    throw new ComplaintError(`Up to ${MAX_PHOTOS} photos, please — pick the ones that show it best.`);
  }
  for (const k of list) {
    if (!k.startsWith(COMPLAINT_PHOTO_PREFIX)) {
      throw new ComplaintError('That photo was not uploaded through this form. Attach it again.');
    }
  }
  return list;
}

/**
 * The ticket number, reserved atomically.
 *
 * It used to be `countDocuments() + 1` with no unique index behind it, which is
 * a race with a two-query window: two residents pressing "report" in the same
 * second both read 41, both wrote CMP/00042, and both rows persisted. The
 * number is the one thing a resident quotes on the phone and the one thing a
 * manager searches for, so two of them meaning different tickets is not a
 * cosmetic defect.
 *
 * The repo already had the answer — `SequenceCounter` + `nextSequence`, doing
 * exactly this for every finance document. Complaints simply never used it.
 * Ticket numbers do not restart with the financial year (a resident's ticket
 * does not become somebody else's in April), so the year slot is pinned to a
 * constant rather than left out: the counter's unique key needs all three
 * parts.
 */
const TICKET_SCOPE = 'COMPLAINT';
const TICKET_SEQUENCE_YEAR = 'ALL';

/**
 * Carry an existing society over to the counter without reusing its numbers.
 *
 * A society that has been running for a year already has CMP/00001 through
 * CMP/00300 and a counter that has never been created. Starting it at zero
 * would hand out three hundred numbers that already exist — every one of them
 * now rejected by the unique index. So the first reservation seeds the counter
 * from what is on the ground. `$setOnInsert` makes that a one-time act: a
 * second concurrent raise cannot rewind a counter that already exists.
 */
async function seedTicketCounter(societyId: string) {
  const key = { societyId: oid(societyId), scope: TICKET_SCOPE, financialYear: TICKET_SEQUENCE_YEAR };
  if (await SequenceCounter.countDocuments(key)) return;
  const already = await Complaint.countDocuments({ societyId: oid(societyId) });
  await SequenceCounter.updateOne(key, { $setOnInsert: { seq: already } }, { upsert: true })
    .catch((e: any) => { if (e?.code !== 11000) throw e; });
}

async function nextTicketCode(societyId: string): Promise<string> {
  await seedTicketCounter(societyId);
  const seq = await nextSequence(oid(societyId), TICKET_SCOPE, TICKET_SEQUENCE_YEAR);
  return `CMP/${String(seq).padStart(5, '0')}`;
}

const log = (
  societyId: string, complaintId: any, type: ComplaintEventType,
  actor: Actor, note?: string, opts: { internal?: boolean; photoKeys?: string[] } = {},
) => ComplaintEvent.create({
  societyId: oid(societyId), complaintId, type, note,
  photoKeys: opts.photoKeys || [],
  byUserId: oid(actor.userId), byName: actor.userName,
  isInternal: opts.internal ?? false,
}).catch(e => logger.error(`Could not log complaint event: ${e.message}`));

export interface RaiseInput {
  kind?: 'SERVICE' | 'CONDUCT';
  title: string;
  description?: string;
  photoKeys?: string[];
  categoryId?: string;
  category?: string;
  subCategory?: string;
  flatId?: string;
  blockId?: string;
  assetId?: string;
  visibility?: 'PERSONAL' | 'COMMUNITY';
  viaChannel?: 'APP' | 'MANAGER' | 'GUARD';
  /** Who a CONDUCT complaint is about — an employee, or a committee member. */
  aboutStaffId?: string;
  aboutUserId?: string;
}

/** Who is filing, and on whose behalf. */
export interface RaiseOpts {
  /** The flats this person actually lives in. `undefined` for staff-side callers. */
  raiserFlatIds?: string[];
  /** A manager or guard filing for somebody else — may name any flat. */
  onBehalf?: boolean;
}

export async function raise(
  societyId: string, input: RaiseInput, actor: Actor, opts: RaiseOpts = {},
): Promise<IComplaint> {
  if (!input.title?.trim()) throw new ComplaintError('What is the problem?');

  let cat: any = null;
  if (input.categoryId) {
    cat = await ComplaintCategory.findOne({ _id: input.categoryId, societyId: oid(societyId), isActive: true }).lean();
    if (!cat) throw new ComplaintError('That is not a category this society uses.');
  }

  // The asset carries its own wing and category, which is the entire point of
  // the QR sticker: scan it and the location stops being a guess.
  let asset: any = null;
  if (input.assetId) {
    asset = await Asset.findOne({ _id: input.assetId, societyId: oid(societyId), isActive: true }).lean();
    if (!asset) throw new ComplaintError('That equipment does not belong to this society.');
  }

  /**
   * Where the problem is.
   *
   * Two failures met here, and together they were the widest leak in the
   * product. The raise form never sent a `flatId` and there was no fallback to
   * the raiser's own flat — so `visibility` fell to COMMUNITY and every
   * complaint filed from the web was readable by every neighbour: "there is a
   * leak in my bathroom", with the raiser's name on it. The same absence broke
   * routing, because a complaint with no wing matches no wing-covering staff.
   *
   * And when a flat WAS supplied it was only checked against the society, so
   * anybody could file a complaint attributed to somebody else's home, which
   * then appeared in that household's list as their own.
   *
   * So: infer it when it is not given, and verify it when it is. The office may
   * still file on a resident's behalf — that is what `opts.onBehalf` is for, and
   * it is the only way to reach another flat.
   */
  let flat: any = null;
  // Not inferred when a sticker was scanned: the asset already says where this
  // is, and it is a lift or a pump, not somebody's kitchen. Attaching the
  // reporter's flat to it would turn a common-area fault into a private one
  // that their neighbours cannot add themselves to.
  const inferred = !asset && opts.raiserFlatIds?.length === 1 ? opts.raiserFlatIds[0] : undefined;
  const flatId = input.flatId || inferred;

  if (flatId) {
    flat = await Flat.findOne({ _id: flatId, societyId: oid(societyId) })
      .select('number blockName blockId').lean();
    if (!flat) throw new ComplaintError('That flat does not belong to this society.');

    if (!opts.onBehalf && opts.raiserFlatIds && !opts.raiserFlatIds.some(f => String(f) === String(flat._id))) {
      throw new ComplaintError('You can only report a problem for your own flat.', 403);
    }
  }

  const blockId = flat?.blockId || asset?.blockId || (input.blockId ? oid(input.blockId) : undefined);
  const kind = input.kind === 'CONDUCT' ? 'CONDUCT' : 'SERVICE';
  const now = new Date();

  /**
   * Who the complaint is about, when it is about a person.
   *
   * Only read for CONDUCT. Carrying it on a service ticket would quietly turn
   * "the lift is broken" into a record naming a technician, which is exactly
   * the conflation `kind` exists to prevent. The staff row is verified against
   * this society for the same reason every other id here is: an unverified id
   * would let somebody name a person who does not work here — or worse, one who
   * works at a different society — and the exclusion filters would then key on
   * a stranger and silently stop protecting anybody.
   */
  let about: { staffId?: any; userId?: any; name?: string } = {};
  if (kind === 'CONDUCT') {
    if (input.aboutStaffId) {
      const who = await SocietyStaff.findOne({ _id: input.aboutStaffId, societyId: oid(societyId) })
        .select('person.name userId').lean();
      if (!who) throw new ComplaintError('That person does not work for this society.');
      about = { staffId: who._id, userId: who.userId, name: who.person?.name };
    } else if (input.aboutUserId) {
      // A committee member has no SocietyStaff row at all, which is precisely
      // why a conduct complaint about one used to be fully visible to them.
      about = { userId: oid(input.aboutUserId) };
    }
    if (about.userId && String(about.userId) === String(actor.userId)) {
      throw new ComplaintError('A conduct complaint cannot be about the person making it.');
    }
  }

  const firstResponseMinutes = cat?.firstResponseMinutes ?? 240;
  const resolutionMinutes = cat?.resolutionMinutes ?? 2880;

  /**
   * The promise, counted in hours the society actually works.
   *
   * This was `now + minutes` in epoch milliseconds. A 15-minute first-reply
   * category filed at 02:00 was therefore breached at 02:15, and the sweep
   * escalated it to the committee — by push, with an email fallback — before
   * anybody could conceivably have attended. Nobody was late; the promise was
   * never keepable in the first place, and the software was recording a fault
   * against its own staff every night.
   *
   * Emergencies keep the old elapsed clock, which is the point of marking a
   * category an emergency: somebody stuck in a lift at 02:00 is a five-minute
   * promise at 02:00, not at 09:05 tomorrow.
   */
  const calendar = await calendarFor(societyId, { emergency: !!cat?.isEmergency });

  const complaint = await createWithTicketCode(societyId, {
    societyId: oid(societyId),
    kind,
    aboutStaffId: about.staffId,
    aboutUserId: about.userId,
    aboutName: about.name,
    title: input.title.trim(),
    description: input.description,
    photoKeys: ourPhotoKeys(input.photoKeys),
    categoryId: cat?._id,
    category: cat?.category || input.category || 'Other',
    subCategory: cat?.subCategory || input.subCategory,
    visibility: input.visibility || (flat ? 'PERSONAL' : 'COMMUNITY'),
    scope: flat ? 'FLAT' : blockId ? 'BLOCK' : 'SOCIETY',
    blockId,
    blockName: flat?.blockName || asset?.blockName,
    flatId: flat?._id,
    flatLabel: flat ? `${flat.blockName || ''} ${flat.number}`.trim() : undefined,
    assetId: asset?._id,
    assetName: asset ? `${asset.name}${asset.location ? ` (${asset.location})` : ''}` : undefined,
    raisedByUserId: oid(actor.userId),
    raisedByName: actor.userName,
    viaChannel: input.viaChannel || 'APP',
    status: 'NEW',
    priority: cat?.isEmergency ? 'EMERGENCY' : 'NORMAL',
    firstResponseDueAt: dueAfter(now, firstResponseMinutes, calendar),
    resolutionDueAt: dueAfter(now, resolutionMinutes, calendar),
    totalPausedMs: 0,
    escalationLevel: 0,
    reopenCount: 0,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });

  await log(societyId, complaint._id, 'RAISED', actor, input.description);

  // A conduct complaint is never routed by trade. Sending "the housekeeping man
  // was rude" to the housekeeping supervisor — or to the man himself — is the
  // failure mode this whole separate kind exists to prevent.
  if (kind === 'SERVICE' && cat?.workCategory) {
    await autoAssign(societyId, complaint, cat.workCategory, actor);
  }

  // An AMC-covered asset goes to the firm that is paid to fix it, at their cost.
  if (asset?.vendorId && asset.amcExpiresOn && asset.amcExpiresOn > now && !complaint.assigneeStaffId) {
    complaint.assigneeVendorId = asset.vendorId;
    complaint.assigneeVendorName = asset.vendorName;
    complaint.routedVia = 'ASSET_AMC';
    complaint.status = 'ASSIGNED';
    await complaint.save();
    await log(societyId, complaint._id, 'ASSIGNED', actor, `Sent to ${asset.vendorName} under the AMC`, { internal: true });
  }

  /**
   * A conduct complaint told NOBODY.
   *
   * `autoAssign` is skipped for conduct — correctly — and nothing else fired,
   * so the entire path ended with a row in a collection. The screen promised
   * "this goes only to the committee member who handles conduct"; it went to no
   * one, sat at NEW forever, and then started escalating to a committee with no
   * idea what it was.
   *
   * The body deliberately does NOT carry the title. A conduct complaint is
   * usually titled with the accused's name, and a push notification is read on
   * a lock screen in front of other people.
   */
  if (kind === 'CONDUCT') {
    tell(() => tellTheConductHandlers(
      societyId, complaint, actor,
      'COMPLAINT_CONDUCT_RAISED',
      'A conduct complaint has been filed',
      'It is waiting for whoever handles conduct. Open it to read it.',
    ));
  }

  return complaint;
}

/**
 * Create the row, and treat a lost ticket-number race as a retry.
 *
 * The counter hands out numbers atomically, so the only way to collide is the
 * one-time seeding of an existing society (two raises in the same instant, both
 * finding no counter). The unique index turns that into a duplicate-key error
 * instead of two tickets called CMP/00042, and this turns the error into the
 * next number. Three attempts, because a fourth would mean something is wrong
 * that a loop cannot fix.
 */
async function createWithTicketCode(societyId: string, doc: Record<string, any>): Promise<IComplaint> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await Complaint.create({ ...doc, ticketCode: await nextTicketCode(societyId) });
    } catch (e: any) {
      const dupTicket = e?.code === 11000 && JSON.stringify(e?.keyPattern || {}).includes('ticketCode');
      if (!dupTicket || attempt === 2) throw e;
      logger.error(`Ticket code collision in ${societyId}, retrying`);
    }
  }
  /* istanbul ignore next — the loop either returns or throws. */
  throw new ComplaintError('Could not allocate a ticket number.', 500);
}

/**
 * The people who deal with conduct — and never the person it is about.
 *
 * The committee is the audience because conduct is a committee matter and
 * `COMPLAINTS_CONDUCT` is granted to committee roles; the raiser is added back
 * so somebody who files a complaint about a staff member is not left wondering
 * whether it went anywhere. The accused is stripped last, by both identities,
 * because an accused committee member IS one of the recipients this would
 * otherwise reach.
 */
async function tellTheConductHandlers(
  societyId: string, c: IComplaint, actor: Actor,
  kind: string, title: string, body: string,
) {
  const committee = await usersOfCommittee(societyId);
  const audience = new Set(committee);
  if (c.raisedByUserId) audience.add(String(c.raisedByUserId));

  await notify({
    societyId,
    userIds: withoutTheAccused(excluding([...audience], actor.userId), c),
    kind, title, body,
    link: `/dashboard/complaints?id=${c._id}`,
    entityType: 'Complaint', entityId: String(c._id),
  });
}

/**
 * Strip the accused out of any audience.
 *
 * Applied to every notification a conduct complaint can produce, not just the
 * one that raised it: the escalation sweep had no `kind` filter at all, so an
 * overdue conduct complaint arrived as a HIGH-priority push in the inbox of
 * every serving committee member — including, when the complaint was about a
 * committee member, the person being complained about.
 */
function withoutTheAccused(userIds: string[], c: Pick<IComplaint, 'kind' | 'aboutUserId'>): string[] {
  if (c.kind !== 'CONDUCT' || !c.aboutUserId) return userIds;
  return userIds.filter(id => String(id) !== String(c.aboutUserId));
}

/** Route to a person, or leave it visibly unassigned. Never guesses. */
async function autoAssign(societyId: string, complaint: IComplaint, workCategory: string, actor: Actor) {
  const match = await findAssignee(societyId, workCategory, complaint.blockId ? String(complaint.blockId) : null);
  if (!match) {
    // Deliberately left NEW and unassigned. It shows up in the manager's queue
    // as needing a decision, which is far better than being handed to somebody
    // who was merely nearby.
    await log(societyId, complaint._id, 'NOTE', actor,
      `Nobody covers ${workCategory}${complaint.blockName ? ` in ${complaint.blockName}` : ''} — needs assigning by hand`,
      { internal: true });
    return;
  }
  complaint.assigneeStaffId = oid(match.staffId);
  complaint.assigneeName = match.staffName;
  complaint.routedVia = match.via;
  complaint.status = 'ASSIGNED';
  await complaint.save();
  await log(societyId, complaint._id, 'ASSIGNED', actor, `Sent to ${match.staffName}`, { internal: true });

  tell(async () => {
    const to = await userOfStaff(societyId, match.staffId);
    await notify({
      societyId, userIds: to, kind: 'COMPLAINT_ASSIGNED',
      title: 'A job has come to you',
      body: `${complaint.title}${complaint.blockName ? ` — ${complaint.blockName}` : ''}`,
      link: `/dashboard/complaints?id=${complaint._id}`,
      entityType: 'Complaint', entityId: String(complaint._id),
      // Work waiting on somebody is worth an email when they have no device —
      // it is the difference between a job starting today and on Thursday.
      emailIfUnreachable: true,
    });
  });
}

export async function assignTo(
  societyId: string, id: string, staffId: string | null, actor: Actor, opts: ListOpts = {},
): Promise<IComplaint> {
  // Was `mine`, so the wing scope the controller resolved was thrown away on
  // the two most sensitive manager actions. A committee member limited to A
  // wing could reassign C wing's work.
  const c = await actable(societyId, id, opts);

  // Work out where this lands BEFORE writing anything, so the machine gets to
  // rule on the real target rather than on a status already changed under it.
  let next: ComplaintStatus = c.status;
  if (staffId && c.status === 'NEW') next = 'ASSIGNED';
  // Only rewind to NEW from ASSIGNED. Unassigning an IN_PROGRESS or WORK_DONE
  // ticket used to silently reset it to NEW, erasing that work had begun —
  // exactly the ADDA failure this module's header claims to avoid. Work that
  // has started stays in its state; it just no longer has a name on it.
  if (!staffId && c.status === 'ASSIGNED') next = 'NEW';
  must(c, next, 'assign', opts);

  if (staffId) {
    const staff = await SocietyStaff.findOne({ _id: staffId, societyId: oid(societyId), isActive: true })
      .select('person.name userId').lean();
    if (!staff) throw new ComplaintError('That staff member is unknown to this society or has left.');

    /**
     * Never to the person it is about.
     *
     * This was reachable and the consequence was severe: a conduct complaint
     * assigned to the accused delivered them a push titled "A job has come to
     * you" with the complaint in the body. The old guard could not catch it —
     * it keyed on `assigneeStaffId`, which is what this call is about to set.
     */
    if (c.kind === 'CONDUCT' && isTheAccused(c, String(staff._id), staff.userId)) {
      throw new ComplaintError('This complaint is about that person — it cannot be given to them.', 403);
    }

    c.assigneeStaffId = oid(staffId);
    c.assigneeName = staff.person.name;
    c.routedVia = 'MANUAL';
  } else {
    c.assigneeStaffId = undefined;
    c.assigneeName = undefined;
  }
  c.status = next;
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'REASSIGNED', actor, c.assigneeName ? `Now with ${c.assigneeName}` : 'Unassigned');

  if (staffId) {
    tell(async () => {
      const to = excluding(await userOfStaff(societyId, staffId), actor.userId);
      await notify({
        societyId, userIds: to, kind: 'COMPLAINT_ASSIGNED',
        title: 'A job has come to you',
        body: `${c.title}${c.blockName ? ` — ${c.blockName}` : ''}`,
        link: `/dashboard/complaints?id=${c._id}`,
        entityType: 'Complaint', entityId: String(c._id),
        emailIfUnreachable: true,
      });
    });
  }
  return c;
}

async function mine(societyId: string, id: string): Promise<IComplaint> {
  const c = await Complaint.findOne({ _id: id, societyId: oid(societyId) });
  if (!c) throw new ComplaintError('That complaint could not be found.', 404);
  return c;
}

/**
 * The same lookup, but only if this caller is entitled to act on it.
 *
 * `mine()` above checks the SOCIETY and nothing else — which is a tenant
 * boundary, not an authorisation check. Every resident-facing action was built
 * on it, so any resident who could see a community complaint's id could
 * resolve, reopen or rate a complaint belonging to another flat. Marking a
 * neighbour's open complaint RESOLVED stops its SLA clock and suppresses its
 * escalation, which is a silent and quite effective way to bury somebody
 * else's problem.
 *
 * The entitlement is deliberately the same shape as the read scoping in
 * `list`/`detail`, so a person can only ever act on what they can already see.
 */
/**
 * Is this complaint one of the reader's OWN household's — H-12.
 *
 * Two questions, and both have to be yes: is the flat in their scope, and was
 * the complaint raised while they lived there. The first is decided in the
 * controller (`readerFlatScope`), because "is this flat let, and to whom" is a
 * household question rather than a complaint one. The second is decided here,
 * because only this file knows when a complaint was raised.
 *
 * A complaint with no `createdAt` — a fixture, a legacy row — is treated as in
 * range. A tenure bound must never turn into "you can see nothing".
 */
function inHousehold(opts: ListOpts, c: { flatId?: any; createdAt?: Date }): boolean {
  if (!opts.residentFlatIds || !c.flatId) return false;
  const flatId = String(c.flatId);
  if (!opts.residentFlatIds.some(f => String(f) === flatId)) return false;

  const window = opts.residentTenure?.[flatId];
  if (!window || !c.createdAt) return true;
  const at = new Date(c.createdAt).getTime();
  if (window.from && at < new Date(window.from).getTime()) return false;
  if (window.to && at > new Date(window.to).getTime()) return false;
  return true;
}

async function actable(societyId: string, id: string, opts: ListOpts): Promise<IComplaint> {
  const c = await mine(societyId, id);

  // Managers act on anything in their society; the wing scope still applies.
  if (opts.canManage) {
    if (opts.blockIds && c.blockId && !opts.blockIds.some(b => String(b) === String(c.blockId))) {
      throw new ComplaintError('That complaint belongs to another wing.', 403);
    }
    return c;
  }

  // The person doing the work, on their own queue.
  if (opts.ownStaffId && String(c.assigneeStaffId || '') === String(opts.ownStaffId)) return c;

  // A resident: their own household's flat, or one they raised themselves.
  if (opts.residentFlatIds) {
    const ownFlat = inHousehold(opts, c as any);
    const raisedIt = opts.userId && String(c.raisedByUserId || '') === String(opts.userId);
    if (ownFlat || raisedIt) return c;
  }

  // 404 rather than 403 — the same reasoning as `detail`: confirming that an
  // id exists is itself a small leak.
  throw new ComplaintError('That complaint could not be found.', 404);
}

/**
 * Which hat this caller is wearing on THIS complaint.
 *
 * The scope object answers "what may I see and touch"; the state machine asks a
 * narrower question — am I the manager, the person doing the work, or the
 * household waiting on it? Derived in one place so no verb can decide it
 * differently, which is precisely how `resolve` ended up admitting the person
 * who did the work.
 */
function roleOn(c: IComplaint, opts: ListOpts): TransitionActor {
  const isAssignee = !!opts.ownStaffId && String(c.assigneeStaffId || '') === String(opts.ownStaffId);
  const ownFlat = inHousehold(opts, c as any);
  const raisedIt = !!opts.userId && String(c.raisedByUserId || '') === String(opts.userId);
  return { canManage: !!opts.canManage, isAssignee, isResident: ownFlat || raisedIt };
}

/** The shape the machine's guards read. */
const subjectOf = (c: IComplaint): TransitionSubject => ({
  status: c.status, kind: c.kind, visibility: c.visibility, pauseCount: c.pauseCount || 0,
});

/**
 * Ask the machine, and refuse in its words.
 *
 * EVERY verb below goes through here. That is the whole point of the table: the
 * eight hand-written `if`s this replaces had drifted apart from each other and
 * from the frontend's button conditions, and a rule that exists in eight copies
 * is a rule with eight chances to be wrong.
 */
function must(c: IComplaint, to: ComplaintStatus, verb: ComplaintVerb, opts: ListOpts, guards: GuardOpts = {}) {
  const verdict = canTransition(c.status, to, roleOn(c, opts), verb, subjectOf(c), guards);
  if (!verdict.ok) throw new ComplaintError(verdict.reason || 'That cannot be done.', verdict.status || 400);
}

/** Is this person the subject of that conduct complaint, by either identity? */
function isTheAccused(c: IComplaint, staffId?: string | null, userId?: any): boolean {
  if (c.kind !== 'CONDUCT') return false;
  if (staffId && c.aboutStaffId && String(c.aboutStaffId) === String(staffId)) return true;
  if (userId && c.aboutUserId && String(c.aboutUserId) === String(userId)) return true;
  return false;
}

/** Anyone who can SEE it may add their voice — that is what "me too" is for. */
async function joinable(societyId: string, id: string, opts: ListOpts): Promise<IComplaint> {
  const c = await mine(societyId, id);
  if (opts.canManage) return c;
  if (c.visibility === 'COMMUNITY' && c.kind !== 'CONDUCT') return c;
  return actable(societyId, id, opts);
}

/**
 * First reply. Recorded separately from resolution because silence is what
 * residents actually complain about — an answered-but-unfixed problem reads
 * completely differently from an ignored one.
 */
export async function respond(
  societyId: string, id: string, note: string, actor: Actor, opts: ListOpts = {},
  photoKeys?: string[],
): Promise<IComplaint> {
  const c = await actable(societyId, id, opts);
  // Replying to something already reported done, or on hold, does not drag it
  // backwards into IN_PROGRESS — it is a reply, not a restart.
  const next: ComplaintStatus = c.status === 'NEW' || c.status === 'ASSIGNED' ? 'IN_PROGRESS' : c.status;
  must(c, next, 'respond', opts);
  if (!c.firstRespondedAt) c.firstRespondedAt = new Date();
  c.status = next;
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'RESPONDED', actor, note, { photoKeys: ourPhotoKeys(photoKeys) });
  tell(() => tellTheFlat(societyId, c, actor, 'COMPLAINT_RESPONDED', 'Somebody has replied', note));
  return c;
}

/**
 * The person who raised it, and the household currently living in that flat.
 *
 * Both, deliberately: a tenant raises the leak and a family member is the one
 * actually at home when the plumber knocks. Falls back to the raiser alone for
 * a community complaint with no flat attached.
 *
 * The household is resolved by the same rule the gate uses, so a rented flat
 * reaches its tenant and not its landlord — an owner does not get to watch what
 * breaks in a home they no longer live in. The raiser is added back explicitly,
 * which is what keeps an owner in the loop on a complaint they filed themselves.
 */
async function tellTheFlat(
  societyId: string, c: IComplaint, actor: Actor,
  kind: string, title: string, body?: string,
) {
  const flatUsers = c.flatId ? (await householdOfFlat(societyId, String(c.flatId))).userIds : [];
  const audience = new Set(flatUsers);
  if (c.raisedByUserId) audience.add(String(c.raisedByUserId));

  await notify({
    societyId,
    userIds: excluding([...audience], actor.userId),
    kind, title,
    body: body ? `${c.title} — ${body}` : c.title,
    link: `/dashboard/complaints?id=${c._id}`,
    entityType: 'Complaint', entityId: String(c._id),
  });
}

/**
 * Stopping the clock — the most consequential thing anybody does to a ticket.
 *
 * A pause suppresses both SLA clocks AND removes the row from the escalation
 * sweep, so it is the single most effective way in the product to make a
 * complaint disappear without anybody noticing. Four things now hold it down:
 *
 *   1. **Scope** — `actable`, not `mine`. Before, the `opts` were accepted and
 *      dropped, so any COMPLAINTS_OWN holder could pause any complaint in the
 *      society, including another wing's and another technician's.
 *   2. **The machine** — refused from NEW (nothing has started, so there is no
 *      delay that is ours) and from WORK_DONE (the wait is the resident's).
 *   3. **A cap** — a ticket re-paused every time it approaches its deadline is
 *      not a repair, it is a hiding place.
 *   4. **The resident is told.** Pausing was the ONLY transition in this module
 *      that notified nobody, which meant the promise a resident was given could
 *      be silently moved while they watched the same screen.
 */
export async function pause(
  societyId: string, id: string, reason: PauseReason, actor: Actor,
  opts: ListOpts = {}, limits: PauseLimits = PAUSE_LIMITS,
): Promise<IComplaint> {
  if (!(PAUSE_REASONS as readonly string[]).includes(reason)) {
    // A free-text reason would make every ticket pausable for anything, and the
    // pause would stop meaning something anybody could count.
    throw new ComplaintError('That is not one of the reasons work can be put on hold.');
  }
  const c = await actable(societyId, id, opts);
  if (c.pausedAt) throw new ComplaintError('This is already on hold.');
  must(c, 'ON_HOLD', 'pause', opts, { pause: limits });

  c.statusBeforePause = c.status;
  c.pausedAt = new Date();
  c.pauseReason = reason;
  c.pauseCount = (c.pauseCount || 0) + 1;
  c.status = 'ON_HOLD';
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'PAUSED', actor, reason);

  tell(() => tellTheFlat(societyId, c, actor, 'COMPLAINT_PAUSED',
    'Work on your complaint is on hold', PAUSE_EXPLANATIONS[reason]));
  return c;
}

/**
 * Said in a way that does not read as an excuse.
 *
 * The stored reason is a constant for aggregation; this is the sentence the
 * household gets, because "AWAITING_ACCESS" tells a resident nothing and
 * "nobody was home" tells them whether the next step is theirs.
 */
const PAUSE_EXPLANATIONS: Record<PauseReason, string> = {
  AWAITING_ACCESS: 'We could not get into the flat. The clock is stopped until somebody can let us in.',
  AWAITING_PARTS: 'A part has been ordered. The clock is stopped until it arrives.',
  AWAITING_VENDOR: 'It is with an outside firm. The clock is stopped until they attend.',
  AWAITING_APPROVAL: 'The spend needs approval. The clock is stopped until that decision is made.',
};

export async function resume(societyId: string, id: string, actor: Actor, opts: ListOpts = {}): Promise<IComplaint> {
  const c = await actable(societyId, id, opts);
  if (!c.pausedAt) throw new ComplaintError('This is not on hold.');

  /**
   * Back to where it was, not to "in progress".
   *
   * `resume` used to land on IN_PROGRESS unconditionally. A ticket that was
   * merely assigned — or, before pausing from NEW was refused, one nobody had
   * even looked at — came back recorded as work somebody was actively doing.
   * That is a false entry in the one field a manager scans, and it made the
   * pause/resume pair a way to launder an untouched ticket into a busy one.
   */
  const back: ComplaintStatus = c.statusBeforePause || 'IN_PROGRESS';
  must(c, back, 'resume', opts);

  const paused = Date.now() - c.pausedAt.getTime();
  c.totalPausedMs += paused;
  // Push the deadlines out by exactly the time nobody could work. Without this
  // the pause would be a label with no effect on the only number that matters.
  if (c.firstResponseDueAt) c.firstResponseDueAt = new Date(c.firstResponseDueAt.getTime() + paused);
  if (c.resolutionDueAt) c.resolutionDueAt = new Date(c.resolutionDueAt.getTime() + paused);
  c.pausedAt = undefined;
  c.pauseReason = undefined;
  c.statusBeforePause = undefined;
  c.status = back;
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'RESUMED', actor, `On hold for ${Math.round(paused / 60_000)} minutes`);
  tell(() => tellTheFlat(societyId, c, actor, 'COMPLAINT_RESUMED', 'Work on your complaint has started again'));
  return c;
}

/**
 * The doer says they are finished. They do NOT get to close it.
 *
 * This is the single most-copied idea from the incumbents, and for good reason:
 * every one of them built a confirmation step, which is strong evidence that
 * premature closure was a real and recurring problem.
 */
export async function markWorkDone(societyId: string, id: string, note: string, photoKeys: string[], actor: Actor, opts: ListOpts = {}): Promise<IComplaint> {
  const c = await actable(societyId, id, opts);
  if (c.pausedAt) throw new ComplaintError('This is on hold — take it off hold first.');
  must(c, 'WORK_DONE', 'workDone', opts);

  c.status = 'WORK_DONE';
  if (!c.firstRespondedAt) c.firstRespondedAt = new Date();
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  // The "after" photograph. Written here since the beginning and read by
  // nothing, so a technician who bothered to take one was showing it to an
  // empty room; `photoUrls` below is the reader that makes it worth taking.
  await log(societyId, c._id, 'WORK_DONE', actor, note, { photoKeys: ourPhotoKeys(photoKeys) });
  // The one notification the whole design turns on: nothing closes until the
  // resident says so, so they have to be asked, and asked reliably.
  tell(() => tellTheFlat(societyId, c, actor, 'COMPLAINT_WORK_DONE',
    'Please confirm this is fixed', note || 'The work is reported done'));
  return c;
}

/**
 * The resident, or a manager on their behalf, confirms it is actually fixed.
 *
 * NOT the person who did the work. `actable` admits the assignee — correctly,
 * for replying and reporting done — so this had to be said separately, and
 * until it was, the technician who clicked "work is done" could immediately
 * click "yes, it is fixed". RESOLVED is where `resolvedAt` is stamped and where
 * every SLA figure is computed, so the doer was stopping their own clock and
 * grading their own work. The module defends this invariant at CLOSED; the
 * defence was simply one step too late.
 *
 * A manager may still resolve on the resident's behalf — households go on
 * holiday, and a ticket cannot hang forever waiting for a tap nobody will look
 * at. That is a different act by a different person, and it is recorded as one.
 */
export async function resolve(societyId: string, id: string, actor: Actor, opts: ListOpts = {}): Promise<IComplaint> {
  const c = await actable(societyId, id, opts);

  const isTheDoer = opts.ownStaffId && String(c.assigneeStaffId || '') === String(opts.ownStaffId);
  if (isTheDoer && !opts.canManage) {
    throw new ComplaintError(
      'You reported the work as done — the flat confirms it is fixed, not you.', 403,
    );
  }

  // The machine says the rest: RESOLVED is reachable only from WORK_DONE, so a
  // brand-new ticket cannot count as solved in the stats and the confirmation
  // step cannot be skipped.
  must(c, 'RESOLVED', 'resolve', opts);
  c.status = 'RESOLVED';
  c.resolvedAt = new Date();
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'RESOLVED', actor);
  return c;
}

/**
 * Closing, which is now refused from NEW.
 *
 * That refusal is not pedantry: closing from NEW was the ONLY way to dispose of
 * a junk ticket, so it was the path everybody took, and every one of those
 * closures landed in the reports as a complaint that ran its course. `reject`
 * and `markDuplicate` below are the honest doors, and they exist so this one
 * can be shut.
 */
export async function close(societyId: string, id: string, actor: Actor, opts: ListOpts = {}): Promise<IComplaint> {
  const c = await actable(societyId, id, opts);
  must(c, 'CLOSED', 'close', opts);
  c.status = 'CLOSED';
  c.closedAt = new Date();
  // NO backfill of resolvedAt. Setting it to closedAt when missing meant a
  // complaint closed straight from NEW entered the median-resolution stat as
  // though it had been worked — flattering the number the committee reads. A
  // complaint closed without being resolved simply has no resolution time.
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'CLOSED', actor);
  tell(() => tellTheFlat(societyId, c, actor, 'COMPLAINT_CLOSED', 'Your complaint has been closed'));
  return c;
}

export interface ReopenPolicy { windowDays?: number }

/**
 * Reopen — and COUNT it.
 *
 * The counter is the point. Reopen rate is the clearest signal that work is
 * being marked done without being done, and a product that resets the status to
 * "new" instead of counting throws that signal away entirely.
 */
export async function reopen(
  societyId: string, id: string, reason: string, actor: Actor, opts: ListOpts = {}, policy: ReopenPolicy = {},
): Promise<IComplaint> {
  const c = await actable(societyId, id, opts);
  must(c, 'REOPENED', 'reopen', opts);

  if (policy.windowDays && c.closedAt) {
    const age = (Date.now() - c.closedAt.getTime()) / 86_400_000;
    if (age > policy.windowDays) {
      throw new ComplaintError(`This was closed ${Math.floor(age)} days ago; the reopening window is ${policy.windowDays} days. Raise a new complaint.`);
    }
  }

  c.reopenCount += 1;
  c.status = 'REOPENED';
  c.resolvedAt = undefined;
  c.closedAt = undefined;

  /**
   * A reopened ticket is a live ticket, and it was being born already late.
   *
   * `reopen` cleared the two stamps and stopped. It did not touch
   * `resolutionDueAt` — which, on a complaint closed a fortnight ago, is a
   * fortnight in the past — so the very next sweep found it overdue by 20,000
   * minutes and escalated it straight to level 4, "fifteen days: a member may
   * now go to the Registrar", within the hour. The committee was told a
   * complaint reopened at 10am had breached a statutory limit by 10:59.
   *
   * So the clocks restart from now. The original promise cannot be reused and
   * cannot be inherited; what is preserved is the SHAPE of it — the same gap
   * between raise and due that the category promised in the first place —
   * because that is the promise the society actually made for this kind of work.
   *
   * The category is re-read rather than the old gap re-used wherever it still
   * exists, because the old gap is WALL-CLOCK time and the new deadline is
   * counted in working minutes. Reusing it would silently double a promise
   * every time a ticket was reopened: a 4-hour job filed on a Saturday evening
   * has a wall-clock gap of about 16 hours, and feeding 16 hours back in as
   * working minutes turns it into most of a week.
   */
  const cat = c.categoryId
    ? await ComplaintCategory.findOne({ _id: c.categoryId, societyId: oid(societyId) })
      .select('firstResponseMinutes resolutionMinutes isEmergency').lean()
    : null;
  const calendar = await calendarFor(societyId, { emergency: !!cat?.isEmergency });

  const at = new Date();
  const wallGap = (due?: Date) => due && c.createdAt ? (due.getTime() - c.createdAt.getTime()) / 60_000 : undefined;
  const firstResponseMinutes = cat?.firstResponseMinutes ?? wallGap(c.firstResponseDueAt) ?? 240;
  const resolutionMinutes = cat?.resolutionMinutes ?? wallGap(c.resolutionDueAt) ?? 2880;
  c.firstRespondedAt = undefined;
  c.firstResponseDueAt = dueAfter(at, Math.max(firstResponseMinutes, 15), calendar);
  c.resolutionDueAt = dueAfter(at, Math.max(resolutionMinutes, 60), calendar);
  // The rung it climbed belonged to the closed ticket. Leaving it set means the
  // reopened one can only ever climb higher, never be escalated properly again.
  c.escalationLevel = 0;
  c.lastEscalatedAt = undefined;

  /**
   * Somebody has to actually do it.
   *
   * Reopening put the ticket back in the queue with the assignee intact, or —
   * if the exit handover had cleared it — with nobody at all, and told no one
   * either way. "Reopened" that reaches nobody is indistinguishable from
   * "ignored", which is exactly the complaint being made.
   */
  const backTo = c.assigneeStaffId ? String(c.assigneeStaffId) : null;
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'REOPENED', actor, reason);

  tell(async () => {
    const staffUsers = backTo ? await userOfStaff(societyId, backTo) : [];
    // Nobody on it: the managers are the ones who must pick it up, and a
    // reopened unassigned ticket is precisely the thing that otherwise rots.
    const to = staffUsers.length ? staffUsers : await usersOfCommittee(societyId);
    await notify({
      societyId, userIds: withoutTheAccused(excluding(to, actor.userId), c),
      kind: 'COMPLAINT_REOPENED',
      title: staffUsers.length ? 'A job has come back to you' : 'A complaint has been reopened',
      body: `${c.title}${c.blockName ? ` — ${c.blockName}` : ''}: ${reason}`,
      link: `/dashboard/complaints?id=${c._id}`,
      entityType: 'Complaint', entityId: String(c._id),
      emailIfUnreachable: true,
    });
  });
  return c;
}

/**
 * Throwing a ticket out, in one act instead of four.
 *
 * `REJECTED` was declared on the model, styled in the UI, and filtered against
 * in four queries — and set by NOTHING. There was no way to reach it, so the
 * only way to dispose of a duplicate, a test entry or a complaint that is not
 * the society's business was Work-done → Yes-it's-fixed → Close: four clicks,
 * thirteen requests, a `resolvedAt` on work nobody did, and a permanent lie in
 * the median-resolution figure the committee reads.
 *
 * A reason is required. A rejection a resident cannot understand is the single
 * fastest way to make somebody stop using the system and start knocking on the
 * office door instead.
 */
export async function reject(
  societyId: string, id: string, reason: string, actor: Actor, opts: ListOpts = {},
): Promise<IComplaint> {
  if (!reason?.trim()) throw new ComplaintError('Say why — a rejection with no reason is just silence.');
  const c = await actable(societyId, id, opts);
  must(c, 'REJECTED', 'reject', opts);

  c.status = 'REJECTED';
  c.rejectionReason = reason.trim();
  c.closedAt = new Date();
  // NOT resolvedAt. Nothing was resolved, and the whole point of this verb is
  // that the statistics stop being told otherwise.
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'REJECTED', actor, reason.trim());
  tell(() => tellTheFlat(societyId, c, actor, 'COMPLAINT_REJECTED',
    'Your complaint was not taken forward', reason.trim()));
  return c;
}

/**
 * "This is the same as that one."
 *
 * `mergedIntoId` has been on the model since the beginning with zero writers.
 * This is the writer, and it does the part that makes merging worth doing:
 * everybody who said "me too" on the copy is carried across to the parent, so a
 * water outage that arrived as forty tickets ends as one ticket with forty
 * names on it — and the forty people still get told when it is fixed, which is
 * what would have been lost by simply rejecting the copies.
 */
export async function markDuplicate(
  societyId: string, id: string, ofId: string, actor: Actor, opts: ListOpts = {},
): Promise<IComplaint> {
  if (String(id) === String(ofId)) throw new ComplaintError('A complaint cannot be a duplicate of itself.');
  const c = await actable(societyId, id, opts);
  must(c, 'REJECTED', 'duplicate', opts);

  // The parent goes through `actable` too. Merging into a ticket the caller
  // cannot act on would let a wing-scoped member move another wing's residents
  // onto a complaint they cannot see.
  const parent = await actable(societyId, ofId, opts);
  if (['REJECTED'].includes(parent.status)) {
    throw new ComplaintError('That ticket was itself rejected — point this at a live one.');
  }
  if (String(parent.mergedIntoId || '') === String(c._id)) {
    throw new ComplaintError('Those two point at each other. Merge into a third, or into neither.');
  }

  // Everybody who was waiting on the copy is now waiting on the parent.
  const already = new Set(parent.meTooUserIds.map(u => String(u)));
  const moving = [
    ...c.meTooUserIds.map(u => String(u)),
    ...(c.raisedByUserId ? [String(c.raisedByUserId)] : []),
  ].filter(u => u !== String(parent.raisedByUserId) && !already.has(u));
  for (const u of new Set(moving)) parent.meTooUserIds.push(oid(u));
  if (moving.length) await parent.save();

  c.status = 'REJECTED';
  c.mergedIntoId = parent._id as any;
  c.rejectionReason = `Same as ${parent.ticketCode}`;
  c.closedAt = new Date();
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'REJECTED', actor, `Merged into ${parent.ticketCode}`);
  await log(societyId, parent._id, 'ME_TOO', actor,
    `${c.ticketCode} was the same thing${moving.length ? ` — ${moving.length} more waiting on this` : ''}`,
    { internal: true });

  tell(() => tellTheFlat(societyId, c, actor, 'COMPLAINT_MERGED',
    'Your complaint was joined to another',
    `It is the same as ${parent.ticketCode} — you will hear about it there.`));
  return c;
}

/**
 * "Me too."
 *
 * Nobody else has this, and it fixes two things at once. A water outage
 * produces forty tickets nobody can work; and residents report being made to
 * feel like nags for chasing — joining a complaint is socially easy in a way
 * that filing a second one is not.
 */
export async function meToo(societyId: string, id: string, actor: Actor, opts: ListOpts = {}): Promise<IComplaint> {
  const c = await joinable(societyId, id, opts);
  // Status unchanged — joining is not a transition — but it still goes through
  // the machine, because "may I press this?" must have exactly one answer and
  // the UI is reading that answer from the same table.
  must(c, c.status, 'meToo', opts);
  const uid = oid(actor.userId);
  if (c.meTooUserIds.some(u => String(u) === String(uid))) return c;

  c.meTooUserIds.push(uid);
  await c.save();
  await log(societyId, c._id, 'ME_TOO', actor);
  return c;
}

/**
 * The household's own voice — the channel that did not exist.
 *
 * `POST /:id/respond` is STAFF_SIDE and behind `COMPLAINTS_OWN`, and the screen
 * rendered its box and its Reply button to everybody. So a resident who wanted
 * to say "the plumber came, nobody was in, please try after six" typed it,
 * pressed Reply, and was told 403 — with no other way to add anything to their
 * own complaint. The workaround people actually used was to raise a second
 * complaint, which is how one leaking tap becomes four tickets and the
 * duplicate-merging above became necessary in the first place.
 *
 * Deliberately does NOT touch `firstRespondedAt`. That clock measures whether
 * the SOCIETY answered; a resident chasing their own complaint must never be
 * able to stop it, or every overdue ticket could be cleared by asking the
 * resident to write something.
 *
 * Deliberately does NOT touch the status either. Talking is not a transition —
 * it goes through the machine only so `allowedVerbs` can tell the screen
 * whether to render the box at all.
 */
export async function comment(
  societyId: string, id: string, note: string, photoKeys: string[] | undefined,
  actor: Actor, opts: ListOpts = {},
): Promise<IComplaint> {
  if (!note?.trim()) throw new ComplaintError('Say something — an empty message helps nobody.');
  const c = await actable(societyId, id, opts);
  must(c, c.status, 'comment', opts);

  await log(societyId, c._id, 'COMMENT', actor, note.trim(), { photoKeys: ourPhotoKeys(photoKeys) });

  /**
   * Somebody has to be listening.
   *
   * A message into a timeline nobody is watching is the same silence the
   * resident was complaining about. It goes to whoever holds the job, and to
   * the committee when nobody does — an unassigned complaint being chased is
   * precisely the one that needs a manager, not a technician.
   */
  tell(async () => {
    const staffUsers = c.assigneeStaffId ? await userOfStaff(societyId, String(c.assigneeStaffId)) : [];
    const to = staffUsers.length ? staffUsers : await usersOfCommittee(societyId);
    await notify({
      societyId, userIds: withoutTheAccused(excluding(to, actor.userId), c),
      kind: 'COMPLAINT_COMMENT',
      title: 'A message about a complaint',
      body: `${c.ticketCode}${c.flatLabel ? ` — ${c.flatLabel}` : ''}: ${note.trim()}`,
      link: `/dashboard/complaints/${c._id}`,
      entityType: 'Complaint', entityId: String(c._id),
    });
  });
  return c;
}

/**
 * Staff talking to staff, where the household cannot read it.
 *
 * `isInternal` has been on `ComplaintEvent` from the start and `detail` has
 * always stripped internal events from residents — but the ONLY writer was this
 * service's own automatic commentary. A manager had no way to record "the owner
 * is abroad until the 12th, stop sending the plumber" without the owner reading
 * it, so that kind of thing lived on WhatsApp and left the ticket looking
 * untouched.
 *
 * The resident-facing counterpart is `respond`, which is the one that says
 * something to the flat and stops the first-reply clock. Two boxes, two
 * audiences, named — rather than the one shared textarea feeding four verbs
 * that §IV-1.6 records people sending replies with by accident.
 */
export async function internalNote(
  societyId: string, id: string, note: string, photoKeys: string[] | undefined,
  actor: Actor, opts: ListOpts = {},
): Promise<IComplaint> {
  if (!note?.trim()) throw new ComplaintError('An empty note records nothing.');
  const c = await actable(societyId, id, opts);
  must(c, c.status, 'note', opts);
  await log(societyId, c._id, 'NOTE', actor, note.trim(),
    { internal: true, photoKeys: ourPhotoKeys(photoKeys) });
  // No notification, on purpose. An internal note is a scratchpad; pushing it
  // would make staff stop writing them, which is how the channel dies.
  return c;
}

export interface ComplaintPhoto {
  key: string;
  /** A signed link, good for five minutes. The bucket is private. */
  url: string;
  /** Where it came from, so the gallery can caption it. */
  source: 'RAISED' | 'EVENT';
  at: Date;
  byName: string;
  caption?: string;
}

/**
 * Every photograph on this complaint that THIS caller may see.
 *
 * Two rules, and the second is the one that would have leaked:
 *
 *   1. **The complaint itself is scoped by `detail`.** Not re-implemented —
 *      called. A photo endpoint with its own idea of who may read a ticket is
 *      exactly the drift that let `detail` and `list` disagree for months, and
 *      here the consequence is a photograph of the inside of somebody's flat.
 *
 *   2. **Internal events are filtered before signing, not after.** `detail`
 *      already strips them for residents, so this reads the filtered list it
 *      returns rather than the raw events. Signing first and hiding later would
 *      hand a resident a working URL to the picture attached to a note about
 *      them.
 *
 * Links are minted per request and expire in five minutes, so a URL copied out
 * of a browser's network tab is worthless by the time it is pasted anywhere.
 */
export async function photoUrls(societyId: string, id: string, opts: ListOpts = {}): Promise<ComplaintPhoto[]> {
  const { complaint, events } = await detail(societyId, id, opts);

  const wanted: Omit<ComplaintPhoto, 'url'>[] = [
    ...(complaint.photoKeys || []).map(key => ({
      key, source: 'RAISED' as const, at: complaint.createdAt, byName: complaint.raisedByName,
      caption: 'When it was reported',
    })),
    ...events.flatMap(e => (e.photoKeys || []).map(key => ({
      key, source: 'EVENT' as const, at: e.createdAt, byName: e.byName,
      caption: e.type === 'WORK_DONE' ? 'After the work' : e.note || undefined,
    }))),
  ];

  // Signing is a network call per object, so they go together rather than in a
  // loop — a ticket with six photos would otherwise take six round trips before
  // the gallery could render anything.
  return Promise.all(wanted.map(async p => ({
    ...p,
    url: await s3Service.getSignedDownloadUrl(p.key, { expiresIn: 5 * 60 }),
  })));
}

export async function rate(societyId: string, id: string, rating: number, feedback: string | undefined, actor: Actor, opts: ListOpts = {}) {
  const c = await actable(societyId, id, opts);
  must(c, c.status, 'rate', opts);
  c.rating = Math.max(1, Math.min(5, Math.round(rating)));
  c.feedback = feedback;
  await c.save();
  await log(societyId, c._id, 'RATED', actor, feedback);
  return c;
}

// ------------------------------------------------------------------- reading

export interface ListOpts {
  residentFlatIds?: string[];
  /**
   * How much of each flat's history belongs to this reader — H-12.
   *
   * Keyed by flat id; a flat with no entry has no bound, which is what an owner
   * living in their own home has. A tenant has one, and it is what stops them
   * inheriting the previous tenant's correspondence with the committee along
   * with the keys. The household half of the same rule is applied where the
   * list is built (`readerFlatScope` in the controller): a landlord's let flat
   * never reaches `residentFlatIds` at all.
   */
  residentTenure?: Record<string, { from?: Date; to?: Date }>;
  access?: EffectiveAccess;
  /** Staff who may only see what was given to them. */
  ownStaffId?: string;
  /** Whether this reader may see conduct complaints at all. */
  canSeeConduct?: boolean;
  /** Their own userId, so a conduct complaint about them is hidden even so. */
  viewerStaffId?: string;
  /** The caller. Used to let somebody act on a complaint they raised themselves. */
  userId?: string;
  /** Whether this reader may act on anything in the society (COMPLAINTS_MANAGE). */
  canManage?: boolean;
  /** Wing scope, when the caller is limited to some blocks. */
  blockIds?: string[];
}

/**
 * The conduct clauses, in one place because list, detail and the escalation
 * queue must answer them identically — and did not.
 *
 * Two rules, and they point in opposite directions, which is why they kept
 * being got wrong:
 *
 *   **The raiser always sees their own.** `list` forced `kind: 'SERVICE'` for
 *   anybody without the conduct permission, and `detail` 404'd. So a resident
 *   who filed a conduct complaint watched it vanish the instant they pressed
 *   send — no row, no ticket number, no way to check on it, and no
 *   notification either. From the resident's side that is indistinguishable
 *   from the software throwing it away, which is what it looked like it had.
 *
 *   **The accused never sees it**, even holding the permission — and the
 *   accused is very often a committee member holding exactly that permission.
 */
function conductClauses(opts: ListOpts): any[] {
  const clauses: any[] = [];

  if (!opts.canSeeConduct) {
    clauses.push(opts.userId
      ? { $or: [{ kind: 'SERVICE' }, { kind: 'CONDUCT', raisedByUserId: oid(opts.userId) }] }
      : { kind: 'SERVICE' });
  }

  const notAbout: any[] = [];
  if (opts.viewerStaffId) {
    notAbout.push({ kind: 'CONDUCT', aboutStaffId: oid(opts.viewerStaffId) });
    // Kept from the original guard. It never fired, because conduct complaints
    // are never routed by trade and so never have an assignee — but a manager
    // CAN now be refused for trying, and a legacy row may still carry one.
    notAbout.push({ kind: 'CONDUCT', assigneeStaffId: oid(opts.viewerStaffId) });
  }
  if (opts.userId) notAbout.push({ kind: 'CONDUCT', aboutUserId: oid(opts.userId) });
  if (notAbout.length) clauses.push({ $nor: notAbout });

  return clauses;
}

/**
 * The two query fields a caller controls, made into strings.
 *
 * Express's `qs` parser turns `?status[$ne]=CLOSED` into an OBJECT, and these
 * were assigned into the Mongo filter raw with no schema on the route — so that
 * one query string returned every complaint in the society to a resident. The
 * route now validates as well; this is the second lock, because the service is
 * also called from scripts and from the escalation queue.
 */
const asPlainString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

export async function list(societyId: string, query: any, opts: ListOpts = {}) {
  const filter: any = { societyId: oid(societyId) };
  filter.$and = conductClauses(opts);

  if (opts.residentFlatIds) {
    /**
     * A resident sees their own household's complaints, plus anything raised
     * for the whole community — which is what "community" means — plus
     * anything they raised themselves.
     *
     * Each flat carries its own date window (H-12), so the clause is built per
     * flat rather than with one `$in`: the previous tenant's complaints are on
     * the same `flatId` as this tenant's, and only the date separates them.
     *
     * The last clause is the escape hatch, and it is not a convenience. Without
     * it the two clamps above would take a complaint away from the person who
     * filed it the moment their tenancy ended or their flat was let — they
     * would be told a ticket number for something they can no longer open.
     */
    const own: any[] = opts.residentFlatIds.map(f => {
      const window = opts.residentTenure?.[String(f)];
      const range: any = {};
      if (window?.from) range.$gte = window.from;
      if (window?.to) range.$lte = window.to;
      return Object.keys(range).length ? { flatId: oid(f), createdAt: range } : { flatId: oid(f) };
    });
    own.push({ visibility: 'COMMUNITY' });
    if (opts.userId) own.push({ raisedByUserId: oid(opts.userId) });

    filter.$and = [...(filter.$and || []), { $or: own }];
  } else if (opts.ownStaffId) {
    filter.assigneeStaffId = oid(opts.ownStaffId);
  }

  if (opts.access && !opts.access.isAdmin && !opts.access.scope.allBlocks) {
    filter.$and = [
      ...(filter.$and || []),
      { $or: [{ blockId: { $in: opts.access.scope.blockIds.map(oid) } }, { blockId: { $exists: false } }] },
    ];
  }

  const wantStatus = asPlainString(query.status);
  const wantCategory = asPlainString(query.category);
  // Only a status the model actually has. An unknown one would return nothing
  // and read as "you have no complaints", which is worse than an error.
  if (wantStatus && ALL_STATUSES.includes(wantStatus as ComplaintStatus)) filter.status = wantStatus;
  if (wantCategory) filter.category = wantCategory;
  if (query.open === 'true') filter.status = { $nin: ['CLOSED', 'REJECTED'] };
  if (asPlainString(query.q)) {
    const rx = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    // Into `$and`, not onto `filter.$or` — a top-level `$or` here would have
    // been silently overwritten by, or would silently overwrite, the wing and
    // household clauses the moment either of them started using one.
    filter.$and.push({ $or: [{ title: rx }, { ticketCode: rx }, { flatLabel: rx }] });
  }

  if (!filter.$and.length) delete filter.$and;

  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));

  const [rows, total] = await Promise.all([
    Complaint.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Complaint.countDocuments(filter),
  ]);
  return { rows, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
}

/**
 * One complaint, and the exact list of things this viewer may do to it.
 *
 * `list` applied four rules — conduct, household, wing, own-queue — and this
 * applied two. So any employee, and any wing-scoped committee member, could
 * read ANY complaint in the society by id, including every internal note on it,
 * because the internal-note filter keys on being a resident. An id is guessable
 * from a notification link, a screenshot, or simply by having once been
 * assigned the ticket. The two lists are now the same four rules in the same
 * order, and a mismatch between them is the bug to look for first.
 */
export async function detail(societyId: string, id: string, opts: ListOpts = {}) {
  const c = await Complaint.findOne({ _id: id, societyId: oid(societyId) }).lean();
  // A 404 rather than a 403 throughout: confirming an id exists is itself a leak.
  const gone = () => new ComplaintError('That complaint could not be found.', 404);
  if (!c) throw gone();

  const raisedIt = !!opts.userId && String(c.raisedByUserId || '') === String(opts.userId);

  if (c.kind === 'CONDUCT') {
    // The raiser always gets their own back. Without this exception a resident
    // who reports a staff member is shown nothing at all, forever.
    if (!opts.canSeeConduct && !raisedIt) throw gone();
    // ...and the accused never, permission or no permission.
    if (isTheAccused(c as any, opts.viewerStaffId, opts.userId)) throw gone();
  }

  // The household boundary, in the same words as `list` — the landlord of a let
  // flat is not its household, and a tenant's slice starts on the day they
  // moved in. `raisedIt` is what survives both (H-12).
  if (opts.residentFlatIds && c.visibility !== 'COMMUNITY') {
    if (!inHousehold(opts, c as any) && !raisedIt) throw gone();
  }

  // Wing scope — `list` has always applied this and `detail` never did.
  if (opts.blockIds && c.blockId && !opts.blockIds.some(b => String(b) === String(c.blockId))) {
    throw gone();
  }

  // Own-queue scope, mirroring `list`'s `assigneeStaffId` clamp. A technician
  // holding only COMPLAINTS_OWN sees the jobs given to them, plus anything they
  // reported themselves — nothing else, and certainly not its internal notes.
  if (opts.ownStaffId && String(c.assigneeStaffId || '') !== String(opts.ownStaffId) && !raisedIt) {
    throw gone();
  }

  const events = await ComplaintEvent.find({ complaintId: c._id })
    .sort({ createdAt: 1 }).lean();

  // A resident does not see the internal running commentary.
  const visible = opts.residentFlatIds ? events.filter(e => !e.isInternal) : events;

  /**
   * What the server will actually accept, computed by the server.
   *
   * The frontend used to decide this from its own conditions, and got it
   * wrong in both directions: it offered a resident Reply, Put on hold, Work is
   * done and the whole manage panel — four to seven controls, every one of them
   * a guaranteed 403 — while hiding verbs a manager did have. There is now one
   * answer to "what can I do here", it is this, and it comes from the same
   * table the verbs above enforce.
   */
  const actor = roleOn(c as any, opts);
  return {
    complaint: c,
    events: visible,
    can: allowedVerbs(
      { status: c.status, kind: c.kind, visibility: c.visibility, pauseCount: c.pauseCount || 0 },
      actor,
    ),
    viewerIs: actor,
  };
}

// ---------------------------------------------------------------- escalation

export interface EscalationStep { level: number; afterMinutes: number; label: string }

/**
 * Four rungs, and the last one is not ours.
 *
 * L4 does not act — it reminds the committee that Indian law expects a member's
 * complaint to be answered inside fifteen days, after which they may go to the
 * Registrar or a consumer forum. Naming that in the product is more pressure
 * than any internal reminder.
 */
/**
 * Four rungs, and the last one is not ours.
 *
 * L4 does not act — it reminds the committee that Indian law expects a member's
 * complaint to be answered inside fifteen days, after which they may go to the
 * Registrar or a consumer forum. Naming that in the product is more pressure
 * than any internal reminder.
 *
 * ⚠️ The thresholds are read with `.filter(...).slice(-1)` — LAST match wins —
 * so two rungs sharing a threshold makes the earlier one unreachable. Levels 1
 * and 2 were both `afterMinutes: 0`, which meant nothing in this product ever
 * sat at level 1: the very first escalation of every complaint jumped straight
 * past the person actually holding it and landed on the manager. The rung that
 * says "the technician has been reminded" existed on paper only. Keep these
 * strictly increasing.
 */
export const ESCALATION_LADDER: EscalationStep[] = [
  { level: 1, afterMinutes: 0, label: 'With the person doing the work' },
  { level: 2, afterMinutes: 1440, label: 'Raised to the manager' },
  { level: 3, afterMinutes: 3 * 1440, label: 'Raised to the committee' },
  { level: 4, afterMinutes: 15 * 1440, label: 'Fifteen days — a member may now go to the Registrar' },
];

/** Once a complaint has climbed a rung, it does not climb again for this long. */
const ESCALATION_COOLDOWN_MS = 60 * 60_000;

/** Which clock was missed. Read by the wording of the message that goes out. */
export type BreachKind = 'FIRST_RESPONSE' | 'RESOLUTION' | 'HELD_TOO_LONG';

/**
 * Everything overdue that has not yet been pushed to the next rung.
 *
 * Three defects lived in this one query:
 *
 * **The first-response clock was never swept.** `firstResponseDueAt` is written
 * on every complaint at raise, adjusted on every resume, and was read by
 * nothing but a retrospective report. So the promise residents actually judge a
 * society by — "somebody will get back to you within the hour" — could be
 * missed by three days and no human was ever told. It is half the SLA and it
 * was decorative.
 *
 * **`WORK_DONE` kept escalating.** The exclusion list named RESOLVED, CLOSED,
 * REJECTED and ON_HOLD but not WORK_DONE, so a ticket the technician had
 * finished — sitting there waiting for the resident to press "yes, it is fixed"
 * — was escalated to the committee as "the staff are late". That is a false
 * accusation against the one person who did their job, and it arrives by push.
 *
 * **A hold ran forever.** ON_HOLD is excluded, which is right for a day and
 * wrong for a month: past the cap, the hold has stopped being an explanation
 * and become the problem, so it comes back into this queue rather than sitting
 * outside every report there is.
 *
 * `opts` is omitted by the nightly sweep — the software has no wing and no
 * permissions of its own. It is supplied by `GET /escalations`, where anybody
 * with COMPLAINTS_MANAGE: READ was reading the titles of overdue CONDUCT
 * complaints regardless of wing.
 */
export async function findEscalations(
  societyId: string, at = new Date(), opts?: ListOpts, limits: PauseLimits = PAUSE_LIMITS,
) {
  const heldSince = new Date(at.getTime() - limits.maxHours * 3_600_000);

  const clauses: any[] = [
    {
      $or: [
        // The fix clock.
        { status: { $nin: DONE_STATUSES }, resolutionDueAt: { $lt: at } },
        // The reply clock — only while there has been no reply at all.
        {
          status: { $nin: DONE_STATUSES },
          firstRespondedAt: { $exists: false },
          firstResponseDueAt: { $lt: at },
        },
        // A hold that has outlived its cap.
        { status: 'ON_HOLD', pausedAt: { $lt: heldSince } },
      ],
    },
    // Do not re-escalate something escalated within the last hour. Without this
    // the hourly sweep marches a badly-overdue complaint 1→2→3→4 in three
    // hours and buries the committee under repeats of the same ticket.
    {
      $or: [
        { lastEscalatedAt: { $exists: false } },
        { lastEscalatedAt: { $lt: new Date(at.getTime() - ESCALATION_COOLDOWN_MS) } },
      ],
    },
  ];

  if (opts) {
    clauses.push(...conductClauses(opts));
    const blockIds = opts.blockIds
      || (opts.access && !opts.access.isAdmin && !opts.access.scope.allBlocks ? opts.access.scope.blockIds : undefined);
    if (blockIds) {
      clauses.push({ $or: [{ blockId: { $in: blockIds.map(oid) } }, { blockId: { $exists: false } }] });
    }
  }

  const rows = await Complaint.find({ societyId: oid(societyId), $and: clauses })
    .select('ticketCode title kind category blockName escalationLevel resolutionDueAt firstResponseDueAt '
      + 'firstRespondedAt pausedAt status priority createdAt lastEscalatedAt aboutStaffId aboutUserId')
    .lean();

  return rows.map(r => {
    const missedFix = !!r.resolutionDueAt && r.resolutionDueAt < at && !DONE_STATUSES.includes(r.status);
    const missedReply = !r.firstRespondedAt && !!r.firstResponseDueAt && r.firstResponseDueAt < at
      && !DONE_STATUSES.includes(r.status);
    // Named for the WORSE miss. A ticket that blew both clocks is a ticket
    // nobody fixed, and reporting it as a late reply understates it.
    const breach: BreachKind = missedFix ? 'RESOLUTION' : missedReply ? 'FIRST_RESPONSE' : 'HELD_TOO_LONG';
    const against = breach === 'RESOLUTION' ? r.resolutionDueAt
      : breach === 'FIRST_RESPONSE' ? r.firstResponseDueAt
        : r.pausedAt;
    const overdueMinutes = Math.max(0, Math.floor((at.getTime() - (against || at).getTime()) / 60_000));
    const ageMinutes = Math.floor((at.getTime() - r.createdAt.getTime()) / 60_000);
    // An emergency skips straight past the lower rungs — a burst pipe cannot
    // wait its turn behind a queue designed for a leaking tap.
    const target = r.priority === 'EMERGENCY'
      ? Math.max(3, r.escalationLevel + 1)
      : ESCALATION_LADDER.filter(s => ageMinutes >= s.afterMinutes).slice(-1)[0]?.level ?? 1;
    return { ...r, breach, overdueMinutes, suggestedLevel: Math.max(target, r.escalationLevel + 1) };
  }).filter(r => r.suggestedLevel > r.escalationLevel && r.suggestedLevel <= 4);
}

/**
 * Finished, for the purposes of "is anybody still waiting on this?"
 *
 * WORK_DONE is deliberately IN this list even though the ticket is still open:
 * the work is done and the wait belongs to the resident, so no amount of
 * elapsed time is the staff's fault. It is counted separately, as
 * `awaitingConfirmation`, which is the number that should actually be chased.
 */
const DONE_STATUSES = ['RESOLVED', 'CLOSED', 'REJECTED', 'ON_HOLD', 'WORK_DONE'];

/**
 * Escalate everything that is overdue, across every society.
 *
 * `findEscalations` and `applyEscalation` were both correct and both dead —
 * `applyEscalation`'s only caller in the whole repo was a verify script, and no
 * cron ever ran the sweep. So `escalationLevel` never left 0 in production and
 * the committee was never told about an overdue complaint. This is the missing
 * caller.
 *
 * A system actor stands in for "the software decided", the same shape the gate
 * timeout sweep already uses.
 */
export async function sweepEscalations(societyId: string, at = new Date()): Promise<number> {
  const due = await findEscalations(societyId, at);
  const actor: Actor = { userId: SYSTEM_ACTOR_ID, userName: 'System' };
  let escalated = 0;
  for (const row of due) {
    try {
      await applyEscalation(societyId, String(row._id), row.suggestedLevel, actor, undefined, row.breach);
      escalated++;
    } catch (e: any) {
      logger.error(`Could not escalate ${row.ticketCode}: ${e.message}`);
    }
  }
  return escalated;
}

/** A stable id for actions the software itself takes. */
const SYSTEM_ACTOR_ID = '000000000000000000000000';

/**
 * @param opts  Omitted by the nightly sweep, which is the software acting with
 *              no wing of its own. Supplied by the manual "send it up" button,
 *              where the caller's wing scope must apply — it was being dropped,
 *              so a wing-scoped member could escalate another wing's work.
 */
export async function applyEscalation(
  societyId: string, id: string, level: number, actor: Actor, opts?: ListOpts,
  breach: BreachKind = 'RESOLUTION',
) {
  const c = opts ? await actable(societyId, id, opts) : await mine(societyId, id);
  c.escalationLevel = level;
  c.lastEscalatedAt = new Date();
  await c.save();
  const step = ESCALATION_LADDER.find(s => s.level === level);
  await log(societyId, c._id, 'ESCALATED', actor, `${step?.label}${BREACH_NOTE[breach]}`, { internal: true });

  // An escalation nobody is told about is just a number changing in a database.
  // This is the rung where the committee is supposed to find out, so it is the
  // one notification here marked HIGH.
  tell(async () => {
    /**
     * A conduct complaint is titled with a person's name, so it does not get
     * broadcast with its title on it.
     *
     * The sweep had no `kind` filter at all: an overdue conduct complaint
     * arrived as a HIGH-priority push, an in-app row and an email in every
     * serving committee member's inbox, carrying the accused's name, and stayed
     * there for ninety days. Including — when the complaint was ABOUT a
     * committee member — in theirs.
     */
    const conduct = c.kind === 'CONDUCT';
    const to = withoutTheAccused(await usersOfCommittee(societyId), c);
    await notify({
      societyId,
      userIds: to,
      kind: 'COMPLAINT_ESCALATED',
      title: `Overdue: ${step?.label || `level ${level}`}`,
      body: conduct
        ? `A conduct complaint has passed its promised time${BREACH_NOTE[breach]}. Open it to read it.`
        : `${c.title}${c.blockName ? ` — ${c.blockName}` : ''} has passed its promised time${BREACH_NOTE[breach]}.`,
      link: `/dashboard/complaints?id=${c._id}`,
      entityType: 'Complaint', entityId: String(c._id),
      priority: 'HIGH',
      emailIfUnreachable: true,
    });
  });
  return c;
}

/** Which promise was broken, said plainly enough to act on. */
const BREACH_NOTE: Record<BreachKind, string> = {
  RESOLUTION: '',
  FIRST_RESPONSE: ' — nobody has even replied yet',
  HELD_TOO_LONG: ' — it has been on hold too long',
};

// ------------------------------------------------------------------- reports

export interface ComplaintStats {
  open: number;
  overdue: number;
  awaitingConfirmation: number;
  unassigned: number;
  reopenRate: number;
  medianResolutionMinutes: number | null;
  /**
   * The mean, on the SAME basis as the median above — paused time excluded.
   *
   * Published so the two "how long do we take" figures in this product stop
   * contradicting each other. `gate-depth.service`'s `avgResolutionMinutes` used
   * to measure raw `createdAt → resolvedAt` with no subtraction, so a society
   * reading the operations report and the complaints dashboard on the same
   * afternoon was told two different numbers about the same tickets, and the
   * bigger one included every hour a flat was locked and nobody could work.
   *
   * That side now subtracts `totalPausedMs` too. Both figures are on this basis
   * and must stay on it: a figure that counts a delay nobody could act on is
   * not a measure of the society's speed, it is a measure of how often
   * residents are out.
   */
  avgResolutionMinutes: number | null;
}

/**
 * "Open" means nobody has finished with it — WORK_DONE belongs here, because
 * the resident has not confirmed and the ticket is still live.
 */
const OPEN_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED', 'WORK_DONE'];

/**
 * "Overdue" means something narrower, and this is the same defect the
 * escalation sweep had.
 *
 * A WORK_DONE ticket is waiting on the RESIDENT. Counting it as overdue puts a
 * red number on the committee's dashboard that blames the staff for a delay
 * that is not theirs, and it double-counts against `awaitingConfirmation`
 * immediately beside it. On hold was already excluded for exactly this reason;
 * WORK_DONE was simply missed.
 */
const CHASEABLE_STATUSES = OPEN_STATUSES.filter(s => s !== 'WORK_DONE' && s !== 'ON_HOLD');

/**
 * Median, not mean — and one round trip, not a full scan.
 *
 * The median is the right statistic: one ticket left open for ninety days
 * destroys an average and tells you nothing about the typical experience.
 *
 * The AGGREGATION is the fix for H-17. This used to be
 * `find({ societyId })` with no limit, no projection worth the name and six
 * separate JavaScript passes over every complaint the society has ever filed —
 * called from `/options`, which the screen re-fetched after every single button
 * click. Nine actions on one ticket meant nine full collection scans and
 * thirty-six requests. A society three years in has tens of thousands of rows,
 * all of them crossing the wire into the API process to be counted there.
 *
 * `$facet` asks the same six questions in one pass inside the database, and
 * returns six numbers. The definitions below are deliberately identical to the
 * ones they replace — including the median's `floor(n/2)` index, which is the
 * upper of the two middles on an even-sized list and is kept exactly so the
 * figure does not move under a society that has been reading it.
 */
export async function stats(societyId: string, at = new Date()): Promise<ComplaintStats> {
  const [facets] = await Complaint.aggregate([
    { $match: { societyId: oid(societyId), kind: 'SERVICE' } },
    {
      $facet: {
        total: [{ $count: 'n' }],
        open: [{ $match: { status: { $in: OPEN_STATUSES } } }, { $count: 'n' }],
        overdue: [
          { $match: { status: { $in: CHASEABLE_STATUSES }, resolutionDueAt: { $lt: at } } },
          { $count: 'n' },
        ],
        awaiting: [{ $match: { status: 'WORK_DONE' } }, { $count: 'n' }],
        // `null` matches missing AND null in Mongo, which is what the old
        // `!r.assigneeStaffId` meant. `$exists: false` alone would miss a row
        // that was explicitly unassigned by `assignTo`.
        unassigned: [
          { $match: { status: { $in: OPEN_STATUSES }, assigneeStaffId: null, assigneeVendorId: null } },
          { $count: 'n' },
        ],
        reopened: [{ $match: { reopenCount: { $gt: 0 } } }, { $count: 'n' }],
        durations: [
          { $match: { resolvedAt: { $ne: null } } },
          {
            $project: {
              // Paused time is excluded, so the figure measures how long WE took.
              minutes: {
                $divide: [
                  { $subtract: [{ $subtract: ['$resolvedAt', '$createdAt'] }, { $ifNull: ['$totalPausedMs', 0] }] },
                  60_000,
                ],
              },
            },
          },
          // A negative span means the pause total outran the elapsed time —
          // impossible unless a clock moved, and it was dropped before too.
          { $match: { minutes: { $gte: 0 } } },
          { $sort: { minutes: 1 } },
          { $group: { _id: null, all: { $push: '$minutes' }, avg: { $avg: '$minutes' }, n: { $sum: 1 } } },
          {
            $project: {
              avg: 1,
              median: { $arrayElemAt: ['$all', { $floor: { $divide: ['$n', 2] } }] },
            },
          },
        ],
      },
    },
  ]);

  const n = (key: string) => facets?.[key]?.[0]?.n || 0;
  const spans = facets?.durations?.[0];
  const total = n('total');

  return {
    open: n('open'),
    overdue: n('overdue'),
    awaitingConfirmation: n('awaiting'),
    unassigned: n('unassigned'),
    reopenRate: total ? Math.round((n('reopened') / total) * 100) : 0,
    medianResolutionMinutes: spans ? Math.round(spans.median) : null,
    avgResolutionMinutes: spans ? Math.round(spans.avg) : null,
  };
}

/** Complaints raised against one piece of equipment — the repair-or-replace case. */
export async function assetHistory(societyId: string, assetId: string) {
  return Complaint.find({ societyId: oid(societyId), assetId: oid(assetId) })
    .select('ticketCode title status createdAt resolvedAt assigneeVendorName')
    .sort({ createdAt: -1 }).lean();
}
