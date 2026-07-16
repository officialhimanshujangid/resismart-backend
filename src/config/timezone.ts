/**
 * Pin the process timezone. Import this FIRST, before anything else, in every
 * entry point (server, scripts, cron) — imports are evaluated in order, so a
 * plain assignment at the top of `server.ts` would run *after* every imported
 * module had already loaded and possibly constructed dates.
 *
 * Why it matters: the finance layer does financial-year math in local time —
 * `new Date(year, month, 1)` in `financial-year.util`, `setHours` in
 * `reporting-period.service`. On a UTC host (the Docker/CI default) an entry
 * posted at 02:00 IST on 1 April is stored as 20:30Z on 31 March and falls into
 * the PREVIOUS financial year. The stamp and the report agree with each other,
 * so nothing flags it — ~5.5 hours either side of every FY boundary is silently
 * misassigned. Setting TZ here makes the code's existing assumption explicit.
 */
process.env.TZ = 'Asia/Kolkata';

export const APP_TIMEZONE = process.env.TZ;
