import { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as complaints from '../services/complaint.service';
import { ComplaintError, ESCALATION_LADDER, MAX_PHOTOS, COMPLAINT_PHOTO_PREFIX } from '../services/complaint.service';
import { TRANSITIONS, VERB_LABELS, PAUSE_LIMITS } from '../services/complaint-transitions';
import { calendarFor, describeCalendar } from '../services/complaint-calendar';
import s3Service from '../services/s3.service';
import * as assets from '../services/asset.service';
import { AssetError } from '../services/asset.service';
import { PAUSE_REASONS } from '../models/complaint.model';
import { ASSET_CATEGORIES } from '../models/asset.model';
import { Resident } from '../models/resident.model';
import { Flat, FlatStatus } from '../models/flat.model';
import { SocietyStaff } from '../models/society-staff.model';
import { Block } from '../models/block.model';
import { Vendor } from '../models/vendor.model';
import { UserRole } from '../constants/roles';
import { allows } from '../services/access-role.service';
import { auditFinance } from '../utils/finance-audit.util';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const actorOf = (req: Request) => ({
  userId: String(req.user!.userId),
  userName: String(req.user!.userName || 'Someone'),
});

const fail = (res: Response, e: any, what: string) => {
  if (e instanceof ComplaintError || e instanceof AssetError) {
    return res.status(e.status).json({ success: false, message: e.message });
  }
  logger.error(`${what} failed: ${e.message}`);
  return res.status(500).json({ success: false, message: `Could not ${what}` });
};

const RESIDENT_ROLES: string[] = [UserRole.RESIDENT_OWNER, UserRole.RESIDENT_TENANT, UserRole.FAMILY_MEMBER];

/**
 * Every flat this person is attached to, whatever household they belong to.
 *
 * This is the FILING scope, and only the filing scope: "which flats may I
 * report a problem for". A landlord may report a problem with the property
 * they own — seepage, a cracked window, the flat's own plumbing — and the
 * tenancy does not take that away from them. Reading their tenant's complaints
 * is a completely different question, answered by `readerFlatScope` below, and
 * the two used to be the same list. That is H-12.
 */
async function residentFlatIds(req: Request): Promise<string[] | undefined> {
  if (!RESIDENT_ROLES.includes(String(req.user?.activeRole || ''))) return undefined;
  const rows = await Resident.find({
    userId: oid(req.user!.userId), societyId: oid(req.user!.activeTenantId), isActive: true,
  }).select('flatId').lean();
  return rows.map(r => String(r.flatId));
}

/** A flat this person may read, and the slice of its history that is theirs. */
export interface ReaderFlatScope {
  flatIds: string[];
  /** Per flat, the occupancy window. An absent entry means "no bound". */
  tenure: Record<string, { from?: Date; to?: Date }>;
}

/**
 * Which flats' complaints this person may READ — H-12.
 *
 * `flat-lifecycle.service` deliberately keeps the OWNER's `Resident` row active
 * through a tenancy, because ownership does not pause while somebody rents the
 * place. Every flat-scoped module respects that boundary; complaints took the
 * row at face value, so a landlord read every complaint their tenant filed, and
 * a new tenant read every complaint the previous one ever filed. Phase 0 closed
 * the notification half of exactly this — `householdOfFlat` in
 * `notify-recipients.ts`, where a RENTED flat reaches its tenant and never its
 * landlord. This is the same rule, applied to reading.
 *
 * Two clamps, and they are separate:
 *
 *   **Household.** On a RENTED flat the owner household is not the household.
 *     An owner who wants to read what their tenant reports is describing
 *     surveillance, not property management — the same sentence that decided
 *     the notification half.
 *
 *   **Tenure.** A resident sees what was raised while they lived there. Without
 *     this a new tenant inherits the last tenant's entire complaint history —
 *     which is not their flat's maintenance record, it is a stranger's
 *     correspondence with the committee.
 *
 * What survives both: a complaint you raised yourself. `raisedByUserId` is the
 * escape hatch, applied in the service, and it is what keeps the landlord above
 * able to read the complaint they filed about their own property, and an
 * ex-tenant able to see what they reported before they left.
 */
async function readerFlatScope(req: Request): Promise<ReaderFlatScope | undefined> {
  if (!RESIDENT_ROLES.includes(String(req.user?.activeRole || ''))) return undefined;

  const societyId = oid(req.user!.activeTenantId);
  const rows = await Resident.find({
    userId: oid(req.user!.userId), societyId, isActive: true,
  }).select('flatId householdType moveInDate moveOutDate').lean();
  if (!rows.length) return { flatIds: [], tenure: {} };

  const flats = await Flat.find({ _id: { $in: rows.map(r => r.flatId) }, societyId })
    .select('status').lean();
  const statusOf = new Map(flats.map(f => [String(f._id), String(f.status)]));

  const scope: ReaderFlatScope = { flatIds: [], tenure: {} };
  for (const r of rows) {
    const flatId = String(r.flatId);
    // The landlord of a let flat. Not an error, not a downgrade — they simply
    // are not the household of that flat while somebody else lives in it.
    if (statusOf.get(flatId) === FlatStatus.RENTED && r.householdType === 'OWNER') continue;
    scope.flatIds.push(flatId);
    if (r.moveInDate || r.moveOutDate) {
      scope.tenure[flatId] = { from: r.moveInDate, to: r.moveOutDate };
    }
  }
  return scope;
}

/**
 * How much of the complaint list this reader gets.
 *
 * Three separate questions, resolved in one place so no handler answers one of
 * them differently: which flats, which wings, and whether conduct complaints
 * exist for them at all.
 */
async function readerOpts(req: Request): Promise<complaints.ListOpts> {
  const societyId = String(req.user!.activeTenantId);
  const access = req.access;
  // The READ scope, not the filing scope — see `readerFlatScope`. `act` below
  // is built from this same object on purpose: a person may only touch what
  // they can already see, so the household boundary lands on both halves at
  // once and the two cannot drift.
  const scope = await readerFlatScope(req);
  const flats = scope?.flatIds;

  // Staff with only COMPLAINTS_OWN see their own queue and nothing else.
  let ownStaffId: string | undefined;
  let viewerStaffId: string | undefined;
  if (!flats) {
    const post = await SocietyStaff.findOne({
      societyId: oid(societyId), userId: oid(req.user!.userId), isActive: true,
    }).select('_id').lean();
    viewerStaffId = post ? String(post._id) : undefined;
    const canManage = access ? allows(access, 'COMPLAINTS_MANAGE', 'READ') : false;
    if (!canManage && post) ownStaffId = String(post._id);
  }

  return {
    residentFlatIds: flats,
    residentTenure: scope?.tenure,
    access,
    ownStaffId,
    viewerStaffId,
    canSeeConduct: access ? allows(access, 'COMPLAINTS_CONDUCT', 'READ') : false,
    // The three below turn this from a READ scope into an ACT scope. The same
    // object now answers both "what may I see?" and "what may I touch?", so
    // the two can never drift apart — which is exactly how a resident came to
    // be able to resolve a neighbour's complaint.
    userId: String(req.user!.userId),
    canManage: access ? allows(access, 'COMPLAINTS_MANAGE', 'FULL') : false,
    blockIds: access && !access.isAdmin && access.scope && !access.scope.allBlocks
      ? access.scope.blockIds
      : undefined,
  };
}

// ---------------------------------------------------------------- complaints

export const raise = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    // A resident gets their own flat filled in and is held to it; the office
    // may file for anybody. Resolved here because this is where "who is
    // asking" is known — the service is given the answer, not the request.
    const flats = await residentFlatIds(req);
    const c = await complaints.raise(societyId, req.body, actorOf(req), {
      raiserFlatIds: flats,
      onBehalf: !flats,
    });
    auditFinance(req, 'COMPLAINT_RAISE', 'Complaint', String(c._id), {
      newValues: { kind: c.kind, category: c.category, flat: c.flatLabel },
    });
    res.status(201).json({
      success: true, data: c,
      message: c.assigneeName
        ? `${c.ticketCode} raised and sent to ${c.assigneeName}`
        : `${c.ticketCode} raised — waiting to be assigned`,
    });
  } catch (e: any) { fail(res, e, 'raise that complaint'); }
};

export const list = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const data = await complaints.list(societyId, req.query, await readerOpts(req));
    res.json({ success: true, ...data });
  } catch (e: any) { fail(res, e, 'load complaints'); }
};

export const detail = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const data = await complaints.detail(societyId, req.params.id, await readerOpts(req));
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load that complaint'); }
};

/**
 * Everything the "raise" form and the board need — and only what this caller
 * may have.
 *
 * Two things were handed to everybody who could open the complaints screen:
 *
 *   **The staff directory.** Every employee's name and designation, to every
 *   resident, on page load. The frontend's own comment asserted the opposite,
 *   which is how it survived review — it is gated here now, on the permissions
 *   that already mean "you may see who works here" and "you may run the
 *   complaints desk", because those are the two screens that actually need it.
 *
 *   **The society's complaint statistics.** How many are open, how many are
 *   overdue, the median time to fix. That is committee information; a resident
 *   reading "23 overdue" about their neighbours' problems is a data leak
 *   dressed as a dashboard, and it also made every page load scan the
 *   collection for numbers nobody was going to be shown.
 *
 * The state machine goes the other way — it is published to EVERYONE, because
 * the whole point is that the UI stops inventing its own answer to "which
 * buttons should this person see". A resident was being offered between four
 * and seven controls that were guaranteed to 403.
 */
export const options = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const actor = actorOf(req);
    const access = req.access;
    const mayManage = access ? allows(access, 'COMPLAINTS_MANAGE', 'READ') : false;
    const maySeeStaff = mayManage || (access ? allows(access, 'STAFF_VIEW', 'READ') : false);

    const [categories, staff, blocks, assetRows, stats, calendar] = await Promise.all([
      complaints.listCategories(societyId, actor.userId, actor.userName),
      maySeeStaff
        ? SocietyStaff.find({ societyId: oid(societyId), isActive: true })
          .select('person.name designation').sort({ 'person.name': 1 }).lean()
        : Promise.resolve([]),
      Block.find({ societyId: oid(societyId) }).select('name').sort({ name: 1 }).lean(),
      assets.listAssets(societyId),
      mayManage ? complaints.stats(societyId).catch(() => null) : Promise.resolve(null),
      calendarFor(societyId),
    ]);
    res.json({
      success: true,
      data: {
        categories, staff, blocks, assets: assetRows, stats,
        pauseReasons: PAUSE_REASONS,
        escalation: ESCALATION_LADDER,
        /**
         * When the clocks actually run.
         *
         * Published to EVERYONE, because it is the sentence that stops a
         * resident thinking the software has lost two days: a complaint filed
         * at 6pm on a Saturday with a four-hour promise is due at 1pm on
         * Monday, and without saying why that reads as a fault.
         */
        workingHours: describeCalendar(calendar),
        photoLimit: MAX_PHOTOS,
        // The machine itself: which verbs each status allows, who may press
        // them, and what the button says. One table, published, so the server
        // and the screen can no longer disagree.
        transitions: TRANSITIONS,
        verbs: VERB_LABELS,
        pauseLimits: PAUSE_LIMITS,
        // Which hats this caller wears, so the published table can be applied
        // per row without a request per ticket.
        viewer: {
          canManage: access ? allows(access, 'COMPLAINTS_MANAGE', 'FULL') : false,
          canSeeStaff: maySeeStaff,
          canSeeConduct: access ? allows(access, 'COMPLAINTS_CONDUCT', 'READ') : false,
        },
      },
    });
  } catch (e: any) { fail(res, e, 'load the form'); }
};

/**
 * The numbers, on their own.
 *
 * They were only ever available inside `/options`, so the screen re-fetched the
 * whole form payload — every category, every asset, the staff directory — after
 * every single button press, purely to refresh six integers (H-17). This is the
 * six integers. `/options` still carries them, because a first paint needs them
 * and because removing a published field breaks callers that read it.
 *
 * Manage-gated for the same reason `/options` gates them: how many of the
 * neighbours' complaints are overdue is committee information.
 */
export const stats = async (req: Request, res: Response) => {
  try {
    const data = await complaints.stats(String(req.user!.activeTenantId));
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load the numbers'); }
};

/**
 * A photograph, on its way to a private prefix.
 *
 * §IV-1.2: the model, the validator and the storage were all ready and there
 * was no uploader and no viewer, so the resident's only way to report a leak
 * was to describe it in prose. This is the uploader. It hands back an object
 * KEY, never a public URL that works — the bucket is private and reading goes
 * back through `GET /:id/photos`, which checks who is asking.
 *
 * Anybody signed into the society may upload, deliberately: the key is useless
 * until it is attached to a complaint, and attaching goes through `raise` or
 * `work-done`, both of which are scoped. Gating the upload itself would only
 * mean a resident discovering they cannot attach a photo AFTER writing the
 * complaint.
 */
export const uploadPhoto = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Choose a photo first.' });
    }
    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const url = await s3Service.uploadBuffer(
      req.file.buffer, COMPLAINT_PHOTO_PREFIX.replace(/\/$/, ''), ext || 'jpg', req.file.mimetype,
    );
    const key = s3Service.keyFromUrl(url);
    res.json({ success: true, data: { key, name: req.file.originalname } });
  } catch (e: any) { fail(res, e, 'upload that photo'); }
};

/** The gallery. Scoped through `detail`, signed for five minutes. */
export const photos = async (req: Request, res: Response) => {
  try {
    const data = await complaints.photoUrls(
      String(req.user!.activeTenantId), req.params.id, await readerOpts(req),
    );
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load the photos'); }
};

/**
 * Every action on one complaint goes through here, and every one of them now
 * receives the caller's scope.
 *
 * That scope is resolved ONCE, in `readerOpts`, and handed down — rather than
 * each action deciding for itself who is allowed to touch what. Eleven actions
 * deciding separately is how four of them ended up checking only the society.
 */
const act = (
  fn: (societyId: string, id: string, req: Request, opts: complaints.ListOpts) => Promise<any>,
  auditAction: string,
  what: string,
) => async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const c = await fn(societyId, req.params.id, req, await readerOpts(req));
    auditFinance(req, auditAction, 'Complaint', String(c._id));
    res.json({ success: true, data: c });
  } catch (e: any) { fail(res, e, what); }
};

export const assign = act(
  (s, id, req, o) => complaints.assignTo(s, id, req.body.staffId || null, actorOf(req), o),
  'COMPLAINT_ASSIGN', 'assign that complaint');

export const respond = act(
  (s, id, req, o) => complaints.respond(s, id, req.body.note, actorOf(req), o, req.body.photoKeys),
  'COMPLAINT_RESPOND', 'record that reply');

/**
 * The two channels that did not exist, side by side so the difference is
 * visible in one screen of code.
 *
 * `comment` is the household's, and it is on the EVERYONE routes. `note` is the
 * staff's, it is behind `COMPLAINTS_OWN`, and `detail` strips it from anybody
 * holding `residentFlatIds` — which is the guarantee the whole internal channel
 * rests on and the thing to break first if either is ever changed.
 */
export const comment = act(
  (s, id, req, o) => complaints.comment(s, id, req.body.note, req.body.photoKeys, actorOf(req), o),
  'COMPLAINT_COMMENT', 'add that message');

export const internalNote = act(
  (s, id, req, o) => complaints.internalNote(s, id, req.body.note, req.body.photoKeys, actorOf(req), o),
  'COMPLAINT_NOTE', 'record that note');

export const pause = act(
  (s, id, req, o) => complaints.pause(s, id, req.body.reason, actorOf(req), o),
  'COMPLAINT_PAUSE', 'put that on hold');

export const resume = act(
  (s, id, req, o) => complaints.resume(s, id, actorOf(req), o),
  'COMPLAINT_RESUME', 'take that off hold');

export const workDone = act(
  (s, id, req, o) => complaints.markWorkDone(s, id, req.body.note, req.body.photoKeys || [], actorOf(req), o),
  'COMPLAINT_WORK_DONE', 'mark that as done');

export const resolve = act(
  (s, id, req, o) => complaints.resolve(s, id, actorOf(req), o),
  'COMPLAINT_RESOLVE', 'confirm that');

export const close = act(
  (s, id, req, o) => complaints.close(s, id, actorOf(req), o),
  'COMPLAINT_CLOSE', 'close that');

export const reopen = act(
  (s, id, req, o) => complaints.reopen(s, id, req.body.reason, actorOf(req), o),
  'COMPLAINT_REOPEN', 'reopen that');

/**
 * Disposing of a ticket in one act.
 *
 * Both of these reach a status — REJECTED — that the model has declared since
 * the beginning and that nothing could set. Until now the only way to get rid
 * of a duplicate or a mistake was Work-done → Yes-it's-fixed → Close, which
 * wrote a `resolvedAt` on work nobody did and pulled the median-resolution
 * figure down with it.
 */
export const reject = act(
  (s, id, req, o) => complaints.reject(s, id, req.body.reason, actorOf(req), o),
  'COMPLAINT_REJECT', 'reject that complaint');

export const markDuplicate = act(
  (s, id, req, o) => complaints.markDuplicate(s, id, req.body.ofId, actorOf(req), o),
  'COMPLAINT_DUPLICATE', 'merge that complaint');

export const meToo = act(
  (s, id, req, o) => complaints.meToo(s, id, actorOf(req), o),
  'COMPLAINT_ME_TOO', 'join that complaint');

export const rate = act(
  (s, id, req, o) => complaints.rate(s, id, Number(req.body.rating), req.body.feedback, actorOf(req), o),
  'COMPLAINT_RATE', 'record that rating');

/**
 * The overdue queue — now scoped like every other read.
 *
 * It was calling the sweep's own society-wide lookup, so anybody holding
 * COMPLAINTS_MANAGE: READ got the titles of overdue CONDUCT complaints (which
 * are titled with a person's name) and every wing's work regardless of their
 * own wing scope. The same `readerOpts` the list uses now applies here.
 */
export const escalations = async (req: Request, res: Response) => {
  try {
    const data = await complaints.findEscalations(
      String(req.user!.activeTenantId), new Date(), await readerOpts(req),
    );
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load escalations'); }
};

/** Manually escalate one complaint — a manager pushing it up before the sweep would. */
export const escalate = act(
  (s, id, req, o) => complaints.applyEscalation(s, id, Number(req.body.level), actorOf(req), o),
  'COMPLAINT_ESCALATE', 'escalate that complaint');

// ------------------------------------------------------------- categories

export const listCategories = async (req: Request, res: Response) => {
  try {
    const data = await complaints.listAllCategories(String(req.user!.activeTenantId));
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load categories'); }
};

export const saveCategory = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const cat = await complaints.saveCategory(societyId, req.body, actorOf(req), req.params.id);
    auditFinance(req, req.params.id ? 'COMPLAINT_CATEGORY_UPDATE' : 'COMPLAINT_CATEGORY_CREATE',
      'ComplaintCategory', String(cat._id), { newValues: { category: cat.category, sla: cat.resolutionMinutes } });
    res.json({ success: true, data: cat, message: 'Saved' });
  } catch (e: any) { fail(res, e, 'save that category'); }
};

// -------------------------------------------------------------------- assets

export const listAssets = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const [rows, blocks, vendors, expiring] = await Promise.all([
      assets.listAssets(societyId, req.query),
      Block.find({ societyId: oid(societyId) }).select('name').sort({ name: 1 }).lean(),
      Vendor.find({ societyId: oid(societyId), isActive: true }).select('name').sort({ name: 1 }).lean(),
      assets.findExpiringAmcs(societyId),
    ]);
    res.json({ success: true, data: { assets: rows, blocks, vendors, expiring, categories: ASSET_CATEGORIES } });
  } catch (e: any) { fail(res, e, 'load equipment'); }
};

export const createAsset = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const a = await assets.createAsset(societyId, req.body, actorOf(req));
    auditFinance(req, 'ASSET_CREATE', 'Asset', String(a._id), { newValues: { name: a.name, category: a.category } });
    res.status(201).json({ success: true, data: a });
  } catch (e: any) { fail(res, e, 'add that equipment'); }
};

export const updateAsset = async (req: Request, res: Response) => {
  try {
    const societyId = String(req.user!.activeTenantId);
    const a = await assets.updateAsset(societyId, req.params.id, req.body, actorOf(req));
    auditFinance(req, 'ASSET_UPDATE', 'Asset', String(a._id));
    res.json({ success: true, data: a });
  } catch (e: any) { fail(res, e, 'update that equipment'); }
};

export const assetHistory = async (req: Request, res: Response) => {
  try {
    const data = await complaints.assetHistory(String(req.user!.activeTenantId), req.params.id);
    res.json({ success: true, data });
  } catch (e: any) { fail(res, e, 'load its history'); }
};

/**
 * Resolve a scanned sticker.
 *
 * Signed in, but NOT tied to one society by the token — the token itself names
 * the society, and the middleware then checks the caller belongs to it. A
 * resident of one society scanning another's lift gets nothing.
 */
export const scan = async (req: Request, res: Response) => {
  try {
    const result = await assets.resolveScan(String(req.params.token));
    if (result.societyId !== String(req.user!.activeTenantId)) {
      // Same wording as "not found": telling them it exists elsewhere is itself
      // a small leak of another society's equipment list.
      return res.status(404).json({ success: false, message: 'That sticker does not match any equipment.' });
    }
    res.json({ success: true, data: result });
  } catch (e: any) { fail(res, e, 'read that sticker'); }
};
