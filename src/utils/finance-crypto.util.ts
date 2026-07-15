import crypto from 'crypto';
import { appConfig } from '../config/appConfig';

/**
 * AES-256-GCM encryption for finance secrets (per-society gateway keys, vendor
 * bank details). Uses a DEDICATED key (appConfig.financeEncryptionKey), separate
 * from the JWT secret, so rotating auth secrets never loses finance data.
 */
function key(): Buffer {
  return crypto.createHash('sha256').update(appConfig.financeEncryptionKey).digest();
}

export function encryptSecret(plaintext: string): { ct: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  let ct = cipher.update(plaintext, 'utf8', 'hex');
  ct += cipher.final('hex');
  return { ct, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

export function decryptSecret(ct: string, ivHex: string, tagHex: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let pt = decipher.update(ct, 'hex', 'utf8');
  pt += decipher.final('utf8');
  return pt;
}
