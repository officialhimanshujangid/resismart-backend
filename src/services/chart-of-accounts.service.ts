import { LedgerAccount, ILedgerAccount, AccountType, normalBalanceForType } from '../models/ledger-account.model';
import { JournalEntry } from '../models/journal-entry.model';

/**
 * Editing the chart of accounts.
 *
 * The seeder has always called the chart "extendable/editable per society" and
 * marks its own rows `isSystem` so they can't be removed — a flag that only makes
 * sense next to a CRUD surface, which was never built. This is that surface.
 */

export interface Actor { userId: string; userName: string }

/** Thrown for a caller mistake — the controller maps these to 4xx, not 500. */
export class AccountError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function createAccount(
  societyId: string,
  body: { code: string; name: string; type: AccountType; isControlAccount?: boolean; parentAccountId?: string },
  actor: Actor,
): Promise<ILedgerAccount> {
  const code = String(body.code).trim();
  if (await LedgerAccount.findOne({ societyId, code })) {
    throw new AccountError(`Account code ${code} is already in use`, 409);
  }
  return LedgerAccount.create({
    societyId,
    code,
    name: String(body.name).trim(),
    type: body.type,
    normalBalance: normalBalanceForType(body.type),
    isControlAccount: Boolean(body.isControlAccount),
    parentAccountId: body.parentAccountId || undefined,
    isSystem: false,
    isActive: true,
    currentBalancePaise: 0,
    createdBy: actor.userId,
    createdByName: actor.userName,
  });
}

export async function updateAccount(
  societyId: string,
  id: string,
  body: { name?: string; isActive?: boolean; parentAccountId?: string | null },
): Promise<ILedgerAccount> {
  const account = await LedgerAccount.findOne({ _id: id, societyId });
  if (!account) throw new AccountError('Account not found', 404);

  // Code and type are immutable: postings reference the code, and flipping the
  // type would silently move an account between the Balance Sheet and the I&E,
  // rewriting history that has already been reported to members.
  if (body.name !== undefined) account.name = String(body.name).trim();
  if (body.parentAccountId !== undefined) account.parentAccountId = (body.parentAccountId as any) || undefined;
  if (body.isActive !== undefined) {
    if (!body.isActive && account.isSystem) {
      throw new AccountError('A system account cannot be deactivated — the posting engine relies on it');
    }
    account.isActive = Boolean(body.isActive);
  }
  await account.save();
  return account;
}

export async function deleteAccount(societyId: string, id: string): Promise<{ deleted: true }> {
  const account = await LedgerAccount.findOne({ _id: id, societyId });
  if (!account) throw new AccountError('Account not found', 404);
  if (account.isSystem) throw new AccountError('A system account cannot be deleted — the posting engine relies on it');

  // Never delete an account with history: the vouchers referencing it would point
  // at nothing and the ledger could no longer be rebuilt. Deactivate instead.
  const used = await JournalEntry.countDocuments({ societyId, 'lines.accountId': account._id });
  if (used > 0) {
    throw new AccountError(`This account has ${used} posted entr${used === 1 ? 'y' : 'ies'} and cannot be deleted. Deactivate it instead.`);
  }
  await account.deleteOne();
  return { deleted: true };
}
