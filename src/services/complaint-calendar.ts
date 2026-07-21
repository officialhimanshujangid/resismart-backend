import mongoose from 'mongoose';
import { ComplaintSettings } from '../models/complaint-settings.model';

/**
 * The one place a complaint deadline is worked out.
 *
 * Every due date in this module used to be `now + minutes` in epoch
 * milliseconds. That is only correct for a society that is staffed every hour
 * of every day, and no society in this product is. The consequences were not
 * subtle:
 *
 *   - A 15-minute first-reply promise filed at 02:00 was breached at 02:15, and
 *     the hourly sweep escalated it to the committee before dawn.
 *   - A two-day fix promise made at 17:55 on a Saturday spent all of Sunday
 *     running down a clock nobody could act on, so Monday morning began already
 *     overdue.
 *   - Every "SLA met" percentage on the committee's report was therefore
 *     measuring how many complaints were filed during office hours, and calling
 *     it staff performance.
 *
 * So deadlines are counted in WORKING minutes: the clock advances only inside
 * the society's own working window, and skips its holidays. Nothing else in the
 * module changes — `resolutionDueAt` is still an instant, still compared with
 * `<`, still swept the same way. Only the arithmetic that produces it moved.
 *
 * Local time throughout, which is safe because `config/timezone` pins the
 * process to Asia/Kolkata before anything else loads. `getHours()` here means
 * what a secretary in Pune means by it.
 */

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export interface WorkingCalendar {
  /** Elapsed time, exactly as before. What an emergency gets. */
  roundTheClock: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  workingDays: number[];
  dayStartMinute: number;
  dayEndMinute: number;
  /** `YYYY-MM-DD` local dates the office is shut. */
  holidays: string[];
}

/**
 * What a society gets before it has said anything.
 *
 * Mon–Sat, 9 to 6, which is what an Indian society office actually does. It is
 * a guess, but it is a defensible guess, and it is enormously closer to the
 * truth than "every minute of every night counts against the plumber".
 */
export const DEFAULT_CALENDAR: WorkingCalendar = {
  roundTheClock: false,
  workingDays: [1, 2, 3, 4, 5, 6],
  dayStartMinute: 9 * 60,
  dayEndMinute: 18 * 60,
  holidays: [],
};

/** The old behaviour, kept as an explicit object rather than as a special case. */
export const ALWAYS_ON: WorkingCalendar = { ...DEFAULT_CALENDAR, roundTheClock: true };

/**
 * The society's calendar, and whether THIS complaint is exempt from it.
 *
 * `emergency` is passed rather than inferred because the caller is the only one
 * that knows: it comes from the category's `isEmergency`, and a complaint filed
 * with no category at all is not an emergency.
 */
export async function calendarFor(
  societyId: string,
  opts: { emergency?: boolean } = {},
): Promise<WorkingCalendar> {
  // One indexed read on a path that already does four. Deliberately not cached:
  // a stale calendar writes a wrong deadline into a document that then keeps it
  // forever, which is a far worse trade than a findOne.
  const row = await ComplaintSettings.findOne({ societyId: oid(societyId) }).lean();
  if (!row) return opts.emergency ? ALWAYS_ON : DEFAULT_CALENDAR;

  if (row.roundTheClock) return ALWAYS_ON;
  if (opts.emergency && row.emergencyRoundTheClock !== false) return ALWAYS_ON;

  const cal: WorkingCalendar = {
    roundTheClock: false,
    workingDays: row.workingDays?.length ? row.workingDays : DEFAULT_CALENDAR.workingDays,
    dayStartMinute: row.dayStartMinute ?? DEFAULT_CALENDAR.dayStartMinute,
    dayEndMinute: row.dayEndMinute ?? DEFAULT_CALENDAR.dayEndMinute,
    holidays: row.holidays || [],
  };

  // A window that ends before it starts is unusable, and the failure mode is
  // the worst one available: `dueAfter` would find no minute of any day
  // workable and fall through to elapsed time — silently, forever. Treat it as
  // "not configured" instead.
  if (cal.dayEndMinute <= cal.dayStartMinute) return DEFAULT_CALENDAR;
  return cal;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD`, which is what a holiday is. */
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The instant `minute` minutes past local midnight on the day `d` falls in. */
const atMinute = (d: Date, minute: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime() + minute * 60_000;

const nextMidnight = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
};

export const isWorkingDay = (d: Date, cal: WorkingCalendar) =>
  cal.workingDays.includes(d.getDay()) && !cal.holidays.includes(localDay(d));

/**
 * `minutes` of WORKING time after `from`.
 *
 * Filed at 02:00 with a 15-minute promise and a 9-to-6 calendar, the answer is
 * 09:15 the same morning — which is a promise the society can actually keep,
 * and therefore a breach that means something when it happens.
 *
 * A zero-minute promise returns the moment work can next start, not `from`:
 * "reply immediately" filed at midnight means first thing, not midnight.
 *
 * The loop is bounded. A calendar with every day marked a holiday would
 * otherwise spin forever; past the bound it falls back to elapsed time, which
 * is wrong but finite and visible, rather than a hung request.
 */
export function dueAfter(from: Date, minutes: number, cal: WorkingCalendar): Date {
  const wanted = Math.max(0, minutes);
  if (cal.roundTheClock) return new Date(from.getTime() + wanted * 60_000);

  let cursor = from.getTime();
  let remainingMs = wanted * 60_000;

  // A year and a bit of days. No real promise is longer, and a calendar that
  // cannot satisfy one inside a year is misconfigured, not slow.
  for (let i = 0; i < 400; i++) {
    const day = new Date(cursor);
    if (isWorkingDay(day, cal)) {
      const opens = atMinute(day, cal.dayStartMinute);
      const shuts = atMinute(day, cal.dayEndMinute);
      if (cursor < opens) cursor = opens;
      if (cursor < shuts) {
        const availableMs = shuts - cursor;
        if (remainingMs <= availableMs) return new Date(cursor + remainingMs);
        remainingMs -= availableMs;
        cursor = shuts;
      }
    }
    cursor = nextMidnight(cursor);
  }
  return new Date(from.getTime() + wanted * 60_000);
}

/**
 * The calendar in a sentence, for the screen.
 *
 * Appendix A rule 1 — say what happens. A resident reading "Fix by Monday 11am"
 * on a complaint filed Saturday evening will otherwise reasonably think the
 * software has lost two days.
 */
export function describeCalendar(cal: WorkingCalendar): string {
  if (cal.roundTheClock) return 'Counted around the clock, every day.';
  const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const days = [...cal.workingDays].sort((a, b) => a - b).map(d => NAMES[d]).filter(Boolean);
  const span = days.length > 2 && days.length === (Math.max(...cal.workingDays) - Math.min(...cal.workingDays) + 1)
    ? `${days[0]} to ${days[days.length - 1]}`
    : days.join(', ');
  const clock = (m: number) => {
    const h = Math.floor(m / 60), mm = m % 60;
    const suffix = h < 12 ? 'am' : 'pm';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return mm ? `${h12}.${pad(mm)}${suffix}` : `${h12}${suffix}`;
  };
  return `Counted during working hours only — ${span}, ${clock(cal.dayStartMinute)} to ${clock(cal.dayEndMinute)}.`;
}
