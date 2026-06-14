import mongoose, { Schema, Document } from 'mongoose';
import { TenantType } from '../constants/roles';

export interface IAuditLog extends Document {
  userId: mongoose.Types.ObjectId;
  userName: string;
  tenantId: mongoose.Types.ObjectId | null;
  tenantType: TenantType;
  action: string;
  resource: string;
  resourceId: mongoose.Types.ObjectId | string;
  ipAddress: string;
  userAgent: string;
  oldValues?: Record<string, any>;
  newValues?: Record<string, any>;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  userName: {
    type: String,
    required: true,
  },
  tenantId: {
    type: Schema.Types.ObjectId,
    default: null,
  },
  tenantType: {
    type: String,
    enum: Object.values(TenantType),
    required: true,
  },
  action: {
    type: String,
    required: true,
  },
  resource: {
    type: String,
    required: true,
  },
  resourceId: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  ipAddress: {
    type: String,
    required: true,
  },
  userAgent: {
    type: String,
    required: true,
  },
  oldValues: {
    type: Schema.Types.Mixed,
  },
  newValues: {
    type: Schema.Types.Mixed,
  },
}, {
  timestamps: { createdAt: true, updatedAt: false }, // Only need createdAt for audit logs
});

// Indexes for fast lookups & report generations
AuditLogSchema.index({ tenantId: 1, createdAt: -1 });
AuditLogSchema.index({ userId: 1, createdAt: -1 });
AuditLogSchema.index({ action: 1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
export default AuditLog;
