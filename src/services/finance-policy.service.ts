import { FinancePolicy, IFinancePolicy } from '../models/finance-policy.model';
import { seedChartOfAccounts } from './chart-of-accounts.seed';
import { logger } from '../utils/logger.util';

/**
 * Load or lazily create a society's FinancePolicy (with sensible Indian-society
 * defaults). Also ensures the default chart of accounts exists, so finance is
 * fully initialized the first time policy is touched.
 */
export async function getOrCreatePolicy(societyId: string, userId: string, userName: string): Promise<IFinancePolicy> {
  let policy = await FinancePolicy.findOne({ societyId });
  if (!policy) {
    policy = await FinancePolicy.create({
      societyId,
      createdBy: userId,
      createdByName: userName,
      updatedBy: userId,
      updatedByName: userName,
    });
    try {
      await seedChartOfAccounts(societyId, userId, userName);
    } catch (e: any) {
      logger.error(`Failed to seed chart of accounts for society ${societyId}: ${e.message}`);
    }
  }

  // Retire the removed PLATFORM_ROUTE settlement mode.
  //
  // It is gone from the enum, so a society still carrying the old value would
  // fail Mongoose validation on the very next save of this document — and
  // several ordinary paths save it (TDS resolution, module inference), which
  // would break expense creation for a reason nobody could trace back to here.
  // Healing it at the single door every policy read goes through is safer than
  // a migration script somebody has to remember to run.
  //
  // PLATFORM_COLLECT_PAYOUT is the honest landing spot: routeAccountId was never
  // read at payment time, so these societies were already behaving exactly this
  // way. They will be asked for payout bank details the next time they open the
  // settlement screen, which is correct — that money has to reach them somehow.
  if ((policy.settlement?.mode as string) === 'PLATFORM_ROUTE') {
    policy.settlement.mode = 'PLATFORM_COLLECT_PAYOUT';
    await policy.save();
    logger.info(`Society ${societyId}: settlement PLATFORM_ROUTE → PLATFORM_COLLECT_PAYOUT (mode retired)`);
  }

  return policy;
}

/** FY start month for a society (defaults to April = 4). */
export async function getFyStartMonth(societyId: string): Promise<number> {
  const policy = await FinancePolicy.findOne({ societyId }).select('financialYear').lean();
  return policy?.financialYear?.startMonth ?? 4;
}
