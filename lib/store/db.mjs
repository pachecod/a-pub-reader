// The database for hosted installs: PostgreSQL (Render Postgres in
// production; an embedded PGlite in tests). Both are wrapped to the same two
// methods, `query(text, params)` returning { rows } and `transaction(fn)`.
//
// The schema is changed only by named migrations, applied in order once each
// and recorded in schema_migrations, under an advisory lock so two instances
// starting together cannot apply one twice.
//
// User content lives in one `records` table (owner, kind, id, data as JSON),
// the same shape the JSON files on your Mac have. That keeps one set of store
// code for both, and SQL simple enough to move to SQLite (Cloudflare D1) if the
// Cloudflare option goes ahead. Accounts (Phase 2) get proper tables.

import pg from 'pg';

export const MIGRATIONS = [
  {
    name: '001_records_settings_cache',
    sql: `
      CREATE TABLE records (
        owner      text        NOT NULL,
        kind       text        NOT NULL,
        id         text        NOT NULL,
        seq        bigserial,
        data       jsonb       NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner, kind, id)
      );
      CREATE INDEX records_owner_kind_seq ON records (owner, kind, seq);
      -- Finding everyone who follows a feed, for shared fetching.
      CREATE INDEX records_feed_url ON records ((data->>'url')) WHERE kind = 'feeds';

      -- Settings for the whole install (limits now; registration and
      -- analytics switches in later phases).
      CREATE TABLE app_settings (
        key        text        PRIMARY KEY,
        value      jsonb       NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      -- Fetched feeds and articles, shared by everyone who follows them.
      CREATE TABLE fetch_cache (
        key        text        PRIMARY KEY,
        value      jsonb       NOT NULL,
        fetched_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX fetch_cache_fetched_at ON fetch_cache (fetched_at);
    `,
  },
  {
    // Accounts (Phase 2a). Usernames and emails are unique ignoring case. A
    // password is stored only as a scrypt hash; when an admin set it, an
    // encrypted copy may be kept for lookup until the user chooses their own.
    // Each user's library is the `records` owner named in `library`.
    name: '002_accounts',
    sql: `
      CREATE TABLE users (
        id                 text        PRIMARY KEY,
        username           text        NOT NULL,
        email              text,
        password_hash      text,
        admin_set_password boolean     NOT NULL DEFAULT false,
        admin_password_enc text,
        role               text        NOT NULL DEFAULT 'user',
        status             text        NOT NULL DEFAULT 'active',
        library            text        NOT NULL,
        created_by         text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        last_sign_in_at    timestamptz,
        email_verified_at  timestamptz
      );
      CREATE UNIQUE INDEX users_username_lower ON users (lower(username));
      CREATE UNIQUE INDEX users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;
      CREATE UNIQUE INDEX users_library ON users (library);

      -- Signed-in browsers. The cookie holds a random token; only its SHA-256
      -- is stored, so a copy of this table cannot be used to sign in.
      CREATE TABLE sessions (
        id           text        PRIMARY KEY,
        user_id      text        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        expires_at   timestamptz NOT NULL,
        user_agent   text,
        ip           text
      );
      CREATE INDEX sessions_user ON sessions (user_id);
      CREATE INDEX sessions_expires ON sessions (expires_at);
    `,
  },
  {
    // A reader key per user, for e-readers that browse the library as an OPDS
    // catalog (HTTP Basic: username + key). Stored as a SHA-256: the key is
    // long and random, so a slow hash adds nothing, and readers ask often.
    name: '003_reader_keys',
    sql: `
      ALTER TABLE users ADD COLUMN reader_key_hash text;
      ALTER TABLE users ADD COLUMN reader_key_created_at timestamptz;
      ALTER TABLE users ADD COLUMN reader_key_used_at timestamptz;
    `,
  },
  {
    // What the reader last did with its key, and its last failed try, so
    // Your account can show whether the reader has checked in.
    name: '004_reader_activity',
    sql: `
      ALTER TABLE users ADD COLUMN reader_last_activity text;
      ALTER TABLE users ADD COLUMN reader_failed_at timestamptz;
      ALTER TABLE users ADD COLUMN reader_last_failure text;
    `,
  },
];

// Any fixed number: the key for the migration advisory lock.
const MIGRATION_LOCK = 4_271_946;

/** Connect to PostgreSQL by URL (DATABASE_URL). */
export function openPostgres(url, { ssl } = {}) {
  // Render's internal URLs need no TLS; external ones (and most providers) do.
  const wantsSsl = ssl ?? !/@(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+)(:\d+)?\//i.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30000,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (err) => console.error('Database connection error:', err.message));
  return {
    kind: 'postgres',
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (text, params) => client.query(text, params) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * Open the database named by DATABASE_URL. A `pglite:<folder>` address opens
 * an embedded PostgreSQL in that folder instead of connecting to a server:
 * for tests, and for trying accounts on your own computer without installing
 * PostgreSQL. (PGlite is a development dependency, so it is not on Render.)
 */
export async function openDatabase(url, { ssl } = {}) {
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const folder = url.slice('pglite:'.length);
    return fromPGlite(folder ? new PGlite(folder) : new PGlite());
  }
  return openPostgres(url, { ssl });
}

/** Wrap a PGlite instance (tests) to the same shape. */
export function fromPGlite(lite) {
  return {
    kind: 'pglite',
    query: (text, params) => lite.query(text, params),
    transaction: (fn) => lite.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
    close: () => lite.close(),
  };
}

/** Apply any migrations not yet applied. Returns the names applied now. */
export async function migrate(db, migrations = MIGRATIONS) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = [];
  for (const migration of migrations) {
    const ran = await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      const { rows } = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [migration.name]);
      if (rows.length) return false;
      for (const statement of splitStatements(migration.sql)) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
      return true;
    });
    if (ran) applied.push(migration.name);
  }
  return applied;
}

/** Split a migration into statements (no semicolons inside strings here). */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Settings for the whole install, by key. */
export class AppSettings {
  constructor(db) {
    this.db = db;
  }

  async get(key, fallback = null) {
    const { rows } = await this.db.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    return rows.length ? rows[0].value : fallback;
  }

  async set(key, value) {
    await this.db.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
    return value;
  }
}
