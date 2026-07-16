import mongoose, { ClientSession } from 'mongoose';
import { LedgerAccount, AccountType, SubLedgerDimension, NormalBalance, normalBalanceForType } from '../models/ledger-account.model';

interface DefaultAccount {
  code: string;
  name: string;
  type: AccountType;
  isControlAccount?: boolean;
  subLedgerDimension?: SubLedgerDimension;
  /**
   * Overrides the type's usual side. Only contra accounts need this — e.g.
   * Accumulated Depreciation is an ASSET that carries a CREDIT balance and nets
   * against the assets above it.
   */
  normalBalance?: NormalBalance;
  /** Groups an account under a heading for Balance Sheet schedules. */
  parentCode?: string;
  /** Member contributions are mutual (not taxable); FD/bank interest is not. */
  taxability?: 'MUTUAL' | 'TAXABLE';
}

/**
 * Default chart of accounts for an Indian housing/co-operative society.
 * Codes: 1xxx assets, 2xxx liabilities, 3xxx funds/equity, 4xxx income, 5xxx expenses.
 * Extendable/editable per society; these are seeded as isSystem (cannot be deleted).
 */
export const DEFAULT_ACCOUNTS: DefaultAccount[] = [
  // Assets
  { code: '1100', name: 'Bank – Current A/c', type: 'ASSET', parentCode: '1000' },
  { code: '1105', name: 'Bank – Savings A/c', type: 'ASSET', parentCode: '1000' },
  { code: '1110', name: 'Cash in Hand', type: 'ASSET', parentCode: '1000' },
  { code: '1120', name: 'Undeposited Cheques', type: 'ASSET', parentCode: '1000' },
  { code: '1200', name: 'Sundry Debtors – Members', type: 'ASSET', isControlAccount: true, subLedgerDimension: 'FLAT' },
  { code: '1300', name: 'Fixed Deposits / Investments', type: 'ASSET' },
  { code: '1400', name: 'TDS Receivable', type: 'ASSET' },
  { code: '1450', name: 'Prepaid Expenses', type: 'ASSET' },
  // Fixed assets — a society Balance Sheet without these isn't a Balance Sheet.
  // 1505, not 1500: the "Fixed Assets" heading owns 1500 and is seeded first,
  // so a Building account sharing that code was silently swallowed by the
  // upsert's $setOnInsert and never existed in any society's books.
  { code: '1505', name: 'Building & Structure', type: 'ASSET', parentCode: '1500' },
  { code: '1510', name: 'Lift & Elevators', type: 'ASSET', parentCode: '1500' },
  { code: '1520', name: 'Plant & Machinery (pumps, DG, STP)', type: 'ASSET', parentCode: '1500' },
  { code: '1530', name: 'Furniture & Fixtures', type: 'ASSET', parentCode: '1500' },
  { code: '1540', name: 'Computers & Equipment', type: 'ASSET', parentCode: '1500' },
  // Contra-asset: an ASSET that carries a CREDIT balance and nets against the above.
  { code: '1590', name: 'Accumulated Depreciation', type: 'ASSET', normalBalance: 'CREDIT', parentCode: '1500' },
  // Liabilities
  { code: '2100', name: "Members' Advance", type: 'LIABILITY', isControlAccount: true, subLedgerDimension: 'FLAT' },
  { code: '2200', name: 'Sundry Creditors – Vendors', type: 'LIABILITY', isControlAccount: true, subLedgerDimension: 'VENDOR' },
  { code: '2300', name: 'GST Output Payable', type: 'LIABILITY' },
  { code: '2310', name: 'TDS Payable', type: 'LIABILITY' },
  { code: '2400', name: 'Security Deposits', type: 'LIABILITY' },
  { code: '2500', name: 'Outstanding Liabilities (accrued)', type: 'LIABILITY' },
  { code: '2600', name: 'Income Tax Payable', type: 'LIABILITY' },
  // With UPI and NEFT, money regularly arrives with no usable reference. It has
  // to land somewhere until someone can attribute it to a flat.
  { code: '2900', name: 'Suspense – Unidentified Receipts', type: 'LIABILITY' },
  // Funds & equity
  { code: '3000', name: 'Share Capital', type: 'EQUITY' },
  { code: '3100', name: 'Corpus Fund', type: 'FUND' },
  { code: '3110', name: 'Sinking Fund', type: 'FUND' },
  { code: '3120', name: 'Repair & Maintenance Fund', type: 'FUND' },
  { code: '3900', name: 'Accumulated Surplus / Opening Balance Equity', type: 'EQUITY' },
  // Income — `taxability` drives the ITR-5 / mutuality split. Member contributions
  // are mutual and not taxable; interest earned from a bank is not mutual.
  { code: '4100', name: 'Maintenance Income', type: 'INCOME', taxability: 'MUTUAL' },
  { code: '4110', name: 'Water Charges', type: 'INCOME', taxability: 'MUTUAL' },
  { code: '4120', name: 'Parking Charges', type: 'INCOME', taxability: 'MUTUAL' },
  { code: '4130', name: 'Non-Occupancy Charges', type: 'INCOME', taxability: 'MUTUAL' },
  { code: '4140', name: 'Interest on Arrears', type: 'INCOME', taxability: 'MUTUAL' },
  { code: '4150', name: 'Festival / Ad-hoc Collection', type: 'INCOME', taxability: 'MUTUAL' },
  { code: '4160', name: 'Transfer & NOC Fees', type: 'INCOME', taxability: 'MUTUAL' },
  { code: '4200', name: 'Interest Income (Bank/FD)', type: 'INCOME', taxability: 'TAXABLE' },
  { code: '4210', name: 'Rent from Mobile Towers / Hoardings', type: 'INCOME', taxability: 'TAXABLE' },
  // Selling an asset for more than its written-down value is a gain from outside
  // the membership, so it is taxable — not covered by mutuality.
  { code: '4220', name: 'Profit on Sale of Assets', type: 'INCOME', taxability: 'TAXABLE' },
  { code: '4900', name: 'Rounding Off', type: 'INCOME', taxability: 'MUTUAL' },
  // Expenses
  { code: '5100', name: 'Security / Guard Charges', type: 'EXPENSE' },
  { code: '5110', name: 'Housekeeping', type: 'EXPENSE' },
  { code: '5120', name: 'Electricity', type: 'EXPENSE' },
  { code: '5130', name: 'Water Expense', type: 'EXPENSE' },
  { code: '5140', name: 'Repairs & Maintenance', type: 'EXPENSE' },
  { code: '5150', name: 'Lift AMC', type: 'EXPENSE' },
  { code: '5160', name: 'Audit / Professional Fees', type: 'EXPENSE' },
  { code: '5170', name: 'Administration', type: 'EXPENSE' },
  { code: '5180', name: 'Bank / Gateway Charges', type: 'EXPENSE' },
  { code: '5190', name: 'Depreciation', type: 'EXPENSE' },
  { code: '5195', name: 'Loss on Sale of Assets', type: 'EXPENSE' },
  { code: '5900', name: 'Rebates & Waivers', type: 'EXPENSE' },
];

/** Headings used to group accounts into Balance Sheet schedules. */
export const ACCOUNT_GROUPS: { code: string; name: string; type: AccountType }[] = [
  { code: '1000', name: 'Cash & Bank Balances', type: 'ASSET' },
  { code: '1500', name: 'Fixed Assets', type: 'ASSET' },
];

/** Codes referenced by name elsewhere (posting map), so they stay stable. */
export const ACCOUNT_CODES = {
  BANK: '1100',
  BANK_SAVINGS: '1105',
  CASH: '1110',
  UNDEPOSITED_CHEQUES: '1120',
  DEBTORS: '1200',
  INVESTMENTS: '1300',
  TDS_RECEIVABLE: '1400',
  FIXED_ASSETS: '1500',
  BUILDING: '1505',
  ACCUMULATED_DEPRECIATION: '1590',
  MEMBERS_ADVANCE: '2100',
  CREDITORS: '2200',
  GST_OUTPUT: '2300',
  TDS_PAYABLE: '2310',
  SECURITY_DEPOSITS: '2400',
  SUSPENSE: '2900',
  SHARE_CAPITAL: '3000',
  CORPUS_FUND: '3100',
  SINKING_FUND: '3110',
  REPAIR_FUND: '3120',
  SURPLUS: '3900',
  MAINTENANCE_INCOME: '4100',
  INTEREST_ON_ARREARS: '4140',
  TRANSFER_FEES: '4160',
  INTEREST_INCOME: '4200',
  PROFIT_ON_SALE: '4220',
  ROUNDING_OFF: '4900',
  GATEWAY_CHARGES: '5180',
  DEPRECIATION: '5190',
  LOSS_ON_SALE: '5195',
  REBATES_WAIVERS: '5900',
} as const;

/**
 * Idempotently seed the default chart of accounts for a society. Existing
 * accounts (matched by code) are left untouched; only missing ones are inserted.
 */
export async function seedChartOfAccounts(
  societyId: string | mongoose.Types.ObjectId,
  createdBy: string | mongoose.Types.ObjectId,
  createdByName: string,
  session?: ClientSession,
): Promise<{ upserted: number }> {
  const base = { societyId, isSystem: true, isActive: true, currentBalancePaise: 0, createdBy, createdByName };

  // Headings first — a child's parentAccountId needs its parent's _id to exist.
  const groupOps = ACCOUNT_GROUPS.map((g) => ({
    updateOne: {
      filter: { societyId, code: g.code },
      update: { $setOnInsert: { ...base, code: g.code, name: g.name, type: g.type, normalBalance: normalBalanceForType(g.type), isControlAccount: false } },
      upsert: true,
    },
  }));
  if (groupOps.length) await LedgerAccount.bulkWrite(groupOps as any, { session });

  const groups = await LedgerAccount.find({ societyId, code: { $in: ACCOUNT_GROUPS.map(g => g.code) } }).select('code').session(session ?? null).lean();
  const groupIdByCode = new Map(groups.map(g => [g.code, g._id]));

  const ops = DEFAULT_ACCOUNTS.map((a) => ({
    updateOne: {
      filter: { societyId, code: a.code },
      update: {
        $setOnInsert: {
          ...base,
          code: a.code,
          name: a.name,
          type: a.type,
          // Contra accounts declare their own side; everything else follows its type.
          normalBalance: a.normalBalance || normalBalanceForType(a.type),
          isControlAccount: a.isControlAccount || false,
          ...(a.subLedgerDimension ? { subLedgerDimension: a.subLedgerDimension } : {}),
          ...(a.parentCode && a.parentCode !== a.code && groupIdByCode.has(a.parentCode)
            ? { parentAccountId: groupIdByCode.get(a.parentCode) } : {}),
          ...(a.taxability ? { taxability: a.taxability } : {}),
        },
      },
      upsert: true,
    },
  }));

  const res = await LedgerAccount.bulkWrite(ops as any, { session });

  // Backfill for societies seeded before grouping and mutuality existed. The
  // upserts above use $setOnInsert, so they never touch an account that is
  // already there — without this, an existing society's Cash & Bank and Fixed
  // Asset schedules would come out empty and its income would all read as
  // untagged. Only fills gaps: an explicitly-set value is left alone.
  const backfill = DEFAULT_ACCOUNTS.flatMap((a) => {
    const ops: any[] = [];
    if (a.parentCode && a.parentCode !== a.code && groupIdByCode.has(a.parentCode)) {
      ops.push({
        updateOne: {
          filter: { societyId, code: a.code, parentAccountId: { $exists: false } },
          update: { $set: { parentAccountId: groupIdByCode.get(a.parentCode) } },
        },
      });
    }
    if (a.taxability) {
      ops.push({
        updateOne: {
          filter: { societyId, code: a.code, taxability: { $exists: false } },
          update: { $set: { taxability: a.taxability } },
        },
      });
    }
    return ops;
  });
  if (backfill.length) await LedgerAccount.bulkWrite(backfill as any, { session });

  return { upserted: res.upsertedCount };
}
