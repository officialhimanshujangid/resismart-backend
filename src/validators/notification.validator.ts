import { z } from 'zod';

const objectId = /^[0-9a-fA-F]{24}$/;

/**
 * Registering a device.
 *
 * The refinement is the point: a WEB subscription is useless without the
 * browser's encryption keys, and accepting one without them would store a row
 * that can never be sent to — the exact "declared, saved, never usable" shape
 * this codebase keeps having to dig out. Rejected at the door instead.
 */
export const registerDeviceSchema = z.object({
  platform: z.enum(['WEB', 'ANDROID', 'IOS']),
  token: z.string().min(10, 'Not a usable device token').max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(300),
  }).optional(),
  deviceLabel: z.string().max(120).optional(),
}).refine(
  v => v.platform !== 'WEB' || !!v.keys,
  { message: 'A browser subscription needs its p256dh and auth keys', path: ['keys'] },
);

export const unregisterDeviceSchema = z.object({
  token: z.string().min(10).max(1000),
});

/**
 * Notification preferences.
 *
 * The two refinements are the ones that would otherwise produce a saved
 * setting that silently does nothing:
 *
 *   - A quiet window whose start equals its end is ambiguous — is 22:00→22:00
 *     "always quiet" or "never quiet"? The service reads it as never, so
 *     accepting it would hand somebody a switch that changes nothing.
 *   - A timezone Node cannot resolve makes the whole window meaningless; it is
 *     checked against the runtime here rather than against a hardcoded list
 *     that goes stale.
 */
const minuteOfDay = z.number().int().min(0).max(1439);

const knownTimezone = (tz: string): boolean => {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; }
  catch { return false; }
};

export const savePreferencesSchema = z.object({
  // Kinds are free strings by design (see notification.model) — bounded in
  // length and count so a crafted list cannot bloat one person's row.
  mutedKinds: z.array(z.string().min(1).max(80)).max(200).optional(),
  channels: z.object({
    inApp: z.boolean().optional(),
    push: z.boolean().optional(),
    email: z.boolean().optional(),
  }).optional(),
  // null clears the window; absent means "leave it as it is". Kept genuinely
  // different, because "I removed my quiet hours" and "I only changed my mutes"
  // are different intentions arriving on the same endpoint.
  quietHours: z.object({
    fromMinute: minuteOfDay,
    toMinute: minuteOfDay,
  }).refine(v => v.fromMinute !== v.toMinute, {
    message: 'Quiet hours must start and end at different times',
    path: ['toMinute'],
  }).nullable().optional(),
  timezone: z.string().min(1).max(64).refine(knownTimezone, 'That is not a timezone this server knows').optional(),
});

export const markReadSchema = z.object({
  // Absent means "all of mine" — an empty array would mean "none", so the two
  // are kept genuinely different rather than collapsed.
  ids: z.array(z.string().regex(objectId)).max(200).optional(),
});
