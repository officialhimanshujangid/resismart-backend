import { Request } from 'express';
import { AuditService } from '../services/audit.service';
import { TenantType } from '../constants/roles';

/** Fire-and-forget audit log for a finance mutation, scoped to the active society. */
export function auditFinance(
  req: Request,
  action: string,
  resource: string,
  resourceId: string,
  extra?: { oldValues?: Record<string, any>; newValues?: Record<string, any> },
): void {
  try {
    if (!req.user?.activeTenantId || !resourceId) return;
    AuditService.log({
      userId: req.user.userId,
      userName: req.user.userName || 'Unknown',
      tenantId: req.user.activeTenantId,
      tenantType: TenantType.SOCIETY,
      action,
      resource,
      resourceId,
      ipAddress: req.ip || 'unknown',
      userAgent: (req.headers['user-agent'] as string) || 'unknown',
      oldValues: extra?.oldValues,
      newValues: extra?.newValues,
    });
  } catch { /* never block the response on audit */ }
}
