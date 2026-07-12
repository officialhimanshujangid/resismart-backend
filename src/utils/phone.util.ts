/**
 * Phone + identifier helpers shared by auth (login lookup) and the
 * user-creation flows (flat/resident/shop). Keep normalization identical on
 * both sides so a number stored at creation always matches at login.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when the string looks like an email address (vs a phone number). */
export const isEmail = (value: string): boolean => EMAIL_RE.test(value.trim());

/**
 * Normalize a raw phone number to a consistent, comparable form.
 *
 * - Strips spaces, dashes, parentheses and dots.
 * - Keeps a leading '+' for already-international numbers.
 * - For India (default), converts a bare 10-digit number or a leading-0
 *   national number into +91 E.164 form.
 *
 * Returns an empty string when there are no usable digits.
 */
export const normalizePhone = (raw: string, defaultCountry: 'IN' = 'IN'): string => {
  if (!raw) return '';

  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');

  if (!digits) return '';

  // Already international (came with a '+').
  if (hasPlus) return `+${digits}`;

  if (defaultCountry === 'IN') {
    // 00-prefixed international dialing → '+'
    if (digits.startsWith('00')) return `+${digits.slice(2)}`;
    // National trunk prefix: 0XXXXXXXXXX (11 digits) → drop the 0
    if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
    // Bare 10-digit mobile number → assume +91
    if (digits.length === 10) return `+91${digits}`;
    // Already includes the 91 country code without '+'
    if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  }

  // Fallback: return the digits with a '+' so comparisons stay consistent.
  return `+${digits}`;
};
