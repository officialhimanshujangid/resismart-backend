import { Request, Response, NextFunction } from 'express';
import { resolveAccess, allows, allowsBlock, EffectiveAccess } from '../services/access-role.service';
import { AccessModule } from '../models/access-role.model';
import { UserRole } from '../constants/roles';
import { logger } from '../utils/logger.util';

/**
 * Enforce a module permission on the server.
 *
 * This exists because the permission model already in this codebase does not.
 * `PermissionRole` stores a read/create/edit/delete quad, the team screen edits
 * it, and the sidebar hides links accordingly — but nothing checks it on any
 * request. A hidden menu item is a courtesy, not a boundary: the API is one
 * `curl` away.
 *
 * Two dimensions, both checked here:
 *   - the LEVEL (NONE / READ / FULL) for the module
 *   - the WING, when the request names one
 *
 * The wing half matters more than it looks. Scoping a committee member to A and
 * B wing and then serving them C wing's complaints from an endpoint they can
 * call directly would repeat exactly the failure this module was designed
 * against — a neighbour reading a log that was never theirs.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Filled by `requirePermission`, so handlers need not resolve it twice. */
      access?: EffectiveAccess;
    }
  }
}

/** Where to look for a wing id on the request, when a route is wing-scoped. */
export type BlockSource = 'body' | 'query' | 'params';

interface Options {
  /**
   * Check the wing named by the request against the role's scope.
   *
   * Only for routes that address ONE wing. A list endpoint should not use this
   * — it should filter its results by `req.access.scope` instead, or a
   * wing-scoped member gets a blanket 403 rather than the subset they are
   * entitled to.
   */
  block?: { from: BlockSource; key?: string };
}

const readBlock = (req: Request, opt: NonNullable<Options['block']>): string | undefined => {
  const key = opt.key || 'blockId';
  const bag = opt.from === 'body' ? req.body : opt.from === 'query' ? req.query : req.params;
  const v = bag?.[key];
  return v ? String(v) : undefined;
};

export function requirePermission(module: AccessModule, needed: 'READ' | 'FULL', options: Options = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const societyId = req.user?.activeTenantId;
    const userId = req.user?.userId;
    const role = req.user?.activeRole as UserRole | undefined;

    if (!societyId || !userId || !role) {
      return res.status(401).json({ success: false, message: 'Not signed in to a society.' });
    }

    let access: EffectiveAccess;
    try {
      access = await resolveAccess(String(societyId), String(userId), role);
    } catch (e: any) {
      // Unlike the setup gate, this one fails CLOSED. That gate guards a
      // workflow step; this guards other people's data, and "we could not
      // check" must never mean "go ahead".
      logger.error(`requirePermission(${module}) could not resolve access: ${e.message}`);
      return res.status(503).json({ success: false, message: 'Could not check your permissions. Try again.' });
    }

    if (!allows(access, module, needed)) {
      return res.status(403).json({
        success: false,
        code: access.awaitingRole ? 'ACCESS_NOT_ASSIGNED' : 'ACCESS_DENIED',
        message: access.awaitingRole
          ? 'You hold a committee seat but nobody has said what you may do yet. Ask your society admin to assign you a role.'
          : 'You do not have access to this.',
      });
    }

    if (options.block) {
      const blockId = readBlock(req, options.block);
      if (!allowsBlock(access, blockId)) {
        return res.status(403).json({
          success: false,
          code: 'ACCESS_WRONG_WING',
          message: 'Your access is limited to certain wings, and this is not one of them.',
        });
      }
    }

    req.access = access;
    next();
  };
}

/**
 * Resolve access without demanding anything, for handlers that need to FILTER
 * rather than refuse — a complaints list that should return A and B wing to a
 * member scoped to those two, not a 403.
 */
export async function attachAccess(req: Request, _res: Response, next: NextFunction) {
  const societyId = req.user?.activeTenantId;
  const userId = req.user?.userId;
  const role = req.user?.activeRole as UserRole | undefined;
  if (societyId && userId && role) {
    try {
      req.access = await resolveAccess(String(societyId), String(userId), role);
    } catch (e: any) {
      logger.error(`attachAccess failed: ${e.message}`);
    }
  }
  next();
}
