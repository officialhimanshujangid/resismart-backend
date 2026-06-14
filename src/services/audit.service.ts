import mongoose from 'mongoose';
import { AuditLog } from '../models/audit.model';
import { TenantType } from '../constants/roles';
import { logger } from '../utils/logger.util';

export interface IAuditDetails {
  userId: string | mongoose.Types.ObjectId;
  userName: string;
  tenantId: string | mongoose.Types.ObjectId | null;
  tenantType: TenantType;
  action: string;
  resource: string;
  resourceId: string | mongoose.Types.ObjectId;
  ipAddress: string;
  userAgent: string;
  oldValues?: Record<string, any>;
  newValues?: Record<string, any>;
}

export class AuditService {
  /**
   * Logs a user action asynchronously. Bypasses blocking key paths to ensure fast API responses.
   */
  static log(details: IAuditDetails): void {
    // Execute DB insertion asynchronously so the HTTP response is not delayed
    AuditLog.create({
      userId: new mongoose.Types.ObjectId(details.userId),
      userName: details.userName,
      tenantId: details.tenantId ? new mongoose.Types.ObjectId(details.tenantId) : null,
      tenantType: details.tenantType,
      action: details.action,
      resource: details.resource,
      resourceId: new mongoose.Types.ObjectId(details.resourceId),
      ipAddress: details.ipAddress || 'unknown',
      userAgent: details.userAgent || 'unknown',
      oldValues: details.oldValues,
      newValues: details.newValues,
    })
      .then((log) => {
        logger.debug(`Audit log recorded: ${log._id} - Action: ${details.action}`);
      })
      .catch((error) => {
        logger.error(`Failed to record audit log: ${error.message}`);
      });
  }
}
export default AuditService;
