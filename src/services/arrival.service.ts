import mongoose from 'mongoose';
import { IVisitorEntry } from '../models/visitor-entry.model';
import { ApprovalRequest } from '../models/approval-request.model';
import { GatePass } from '../models/gate-pass.model';
import * as visitor from './visitor.service';
import { requestApproval, RequestInput } from './gate-approval.service';
import { redeem as redeemPass } from './gate-pass.service';
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
  };

  // The flat is being asked. Record the person NOW, waiting, and hang the
  // request off the entry so the two are joined for good.
  if (decision.verdict === 'ASK' && decision.request) {
    const entry = await visitor.createEntry(societyId, base, actor, {
      status: 'AWAITING',
      approvalRequestId: String(decision.request._id),
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
    const entry = await visitor.createEntry(societyId, base, actor, { status: 'AT_GATE' });
    return { entry, outcome: 'LEFT_AT_GATE', reason: decision.reason };
  }

  // Straight in. `admittedVia` records WHY it needed no approval, so the
  // register can tell an expected visitor from a notify-only one from a guard's
  // own call months later.
  const via =
    decision.reason.includes('expects them') ? 'EXPECTED' as const :
    decision.reason.includes('has been told') ? 'NOTIFY' as const :
    'GUARD' as const;

  const entry = await visitor.createEntry(societyId, base, actor, {
    status: 'INSIDE',
    admittedVia: via,
    notifyArrival: via === 'GUARD',   // the other two already notified inside requestApproval
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
 * A pass is scanned or its code typed. Burn it AND write the entry, in that
 * order, so a redeemed pass is never a visitor who is nowhere in the register.
 */
export async function arriveByPass(
  societyId: string, by: { code?: string; payload?: string }, actor: Actor,
  opts: { guardStaffId?: string } = {},
): Promise<ArrivalResult> {
  const result = await redeemPass(societyId, by, actor);
  const pass = result.pass;

  // A pass is an invitation the resident already extended — it needs no
  // approval. Straight in, tagged PASS, and linked both ways.
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
  });

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
