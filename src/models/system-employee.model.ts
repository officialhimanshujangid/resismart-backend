import mongoose, { Schema, Document } from 'mongoose';

export interface ISystemEmployee extends Document {
  userId: mongoose.Types.ObjectId;
  designationId: mongoose.Types.ObjectId;
  permissionRoleId: mongoose.Types.ObjectId;
  employeeCode: string;
  phone?: string;
  isActive: boolean;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  bankDetails?: {
    bankName: string;
    accountNumber: string;
    ifscCode: string;
  };
  address?: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  dateOfBirth?: Date;
  dateOfJoining?: Date;
  emergencyContact?: string;
  reportingManagerId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SystemEmployeeSchema = new Schema<ISystemEmployee>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    designationId: {
      type: Schema.Types.ObjectId,
      ref: 'Designation',
      required: true,
    },
    permissionRoleId: {
      type: Schema.Types.ObjectId,
      ref: 'PermissionRole',
      required: true,
    },
    employeeCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    bankDetails: {
      bankName: { type: String, trim: true },
      accountNumber: { type: String, trim: true },
      ifscCode: { type: String, trim: true },
    },
    address: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      zipCode: { type: String, trim: true },
      country: { type: String, trim: true },
    },
    dateOfBirth: {
      type: Date,
    },
    dateOfJoining: {
      type: Date,
    },
    emergencyContact: {
      type: String,
      trim: true,
    },
    reportingManagerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

SystemEmployeeSchema.index({ designationId: 1 });
SystemEmployeeSchema.index({ permissionRoleId: 1 });

export const SystemEmployee = mongoose.model<ISystemEmployee>('SystemEmployee', SystemEmployeeSchema);
export default SystemEmployee;
