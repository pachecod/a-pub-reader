// The encrypted copy of a password an admin set, so the admin can look it up
// again (decided in the plan). Only admin-set passwords are kept this way, and
// the copy is deleted the moment the user chooses their own: a password a user
// picked exists only as a hash.
//
// AES-256-GCM, with the key in PASSWORD_LOOKUP_KEY (32 random bytes, base64 or
// hex; Render can generate one). Without the key, lookup is simply off.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The lookup key from the environment, or null when unset. Throws if malformed. */
export function lookupKey(env = process.env) {
  const raw = String(env.PASSWORD_LOOKUP_KEY || '').trim();
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('PASSWORD_LOOKUP_KEY must be 32 bytes, as base64 or 64 hex characters.');
  return key;
}

/** Encrypt a password: "v1.<iv>.<tag>.<ciphertext>", base64. */
export function sealPassword(key, password) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

/** Decrypt a sealed password, or null if it cannot be (wrong key, tampered). */
export function openPassword(key, sealed) {
  try {
    const [version, iv, tag, data] = String(sealed || '').split('.');
    if (version !== 'v1') return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
