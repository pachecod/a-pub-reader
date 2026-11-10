// Accounts and sessions in the database (tables from migration 002_accounts).
//
// A user has a username (and optionally an email), a role ('admin' or
// 'user'), a status ('active', 'pending' for approval, or 'disabled') and a
// library: the `records` owner their queue, feeds and drafts are kept under.
//
// A session is a random token in the browser's cookie. The table holds only
// the token's SHA-256, so even a full copy of the database signs no one in.
// Sessions last 30 days from the last visit, and are dropped on sign-out, on
// "sign out everywhere", when the password changes, or when an admin says so.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
// Recording each visit would be a write per request; once a few minutes is plenty.
const TOUCH_EVERY_MS = 5 * 60 * 1000;

export const ROLES = ['admin', 'user'];
export const STATUSES = ['active', 'pending', 'disabled'];

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

// Reader keys are typed on an e-reader's on-screen keyboard: lower-case
// letters and digits only, none that look alike (no 0/o, 1/l/i), in groups.
const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** A new reader key: 20 characters in groups of four, about 99 bits. */
export function readerKey() {
  const chars = Array.from({ length: 20 }, () => KEY_ALPHABET[randomInt(KEY_ALPHABET.length)]).join('');
  return chars.match(/.{4}/g).join('-');
}
/** A key as typed, without spaces, dashes or capitals. */
export const normalizeReaderKey = (key) => String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const newId = (prefix) => `${prefix}${randomBytes(9).toString('hex')}`;

/** Why a username will not do, or null. */
export function usernameProblem(username) {
  if (!USERNAME.test(String(username || ''))) {
    return 'A username is 3 to 32 letters, numbers, dots, dashes or underscores, starting with a letter or number.';
  }
  return null;
}

/** Why an email will not do, or null. Empty is fine (email is optional). */
export function emailProblem(email) {
  if (!email) return null;
  return EMAIL.test(String(email)) && String(email).length <= 254 ? null : 'That does not look like an email address.';
}

/** The parts of a user row that leave the server. Never the hash or the sealed copy. */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email || '',
    role: row.role,
    status: row.status,
    library: row.library,
    adminSetPassword: Boolean(row.admin_set_password),
    readerKey: row.reader_key_hash
      ? {
          createdAt: row.reader_key_created_at ? new Date(row.reader_key_created_at).toISOString() : null,
          usedAt: row.reader_key_used_at ? new Date(row.reader_key_used_at).toISOString() : null,
          lastActivity: row.reader_last_activity || '',
          failedAt: row.reader_failed_at ? new Date(row.reader_failed_at).toISOString() : null,
          lastFailure: row.reader_last_failure || '',
        }
      : null,
    canLookUp: Boolean(row.admin_password_enc),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    lastSignInAt: row.last_sign_in_at ? new Date(row.last_sign_in_at).toISOString() : null,
  };
}

export class AccountStore {
  constructor(db) {
    this.db = db;
  }

  // ---- users

  async count({ role } = {}) {
    const { rows } = role
      ? await this.db.query("SELECT count(*)::int AS n FROM users WHERE role = $1 AND status <> 'disabled'", [role])
      : await this.db.query('SELECT count(*)::int AS n FROM users');
    return rows[0].n;
  }

  async list() {
    const { rows } = await this.db.query('SELECT * FROM users ORDER BY created_at');
    return rows.map(publicUser);
  }

  async get(id) {
    const { rows } = await this.db.query('SELECT * FROM users WHERE id = $1', [String(id || '')]);
    return publicUser(rows[0]);
  }

  /** The full row, for checking a password. Internal only. */
  async #rowByLogin(login) {
    const value = String(login || '').trim().toLowerCase();
    if (!value) return null;
    const { rows } = await this.db.query(
      'SELECT * FROM users WHERE lower(username) = $1 OR (email IS NOT NULL AND lower(email) = $1) LIMIT 1',
      [value]
    );
    return rows[0] || null;
  }

  async #row(id) {
    const { rows } = await this.db.query('SELECT * FROM users WHERE id = $1', [String(id || '')]);
    return rows[0] || null;
  }

  /** The stored hash and status for a username or email, to check a sign-in. */
  async credentials(login) {
    const row = await this.#rowByLogin(login);
    return row ? { user: publicUser(row), hash: row.password_hash } : null;
  }

  async credentialsById(id) {
    const row = await this.#row(id);
    return row ? { user: publicUser(row), hash: row.password_hash, sealed: row.admin_password_enc } : null;
  }

  /**
   * Create a user. Throws with a readable message if the username or email is
   * taken or not valid.
   */
  async create({ username, email = '', role = 'user', status = 'active', passwordHash, adminSet = false, sealed = null, library, createdBy = null }) {
    const name = String(username || '').trim();
    const mail = String(email || '').trim();
    const problem = usernameProblem(name) || emailProblem(mail);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    if (!ROLES.includes(role) || !STATUSES.includes(status)) throw Object.assign(new Error('Unknown role or status.'), { status: 400 });
    const id = newId('u_');
    try {
      await this.db.query(
        `INSERT INTO users (id, username, email, password_hash, admin_set_password, admin_password_enc, role, status, library, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, name, mail || null, passwordHash || null, adminSet, sealed, role, status, library || newId('lib'), createdBy]
      );
    } catch (err) {
      if (err.code === '23505' || /unique|duplicate/i.test(err.message)) {
        const which = /email/.test(err.message) || err.constraint === 'users_email_lower' ? 'email' : 'username';
        throw Object.assign(new Error(`That ${which} is already taken.`), { status: 409 });
      }
      throw err;
    }
    return this.get(id);
  }

  /** Change role, status or email. */
  async update(id, { role, status, email } = {}) {
    const sets = [];
    const values = [];
    const add = (column, value) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (role !== undefined) {
      if (!ROLES.includes(role)) throw Object.assign(new Error('Unknown role.'), { status: 400 });
      add('role', role);
    }
    if (status !== undefined) {
      if (!STATUSES.includes(status)) throw Object.assign(new Error('Unknown status.'), { status: 400 });
      add('status', status);
    }
    if (email !== undefined) {
      const mail = String(email || '').trim();
      const problem = emailProblem(mail);
      if (problem) throw Object.assign(new Error(problem), { status: 400 });
      add('email', mail || null);
    }
    if (!sets.length) return this.get(id);
    values.push(String(id));
    try {
      await this.db.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`, values);
    } catch (err) {
      if (err.code === '23505' || /unique|duplicate/i.test(err.message)) {
        throw Object.assign(new Error('That email is already taken.'), { status: 409 });
      }
      throw err;
    }
    return this.get(id);
  }

  /**
   * Set a password. `adminSet` marks one an admin chose or generated; `sealed`
   * is its encrypted copy for lookup (or null). A password the user chose
   * clears both.
   */
  async setPassword(id, passwordHash, { adminSet = false, sealed = null } = {}) {
    await this.db.query(
      'UPDATE users SET password_hash = $2, admin_set_password = $3, admin_password_enc = $4, updated_at = now() WHERE id = $1',
      [String(id), passwordHash, adminSet, adminSet ? sealed : null]
    );
  }

  async recordSignIn(id) {
    await this.db.query('UPDATE users SET last_sign_in_at = now() WHERE id = $1', [String(id)]);
  }

  async delete(id) {
    const { rows } = await this.db.query('DELETE FROM users WHERE id = $1 RETURNING library', [String(id)]);
    return rows[0]?.library || null;
  }

  // ---- reader keys (OPDS)

  /** Make a new reader key for a user, replacing any earlier one. Returns the key, shown once. */
  async newReaderKey(id) {
    const key = readerKey();
    await this.db.query(
      'UPDATE users SET reader_key_hash = $2, reader_key_created_at = now(), reader_key_used_at = NULL, reader_last_activity = NULL, reader_failed_at = NULL, reader_last_failure = NULL WHERE id = $1',
      [String(id), tokenHash(normalizeReaderKey(key))]
    );
    return key;
  }

  async removeReaderKey(id) {
    await this.db.query(
      'UPDATE users SET reader_key_hash = NULL, reader_key_created_at = NULL, reader_key_used_at = NULL, reader_last_activity = NULL, reader_failed_at = NULL, reader_last_failure = NULL WHERE id = $1',
      [String(id)]
    );
  }

  /** The active user a username (or email) and reader key belong to, or null. */
  async readerKeyUser(login, key) {
    const value = String(login || '').trim().toLowerCase();
    const given = normalizeReaderKey(key);
    if (!value || given.length < 16) return null;
    const { rows } = await this.db.query(
      'SELECT * FROM users WHERE (lower(username) = $1 OR (email IS NOT NULL AND lower(email) = $1)) AND reader_key_hash IS NOT NULL LIMIT 1',
      [value]
    );
    const row = rows[0];
    if (!row || row.status !== 'active') return null;
    const expected = Buffer.from(row.reader_key_hash, 'hex');
    const actual = Buffer.from(tokenHash(given), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return publicUser(row);
  }

  /** What the reader just did with its key ("Opened the catalog", "Downloaded …"). */
  async noteReaderActivity(id, activity) {
    await this.db
      .query('UPDATE users SET reader_key_used_at = now(), reader_last_activity = $2 WHERE id = $1', [String(id), String(activity).slice(0, 200)])
      .catch(() => {});
  }

  /**
   * A failed try for a username that has a reader key: why, without anything
   * that was sent. Nothing is recorded for usernames without a key.
   */
  async noteReaderFailure(login, reason) {
    const value = String(login || '').trim().toLowerCase();
    if (!value) return;
    await this.db
      .query(
        `UPDATE users SET reader_failed_at = now(), reader_last_failure = $2
         WHERE (lower(username) = $1 OR (email IS NOT NULL AND lower(email) = $1)) AND reader_key_hash IS NOT NULL`,
        [value, String(reason).slice(0, 200)]
      )
      .catch(() => {});
  }

  // ---- sessions

  /** Start a session; returns the token for the cookie (never stored as is). */
  async createSession(userId, { userAgent = '', ip = '' } = {}) {
    const token = randomBytes(32).toString('base64url');
    await this.db.query(
      `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip)
       VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5)`,
      [tokenHash(token), String(userId), SESSION_MS / 1000, String(userAgent).slice(0, 300), String(ip).slice(0, 64)]
    );
    return token;
  }

  /**
   * The signed-in user for a session token, or null: unknown, expired, or the
   * account is disabled. A visit keeps the session alive for another 30 days.
   */
  async sessionUser(token) {
    if (!token || String(token).length > 200) return null;
    const id = tokenHash(token);
    const { rows } = await this.db.query(
      `SELECT s.last_seen_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > now()`,
      [id]
    );
    const row = rows[0];
    if (!row || row.status === 'disabled') return null;
    if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_EVERY_MS) {
      await this.db
        .query('UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(secs => $2) WHERE id = $1', [
          id,
          SESSION_MS / 1000,
        ])
        .catch(() => {});
    }
    return { user: publicUser(row), sessionId: id };
  }

  async deleteSession(token) {
    if (!token) return;
    await this.db.query('DELETE FROM sessions WHERE id = $1', [tokenHash(token)]);
  }

  /** Sign a user out everywhere, optionally keeping one session (this browser). */
  async deleteUserSessions(userId, { keep = null } = {}) {
    const { rows } = keep
      ? await this.db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2 RETURNING id', [String(userId), keep])
      : await this.db.query('DELETE FROM sessions WHERE user_id = $1 RETURNING id', [String(userId)]);
    return rows.length;
  }

  async countSessions(userId) {
    const { rows } = await this.db.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND expires_at > now()', [String(userId)]);
    return rows[0].n;
  }

  async pruneSessions() {
    await this.db.query('DELETE FROM sessions WHERE expires_at <= now()');
  }
}
