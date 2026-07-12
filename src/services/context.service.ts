/**
 * Resolves the set of switchable "contexts" (workspaces) a user can act in.
 *
 * A context is unit-granular: one per society flat/plot the user belongs to,
 * one per shop they administer, plus any tenant-level admin/employee role.
 * This is the single source of truth used by login, select-context and
 * refresh so the JWT can carry which *unit* is active — not just the tenant.
 */
import mongoose from 'mongoose';
import { IUser } from '../models/user.model';
import { Resident } from '../models/resident.model';
import { Flat } from '../models/flat.model';
import { Shop } from '../models/shop.model';
import { Society } from '../models/society.model';
import { ISecureJwtPayload } from '../utils/jwt.util';
import { TenantType, UserRole } from '../constants/roles';

export type ContextKind = 'SOCIETY_UNIT' | 'SHOP' | 'ADMIN';
export type UnitType = 'FLAT' | 'SHOP';

export interface IResolvedContext {
  contextId: string;                 // stable id, e.g. "resident:<id>" | "shop:<id>" | "member:<tenantId>:<role>"
  kind: ContextKind;
  tenantType: TenantType;
  tenantId: string;
  tenantName: string;
  unitType: UnitType | null;         // null for tenant-level admin/employee contexts
  unitId: string | null;             // flatId / shopId
  unitLabel: string | null;          // "A-101" / "Plot 12" / shop name
  role: UserRole;
}

// Roles derived from Resident / Shop records — skipped in the membership loop
// so a user with both a membership entry and a Resident/Shop row isn't duplicated.
const UNIT_DERIVED_ROLES = new Set<UserRole>([
  UserRole.RESIDENT_OWNER,
  UserRole.RESIDENT_TENANT,
  UserRole.FAMILY_MEMBER,
  UserRole.SHOP_ADMIN,
  UserRole.SHOP_OWNER,
  UserRole.SHOP_CLIENT,
]);

const relationshipToRole = (relationship: string, isOwner: boolean): UserRole => {
  if (isOwner || relationship === 'OWNER') return UserRole.RESIDENT_OWNER;
  if (relationship === 'TENANT') return UserRole.RESIDENT_TENANT;
  return UserRole.FAMILY_MEMBER;
};

const flatLabel = (flat: any): string => {
  if (!flat) return 'Unit';
  if (flat.plotNumber) return `Plot ${flat.plotNumber}`;
  return flat.blockName ? `${flat.blockName}-${flat.number}` : `${flat.number}`;
};

interface Entry { ctx: IResolvedContext; sortAt: number }

const kindOrder: Record<ContextKind, number> = { ADMIN: 0, SOCIETY_UNIT: 1, SHOP: 2 };

/**
 * Build every context available to a user, sorted deterministically so the
 * "first" one (the default landed-on unit) is stable across requests.
 */
export const resolveUserContexts = async (user: IUser): Promise<IResolvedContext[]> => {
  const userId = user._id as mongoose.Types.ObjectId;
  const entries: Entry[] = [];

  // 1) Memberships → SHOP tenants become shop units (both identities that hold the
  //    membership see them); other non-resident roles are tenant-level admin contexts.
  const shopMembershipIds: string[] = [];
  const societyAdminIds = (user.memberships || [])
    .filter((m) => m.tenantType === TenantType.SOCIETY && !UNIT_DERIVED_ROLES.has(m.role))
    .map((m) => m.tenantId.toString());
  const societyNameMap = new Map<string, string>();
  if (societyAdminIds.length) {
    const socs = await Society.find({ _id: { $in: societyAdminIds } }).select('name').lean();
    for (const s of socs as any[]) societyNameMap.set(s._id.toString(), s.name);
  }

  for (const m of user.memberships || []) {
    if (m.tenantType === TenantType.SHOP) {
      shopMembershipIds.push(m.tenantId.toString());
      continue;
    }
    if (UNIT_DERIVED_ROLES.has(m.role)) continue; // RESIDENT_* come from Resident rows
    const tenantName = m.tenantType === TenantType.SYSTEM
      ? 'Platform'
      : m.tenantType === TenantType.SOCIETY
        ? (societyNameMap.get(m.tenantId.toString()) || 'Society')
        : m.tenantType;
    entries.push({
      ctx: {
        contextId: `member:${m.tenantId.toString()}:${m.role}`,
        kind: 'ADMIN',
        tenantType: m.tenantType,
        tenantId: m.tenantId.toString(),
        tenantName,
        unitType: null,
        unitId: null,
        unitLabel: null,
        role: m.role,
      },
      sortAt: 0,
    });
  }

  // 2) Society units — one context per Resident row (source of truth).
  const residents = await Resident.find({ userId, isActive: true })
    .populate('flatId', 'number blockName plotNumber fullAddress')
    .populate('societyId', 'name')
    .lean();

  const coveredFlatIds = new Set<string>();
  for (const r of residents as any[]) {
    if (!r.flatId) continue; // orphaned resident (flat deleted)
    const flatId = (r.flatId._id || r.flatId).toString();
    coveredFlatIds.add(flatId);
    entries.push({
      ctx: {
        contextId: `resident:${r._id.toString()}`,
        kind: 'SOCIETY_UNIT',
        tenantType: TenantType.SOCIETY,
        tenantId: (r.societyId?._id || r.societyId).toString(),
        tenantName: r.societyId?.name || 'Society',
        unitType: 'FLAT',
        unitId: flatId,
        unitLabel: flatLabel(r.flatId),
        role: relationshipToRole(r.relationship, r.isOwner),
      },
      sortAt: new Date(r.createdAt).getTime() || 0,
    });
  }

  // 3) Legacy fallback: flats linking the user via headOfFamily/familyMembers
  //    that have no Resident row yet (keeps pre-Resident data switchable).
  const legacyFlats = await Flat.find({
    $or: [{ headOfFamily: userId }, { familyMembers: userId }],
  })
    .populate('societyId', 'name')
    .lean();

  for (const f of legacyFlats as any[]) {
    if (coveredFlatIds.has(f._id.toString())) continue;
    const isHead = f.headOfFamily?.toString() === userId.toString();
    entries.push({
      ctx: {
        contextId: `flat:${f._id.toString()}`,
        kind: 'SOCIETY_UNIT',
        tenantType: TenantType.SOCIETY,
        tenantId: (f.societyId?._id || f.societyId).toString(),
        tenantName: f.societyId?.name || 'Society',
        unitType: 'FLAT',
        unitId: f._id.toString(),
        unitLabel: flatLabel(f),
        role: isHead ? UserRole.RESIDENT_OWNER : UserRole.FAMILY_MEMBER,
      },
      sortAt: new Date(f.createdAt).getTime() || 0,
    });
  }

  // 4) Shops the identity administers (from SHOP memberships — so both the email
  //    and phone identity of a shop admin surface it). Only ACTIVE shops.
  const shops = shopMembershipIds.length
    ? await Shop.find({ _id: { $in: shopMembershipIds }, status: 'ACTIVE' }).select('name createdAt').lean()
    : [];

  for (const s of shops as any[]) {
    entries.push({
      ctx: {
        contextId: `shop:${s._id.toString()}`,
        kind: 'SHOP',
        tenantType: TenantType.SHOP,
        tenantId: s._id.toString(),
        tenantName: s.name || 'Shop',
        unitType: 'SHOP',
        unitId: s._id.toString(),
        unitLabel: s.name || 'Shop',
        role: UserRole.SHOP_ADMIN,
      },
      sortAt: new Date(s.createdAt).getTime() || 0,
    });
  }

  entries.sort((a, b) => {
    const ko = kindOrder[a.ctx.kind] - kindOrder[b.ctx.kind];
    if (ko !== 0) return ko;
    if (a.sortAt !== b.sortAt) return a.sortAt - b.sortAt;
    return a.ctx.contextId.localeCompare(b.ctx.contextId);
  });

  return entries.map((e) => e.ctx);
};

/** Re-resolve and return the context matching contextId, or null if not owned. */
export const findContextById = async (
  user: IUser,
  contextId: string
): Promise<IResolvedContext | null> => {
  const contexts = await resolveUserContexts(user);
  return contexts.find((c) => c.contextId === contextId) || null;
};

/**
 * Backward-compat resolver: find the first context matching a tenantId+role
 * pair (the pre-unit switching key). Prefers a unit-bearing context.
 */
export const findContextByTenantRole = async (
  user: IUser,
  tenantId: string,
  role: string
): Promise<IResolvedContext | null> => {
  const contexts = await resolveUserContexts(user);
  const matches = contexts.filter((c) => c.tenantId === tenantId && c.role === role);
  if (matches.length === 0) return null;
  return matches.find((c) => c.unitId) || matches[0];
};

/** Build the JWT payload for an access token scoped to a context. */
export const toTokenPayload = (user: IUser, ctx: IResolvedContext): ISecureJwtPayload => ({
  userId: (user._id as mongoose.Types.ObjectId).toString(),
  activeTenantId: ctx.tenantId,
  activeTenantType: ctx.tenantType,
  activeRole: ctx.role,
  activeUnitType: ctx.unitType ?? undefined,
  activeUnitId: ctx.unitId ?? undefined,
  activeContextId: ctx.contextId,
});
