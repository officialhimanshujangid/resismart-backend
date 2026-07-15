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
  return policy;
}

/** FY start month for a society (defaults to April = 4). */
export async function getFyStartMonth(societyId: string): Promise<number> {
  const policy = await FinancePolicy.findOne({ societyId }).select('financialYear').lean();
  return policy?.financialYear?.startMonth ?? 4;
}
