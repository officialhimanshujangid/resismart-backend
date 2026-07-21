import mongoose from 'mongoose';
import { VisitorEntry, IVisitorEntry } from '../models/visitor-entry.model';
import { ApprovalRequest } from '../models/approval-request.model';
import { GatePass } from '../models/gate-pass.model';
import * as visitor from './visitor.service';
import { requestApproval, RequestInput } from './gate-approval.service';
import { redeem as redeemPass, inspect as inspectPass } from './gate-pass.service';
import { logger } from '../utils/logger.util';

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export interface Actor { userId: string; userName: string }

/**
 * THE single door a visitor comes through.
 *
 * Before this, the gate had three unconnected paths and a guard who only ever
 * used the first: `recordEntry` logged straight to INSIDE, `requestApproval`
 * built a request nothing consumed, and `redeem` burned a pass without ever
 * writing an entry. A society could switch approval on and watch it do nothing,
 * a scanned visitor never appeared in "who is inside", and the approval and
 * pass records dangled with no link back to the visit they belonged to.
 *
 * This service is the join. Every arrival — typed, scanned, or approved —
 * lands here, and here decides which of them happens:
 *
 *   - approval is asked, and the entry waits (AWAITING) until it is answered;
 *   - a pass is redeemed, and the entry is written the same instant;
 *   - a "leave at the gate" delivery is recorded (AT_GATE) without admitting;
 *   - everything else is admitted and logged.
 *
 * The person is recorded the moment they reach the gate, in whatever state is
 * true — because somebody standing at the gate with no record is the failure
 * this whole module exists to prevent.
 */

export class ArrivalError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface ArrivalInput extends RequestInput {
  photoKey?: string;
  idType?: string;
  idLast4?: string;
  vehiclePhotoKey?: string;
  guardStaffId?: string;
  entryGateId?: string;
}

export interface ArrivalResult {
  entry: IVisitorEntry;
  /** What the guard sees happen: admitted, waiting, or left at the gate. */
  outcome: 'ADMITTED' | 'AWAITING' | 'LEFT_AT_GATE';
  reason: string;
}

/**
 * A visitor arrives and the guard logs them.
 *
 * The approval policy decides the rest. Note the ordering: approval is asked
 * FIRST, and only then is the entry written in the matching state — so an entry
 * is never created INSIDE and then retroactively made to wait.
 */
export async function arrive(societyId: string, input: ArrivalInput, actor: Actor): Promise<ArrivalResult> {
  const decision = await requestApproval(societyId, input, actor);

  const base = {
    category: input.category,
    visitorName: input.visitorName,
    visitorPhone: input.visitorPhone,
    photoKey: input.photoKey,
    idType: input.idType,
    idLast4: input.idLast4,
    flatId: input.flatId || undefined,
    vehicleNumber: input.vehicleNumber,
    vehiclePhotoKey: input.vehiclePhotoKey,
    notes: input.notes,
    guardStaffId: input.guardStaffId,
    entryGateId: input.entryGateId,
    // Carried through so the register is filed against the same host the
    // approval was resolved against — a visit for the secretary is a visit for
    // the secretary in both records or in neither.
    hostKind: input.hostKind,
    hostUserId: input.hostUserId || undefined,
    hostStaffId: input.hostStaffId || undefined,
  };

  // The flat is being asked. Record the person NOW, waiting, and hang the
  // request off the entry so the two are joined for good.
  if (decision.verdict === 'ASK' && decision.request) {
    const entry = await visitor.createEntry(societyId, base, actor, {
      status: 'AWAITING',
      approvalRequestId: String(decision.request._id),
      host: decision.host,
    });
    // Back-reference the other way too, so a resident answering the request can
    // find the entry to settle without a search.
    await ApprovalRequest.updateOne(
      { _id: decision.request._id },
      { $set: { visitorEntryId: entry._id } },
    ).catch(e => logger.error(`Could not link approval to entry: ${e.message}`));
    return { entry, outcome: 'AWAITING', reason: decision.reason };
  }

  // A delivery the flat wants left at the gate. Recorded, but never admitted.
  if (decision.verdict === 'LEAVE_AT_GATE') {
    const entry = await visitor.createEntry(societyId, base, actor, {
      status: 'AT_GATE', host: decision.host,
    });
    return { entry, outcome: 'LEFT_AT_GATE', reason: decision.reason };
  }

  /**
   * Straight in. `admittedVia` records WHY it needed no approval, so the
   * register can tell an expected visitor from a notify-only one from a guard's
   * own call months later.
   *
   * This used to be derived by substring-matching `decision.reason` — English
   * prose written for a guard's screen, load-bearing for a permanent audit
   * field. It failed exactly where it mattered: "A resident of this flat"
   * matched none of the patterns, fell through to GUARD, and GUARD meant "tell
   * the flat", so a household was notified that one of its own members had
   * arrived home. The decision now says what it decided, in values.
   */
  const entry = await visitor.createEntry(societyId, base, actor, {
    status: 'INSIDE',
    admittedVia: decision.admittedVia,
    notifyArrival: decision.notifyArrival,
    host: decision.host,
  });
  return { entry, outcome: 'ADMITTED', reason: decision.reason };
}

/**
 * A resident (or the guard, via override) has answered an approval. Turn the
 * AWAITING entry into its final state.
 *
 * The approval service still owns the decision — who was asked, first-answer-
 * wins, the override reason. This only carries that decision onto the entry, so
 * "who is inside" reflects it. Kept here rather than in gate-approval.service to
 * avoid a circular import: approval knows nothing about entries, arrival knows
 * about both.
 */
export async function applyDecision(
  societyId: string, approvalRequestId: string,
  outcome: 'APPROVED' | 'DENIED' | 'LEFT_AT_GATE' | 'GUARD_OVERRIDE' | 'TIMED_OUT' | 'AUTO_DENIED',
  by: { name?: string; reason?: string },
  actor: Actor,
): Promise<IVisitorEntry | null> {
  const req = await ApprovalRequest.findOne({ _id: oid(approvalRequestId), societyId: oid(societyId) }).lean();
  if (!req?.visitorEntryId) return null;

  const settle = (status: 'INSIDE' | 'DENIED' | 'AT_GATE', via?: 'RESIDENT_APPROVAL' | 'OVERRIDE') =>
    visitor.settleEntry(societyId, String(req.visitorEntryId), {
      status, admittedVia: via, decidedByName: by.name, reason: by.reason,
    }, actor);

  switch (outcome) {
    case 'APPROVED':       return settle('INSIDE', 'RESIDENT_APPROVAL');
    case 'GUARD_OVERRIDE': return settle('INSIDE', 'OVERRIDE');
    case 'LEFT_AT_GATE':   return settle('AT_GATE');
    // A refusal, a timeout with AUTO_DENY, or a HOLD that ran out: the person
    // did not come in. The entry is settled DENIED rather than left dangling,
    // so "who is inside" stops counting somebody who was turned away.
    default:               return settle('DENIED');
  }
}

/**
 * A pass is scanned or its code typed. Check, THEN burn, THEN write the entry.
 *
 * That ordering is the fix, and the bug it replaces was total rather than rare.
 * The pass was burned first and `createEntry` validated second, so in any
 * society with `capture.photo = 'REQUIRED'` — a real and recommended setting —
 * **every** redemption threw after `usedCount` had already been incremented.
 * The guest was turned away and their invitation was destroyed in the same
 * request, with no transaction and no compensating decrement. The resident's
 * only evidence was a pass that said USED for a visitor who never got in.
 *
 * So the entry is validated against the society's capture rules BEFORE the
 * irreversible step, and if the write still fails afterwards for any reason the
 * burn is undone. Belt and braces, because the failure mode is a guest standing
 * at a gate holding an invitation the software has just eaten.
 */
export async function arriveByPass(
  societyId: string, by: { code?: string; payload?: string }, actor: Actor,
  opts: { guardStaffId?: string; photoKey?: string; visitorPhone?: string } = {},
): Promise<ArrivalResult> {
  // Read the pass without touching it, so the capture rules can be applied to
  // the entry this would produce while the invitation is still intact.
  const intended = await inspectPass(societyId, by);

  const draft = {
    category: intended.category,
    visitorName: intended.visitorName,
    // The guard may capture what the pass could not carry. A pass has no photo
    // field at all, so without this a REQUIRED-photo society could never redeem
    // one — the rule would be unsatisfiable rather than merely strict.
    visitorPhone: opts.visitorPhone || intended.visitorPhone,
    photoKey: opts.photoKey,
    flatId: intended.flatId,
    guardStaffId: opts.guardStaffId,
  };
  await visitor.assertEntryAllowed(societyId, draft, actor);

  const result = await redeemPass(societyId, by, actor);
  const pass = result.pass;

  // A pass is an invitation the resident already extended — it needs no
  // approval. Straight in, tagged PASS, and linked both ways.
  let entry: IVisitorEntry;
  try {
    entry = await visitor.createEntry(societyId, {
      ...draft,
      visitorName: pass.visitorName,
      flatId: pass.flatId ? String(pass.flatId) : undefined,
    }, actor, {
      status: 'INSIDE',
      admittedVia: 'PASS',
      gatePassId: String(pass._id),
      notifyArrival: true,
    });
  } catch (e: any) {
    // The pass survives a failure that happens after the burn. Restoring the
    // count is not bookkeeping — it is the difference between "try again" and
    // "your guest cannot come in and you cannot re-invite them".
    await GatePass.updateOne(
      { _id: pass._id },
      { $inc: { usedCount: -1 }, $set: { status: 'ACTIVE' } },
    ).catch(u => logger.error(`Could not restore a burned pass: ${u.message}`));
    throw e;
  }

  // The pass remembers which entries it produced — a family pass admits four
  // people over an evening, and this is how you see all four. Closes the dead
  // `usedEntryIds` field.
  await GatePass.updateOne(
    { _id: pass._id },
    { $push: { usedEntryIds: entry._id } },
  ).catch(e => logger.error(`Could not link pass to entry: ${e.message}`));

  return {
    entry,
    outcome: 'ADMITTED',
    reason: result.overUsed ? 'Pass accepted and flagged for review' : `${pass.visitorName} — pass accepted`,
  };
}

/**
 * An arrival a guard device already admitted while it had no network.
 *
 * Everything here is reconciliation, not admission, and the difference decides
 * every judgement call in it. The person walked in half an hour ago; the only
 * question left is whether the register knows. Previously the sync handler
 * burned the pass and stopped — so every visitor admitted during an outage was
 * permanently absent from the register, from "who is inside", from the morning
 * reconciliation and from the retention purge that is supposed to delete their
 * photograph. A society that went offline for an evening simply had no record
 * of that evening.
 *
 * `clientId` makes it exactly-once: a device that syncs, loses the response and
 * retries must not write the visitor in twice. The check is cheap and the
 * unique index behind it is what actually holds under two devices retrying at
 * the same moment.
 */
export async function arriveByQueuedPass(
  societyId: string,
  item: { clientId: string; code?: string; payload?: string; scannedAt?: Date },
  actor: Actor,
  opts: { guardStaffId?: string } = {},
): Promise<ArrivalResult & { duplicate: boolean; overUsed: boolean }> {
  const at = item.scannedAt || new Date();

  const already = await VisitorEntry.findOne({
    societyId: oid(societyId), offlineClientId: item.clientId,
  });
  if (already) {
    return {
      entry: already, outcome: 'ADMITTED', duplicate: true, overUsed: false,
      reason: 'Already synced — recorded once.',
    };
  }

  const result = await redeemPass(societyId, { code: item.code, payload: item.payload }, actor, {
    at, offlineQueued: true,
  });
  const pass = result.pass;

  const entry = await visitor.createEntry(societyId, {
    category: pass.category,
    visitorName: pass.visitorName,
    visitorPhone: pass.visitorPhone,
    flatId: pass.flatId ? String(pass.flatId) : undefined,
    guardStaffId: opts.guardStaffId,
  }, actor, {
    status: 'INSIDE',
    admittedVia: 'PASS',
    gatePassId: String(pass._id),
    notifyArrival: true,
    // The time they actually walked in, not the time the phone found a signal.
    enteredAt: at,
    offlineClientId: item.clientId,
    // See `assertEntryAllowed`: a capture rule decides whether somebody is let
    // in, and that decision was made offline, by a device, thirty minutes ago.
    reconciling: true,
  });

  await GatePass.updateOne(
    { _id: pass._id },
    { $push: { usedEntryIds: entry._id } },
  ).catch(e => logger.error(`Could not link pass to entry: ${e.message}`));

  return {
    entry, outcome: 'ADMITTED', duplicate: false, overUsed: result.overUsed,
    reason: result.overUsed ? 'Recorded, and flagged for review.' : `${pass.visitorName} — recorded`,
  };
}
