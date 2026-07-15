import mongoose from 'mongoose';
import { IFlat, Flat, FlatStatus } from '../models/flat.model';
import { Resident } from '../models/resident.model';
import { FlatTenure } from '../models/flat-tenure.model';
import { attachTenantMembership } from './identity.service';
import { TenantType, UserRole } from '../constants/roles';

export type ApprovalSide = 'SOCIETY' | 'FLAT_OWNER' | 'INVITED_USER';
export type InitiatorSide = 'SOCIETY' | 'FLAT_OWNER' | 'TENANT_HEAD';

/** Map a household relationship to the society role granted on approval. */
export const relationshipToRole = (relationship: string): UserRole => {
  if (relationship === 'OWNER') return UserRole.RESIDENT_OWNER;
  if (relationship === 'TENANT') return UserRole.RESIDENT_TENANT;
  return UserRole.FAMILY_MEMBER;
};

export interface RoutingResult {
  initiatorSide: InitiatorSide;
  requestedRole: UserRole;
  approverSide: ApprovalSide;
  approverUserId?: mongoose.Types.ObjectId;
  autoApprove: boolean;
}

/**
 * Decides who must approve a registration, based on WHO initiated it and the flat's
 * current ownership. Encodes the two-way rule:
 *   - society initiates  → the flat owner approves (auto when the flat has no owner)
 *   - flat owner initiates → the society admin approves
 *   - flat head adds household → auto-approved
 * `societyAdminUserId` is the society's admin (approver for owner-initiated requests).
 */
export const resolveRouting = (params: {
  initiatorRole: UserRole;
  relationship: string;
  flat: IFlat;
  societyAdminUserId?: mongoose.Types.ObjectId | null;
}): RoutingResult => {
  const { initiatorRole, relationship, flat, societyAdminUserId } = params;
  const requestedRole = relationshipToRole(relationship);
  const flatOwnerId = flat.ownerUserId as mongoose.Types.ObjectId | undefined;

  let initiatorSide: InitiatorSide;
  if (initiatorRole === UserRole.SOCIETY_ADMIN || initiatorRole === UserRole.SOCIETY_COMMITTEE) {
    initiatorSide = 'SOCIETY';
  } else if (initiatorRole === UserRole.RESIDENT_OWNER) {
    initiatorSide = 'FLAT_OWNER';
  } else {
    initiatorSide = 'TENANT_HEAD';
  }

  // Household add by the flat head (owner/tenant adding family) → auto-approved.
  if (initiatorSide === 'TENANT_HEAD') {
    return { initiatorSide, requestedRole, approverSide: 'SOCIETY', approverUserId: societyAdminUserId || undefined, autoApprove: true };
  }

  if (initiatorSide === 'FLAT_OWNER') {
    // Flat owner registers someone → the society admin approves.
    return { initiatorSide, requestedRole, approverSide: 'SOCIETY', approverUserId: societyAdminUserId || undefined, autoApprove: false };
  }

  // initiatorSide === 'SOCIETY'
  if (flatOwnerId) {
    // A current owner exists → they approve whatever the society registers into their flat.
    return { initiatorSide, requestedRole, approverSide: 'FLAT_OWNER', approverUserId: flatOwnerId, autoApprove: false };
  }
  // Ownerless flat: the society is authoritative for the initial owner/resident assignment.
  return { initiatorSide, requestedRole, approverSide: 'INVITED_USER', autoApprove: true };
};

export interface MaterializeArgs {
  flatId: mongoose.Types.ObjectId;
  societyId: mongoose.Types.ObjectId;
  name: string;
  email?: string;
  phone?: string;
  relationship: string;
  requestedRole: UserRole;
  actorUserId: mongoose.Types.ObjectId;
  actorName: string;
}

/**
 * Turns an approved request into real access: grants the society role on BOTH the email
 * and phone identities, creates the Resident row(s), links them to the flat, and (for an
 * owner) sets ownerUserId + flips a vacant flat to owner-occupied. Idempotent per identity.
 * Must run inside a Mongoose transaction (pass the session).
 */
export const materializeMembership = async (args: MaterializeArgs, session: mongoose.ClientSession) => {
  const isOwner = args.requestedRole === UserRole.RESIDENT_OWNER;

  const identities = await attachTenantMembership({
    email: args.email,
    phone: args.phone,
    name: args.name,
    tenantType: TenantType.SOCIETY,
    tenantId: args.societyId,
    role: args.requestedRole,
  }, session);

  const identityIds = [identities.emailUser?._id, identities.phoneUser?._id]
    .filter(Boolean) as mongoose.Types.ObjectId[];

  const flat = await Flat.findById(args.flatId).session(session);
  if (!flat) throw new Error('Flat not found while materializing membership');

  const created: any[] = [];
  for (const uid of identityIds) {
    const existing = await Resident.findOne({ flatId: flat._id, userId: uid }).session(session);
    if (existing) {
      // Re-activate + reconcile role if a stale row exists.
      existing.isActive = true;
      existing.relationship = args.relationship;
      existing.isOwner = isOwner || existing.isOwner;
      existing.updatedBy = args.actorUserId;
      existing.updatedByName = args.actorName;
      await existing.save({ session });
      created.push(existing);
      continue;
    }
    const resident = new Resident({
      flatId: flat._id,
      societyId: args.societyId,
      userId: uid,
      person: { name: args.name, email: args.email?.toLowerCase().trim(), phone: args.phone },
      relationship: args.relationship,
      isOwner,
      isHead: isOwner,
      isActive: true,
      createdBy: args.actorUserId,
      createdByName: args.actorName,
      updatedBy: args.actorUserId,
      updatedByName: args.actorName,
    });
    await resident.save({ session });
    if (!flat.residents.some((r) => r.toString() === resident._id.toString())) {
      flat.residents.push(resident._id as any);
    }
    created.push(resident);
  }

  if (isOwner && identityIds.length > 0) {
    const wasOwnerless = !flat.ownerUserId;
    if (wasOwnerless) flat.ownerUserId = identityIds[0];
    if (flat.status === FlatStatus.VACANT) flat.status = FlatStatus.OWNER_OCCUPIED;

    // First owner assignment opens the timeline with an INITIAL ownership period.
    if (wasOwnerless) {
      const activeOwnership = await FlatTenure.findOne({ flatId: flat._id, type: 'OWNERSHIP', status: 'ACTIVE' }).session(session);
      if (!activeOwnership) {
        await FlatTenure.create([{
          flatId: flat._id, societyId: args.societyId, type: 'OWNERSHIP',
          party: { userId: identityIds[0], name: args.name }, occupants: [],
          startDate: new Date(), endDate: null, status: 'ACTIVE', source: 'INITIAL',
          createdBy: args.actorUserId, createdByName: args.actorName, updatedBy: args.actorUserId, updatedByName: args.actorName,
        }], { session });
      }
    }
  }

  flat.updatedBy = args.actorUserId;
  flat.updatedByName = args.actorName;
  await flat.save({ session });

  return { residents: created, identityIds, generatedPassword: identities.generatedPassword };
};
