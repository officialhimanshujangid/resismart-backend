import mongoose, { ClientSession } from 'mongoose';
import { SequenceCounter } from '../models/sequence-counter.model';
import { formatDocNumber } from '../utils/financial-year.util';

/**
 * Atomically reserve the next sequence number for a society/scope/FY. Pass the
 * active `session` so the reservation lives inside the document-creating txn
 * (a rollback then releases the number instead of burning it).
 */
export async function nextSequence(
  societyId: string | mongoose.Types.ObjectId,
  scope: string,
  financialYear: string,
  session?: ClientSession,
): Promise<number> {
  const doc = await SequenceCounter.findOneAndUpdate(
    { societyId, scope, financialYear },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  );
  return doc!.seq;
}

/** Reserve the next number and format it via the numbering template in one call. */
export async function nextDocNumber(
  societyId: string | mongoose.Types.ObjectId,
  scope: string,
  financialYear: string,
  opts: { prefix: string; padding?: number; template?: string },
  session?: ClientSession,
): Promise<{ seq: number; number: string }> {
  const seq = await nextSequence(societyId, scope, financialYear, session);
  return {
    seq,
    number: formatDocNumber({ prefix: opts.prefix, fyString: financialYear, seq, padding: opts.padding, template: opts.template }),
  };
}
