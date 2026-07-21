import { Request, Response, NextFunction } from 'express';
import { resolveAccess, allows, allowsBlock, EffectiveAccess } from '../services/access-role.service';
import { AccessModule, ACCESS_MODULES } from '../models/access-role.model';
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
 * Guard a whole router: reading needs the view permission, changing anything
 * needs the manage permission.
 *
 * Mounted with `router.use(...)` rather than repeated on 124 route lines, for
 * the same reason `requireSetupComplete` already is in that file — **a route
 * added next month is gated by default**. The finance module is the proof of
 * why that matters: `FINANCE_VIEW` and `FINANCE_MANAGE` existed in the
 * permission editor, an admin could set them to NONE, and not one of the ~124
 * finance routes ever consulted them. Every route carried `authorizeRoles`
 * alone, so any committee member — including one holding a seat with no role
 * assigned at all — could post journals, confirm payments and create vendors.
 * Hand-editing every line would have fixed today and not next month.
 *
 * GET and HEAD are the read side. Everything else changes something.
 */
export function requireModulePermission(readModule: AccessModule, writeModule: AccessModule) {
  const read = requirePermission(readModule, 'READ');
  const write = requirePermission(writeModule, 'FULL');
  return (req: Request, res: Response, next: NextFunction) => {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    return isRead ? read(req, res, next) : write(req, res, next);
  };
}

/**
 * A permission that residents are exempt from, because the handler clamps them
 * to their own flat instead.
 *
 * The gate log is the case this exists for. Residents belong there — they are
 * narrowed to their own flats by `residentFlatIds`, which is a stronger limit
 * than any permission. Everybody else must hold the permission, and until this
 * existed they held nothing: the route was `authorizeRoles(SOCIETY_ROLES)` and
 * nothing more, so an unassigned committee seat or a gardener with only
 * COMPLAINTS_OWN could read every visitor record in the society — phone
 * numbers, ID digits, notes — and pull the face photographs.
 *
 * Written as one middleware rather than a check inside the handler so the
 * exemption is visible on the route line. A rule that only exists three files
 * away is a rule the next person adding an endpoint will not know about.
 */
export function requirePermissionUnlessResident(module: AccessModule, needed: 'READ' | 'FULL') {
  const RESIDENT_ROLES: string[] = [
    UserRole.RESIDENT_OWNER, UserRole.RESIDENT_TENANT, UserRole.FAMILY_MEMBER,
  ];
  const gate = requirePermission(module, needed);

  return async (req: Request, res: Response, next: NextFunction) => {
    if (RESIDENT_ROLES.includes(String(req.user?.activeRole || ''))) {
      // Still resolve access, so anything downstream that filters by wing sees
      // the same object it would have seen on the guarded path.
      return attachAccess(req, res, next);
    }
    return gate(req, res, next);
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
      // Degrade to the NARROWEST access, never to none at all.
      //
      // This used to leave `req.access` undefined, which sounds like the
      // cautious choice and is the opposite. Every wing filter downstream is
      // written `if (access && ...)` — so an absent access object skips the
      // filter entirely, and a transient database hiccup *widened* a
      // wing-scoped member from two wings to the whole society. Failing to
      // resolve a permission must never read as holding it.
      logger.error(`attachAccess failed, degrading to no permissions: ${e.message}`);
      req.access = {
        role, isAdmin: false, awaitingRole: true,
        permissions: Object.fromEntries(ACCESS_MODULES.map(m => [m, 'NONE'])) as any,
        scope: { allBlocks: false, blockIds: [] },
      };
    }
  }
  next();
}
