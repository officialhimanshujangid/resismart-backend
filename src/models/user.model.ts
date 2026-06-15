import mongoose, { Schema, Document } from 'mongoose';
import { TenantType, UserRole } from '../constants/roles';

export interface IMembership {
  tenantType: TenantType;
  tenantId: mongoose.Types.ObjectId;
  role: UserRole;
}

export interface IUser extends Document {
  name: string;
  email: string;
  passwordHash: string;
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
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  passwordHash: {
    type: String,
    required: true,
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

export const User = mongoose.model<IUser>('User', UserSchema);
export default User;
