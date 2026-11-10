// Passwords: hashing, checking, the rules for a new one, and readable ones for
// an admin to hand out.
//
// Hashing is scrypt from Node's own crypto: salted and memory-hard, so a
// stolen table of hashes is slow to attack even with fast hardware. The cost
// is OWASP's "N=2^15, r=8, p=3" setting: 32 MB of memory per check, which a
// small (512 MB) server can afford, and around a tenth of a second.
//
// A hash cannot be turned back into the password. That is the point: the
// server can tell whether a password is right, never what it is.

import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

import { isCommonPassword } from '../security.mjs';

const COST = { N: 2 ** 15, r: 8, p: 3 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

function derive(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) =>
    scrypt(String(password).normalize('NFKC'), salt, KEY_BYTES, { N, r, p, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  );
}

/** A stored hash: "scrypt$<log2 N>$<r>$<p>$<salt>$<hash>", base64. */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST);
  return ['scrypt', Math.log2(COST.N), COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

// Checked against when there is no account, so a wrong username takes as long
// as a wrong password and the timing does not reveal which usernames exist.
let decoy = null;

/** Whether a password matches a stored hash. Never throws on a bad hash. */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    decoy ||= await hashPassword(randomBytes(12).toString('hex'));
    await verifyPassword(password, decoy);
    return false;
  }
  const [, logN, r, p, salt, hash] = parts;
  try {
    const expected = Buffer.from(hash, 'base64');
    const key = await derive(password, Buffer.from(salt, 'base64'), { N: 2 ** Number(logN), r: Number(r), p: Number(p) });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * Why a new password will not do, as a sentence; null when it is fine.
 * Long beats complicated: no rules about symbols, just a minimum length and
 * nothing guessable.
 */
export function passwordProblem(password, { username = '', email = '' } = {}) {
  const value = typeof password === 'string' ? password : '';
  if (value.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (value.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  const lower = value.toLowerCase();
  if (isCommonPassword(lower) || /^(.)\1+$/.test(value)) return 'That password is too easy to guess.';
  const names = [username, String(email).split('@')[0]].map((n) => String(n || '').toLowerCase()).filter((n) => n.length >= 3);
  if (names.some((n) => lower.includes(n))) return 'A password should not contain your username or email.';
  return null;
}

// Short, common, unambiguous words: easy to read out and type.
const WORDS = (
  'acorn amber anchor apple arrow aspen atlas autumn badge bamboo banjo barley basil beacon berry birch ' +
  'bison blossom bramble breeze brook cabin cactus canal candle canyon cedar cello chalk cherry cider ' +
  'cinder clover cobalt comet copper coral cosmos cotton crane crater crystal daisy delta denim desert ' +
  'dolphin dune eagle ember falcon fern fiddle fjord flint forest fossil garden garnet ginger glacier ' +
  'granite gravel harbor harvest hazel heron honey island ivory jasper juniper kayak kettle lagoon ' +
  'lantern laurel lemon lilac linen lotus magnet mango maple marble meadow melon mesa mint mosaic ' +
  'nectar nickel nutmeg oasis ocean olive orbit orchid otter pebble pepper pigeon pine planet plum ' +
  'pollen poppy prairie quartz quill rabbit raven reef ribbon river robin saffron salmon sapphire ' +
  'sequoia shadow silver sparrow spruce stone summit sunset swallow tango thistle thunder tiger timber ' +
  'topaz tulip tundra valley velvet violet walnut willow winter yarrow zephyr'
).split(' ');

/** A password an admin can read out: four words and two digits, about 40 bits. */
export function readablePassword() {
  const words = Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]);
  return `${words.join('-')}-${String(randomInt(100)).padStart(2, '0')}`;
}
