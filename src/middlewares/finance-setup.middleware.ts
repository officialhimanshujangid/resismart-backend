import { Request, Response, NextFunction } from 'express';
import { isSetupComplete } from '../services/finance-setup.service';

/**
 * Paths that must keep working while setup is unanswered — because they are how
 * a society answers it.
 *
 * Matched as prefixes against the path within this router. Everything here is
 * either the setup flow itself, or a step somebody has to be able to take
 * before they can state an opening position: choose a financial year, add the
 * account they bank into, import their flats.
 */
const SETUP_PATHS = [
  '/setup',
  '/settings',
  '/policy',
  '/modules',
  '/import',
  // The chart of accounts, so a society can add the account it banks into
  // before it states what is in it.
  //
  // NOT `/ledger` wholesale: that would leave `POST /ledger/journal` open, and
  // arbitrary double-entry posting is the most powerful write in the module.
  // Gating expenses while leaving raw journals open would mean "record whatever
  // you like, as long as you use the harder screen." Stating an opening
  // position by hand is what `/setup/complete` is for.
  '/ledger/accounts',
];

/**
 * Refuse to record business until the society has said where its books start.
 *
 * Mounted once on the finance router rather than listed on each route, for two
 * reasons: there are over a hundred routes and a hand-maintained list would
 * drift, and — more importantly — a route added next year is gated by default
 * instead of quietly slipping through because nobody remembered this file.
 *
 * Reads are always allowed. Somebody arriving at a half-configured society
 * should be able to look around, and the screens need their data to render the
 * explanation of why they are locked.
 *
 * Note what this does NOT gate: flats, members, committee, documents, and
 * everything outside finance. The books are unanswered, not the society.
 */
export async function requireSetupComplete(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  // Lower-cased because Express routes case-insensitively by default: without
  // this, `POST /Setup/complete` reaches the controller but fails the allowlist.
  const path = (req.path || '').toLowerCase();
  if (SETUP_PATHS.some(p => path === p || path.startsWith(`${p}/`))) return next();

  const societyId = req.user?.activeTenantId;
  if (!societyId) return next(); // enforceTenantAccess already had its say

  try {
    if (await isSetupComplete(String(societyId))) return next();
  } catch {
    // A lookup failure must not become a lockout. The gate is a guard rail, not
    // a load-bearing wall, and failing open here is safer than failing closed.
    return next();
  }

  return res.status(403).json({
    success: false,
    code: 'FINANCE_SETUP_INCOMPLETE',
    message:
      'Opening balances have not been set for this society. Complete finance setup before recording anything — otherwise the balance sheet is wrong from the first day.',
  });
}
