export type InterestOrder = 'PRINCIPAL_FIRST' | 'INTEREST_FIRST';

export interface PaymentSplit {
  /** How much of the offered amount this bill can absorb. */
  applyPaise: number;
  toInterestPaise: number;
  toPrincipalPaise: number;
}

/**
 * How a payment lands inside one bill: against the penalty, or against the dues.
 *
 * The order matters beyond bookkeeping. Interest is levied on unpaid dues, so
 * settling dues first shrinks next month's interest, while settling the penalty
 * first leaves the dues — and the interest they attract — untouched. Bye-laws
 * commonly require the former; lenders conventionally do the latter. Hence a
 * policy knob rather than a hard-coded rule.
 *
 * Pure and shared by every caller that reduces a bill — a receipt, an
 * auto-applied advance, a waiver — so they cannot drift apart.
 */
export function splitPayment(
  order: InterestOrder,
  amountPaise: number,
  outstandingPaise: number,
  interestOutstandingPaise: number,
): PaymentSplit {
  const applyPaise = Math.max(0, Math.min(amountPaise, outstandingPaise));
  const interestDue = Math.max(0, Math.min(interestOutstandingPaise, outstandingPaise));
  const principalDue = outstandingPaise - interestDue;

  const toInterestPaise = order === 'INTEREST_FIRST'
    ? Math.min(applyPaise, interestDue)
    // Principal first: only what is left over once the dues are cleared touches
    // the penalty.
    : Math.max(0, applyPaise - principalDue);

  return { applyPaise, toInterestPaise, toPrincipalPaise: applyPaise - toInterestPaise };
}
