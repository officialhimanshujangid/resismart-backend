import mongoose, { Schema, Document } from 'mongoose';

/**
 * How the bank hands the interest over.
 *
 * CUMULATIVE and ON_MATURITY leave the money with the bank until the deposit
 * ends; QUARTERLY pays it out as it goes. None of them change what the society
 * has *earned* by a given date — that is what accrual measures — so this is
 * recorded for the register and for maturity planning, not for the arithmetic.
 */
export type InterestPayout = 'CUMULATIVE' | 'QUARTERLY' | 'ON_MATURITY';
export type InvestmentStatus = 'ACTIVE' | 'MATURED' | 'CLOSED';

export interface IInvestment extends Document {
  societyId: mongoose.Types.ObjectId;
  bankName: string;
  /** Last four digits only — the full FD number is not ours to store. */
  accountNumberLast4?: string;
  principalPaise: number;
  /** Annual rate, e.g. 7.1 for 7.1% p.a. */
  ratePercent: number;
  startDate: Date;
  maturityDate: Date;
  interestPayout: InterestPayout;

  /**
   * The fund whose money this deposit holds, when it holds one.
   *
   * This is the field that decides where interest lands. Interest earned on the
   * sinking fund's own money belongs to the sinking fund; crediting it to
   * general income would quietly drain a reserve the members are owed, and no
   * report would show why. Unlinked deposits earn ordinary income (4200).
   */
  linkedFundId?: mongoose.Types.ObjectId;
  autoRenew: boolean;

  /** Running total accrued to date and not yet settled by a closure. */
  accruedInterestPaise: number;
  /**
   * The through-date of the last posted accrual. This is what makes a run
   * idempotent: the next run only accrues the span *after* this date, so
   * re-running the same period accrues nothing rather than double-counting.
   */
  lastAccrualUpTo?: Date;

  status: InvestmentStatus;
  closedOn?: Date;

  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const InvestmentSchema = new Schema<IInvestment>({
  societyId: { type: Schema.Types.ObjectId, ref: 'Society', required: true },
  bankName: { type: String, required: true, trim: true },
  accountNumberLast4: { type: String, trim: true },
  principalPaise: { type: Number, required: true, min: 1 },
  ratePercent: { type: Number, required: true, min: 0, max: 100 },
  startDate: { type: Date, required: true },
  maturityDate: { type: Date, required: true },
  interestPayout: { type: String, enum: ['CUMULATIVE', 'QUARTERLY', 'ON_MATURITY'], default: 'CUMULATIVE' },

  linkedFundId: { type: Schema.Types.ObjectId, ref: 'FinanceFund' },
  autoRenew: { type: Boolean, default: false },

  accruedInterestPaise: { type: Number, default: 0, min: 0 },
  lastAccrualUpTo: { type: Date },

  status: { type: String, enum: ['ACTIVE', 'MATURED', 'CLOSED'], default: 'ACTIVE' },
  closedOn: { type: Date },

  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String, required: true },
}, { timestamps: true });

InvestmentSchema.index({ societyId: 1, status: 1, maturityDate: 1 });
InvestmentSchema.index({ societyId: 1, linkedFundId: 1 });

export const Investment = mongoose.model<IInvestment>('Investment', InvestmentSchema);
export default Investment;
