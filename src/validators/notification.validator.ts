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

export const markReadSchema = z.object({
  // Absent means "all of mine" — an empty array would mean "none", so the two
  // are kept genuinely different rather than collapsed.
  ids: z.array(z.string().regex(objectId)).max(200).optional(),
});
