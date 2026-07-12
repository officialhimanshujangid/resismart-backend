import mongoose, { Schema, Document } from 'mongoose';
import { TenantType, UserRole } from '../constants/roles';

export interface IMembership {
  tenantType: TenantType;
  tenantId: mongoose.Types.ObjectId;
  role: UserRole;
}

export interface IUser extends Document {
  name: string;
  // A User row = one login IDENTITY, keyed by a single identifier: email OR phone.
  // Tenant identities are passwordless (OTP login); owner/staff have a passwordHash.
  email?: string;
  phone?: string;
  phoneVerifiedAt?: Date; // reserved for future OTP verification
  passwordHash?: string;
  isActive: boolean;
  memberships: IMembership[];
  resetPasswordToken?: string;
  resetPasswordExpires?: Date;
  profileImage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MembershipSchema = new Schema<IMembership>({
  tenantType: {
    type: String,
    enum: Object.values(TenantType),
    required: true,
  },
  tenantId: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  role: {
    type: String,
    enum: Object.values(UserRole),
    required: true,
  },
}, { _id: false });

const UserSchema = new Schema<IUser>({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  phoneVerifiedAt: {
    type: Date,
  },
  passwordHash: {
    type: String,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  resetPasswordToken: {
    type: String,
  },
  resetPasswordExpires: {
    type: Date,
  },
  profileImage: {
    type: String,
  },
  memberships: [MembershipSchema],
}, {
  timestamps: true,
});

// Indexes for performance optimization
UserSchema.index({ 'memberships.tenantId': 1 });
UserSchema.index({ 'memberships.role': 1 });
// Sparse-unique identifiers: an identity is keyed by EITHER email or phone, and
// each identifier maps to exactly one identity. Sparse allows the other field to
// be absent (phone-only or email-only identities).
UserSchema.index({ email: 1 }, { unique: true, sparse: true });
UserSchema.index({ phone: 1 }, { unique: true, sparse: true });

export const User = mongoose.model<IUser>('User', UserSchema);
export default User;
