/**
 * Identity provisioning for the identifier-scoped login model.
 *
 * A login account = ONE verified identifier (email OR phone). A tenant that is
 * registered with an email AND a phone therefore grants access to BOTH the
 * email-identity and the phone-identity — which is why logging in with the
 * email vs the phone can surface different (overlapping) sets of tenants.
 *
 * Tenant identities are passwordless (OTP login) — no passwordHash is set here.
 */
import mongoose from 'mongoose';
import { User, IUser } from '../models/user.model';
import { normalizePhone, isEmail } from '../utils/phone.util';
import { TenantType, UserRole } from '../constants/roles';
import crypto from 'crypto';
import { hashPassword } from '../utils/hash.util';

export interface AttachArgs {
  email?: string;
  phone?: string;
  name: string;
  tenantType: TenantType;
  tenantId: mongoose.Types.ObjectId | string;
  role: UserRole;
  isActive?: boolean; // default true; shops pass false until approval
}

export interface AttachResult {
  emailUser?: IUser;
  phoneUser?: IUser;
  generatedPassword?: string;
}

const addMembership = (
  user: IUser,
  tenantType: TenantType,
  tenantId: mongoose.Types.ObjectId,
  role: UserRole
): void => {
  const exists = user.memberships.some(
    (m) => m.tenantId.toString() === tenantId.toString() && m.role === role && m.tenantType === tenantType
  );
  if (!exists) user.memberships.push({ tenantType, tenantId, role });
};

const findOne = (filter: any, session?: mongoose.ClientSession) => {
  const q = User.findOne(filter);
  if (session) q.session(session);
  return q.exec();
};

/**
 * Attach `role` on `tenant` to the email identity and the phone identity,
 * creating a passwordless identity for whichever doesn't exist yet.
 */
export const attachTenantMembership = async (
  args: AttachArgs,
  session?: mongoose.ClientSession
): Promise<AttachResult> => {
  const tenantId = new mongoose.Types.ObjectId(args.tenantId.toString());
  const isActive = args.isActive !== false;
  const out: AttachResult = {};

  if (args.email && isEmail(args.email)) {
    const email = args.email.toLowerCase().trim();
    let u = await findOne({ email }, session);
    if (!u) {
      const plainPassword = crypto.randomBytes(4).toString('hex');
      const passwordHash = await hashPassword(plainPassword);
      u = new User({ email, name: args.name, isActive, memberships: [], passwordHash });
      out.generatedPassword = plainPassword;
    }
    if (isActive) u.isActive = true;
    addMembership(u, args.tenantType, tenantId, args.role);
    await u.save(session ? { session } : {});
    out.emailUser = u;
  }

  if (args.phone) {
    const phone = normalizePhone(args.phone);
    if (phone) {
      let u = await findOne({ phone }, session);
      if (!u) u = new User({ phone, name: args.name, isActive, memberships: [] });
      if (isActive) u.isActive = true;
      addMembership(u, args.tenantType, tenantId, args.role);
      await u.save(session ? { session } : {});
      out.phoneUser = u;
    }
  }

  return out;
};

/** The display/primary identity id for a tenant (email identity preferred). */
export const primaryIdentityId = (r: AttachResult): mongoose.Types.ObjectId | undefined =>
  (r.emailUser?._id || r.phoneUser?._id) as mongoose.Types.ObjectId | undefined;
