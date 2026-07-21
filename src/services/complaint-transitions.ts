import { ComplaintStatus } from '../models/complaint.model';

/**
 * The one place a complaint transition is decided.
 *
 * Before this file, transition legality lived in TEN places that already
 * disagreed with each other: eight `if`s scattered through the service, the
 * frontend's button conditions, and the escalation filter. The disagreement was
 * not theoretical — the service refused `resolve` from NEW while the UI offered
 * the button, the UI offered a resident "Put on hold" and "Work is done" which
 * the routes then 403'd, and the escalation filter thought WORK_DONE was still
 * somebody's fault. Every one of those is the same bug: two answers to one
 * question.
 *
 * So there is now one table, and three consumers read it:
 *
 *   1. Every service verb, via `canTransition` — it is the authority, not a
 *      second opinion.
 *   2. `GET /complaints/:id`, via `allowedVerbs` — the exact list of buttons
 *      this viewer may press on this ticket, computed by the server that will
 *      have to accept them.
 *   3. `GET /complaints/options`, which publishes the whole machine so a board
 *      can render a row without a round trip per ticket.
 *
 * The rule for adding anything: if a verb can change a status, it belongs here.
 * A guard that lives in a service function is a guard the UI cannot see, and an
 * invisible guard is a button that is guaranteed to fail.
 */

export const COMPLAINT_VERBS = [
  'assign', 'respond', 'pause', 'resume', 'workDone', 'resolve',
  'close', 'reopen', 'reject', 'duplicate', 'rate', 'meToo', 'escalate',
  'comment', 'note',
] as const;
export type ComplaintVerb = typeof COMPLAINT_VERBS[number];

/** What the button says. Published, so the server names its own actions. */
export const VERB_LABELS: Record<ComplaintVerb, string> = {
  assign: 'Give it to somebody',
  respond: 'Reply',
  pause: 'Put on hold',
  resume: 'Take off hold',
  workDone: 'Work is done',
  resolve: 'Yes, it is fixed',
  close: 'Close it',
  reopen: 'Not fixed — reopen',
  reject: 'Reject it',
  duplicate: 'Same as another ticket',
  rate: 'Rate it',
  meToo: 'Me too',
  escalate: 'Send it up',
  comment: 'Add a message',
  note: 'Note for staff only',
};

/**
 * Two verbs that change no status, and are in this table anyway.
 *
 * **`comment`** is the resident's side of the conversation, and until now there
 * was none. `POST /:id/respond` is a STAFF_SIDE route behind `COMPLAINTS_OWN`,
 * yet the screen rendered its note box and Reply button to everybody — so a
 * resident asked when the plumber was coming, pressed Reply, and got a 403.
 * The only way to say anything was to raise a second complaint, which is
 * exactly how one leaking tap becomes four tickets.
 *
 * **`note`** is the other half: staff talking to each other. `isInternal` has
 * been on `ComplaintEvent` since the beginning, `detail` has always stripped
 * internal events from residents, and NOTHING could set it except the two
 * automatic notes this service writes itself. There was no way for a manager to
 * write "the owner is abroad, do not keep knocking" without the owner reading
 * it.
 *
 * They are here, rather than guarded inside the service, for the reason the
 * whole file exists: a guard the UI cannot see is a button guaranteed to fail.
 * `allowedVerbs` now answers "may I type in this box" with the same table that
 * answers "may I press this".
 */

/**
 * Who a person is on THIS complaint — not what role they hold in the society.
 *
 * Three, and they overlap on purpose. A manager who is also the assignee is
 * both, and the resolve rule below turns on exactly that: the assignee alone
 * may not sign off their own work, but a manager may act for a flat that has
 * gone quiet, even if they also happen to be the person who did it.
 */
export type TransitionRole = 'MANAGER' | 'ASSIGNEE' | 'RESIDENT' | 'ANYONE';

export interface TransitionActor {
  /** COMPLAINTS_MANAGE: FULL — may act on anything in their wings. */
  canManage?: boolean;
  /** The staff member the job is with. */
  isAssignee?: boolean;
  /** The raiser, or somebody living in the flat it was raised for. */
  isResident?: boolean;
}

/** The bits of a complaint a guard needs. Deliberately not the whole document. */
export interface TransitionSubject {
  status: ComplaintStatus;
  kind?: string;
  visibility?: string;
  /** How many times the clock has already been stopped on this ticket. */
  pauseCount?: number;
}

/**
 * How much stopping the clock a society will tolerate.
 *
 * Pausing suppresses both SLA clocks AND removes the row from the escalation
 * sweep, which makes an uncapped pause the quietest way in the product to bury
 * a complaint forever. A cap does not stop legitimate use — three holds on one
 * ticket is already an unusual repair — it stops the pattern where a ticket is
 * re-paused every time it is about to breach.
 */
export interface PauseLimits {
  maxCount: number;
  maxHours: number;
}
export const PAUSE_LIMITS: PauseLimits = { maxCount: 3, maxHours: 72 };

export interface GuardOpts {
  pause?: PauseLimits;
}

export interface TransitionSpec {
  /** The status the service will actually write. Self-transitions are real entries. */
  to: ComplaintStatus;
  verb: ComplaintVerb;
  who: TransitionRole[];
  label: string;
  /**
   * A condition beyond the status. Returns the refusal sentence, or null.
   *
   * This is what keeps the published verb list EXACT rather than merely
   * plausible: "me too" is legal from every open status but only on a community
   * complaint, and a UI that cannot see that condition shows the button on
   * every personal ticket in the list.
   */
  unless?: (c: TransitionSubject, o: GuardOpts) => string | null;
}

// ---------------------------------------------------------------- the guards

const COMMUNITY_ONLY = (c: TransitionSubject) =>
  c.visibility === 'COMMUNITY' ? null : 'You can only join a community complaint.';

const WITHIN_PAUSE_LIMIT = (c: TransitionSubject, o: GuardOpts) => {
  const max = o.pause?.maxCount ?? PAUSE_LIMITS.maxCount;
  return (c.pauseCount || 0) >= max
    ? `This has already been put on hold ${max} times. It needs a decision, not another hold.`
    : null;
};

// ------------------------------------------------------------- the machine

/**
 * Read this as "from THIS status, these things may happen".
 *
 * Four decisions in here are load-bearing and each undoes a specific defect:
 *
 * - **`close` is absent from NEW.** Disposing of a junk ticket used to cost
 *   four clicks through Work-done → It's-fixed → Close, which stamped a
 *   `resolvedAt` on a ticket nobody ever worked and dragged the median
 *   resolution time down with it. `reject` and `duplicate` exist so that path
 *   is never needed.
 * - **`pause` is absent from NEW and WORK_DONE.** Nothing has started, or the
 *   work is finished and the wait is the resident's — neither is a delay the
 *   clock should stop for.
 * - **`resolve` never lists ASSIGNEE.** The person who did the work does not
 *   get to say it is fixed. A manager who is also the assignee still may, via
 *   MANAGER, which is a different act by a different hat and is recorded as one.
 * - **`resume` names four targets.** The clock comes back on where it left off.
 *   Always landing on IN_PROGRESS recorded work in progress that nobody had
 *   started. NEW is listed only for rows paused before pausing from NEW was
 *   refused — new ones cannot get there.
 */
export const TRANSITIONS: Record<ComplaintStatus, TransitionSpec[]> = {
  NEW: [
    { to: 'ASSIGNED', verb: 'assign', who: ['MANAGER'], label: VERB_LABELS.assign },
    { to: 'NEW', verb: 'assign', who: ['MANAGER'], label: 'Take the name off it' },
    { to: 'IN_PROGRESS', verb: 'respond', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.respond },
    { to: 'WORK_DONE', verb: 'workDone', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.workDone },
    { to: 'REJECTED', verb: 'reject', who: ['MANAGER'], label: VERB_LABELS.reject },
    { to: 'REJECTED', verb: 'duplicate', who: ['MANAGER'], label: VERB_LABELS.duplicate },
    { to: 'NEW', verb: 'escalate', who: ['MANAGER'], label: VERB_LABELS.escalate },
    { to: 'NEW', verb: 'meToo', who: ['ANYONE'], label: VERB_LABELS.meToo, unless: COMMUNITY_ONLY },
    { to: 'NEW', verb: 'comment', who: ['RESIDENT'], label: VERB_LABELS.comment },
    { to: 'NEW', verb: 'note', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.note },
  ],

  ASSIGNED: [
    { to: 'ASSIGNED', verb: 'assign', who: ['MANAGER'], label: VERB_LABELS.assign },
    { to: 'NEW', verb: 'assign', who: ['MANAGER'], label: 'Take the name off it' },
    { to: 'IN_PROGRESS', verb: 'respond', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.respond },
    { to: 'ON_HOLD', verb: 'pause', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.pause, unless: WITHIN_PAUSE_LIMIT },
    { to: 'WORK_DONE', verb: 'workDone', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.workDone },
    { to: 'CLOSED', verb: 'close', who: ['MANAGER'], label: VERB_LABELS.close },
    { to: 'REJECTED', verb: 'reject', who: ['MANAGER'], label: VERB_LABELS.reject },
    { to: 'REJECTED', verb: 'duplicate', who: ['MANAGER'], label: VERB_LABELS.duplicate },
    { to: 'ASSIGNED', verb: 'escalate', who: ['MANAGER'], label: VERB_LABELS.escalate },
    { to: 'ASSIGNED', verb: 'meToo', who: ['ANYONE'], label: VERB_LABELS.meToo, unless: COMMUNITY_ONLY },
    { to: 'ASSIGNED', verb: 'comment', who: ['RESIDENT'], label: VERB_LABELS.comment },
    { to: 'ASSIGNED', verb: 'note', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.note },
  ],

  IN_PROGRESS: [
    { to: 'IN_PROGRESS', verb: 'assign', who: ['MANAGER'], label: VERB_LABELS.assign },
    { to: 'IN_PROGRESS', verb: 'respond', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.respond },
    { to: 'ON_HOLD', verb: 'pause', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.pause, unless: WITHIN_PAUSE_LIMIT },
    { to: 'WORK_DONE', verb: 'workDone', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.workDone },
    // The flat may confirm a fix the technician never got round to reporting —
    // still never the technician themselves.
    { to: 'RESOLVED', verb: 'resolve', who: ['RESIDENT', 'MANAGER'], label: VERB_LABELS.resolve },
    { to: 'CLOSED', verb: 'close', who: ['MANAGER'], label: VERB_LABELS.close },
    { to: 'REJECTED', verb: 'reject', who: ['MANAGER'], label: VERB_LABELS.reject },
    { to: 'REJECTED', verb: 'duplicate', who: ['MANAGER'], label: VERB_LABELS.duplicate },
    { to: 'IN_PROGRESS', verb: 'escalate', who: ['MANAGER'], label: VERB_LABELS.escalate },
    { to: 'IN_PROGRESS', verb: 'meToo', who: ['ANYONE'], label: VERB_LABELS.meToo, unless: COMMUNITY_ONLY },
    { to: 'IN_PROGRESS', verb: 'comment', who: ['RESIDENT'], label: VERB_LABELS.comment },
    { to: 'IN_PROGRESS', verb: 'note', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.note },
  ],

  ON_HOLD: [
    // Back to wherever it was. `resume` picks the target from
    // `statusBeforePause`; all four are legal so the table can be checked
    // against whichever one it picks.
    { to: 'IN_PROGRESS', verb: 'resume', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.resume },
    { to: 'ASSIGNED', verb: 'resume', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.resume },
    { to: 'REOPENED', verb: 'resume', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.resume },
    { to: 'NEW', verb: 'resume', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.resume },
    { to: 'ON_HOLD', verb: 'assign', who: ['MANAGER'], label: VERB_LABELS.assign },
    { to: 'ON_HOLD', verb: 'respond', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.respond },
    { to: 'REJECTED', verb: 'reject', who: ['MANAGER'], label: VERB_LABELS.reject },
    { to: 'REJECTED', verb: 'duplicate', who: ['MANAGER'], label: VERB_LABELS.duplicate },
    { to: 'ON_HOLD', verb: 'meToo', who: ['ANYONE'], label: VERB_LABELS.meToo, unless: COMMUNITY_ONLY },
    // The status a resident most needs to be able to answer: "nobody was home"
    // is a hold whose next step is theirs, and they had no way to reply to it.
    { to: 'ON_HOLD', verb: 'comment', who: ['RESIDENT'], label: VERB_LABELS.comment },
    { to: 'ON_HOLD', verb: 'note', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.note },
  ],

  WORK_DONE: [
    // The confirmation step, and the reason this status exists at all.
    { to: 'RESOLVED', verb: 'resolve', who: ['RESIDENT', 'MANAGER'], label: VERB_LABELS.resolve },
    { to: 'REOPENED', verb: 'reopen', who: ['RESIDENT', 'MANAGER'], label: VERB_LABELS.reopen },
    { to: 'WORK_DONE', verb: 'respond', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.respond },
    { to: 'WORK_DONE', verb: 'assign', who: ['MANAGER'], label: VERB_LABELS.assign },
    { to: 'CLOSED', verb: 'close', who: ['MANAGER'], label: VERB_LABELS.close },
    { to: 'WORK_DONE', verb: 'meToo', who: ['ANYONE'], label: VERB_LABELS.meToo, unless: COMMUNITY_ONLY },
    { to: 'WORK_DONE', verb: 'comment', who: ['RESIDENT'], label: VERB_LABELS.comment },
    { to: 'WORK_DONE', verb: 'note', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.note },
  ],

  REOPENED: [
    { to: 'REOPENED', verb: 'assign', who: ['MANAGER'], label: VERB_LABELS.assign },
    { to: 'IN_PROGRESS', verb: 'respond', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.respond },
    { to: 'ON_HOLD', verb: 'pause', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.pause, unless: WITHIN_PAUSE_LIMIT },
    { to: 'WORK_DONE', verb: 'workDone', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.workDone },
    { to: 'RESOLVED', verb: 'resolve', who: ['RESIDENT', 'MANAGER'], label: VERB_LABELS.resolve },
    { to: 'CLOSED', verb: 'close', who: ['MANAGER'], label: VERB_LABELS.close },
    { to: 'REJECTED', verb: 'reject', who: ['MANAGER'], label: VERB_LABELS.reject },
    { to: 'REOPENED', verb: 'escalate', who: ['MANAGER'], label: VERB_LABELS.escalate },
    { to: 'REOPENED', verb: 'meToo', who: ['ANYONE'], label: VERB_LABELS.meToo, unless: COMMUNITY_ONLY },
    { to: 'REOPENED', verb: 'comment', who: ['RESIDENT'], label: VERB_LABELS.comment },
    { to: 'REOPENED', verb: 'note', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.note },
  ],

  RESOLVED: [
    { to: 'CLOSED', verb: 'close', who: ['MANAGER'], label: VERB_LABELS.close },
    { to: 'REOPENED', verb: 'reopen', who: ['RESIDENT', 'MANAGER'], label: VERB_LABELS.reopen },
    { to: 'RESOLVED', verb: 'rate', who: ['RESIDENT', 'MANAGER'], label: VERB_LABELS.rate },
    { to: 'RESOLVED', verb: 'comment', who: ['RESIDENT'], label: VERB_LABELS.comment },
    { to: 'RESOLVED', verb: 'note', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.note },
  ],

  CLOSED: [
    { to: 'REOPENED', verb: 'reopen', who: ['RESIDENT', 'MANAGER'], label: VERB_LABELS.reopen },
    { to: 'CLOSED', verb: 'rate', who: ['RESIDENT', 'MANAGER'], label: VERB_LABELS.rate },
    // Saying "thank you" or "it has come back" on a closed ticket is allowed;
    // reopening it is the separate, counted act immediately above.
    { to: 'CLOSED', verb: 'comment', who: ['RESIDENT'], label: VERB_LABELS.comment },
    { to: 'CLOSED', verb: 'note', who: ['MANAGER', 'ASSIGNEE'], label: VERB_LABELS.note },
  ],

  // Terminal. A ticket disposed of as junk or as a duplicate is not reopened —
  // the duplicate's parent is where the conversation continues, and that is
  // what `mergedIntoId` points at.
  //
  // `comment` is absent here for the same reason, and deliberately: a resident
  // typing into a rejected ticket is typing into a room nobody is in. The
  // merge notification names the ticket that IS live.
  REJECTED: [],
};

/**
 * Every status there is, taken from the machine rather than typed out again.
 *
 * A second hand-written list is a second thing to forget: `REJECTED` was on the
 * model for months and reachable from nowhere precisely because the places that
 * had to know about it each kept their own copy.
 */
export const ALL_STATUSES = Object.keys(TRANSITIONS) as ComplaintStatus[];

// ------------------------------------------------------------- the questions

const roleMatches = (who: TransitionRole[], actor: TransitionActor) =>
  who.some(r =>
    r === 'ANYONE'
    || (r === 'MANAGER' && !!actor.canManage)
    || (r === 'ASSIGNEE' && !!actor.isAssignee)
    || (r === 'RESIDENT' && !!actor.isResident));

export interface TransitionVerdict {
  ok: boolean;
  reason?: string;
  /**
   * 400 when the STATUS forbids it — a true statement about the ticket that
   * telling the caller costs nothing. 403 when the status allows it but this
   * person may not: a different fact, and the two were being conflated.
   */
  status?: number;
}

/**
 * May `actor` move a complaint from `from` to `to`?
 *
 * `verb` is optional and narrows the match — several verbs can produce the same
 * target (a manager reassigning an IN_PROGRESS ticket and replying to it both
 * leave it IN_PROGRESS), and a service that names its verb gets the refusal
 * sentence that belongs to it.
 */
export function canTransition(
  from: ComplaintStatus,
  to: ComplaintStatus,
  actor: TransitionActor,
  verb?: ComplaintVerb,
  subject?: TransitionSubject,
  guards: GuardOpts = {},
): TransitionVerdict {
  const specs = (TRANSITIONS[from] || []).filter(s => s.to === to && (!verb || s.verb === verb));
  if (!specs.length) {
    return {
      ok: false,
      status: 400,
      reason: refusalFor(from, to, verb),
    };
  }

  // Any ONE matching spec is enough — the roles are a union, not a conjunction.
  const permitted = specs.filter(s => roleMatches(s.who, actor));
  if (!permitted.length) {
    return { ok: false, status: 403, reason: whoRefusal(verb) };
  }

  const c: TransitionSubject = subject || { status: from };
  for (const spec of permitted) {
    const blocked = spec.unless?.(c, guards);
    if (!blocked) return { ok: true };
    // Every permitted spec refused for a data reason: report the first, which
    // is the specific sentence rather than a generic "no".
    if (spec === permitted[permitted.length - 1]) {
      return { ok: false, status: 400, reason: blocked };
    }
  }
  return { ok: true };
}

/**
 * Everything this viewer may do to this ticket, right now.
 *
 * This is the answer `GET /complaints/:id` publishes. It is computed from the
 * same table the services enforce, which is the entire point: a resident used
 * to be shown between four and seven controls — Reply, Put on hold, Work is
 * done, the whole manage panel — every one of which was guaranteed to 403.
 */
export function allowedVerbs(
  subject: TransitionSubject,
  actor: TransitionActor,
  guards: GuardOpts = {},
): ComplaintVerb[] {
  const out: ComplaintVerb[] = [];
  for (const spec of TRANSITIONS[subject.status] || []) {
    if (out.includes(spec.verb)) continue;
    if (!roleMatches(spec.who, actor)) continue;
    if (spec.unless?.(subject, guards)) continue;
    out.push(spec.verb);
  }
  return out;
}

/**
 * The sentence a person reads.
 *
 * Written per case rather than as one generic line because "this is already
 * finished" and "nobody has worked on this yet" are the two the resident
 * actually hits, and a machine-shaped message here reads as a fault in the
 * product rather than a fact about their ticket.
 */
function refusalFor(from: ComplaintStatus, to: ComplaintStatus, verb?: ComplaintVerb): string {
  if (verb === 'resolve' && (from === 'NEW' || from === 'ASSIGNED')) {
    return 'Nobody has worked on this yet — it cannot be marked resolved.';
  }
  if (verb === 'close' && from === 'NEW') {
    // The whole reason `reject` exists. Closing from NEW used to be the only
    // way to dispose of junk, and it left a ticket that reads as "worked and
    // finished" in every report.
    return 'Nothing has been done on this yet — reject it, or mark it a duplicate, rather than closing it.';
  }
  if (verb === 'pause' && from === 'NEW') {
    return 'Nothing has started yet, so there is nothing to put on hold — assign it first.';
  }
  if (verb === 'pause' && from === 'WORK_DONE') {
    return 'The work is reported done and the flat has been asked to confirm — that wait is not ours to pause.';
  }
  if (verb === 'pause' && from === 'ON_HOLD') return 'This is already on hold.';
  if (verb === 'resume' && from !== 'ON_HOLD') return 'This is not on hold.';
  if (verb === 'reopen') return 'This is still open — there is nothing to reopen.';
  if (verb === 'rate') return 'Rate it once it is finished.';
  if (verb === 'comment' || verb === 'note') {
    // The only status that refuses either. Said as a direction rather than a
    // refusal, because the person has already typed their message.
    return 'This complaint was closed off, so nobody is reading it. If it was merged, carry on at the ticket it was joined to; otherwise raise a new one.';
  }
  if (from === 'CLOSED') return 'This is already closed.';
  if (from === 'REJECTED') return 'This was rejected — raise a new complaint if the problem is still there.';
  if (from === 'RESOLVED' || from === 'WORK_DONE') return 'This is already finished.';
  return `That cannot be done while this complaint is ${from.toLowerCase().replace('_', ' ')}.`;
}

function whoRefusal(verb?: ComplaintVerb): string {
  if (verb === 'resolve') {
    // The C-9 sentence, kept word for word. It is the one refusal in this
    // module a technician will actually read, and it has to explain the design
    // rather than sound like a permissions error.
    return 'You reported the work as done — the flat confirms it is fixed, not you.';
  }
  if (verb === 'close' || verb === 'reject' || verb === 'duplicate' || verb === 'assign') {
    return 'That is a manager\'s decision.';
  }
  if (verb === 'note') {
    // The one sentence that has to explain a channel rather than a rule: a
    // resident who could write here would be writing where they cannot read.
    return 'Notes are between the staff. Use the message box — the household sees that, and so do we.';
  }
  if (verb === 'comment') {
    return 'This is not your complaint to write on. Use "Reply", which is recorded against the ticket.';
  }
  return 'You are not the person who may do that on this complaint.';
}
