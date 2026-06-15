import mongoose, { Schema, Document } from 'mongoose';

export interface IModulePermission {
  module: string;       // e.g. "societies", "shops", "audit-logs", "settings"
  moduleLabel: string;  // Human-readable label e.g. "Societies"
  canRead: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export interface IPermissionRole extends Document {
  name: string;
  description?: string;
  permissions: IModulePermission[];
  isActive: boolean;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ModulePermissionSchema = new Schema<IModulePermission>(
  {
    module: { type: String, required: true },
    moduleLabel: { type: String, required: true },
    canRead: { type: Boolean, default: false },
    canCreate: { type: Boolean, default: false },
    canEdit: { type: Boolean, default: false },
    canDelete: { type: Boolean, default: false },
  },
  { _id: false }
);

const PermissionRoleSchema = new Schema<IPermissionRole>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    description: {
      type: String,
      trim: true,
    },
    permissions: [ModulePermissionSchema],
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
  },
  { timestamps: true }
);

export const PermissionRole = mongoose.model<IPermissionRole>('PermissionRole', PermissionRoleSchema);
export default PermissionRole;
