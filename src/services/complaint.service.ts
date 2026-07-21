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
import { usersOfFlat, userOfStaff, usersOfCommittee, excluding } from './notify-recipients';
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

async function nextTicketCode(societyId: string): Promise<string> {
  const count = await Complaint.countDocuments({ societyId: oid(societyId) });
  return `CMP/${String(count + 1).padStart(5, '0')}`;
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
}

export async function raise(societyId: string, input: RaiseInput, actor: Actor): Promise<IComplaint> {
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

  let flat: any = null;
  if (input.flatId) {
    flat = await Flat.findOne({ _id: input.flatId, societyId: oid(societyId) })
      .select('number blockName blockId').lean();
    if (!flat) throw new ComplaintError('That flat does not belong to this society.');
  }

  const blockId = flat?.blockId || asset?.blockId || (input.blockId ? oid(input.blockId) : undefined);
  const kind = input.kind === 'CONDUCT' ? 'CONDUCT' : 'SERVICE';
  const now = new Date();

  const firstResponseMinutes = cat?.firstResponseMinutes ?? 240;
  const resolutionMinutes = cat?.resolutionMinutes ?? 2880;

  const complaint = await Complaint.create({
    societyId: oid(societyId),
    ticketCode: await nextTicketCode(societyId),
    kind,
    title: input.title.trim(),
    description: input.description,
    photoKeys: input.photoKeys || [],
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
    firstResponseDueAt: new Date(now.getTime() + firstResponseMinutes * 60_000),
    resolutionDueAt: new Date(now.getTime() + resolutionMinutes * 60_000),
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

  return complaint;
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
  societyId: string, id: string, staffId: string | null, actor: Actor,
): Promise<IComplaint> {
  const c = await mine(societyId, id);
  if (staffId) {
    const staff = await SocietyStaff.findOne({ _id: staffId, societyId: oid(societyId), isActive: true })
      .select('person.name').lean();
    if (!staff) throw new ComplaintError('That staff member is unknown to this society or has left.');
    c.assigneeStaffId = oid(staffId);
    c.assigneeName = staff.person.name;
    c.routedVia = 'MANUAL';
    if (c.status === 'NEW') c.status = 'ASSIGNED';
  } else {
    c.assigneeStaffId = undefined;
    c.assigneeName = undefined;
    // Only rewind to NEW from ASSIGNED. Unassigning an IN_PROGRESS or WORK_DONE
    // ticket used to silently reset it to NEW, erasing that work had begun —
    // exactly the ADDA failure this module's header claims to avoid. Work that
    // has started stays in its state; it just no longer has a name on it.
    if (c.status === 'ASSIGNED') c.status = 'NEW';
  }
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

  // A resident: their own flat, or one they raised themselves.
  if (opts.residentFlatIds) {
    const ownFlat = c.flatId && opts.residentFlatIds.some(f => String(f) === String(c.flatId));
    const raisedIt = opts.userId && String(c.raisedByUserId || '') === String(opts.userId);
    if (ownFlat || raisedIt) return c;
  }

  // 404 rather than 403 — the same reasoning as `detail`: confirming that an
  // id exists is itself a small leak.
  throw new ComplaintError('That complaint could not be found.', 404);
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
export async function respond(societyId: string, id: string, note: string, actor: Actor, opts: ListOpts = {}): Promise<IComplaint> {
  const c = await actable(societyId, id, opts);
  if (!c.firstRespondedAt) c.firstRespondedAt = new Date();
  if (c.status === 'NEW' || c.status === 'ASSIGNED') c.status = 'IN_PROGRESS';
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'RESPONDED', actor, note);
  tell(() => tellTheFlat(societyId, c, actor, 'COMPLAINT_RESPONDED', 'Somebody has replied', note));
  return c;
}

/**
 * The person who raised it, and everyone else living in that flat.
 *
 * Both, deliberately: a tenant raises the leak, the owner is paying for it, and
 * a family member is the one actually at home when the plumber knocks. Falls
 * back to the raiser alone for a community complaint with no flat attached.
 */
async function tellTheFlat(
  societyId: string, c: IComplaint, actor: Actor,
  kind: string, title: string, body?: string,
) {
  const flatUsers = c.flatId ? await usersOfFlat(societyId, String(c.flatId)) : [];
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

export async function pause(societyId: string, id: string, reason: PauseReason, actor: Actor, opts: ListOpts = {}): Promise<IComplaint> {
  if (!(PAUSE_REASONS as readonly string[]).includes(reason)) {
    // A free-text reason would make every ticket pausable for anything, and the
    // pause would stop meaning something anybody could count.
    throw new ComplaintError('That is not one of the reasons work can be put on hold.');
  }
  const c = await mine(societyId, id);
  if (c.pausedAt) throw new ComplaintError('This is already on hold.');
  if (['RESOLVED', 'CLOSED', 'REJECTED'].includes(c.status)) throw new ComplaintError('This is already finished.');

  c.pausedAt = new Date();
  c.pauseReason = reason;
  c.status = 'ON_HOLD';
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'PAUSED', actor, reason);
  return c;
}

export async function resume(societyId: string, id: string, actor: Actor, opts: ListOpts = {}): Promise<IComplaint> {
  const c = await actable(societyId, id, opts);
  if (!c.pausedAt) throw new ComplaintError('This is not on hold.');

  const paused = Date.now() - c.pausedAt.getTime();
  c.totalPausedMs += paused;
  // Push the deadlines out by exactly the time nobody could work. Without this
  // the pause would be a label with no effect on the only number that matters.
  if (c.firstResponseDueAt) c.firstResponseDueAt = new Date(c.firstResponseDueAt.getTime() + paused);
  if (c.resolutionDueAt) c.resolutionDueAt = new Date(c.resolutionDueAt.getTime() + paused);
  c.pausedAt = undefined;
  c.pauseReason = undefined;
  c.status = 'IN_PROGRESS';
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'RESUMED', actor, `On hold for ${Math.round(paused / 60_000)} minutes`);
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
  if (['RESOLVED', 'CLOSED', 'REJECTED'].includes(c.status)) throw new ComplaintError('This is already finished.');
  if (c.pausedAt) throw new ComplaintError('This is on hold — take it off hold first.');

  c.status = 'WORK_DONE';
  if (!c.firstRespondedAt) c.firstRespondedAt = new Date();
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'WORK_DONE', actor, note, { photoKeys });
  // The one notification the whole design turns on: nothing closes until the
  // resident says so, so they have to be asked, and asked reliably.
  tell(() => tellTheFlat(societyId, c, actor, 'COMPLAINT_WORK_DONE',
    'Please confirm this is fixed', note || 'The work is reported done'));
  return c;
}

/** The resident, or a manager on their behalf, confirms it is actually fixed. */
export async function resolve(societyId: string, id: string, actor: Actor, opts: ListOpts = {}): Promise<IComplaint> {
  const c = await actable(societyId, id, opts);
  if (c.status === 'CLOSED') throw new ComplaintError('This is already closed.');
  // A complaint nobody has touched cannot be "resolved". The WORK_DONE step
  // exists precisely so the person who did the work does not also declare it
  // fixed — jumping NEW → RESOLVED skipped that and let a brand-new ticket
  // count as solved in the stats.
  if (c.status === 'NEW') {
    throw new ComplaintError('Nobody has worked on this yet — it cannot be marked resolved.');
  }
  c.status = 'RESOLVED';
  c.resolvedAt = new Date();
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'RESOLVED', actor);
  return c;
}

export async function close(societyId: string, id: string, actor: Actor, opts: ListOpts = {}): Promise<IComplaint> {
  const c = await actable(societyId, id, opts);
  if (c.status === 'CLOSED') throw new ComplaintError('This is already closed.');
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
  if (!['WORK_DONE', 'RESOLVED', 'CLOSED'].includes(c.status)) {
    throw new ComplaintError('This is still open — there is nothing to reopen.');
  }

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
  c.updatedBy = oid(actor.userId); c.updatedByName = actor.userName;
  await c.save();
  await log(societyId, c._id, 'REOPENED', actor, reason);
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
  if (c.visibility !== 'COMMUNITY') throw new ComplaintError('You can only join a community complaint.');
  const uid = oid(actor.userId);
  if (c.meTooUserIds.some(u => String(u) === String(uid))) return c;

  c.meTooUserIds.push(uid);
  await c.save();
  await log(societyId, c._id, 'ME_TOO', actor);
  return c;
}

export async function rate(societyId: string, id: string, rating: number, feedback: string | undefined, actor: Actor, opts: ListOpts = {}) {
  const c = await actable(societyId, id, opts);
  if (!['RESOLVED', 'CLOSED'].includes(c.status)) throw new ComplaintError('Rate it once it is finished.');
  c.rating = Math.max(1, Math.min(5, Math.round(rating)));
  c.feedback = feedback;
  await c.save();
  await log(societyId, c._id, 'RATED', actor, feedback);
  return c;
}

// ------------------------------------------------------------------- reading

export interface ListOpts {
  residentFlatIds?: string[];
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

export async function list(societyId: string, query: any, opts: ListOpts = {}) {
  const filter: any = { societyId: oid(societyId) };

  // Conduct complaints are invisible unless explicitly granted — and even then
  // never to the person they are about.
  if (!opts.canSeeConduct) {
    filter.kind = 'SERVICE';
  } else if (opts.viewerStaffId) {
    filter.$nor = [{ kind: 'CONDUCT', assigneeStaffId: oid(opts.viewerStaffId) }];
  }

  if (opts.residentFlatIds) {
    // A resident sees their own flat's complaints, plus anything raised for the
    // whole community — which is what "community" means.
    filter.$and = [
      ...(filter.$and || []),
      { $or: [{ flatId: { $in: opts.residentFlatIds.map(oid) } }, { visibility: 'COMMUNITY' }] },
    ];
  } else if (opts.ownStaffId) {
    filter.assigneeStaffId = oid(opts.ownStaffId);
  }

  if (opts.access && !opts.access.isAdmin && !opts.access.scope.allBlocks) {
    filter.$and = [
      ...(filter.$and || []),
      { $or: [{ blockId: { $in: opts.access.scope.blockIds.map(oid) } }, { blockId: { $exists: false } }] },
    ];
  }

  if (query.status) filter.status = query.status;
  if (query.category) filter.category = query.category;
  if (query.open === 'true') filter.status = { $nin: ['CLOSED', 'REJECTED'] };
  if (query.q) {
    const rx = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: rx }, { ticketCode: rx }, { flatLabel: rx }];
  }

  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));

  const [rows, total] = await Promise.all([
    Complaint.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Complaint.countDocuments(filter),
  ]);
  return { rows, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
}

export async function detail(societyId: string, id: string, opts: ListOpts = {}) {
  const c = await Complaint.findOne({ _id: id, societyId: oid(societyId) }).lean();
  if (!c) throw new ComplaintError('That complaint could not be found.', 404);

  if (c.kind === 'CONDUCT' && !opts.canSeeConduct) {
    // A 404, not a 403: confirming one exists is itself a leak.
    throw new ComplaintError('That complaint could not be found.', 404);
  }
  if (opts.residentFlatIds && c.visibility !== 'COMMUNITY') {
    const mineFlat = opts.residentFlatIds.some(f => String(f) === String(c.flatId));
    if (!mineFlat) throw new ComplaintError('That complaint could not be found.', 404);
  }

  const events = await ComplaintEvent.find({ complaintId: c._id })
    .sort({ createdAt: 1 }).lean();

  // A resident does not see the internal running commentary.
  const visible = opts.residentFlatIds ? events.filter(e => !e.isInternal) : events;
  return { complaint: c, events: visible };
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
export const ESCALATION_LADDER: EscalationStep[] = [
  { level: 1, afterMinutes: 0, label: 'With the person doing the work' },
  { level: 2, afterMinutes: 0, label: 'Raised to the manager' },
  { level: 3, afterMinutes: 3 * 1440, label: 'Raised to the committee' },
  { level: 4, afterMinutes: 15 * 1440, label: 'Fifteen days — a member may now go to the Registrar' },
];

/** Overdue complaints that have not yet been pushed to the next rung. */
/** Once a complaint has climbed a rung, it does not climb again for this long. */
const ESCALATION_COOLDOWN_MS = 60 * 60_000;

export async function findEscalations(societyId: string, at = new Date()) {
  const rows = await Complaint.find({
    societyId: oid(societyId),
    status: { $nin: ['RESOLVED', 'CLOSED', 'REJECTED', 'ON_HOLD'] },
    resolutionDueAt: { $lt: at },
    // Do not re-escalate something escalated within the last hour. Without this
    // the hourly sweep marches a badly-overdue complaint 1→2→3→4 in three
    // hours and buries the committee under repeats of the same ticket.
    $or: [
      { lastEscalatedAt: { $exists: false } },
      { lastEscalatedAt: { $lt: new Date(at.getTime() - ESCALATION_COOLDOWN_MS) } },
    ],
  }).select('ticketCode title category blockName escalationLevel resolutionDueAt priority createdAt lastEscalatedAt').lean();

  return rows.map(r => {
    const overdueMinutes = Math.floor((at.getTime() - r.resolutionDueAt!.getTime()) / 60_000);
    const ageMinutes = Math.floor((at.getTime() - r.createdAt.getTime()) / 60_000);
    // An emergency skips straight past the lower rungs — a burst pipe cannot
    // wait its turn behind a queue designed for a leaking tap.
    const target = r.priority === 'EMERGENCY'
      ? Math.max(3, r.escalationLevel + 1)
      : ESCALATION_LADDER.filter(s => ageMinutes >= s.afterMinutes).slice(-1)[0]?.level ?? 2;
    return { ...r, overdueMinutes, suggestedLevel: Math.max(target, r.escalationLevel + 1) };
  }).filter(r => r.suggestedLevel > r.escalationLevel && r.suggestedLevel <= 4);
}

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
      await applyEscalation(societyId, String(row._id), row.suggestedLevel, actor);
      escalated++;
    } catch (e: any) {
      logger.error(`Could not escalate ${row.ticketCode}: ${e.message}`);
    }
  }
  return escalated;
}

/** A stable id for actions the software itself takes. */
const SYSTEM_ACTOR_ID = '000000000000000000000000';

export async function applyEscalation(societyId: string, id: string, level: number, actor: Actor) {
  const c = await mine(societyId, id);
  c.escalationLevel = level;
  c.lastEscalatedAt = new Date();
  await c.save();
  const step = ESCALATION_LADDER.find(s => s.level === level);
  await log(societyId, c._id, 'ESCALATED', actor, step?.label, { internal: true });

  // An escalation nobody is told about is just a number changing in a database.
  // This is the rung where the committee is supposed to find out, so it is the
  // one notification here marked HIGH.
  tell(async () => {
    await notify({
      societyId,
      userIds: await usersOfCommittee(societyId),
      kind: 'COMPLAINT_ESCALATED',
      title: `Overdue: ${step?.label || `level ${level}`}`,
      body: `${c.title}${c.blockName ? ` — ${c.blockName}` : ''} has passed its promised time.`,
      link: `/dashboard/complaints?id=${c._id}`,
      entityType: 'Complaint', entityId: String(c._id),
      priority: 'HIGH',
      emailIfUnreachable: true,
    });
  });
  return c;
}

// ------------------------------------------------------------------- reports

export interface ComplaintStats {
  open: number;
  overdue: number;
  awaitingConfirmation: number;
  unassigned: number;
  reopenRate: number;
  medianResolutionMinutes: number | null;
}

/**
 * Median, not mean.
 *
 * One ticket left open for ninety days destroys an average and tells you
 * nothing about the typical experience. MyGate reports median for the same
 * reason, and it is the right call.
 */
export async function stats(societyId: string, at = new Date()): Promise<ComplaintStats> {
  const rows = await Complaint.find({ societyId: oid(societyId), kind: 'SERVICE' })
    .select('status resolutionDueAt createdAt resolvedAt reopenCount totalPausedMs assigneeStaffId assigneeVendorId')
    .lean();

  const openStatuses = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED', 'WORK_DONE'];
  const open = rows.filter(r => openStatuses.includes(r.status));

  const resolved = rows.filter(r => r.resolvedAt);
  const durations = resolved
    // Paused time is excluded, so the figure measures how long WE took.
    .map(r => (r.resolvedAt!.getTime() - r.createdAt.getTime() - (r.totalPausedMs || 0)) / 60_000)
    .filter(d => d >= 0)
    .sort((a, b) => a - b);

  return {
    open: open.length,
    overdue: open.filter(r => r.resolutionDueAt && r.resolutionDueAt < at && r.status !== 'ON_HOLD').length,
    awaitingConfirmation: rows.filter(r => r.status === 'WORK_DONE').length,
    unassigned: open.filter(r => !r.assigneeStaffId && !r.assigneeVendorId).length,
    reopenRate: rows.length ? Math.round((rows.filter(r => r.reopenCount > 0).length / rows.length) * 100) : 0,
    medianResolutionMinutes: durations.length ? Math.round(durations[Math.floor(durations.length / 2)]) : null,
  };
}

/** Complaints raised against one piece of equipment — the repair-or-replace case. */
export async function assetHistory(societyId: string, assetId: string) {
  return Complaint.find({ societyId: oid(societyId), assetId: oid(assetId) })
    .select('ticketCode title status createdAt resolvedAt assigneeVendorName')
    .sort({ createdAt: -1 }).lean();
}
