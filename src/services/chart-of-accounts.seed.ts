import mongoose, { ClientSession } from 'mongoose';
import { LedgerAccount, AccountType, SubLedgerDimension, normalBalanceForType } from '../models/ledger-account.model';

interface DefaultAccount {
  code: string;
  name: string;
  type: AccountType;
  isControlAccount?: boolean;
  subLedgerDimension?: SubLedgerDimension;
}

/**
 * Default chart of accounts for an Indian housing/co-operative society.
 * Codes: 1xxx assets, 2xxx liabilities, 3xxx funds/equity, 4xxx income, 5xxx expenses.
 * Extendable/editable per society; these are seeded as isSystem (cannot be deleted).
 */
export const DEFAULT_ACCOUNTS: DefaultAccount[] = [
  // Assets
  { code: '1100', name: 'Bank – Current A/c', type: 'ASSET' },
  { code: '1110', name: 'Cash in Hand', type: 'ASSET' },
  { code: '1120', name: 'Undeposited Cheques', type: 'ASSET' },
  { code: '1200', name: 'Sundry Debtors – Members', type: 'ASSET', isControlAccount: true, subLedgerDimension: 'FLAT' },
  { code: '1300', name: 'Fixed Deposits / Investments', type: 'ASSET' },
  { code: '1400', name: 'TDS Receivable', type: 'ASSET' },
  // Liabilities
  { code: '2100', name: "Members' Advance", type: 'LIABILITY', isControlAccount: true, subLedgerDimension: 'FLAT' },
  { code: '2200', name: 'Sundry Creditors – Vendors', type: 'LIABILITY', isControlAccount: true, subLedgerDimension: 'VENDOR' },
  { code: '2300', name: 'GST Output Payable', type: 'LIABILITY' },
  { code: '2310', name: 'TDS Payable', type: 'LIABILITY' },
  { code: '2400', name: 'Security Deposits', type: 'LIABILITY' },
  // Funds & equity
  { code: '3100', name: 'Corpus Fund', type: 'FUND' },
  { code: '3110', name: 'Sinking Fund', type: 'FUND' },
  { code: '3120', name: 'Repair & Maintenance Fund', type: 'FUND' },
  { code: '3900', name: 'Accumulated Surplus / Opening Balance Equity', type: 'EQUITY' },
  // Income
  { code: '4100', name: 'Maintenance Income', type: 'INCOME' },
  { code: '4110', name: 'Water Charges', type: 'INCOME' },
  { code: '4120', name: 'Parking Charges', type: 'INCOME' },
  { code: '4130', name: 'Non-Occupancy Charges', type: 'INCOME' },
  { code: '4140', name: 'Interest on Arrears', type: 'INCOME' },
  { code: '4150', name: 'Festival / Ad-hoc Collection', type: 'INCOME' },
  { code: '4200', name: 'Interest Income (Bank/FD)', type: 'INCOME' },
  { code: '4900', name: 'Rounding Off', type: 'INCOME' },
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
  { code: '5900', name: 'Rebates & Waivers', type: 'EXPENSE' },
];

/** Codes referenced by name elsewhere (posting map), so they stay stable. */
export const ACCOUNT_CODES = {
  BANK: '1100',
  CASH: '1110',
  UNDEPOSITED_CHEQUES: '1120',
  DEBTORS: '1200',
  INVESTMENTS: '1300',
  TDS_RECEIVABLE: '1400',
  MEMBERS_ADVANCE: '2100',
  CREDITORS: '2200',
  GST_OUTPUT: '2300',
  TDS_PAYABLE: '2310',
  CORPUS_FUND: '3100',
  SINKING_FUND: '3110',
  REPAIR_FUND: '3120',
  SURPLUS: '3900',
  MAINTENANCE_INCOME: '4100',
  INTEREST_ON_ARREARS: '4140',
  ROUNDING_OFF: '4900',
  GATEWAY_CHARGES: '5180',
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
  const ops = DEFAULT_ACCOUNTS.map((a) => ({
    updateOne: {
      filter: { societyId, code: a.code },
      update: {
        $setOnInsert: {
          societyId,
          code: a.code,
          name: a.name,
          type: a.type,
          normalBalance: normalBalanceForType(a.type),
          isControlAccount: a.isControlAccount || false,
          ...(a.subLedgerDimension ? { subLedgerDimension: a.subLedgerDimension } : {}),
          isSystem: true,
          isActive: true,
          openingBalancePaise: 0,
          currentBalancePaise: 0,
          createdBy,
          createdByName,
        },
      },
      upsert: true,
    },
  }));

  const res = await LedgerAccount.bulkWrite(ops as any, { session });
  return { upserted: res.upsertedCount };
}
