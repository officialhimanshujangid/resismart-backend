import { FinanceFund } from '../models/finance-fund.model';
import { LedgerAccount } from '../models/ledger-account.model';

// Default mapping of a fund card's category to its FUND ledger account code.
const CATEGORY_TO_CODE: Record<string, string> = { CORPUS: '3100', SINKING: '3110', REPAIR: '3120' };

/**
 * Reconcile FinanceFund cards against their ledger-backed FUND accounts so the
 * displayed balance reflects real money movements (fixes the "funds never move"
 * gap). Links by explicit ledgerAccountId, else by category → default code.
 */
export async function reconcileSocietyFunds(societyId: string): Promise<{ reconciled: number }> {
  const [funds, accounts] = await Promise.all([
    FinanceFund.find({ societyId }),
    LedgerAccount.find({ societyId, type: 'FUND' }),
  ]);
  const byId = new Map(accounts.map(a => [a._id.toString(), a]));
  const byCode = new Map(accounts.map(a => [a.code, a]));
  let reconciled = 0;
  for (const f of funds) {
    const acct = (f.ledgerAccountId && byId.get(f.ledgerAccountId.toString())) || byCode.get(CATEGORY_TO_CODE[f.category]);
    if (!acct) continue;
    f.currentBalancePaise = acct.currentBalancePaise;
    f.ledgerAccountId = acct._id as any;
    await f.save();
    reconciled++;
  }
  return { reconciled };
}
