import mongoose from 'mongoose';
import { SocietyStaff, ISocietyStaff, STAFF_DESIGNATIONS } from '../models/society-staff.model';
import { StaffAssignment, WORK_CATEGORIES } from '../models/staff-assignment.model';
import { Vendor } from '../models/vendor.model';
import { Block } from '../models/block.model';
import { AccessRole } from '../models/access-role.model';
import { User } from '../models/user.model';
import { TenantType, UserRole } from '../constants/roles';
import { attachTenantMembership, primaryIdentityId } from './identity.service';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class StaffError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Actor { userId: string; userName: string }

/**
 * A short per-society code. Gapless is unnecessary here — nobody audits a staff
 * number — but it must not collide, so it counts what exists and retries on the
 * unique index rather than trusting a read-then-write.
 */
async function nextStaffCode(societyId: string): Promise<string> {
  const count = await SocietyStaff.countDocuments({ societyId: oid(societyId) });
  return `SF/${String(count + 1).padStart(4, '0')}`;
}

export interface CreateStaffInput {
  name: string;
  phone: string;
  email?: string;
  photoKey?: string;
  designation: string;
  employmentType?: 'DIRECT' | 'AGENCY' | 'CONTRACT';
  vendorId?: string;
  joinedOn?: string;
  accessRoleId?: string;
  verification?: { policeVerifiedOn?: string; verifiedBy?: string; documentKey?: string; expiresOn?: string };
  emergencyContact?: { name?: string; phone?: string; relation?: string };
  notes?: string;
}

export async function createStaff(societyId: string, input: CreateStaffInput, actor: Actor): Promise<ISocietyStaff> {
  if (!STAFF_DESIGNATIONS.includes(input.designation as any)) {
    throw new StaffError('That is not a job this society recognises.');
  }

  let vendorName: string | undefined;
  if (input.employmentType === 'AGENCY') {
    if (!input.vendorId) throw new StaffError('Which agency supplies them?');
    const vendor = await Vendor.findOne({ _id: input.vendorId, societyId: oid(societyId), isActive: true })
      .select('name').lean();
    if (!vendor) throw new StaffError('That agency is unknown to this society or inactive.');
    vendorName = vendor.name;
  }

  if (input.accessRoleId) await assertRoleUsable(societyId, input.accessRoleId);

  // Retry once on the unique index: two people added at the same moment would
  // otherwise race for the same code.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await SocietyStaff.create({
        societyId: oid(societyId),
        staffCode: await nextStaffCode(societyId),
        person: {
          name: input.name.trim(), phone: input.phone.trim(),
          email: input.email?.trim(), photoKey: input.photoKey,
        },
        designation: input.designation,
        employmentType: input.employmentType || 'DIRECT',
        vendorId: input.employmentType === 'AGENCY' ? oid(input.vendorId) : undefined,
        vendorName,
        accessRoleId: input.accessRoleId ? oid(input.accessRoleId) : undefined,
        joinedOn: input.joinedOn ? new Date(input.joinedOn) : new Date(),
        isActive: true,
        verification: {
          policeVerifiedOn: input.verification?.policeVerifiedOn ? new Date(input.verification.policeVerifiedOn) : undefined,
          verifiedBy: input.verification?.verifiedBy,
          documentKey: input.verification?.documentKey,
          expiresOn: input.verification?.expiresOn ? new Date(input.verification.expiresOn) : undefined,
        },
        emergencyContact: input.emergencyContact?.name ? input.emergencyContact : undefined,
        notes: input.notes,
        createdBy: oid(actor.userId), createdByName: actor.userName,
        updatedBy: oid(actor.userId), updatedByName: actor.userName,
      });
    } catch (e: any) {
      if (e?.code !== 11000 || attempt === 2) throw e;
    }
  }
  throw new StaffError('Could not allocate a staff code. Try again.');
}

/** A role must belong to this society and be offered for staff posts. */
async function assertRoleUsable(societyId: string, accessRoleId: string) {
  const role = await AccessRole.findOne({ _id: accessRoleId, societyId: oid(societyId), isActive: true }).lean();
  if (!role) throw new StaffError('That role does not belong to this society.');
  if (role.appliesTo === 'COMMITTEE') throw new StaffError('That role is for committee seats, not staff.');
}

export async function updateStaff(societyId: string, id: string, body: any, actor: Actor): Promise<ISocietyStaff> {
  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) });
  if (!staff) throw new StaffError('That staff member could not be found.', 404);

  if (body.accessRoleId !== undefined) {
    if (body.accessRoleId) {
      await assertRoleUsable(societyId, body.accessRoleId);
      staff.accessRoleId = oid(body.accessRoleId);
    } else {
      staff.accessRoleId = undefined;
    }
  }

  if (body.name) staff.person.name = String(body.name).trim();
  if (body.phone) staff.person.phone = String(body.phone).trim();
  if (body.email !== undefined) staff.person.email = body.email || undefined;
  if (body.photoKey !== undefined) staff.person.photoKey = body.photoKey || undefined;
  if (body.designation) {
    if (!STAFF_DESIGNATIONS.includes(body.designation)) throw new StaffError('That is not a job this society recognises.');
    staff.designation = body.designation;
  }
  if (body.notes !== undefined) staff.notes = body.notes;
  if (body.emergencyContact !== undefined) staff.emergencyContact = body.emergencyContact;
  if (body.verification !== undefined) {
    staff.verification = {
      policeVerifiedOn: body.verification.policeVerifiedOn ? new Date(body.verification.policeVerifiedOn) : staff.verification.policeVerifiedOn,
      verifiedBy: body.verification.verifiedBy ?? staff.verification.verifiedBy,
      documentKey: body.verification.documentKey ?? staff.verification.documentKey,
      expiresOn: body.verification.expiresOn ? new Date(body.verification.expiresOn) : staff.verification.expiresOn,
    };
  }

  staff.updatedBy = oid(actor.userId);
  staff.updatedByName = actor.userName;
  await staff.save();
  return staff;
}

/**
 * Give a staff member a login.
 *
 * This is the function whose absence made the whole permission system dead
 * code. `SocietyStaff.userId` was declared and never written, so `resolveAccess`
 * always found nobody, every SOCIETY_EMPLOYEE got all-NONE, and no assigned
 * technician was ever notified. The model was right; there was simply no door
 * from a staff record to a user account.
 *
 * Reuses `attachTenantMembership` — the exact machinery residents and shops are
 * provisioned through — rather than inventing a second way to make a user. The
 * generated password is returned so the office can hand it over; there is no
 * SMS gateway yet, and inventing one here would be scope this phase does not own.
 */
export async function provisionLogin(societyId: string, id: string, actor: Actor): Promise<{ staff: ISocietyStaff; password?: string }> {
  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) });
  if (!staff) throw new StaffError('That staff member could not be found.', 404);
  if (!staff.isActive) throw new StaffError('They have left — a former employee cannot be given a login.');
  if (staff.userId) throw new StaffError('They already have a login.');
  if (!staff.person.phone && !staff.person.email) {
    throw new StaffError('Add a phone or email first — a login needs something to sign in with.');
  }

  const attached = await attachTenantMembership({
    name: staff.person.name,
    email: staff.person.email,
    phone: staff.person.phone,
    tenantType: TenantType.SOCIETY,
    tenantId: societyId,
    role: UserRole.SOCIETY_EMPLOYEE,
  });

  const userId = primaryIdentityId(attached);
  if (!userId) throw new StaffError('Could not create a login for them.');

  staff.userId = userId;
  staff.updatedBy = oid(actor.userId); staff.updatedByName = actor.userName;
  await staff.save();

  logger.info(`Society ${societyId}: login provisioned for ${staff.person.name}`);
  return { staff, password: attached.generatedPassword };
}

/**
 * End someone's employment.
 *
 * Deactivated, never deleted: their name is on months of complaint history and
 * gate entries, and a deleted row would leave those reading "unknown". Their
 * assignments go with them, so routing stops sending them work the same day.
 */
export async function endEmployment(societyId: string, id: string, leftOn: Date, actor: Actor): Promise<ISocietyStaff> {
  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) });
  if (!staff) throw new StaffError('That staff member could not be found.', 404);
  if (!staff.isActive) throw new StaffError('They have already left.');

  staff.isActive = false;
  staff.leftOn = leftOn;
  staff.updatedBy = oid(actor.userId);
  staff.updatedByName = actor.userName;
  await staff.save();

  const res = await StaffAssignment.updateMany(
    { societyId: oid(societyId), staffId: staff._id, isActive: true },
    { $set: { isActive: false, updatedBy: oid(actor.userId), updatedByName: actor.userName } },
  );

  // Pull their society-employee membership, so a dismissed guard cannot still
  // sign in. The identity row itself stays — they may be a resident elsewhere,
  // and their name must keep resolving on old records.
  if (staff.userId) {
    await User.updateOne(
      { _id: staff.userId },
      { $pull: { memberships: { tenantId: oid(societyId), role: UserRole.SOCIETY_EMPLOYEE } } },
    ).catch(e => logger.error(`Could not revoke login for departed staff: ${e.message}`));
  }

  logger.info(`Society ${societyId}: ${staff.person.name} left; ${res.modifiedCount} assignment(s) ended with them`);
  return staff;
}

export async function listStaff(societyId: string, query: any = {}) {
  const filter: any = { societyId: oid(societyId) };
  if (query.active !== 'all') filter.isActive = query.active === 'false' ? false : true;
  if (query.designation) filter.designation = query.designation;
  if (query.q) {
    const rx = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ 'person.name': rx }, { 'person.phone': rx }, { staffCode: rx }];
  }
  return SocietyStaff.find(filter).sort({ isActive: -1, 'person.name': 1 }).lean();
}

export async function getStaff(societyId: string, id: string) {
  const staff = await SocietyStaff.findOne({ _id: id, societyId: oid(societyId) }).lean();
  if (!staff) throw new StaffError('That staff member could not be found.', 404);
  const assignments = await StaffAssignment.find({ societyId: oid(societyId), staffId: oid(id) })
    .sort({ isActive: -1, rank: 1 }).lean();
  return { staff, assignments };
}

// ---------------------------------------------------------------- assignments

export interface AssignInput {
  staffId: string;
  scope: 'SOCIETY' | 'BLOCK';
  blockId?: string;
  categories: string[];
  rank?: 'PRIMARY' | 'BACKUP';
}

export async function assign(societyId: string, input: AssignInput, actor: Actor) {
  const staff = await SocietyStaff.findOne({ _id: input.staffId, societyId: oid(societyId), isActive: true })
    .select('person.name').lean();
  if (!staff) throw new StaffError('That staff member is unknown to this society or has left.');

  const categories = (input.categories || []).filter(c => (WORK_CATEGORIES as readonly string[]).includes(c));
  if (!categories.length) throw new StaffError('What kind of work should reach them?');

  let blockName: string | undefined;
  if (input.scope === 'BLOCK') {
    if (!input.blockId) throw new StaffError('Which wing?');
    const block = await Block.findOne({ _id: input.blockId, societyId: oid(societyId) }).select('name').lean();
    if (!block) throw new StaffError('That wing does not belong to this society.');
    blockName = block.name;
  }

  return StaffAssignment.create({
    societyId: oid(societyId),
    staffId: oid(input.staffId),
    staffName: staff.person.name,
    scope: input.scope,
    blockId: input.scope === 'BLOCK' ? oid(input.blockId) : undefined,
    blockName,
    categories,
    rank: input.rank || 'PRIMARY',
    isActive: true,
    createdBy: oid(actor.userId), createdByName: actor.userName,
    updatedBy: oid(actor.userId), updatedByName: actor.userName,
  });
}

export async function unassign(societyId: string, assignmentId: string, actor: Actor) {
  const row = await StaffAssignment.findOne({ _id: assignmentId, societyId: oid(societyId) });
  if (!row) throw new StaffError('That assignment could not be found.', 404);
  row.isActive = false;
  row.updatedBy = oid(actor.userId);
  row.updatedByName = actor.userName;
  await row.save();
  return row;
}

export interface RoutingMatch {
  staffId: string;
  staffName: string;
  rank: 'PRIMARY' | 'BACKUP';
  via: 'BLOCK_PRIMARY' | 'BLOCK_BACKUP' | 'SOCIETY_WIDE';
}

/**
 * Who should this piece of work go to?
 *
 * Walks primary → backup → society-wide and returns `null` if nothing matches,
 * which is a real answer the caller must handle by parking the work in an
 * "unassigned" queue. It must never silently pick someone plausible: a
 * complaint quietly given to the wrong person is worse than one visibly given
 * to nobody, because the second gets noticed.
 */
export async function findAssignee(
  societyId: string, category: string, blockId?: string | null,
): Promise<RoutingMatch | null> {
  const base = { societyId: oid(societyId), isActive: true, categories: category };

  const order: { filter: any; via: RoutingMatch['via'] }[] = [];
  if (blockId) {
    order.push({ filter: { ...base, scope: 'BLOCK', blockId: oid(blockId), rank: 'PRIMARY' }, via: 'BLOCK_PRIMARY' });
    order.push({ filter: { ...base, scope: 'BLOCK', blockId: oid(blockId), rank: 'BACKUP' }, via: 'BLOCK_BACKUP' });
  }
  order.push({ filter: { ...base, scope: 'SOCIETY' }, via: 'SOCIETY_WIDE' });

  for (const step of order) {
    const hit = await StaffAssignment.findOne(step.filter).sort({ createdAt: 1 }).lean();
    if (hit) {
      // The assignment may outlive the person if something went wrong
      // elsewhere; check they are still employed before handing them work.
      const staff = await SocietyStaff.findOne({ _id: hit.staffId, isActive: true }).select('person.name').lean();
      if (!staff) continue;
      return { staffId: String(hit.staffId), staffName: staff.person.name, rank: hit.rank, via: step.via };
    }
  }
  return null;
}

// ------------------------------------------------------------------ coverage

export interface CoverageCell {
  category: string;
  scopeKey: string;              // a block id, or 'SOCIETY'
  scopeLabel: string;
  primary: { staffId: string; staffName: string }[];
  backup: { staffId: string; staffName: string }[];
}

export interface CoverageMatrix {
  categories: string[];
  scopes: { key: string; label: string }[];
  cells: CoverageCell[];
  /** Category+wing pairs where a complaint would reach nobody. */
  gaps: { category: string; scopeKey: string; scopeLabel: string }[];
}

/**
 * Who covers what, laid out as a grid.
 *
 * `findAssignee` returns `null` when nothing matches and the caller parks the
 * complaint unassigned — correct behaviour, and completely silent. A committee
 * only discovers the hole when a lift complaint sits untouched for a week.
 *
 * This computes the same walk `findAssignee` does, for every category against
 * every wing, and names the empty squares. It is the answer to "why did nobody
 * get my complaint" before it is asked rather than after.
 *
 * Note the gap rule mirrors routing exactly: a wing is covered if it has its
 * own primary or backup, OR if somebody covers the whole society. Diverging
 * here would produce a grid that disagrees with what actually happens.
 */
export async function coverage(societyId: string): Promise<CoverageMatrix> {
  const [assignments, blocks, activeStaff] = await Promise.all([
    StaffAssignment.find({ societyId: oid(societyId), isActive: true }).lean(),
    Block.find({ societyId: oid(societyId) }).select('name').sort({ name: 1 }).lean(),
    SocietyStaff.find({ societyId: oid(societyId), isActive: true }).select('_id').lean(),
  ]);

  // An assignment can outlive the person. Routing skips those, so the grid must
  // too, or it shows cover that does not exist.
  const employed = new Set(activeStaff.map(s => String(s._id)));
  const live = assignments.filter(a => employed.has(String(a.staffId)));

  const scopes = [
    { key: 'SOCIETY', label: 'Whole society' },
    ...blocks.map(b => ({ key: String(b._id), label: b.name })),
  ];

  const cells: CoverageCell[] = [];
  const gaps: CoverageMatrix['gaps'] = [];

  for (const category of WORK_CATEGORIES) {
    const forCategory = live.filter(a => a.categories.includes(category));
    const societyWide = forCategory.filter(a => a.scope === 'SOCIETY');

    for (const scope of scopes) {
      const mine = scope.key === 'SOCIETY'
        ? societyWide
        : forCategory.filter(a => a.scope === 'BLOCK' && String(a.blockId) === scope.key);

      const cell: CoverageCell = {
        category, scopeKey: scope.key, scopeLabel: scope.label,
        primary: mine.filter(a => a.rank === 'PRIMARY').map(a => ({ staffId: String(a.staffId), staffName: a.staffName })),
        backup: mine.filter(a => a.rank === 'BACKUP').map(a => ({ staffId: String(a.staffId), staffName: a.staffName })),
      };
      cells.push(cell);

      const covered = cell.primary.length + cell.backup.length > 0
        || (scope.key !== 'SOCIETY' && societyWide.length > 0);
      if (!covered) gaps.push({ category, scopeKey: scope.key, scopeLabel: scope.label });
    }
  }

  return { categories: [...WORK_CATEGORIES], scopes, cells, gaps };
}

/**
 * Verifications that have lapsed or are about to.
 *
 * A police verification from three years ago reads exactly like one that never
 * happened. No competitor tracks the expiry; this is the whole reason the field
 * carries a date rather than a tick.
 */
export async function findExpiringVerifications(societyId: string, withinDays = 30, at = new Date()) {
  const horizon = new Date(at.getTime() + withinDays * 86_400_000);
  return SocietyStaff.find({
    societyId: oid(societyId),
    isActive: true,
    'verification.expiresOn': { $ne: null, $lte: horizon },
  }).select('staffCode person.name designation verification.expiresOn').sort({ 'verification.expiresOn': 1 }).lean();
}

// ------------------------------------------------------- agency bill checking

export interface AgencyHeadcount {
  vendorId: string;
  vendorName: string;
  active: number;
  leftThisMonth: number;
}

/**
 * How many people each agency actually has on site.
 *
 * This is the whole reason staff records are worth keeping without payroll:
 * when the agency bills for four guards, somebody has to be able to say the
 * roll shows three. Nothing else in the system can answer that.
 */
export async function agencyHeadcount(societyId: string, at = new Date()): Promise<AgencyHeadcount[]> {
  const monthStart = new Date(at.getFullYear(), at.getMonth(), 1);
  const rows = await SocietyStaff.find({
    societyId: oid(societyId),
    employmentType: 'AGENCY',
    $or: [{ isActive: true }, { leftOn: { $gte: monthStart } }],
  }).select('vendorId vendorName isActive leftOn').lean();

  const byVendor = new Map<string, AgencyHeadcount>();
  for (const r of rows) {
    const key = String(r.vendorId || 'unknown');
    const row = byVendor.get(key) || {
      vendorId: key, vendorName: r.vendorName || 'Unknown agency', active: 0, leftThisMonth: 0,
    };
    if (r.isActive) row.active++;
    else if (r.leftOn && r.leftOn >= monthStart) row.leftThisMonth++;
    byVendor.set(key, row);
  }
  return [...byVendor.values()].sort((a, b) => b.active - a.active);
}
