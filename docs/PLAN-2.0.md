# A-Pub Reader 2.0 — plan for review

Status: **decisions made 2026-11-09 (two still open, §10) — no code has been changed.** Branch: `v2` (local).
Written 2026-11-09 from: this codebase as of 1.0.0; the WebXRIDE repository
(`pachecod/vr-hotspots-educational`, `main` at 2.8 plus its newer `2.8`, `3.6`
and `3.8.x` branches); Node.js security releases through October 2026; and
Cloudflare and Render documentation. Settled choices are marked *decided*;
the full list is in §10.

---

## 1. What 2.0 adds, in one paragraph

A-Pub Reader 2.0 becomes a multi-user app when hosted. People sign in — with an
account an administrator made for them, an account they registered themselves
and verified by email, or their Google login — and everything they choose
(feeds, books, notes, switches, settings) is saved in the cloud on Render. An
administrator gets a dashboard to manage users, the Find feeds list, site
settings, legal pages and usage (including Google Analytics). Security is
brought up to date with this year's Node.js vulnerabilities and with what
WebXRIDE learned. Render stays the main deploy path, with a mapped-out route to
Cloudflare.

**Principle: the single-user app on your Mac keeps working exactly as it does
now.** Everything new switches on in hosted mode (or when configured), so the
local app — with its reader sync, cards and Drive folders — is not burdened by
accounts it does not need.

---

## 2. Where the app is today (what has to change)

- **One shared library.** 33 server routes read and write one set of files:
  `out/outbox.json` plus EPUBs, `feeds.json`, `drafts/`, `assets/`,
  `config.json` and `out/removals.json`. Nothing records *whose* anything is.
  Every store needs an owner.
- **Local disk only.** Render's free plan keeps no files, and even a paid disk
  is one machine. Multi-user cloud storage means a database plus object storage.
- **One shared password when hosted** (HTTP Basic, `APP_PASSWORD`). No users,
  no roles, no sessions.
- **The server fetches web addresses people type** — pasted URLs, feeds,
  images, book catalogues and downloads, full articles. With strangers able to
  register, that is a server-side request forgery (SSRF) risk: someone could aim
  it at addresses inside Render's network or cloud metadata services.
- **Security headers only on reading pages.** The main page has no
  Content-Security-Policy; most routes have no size limits beyond the global 96 MB.
- **Already good:** PDFs open with `isEvalSupported: false` everywhere (the 2024
  malicious-PDF fix, CVE-2024-4367); static files are served only from
  `public/` (WebXRIDE's main branch serves its whole repo root — a mistake not
  to copy); the hosted password check is timing-safe.

---

## 3. Phase 0 — Security baseline (do first, before any new feature)

**Status: built 2026-11-09** (local `v2`). Node 26.13.0 pinned; DOMPurify
3.4.17 (also the browser copy in `public/vendor/`) and Readability 0.6.0, with a
clean `npm audit`; `lib/netguard.mjs` (SSRF guard on undici, pinned 8.12.3);
`lib/security.mjs` (headers, CSP, same-origin, Host check, secrets, rate
limits); per-route body limits and JSON-only bodies; chapters sanitized
server-side; `test/security.test.mjs`. Left for Phase 2, when there are
sessions and a database: `SameSite` session cookies and database-backed rate
limits. Still to do: the Node release due 2026-11-11.

Grounded in the Node.js 2025–26 security releases and WebXRIDE's hardening
(`SECURITY_AUDIT.md`, its 2.8 → 3.8 security commits, `ad04079` "Pin Node
24.22.1 for the October security release").

**Runtime and dependencies**
- **Node 26 LTS, pinned** (*decided*). Node 26 has been Active LTS since
  2026-10-28 and has the longest support ahead of it; Node 22 (what `render.yaml`
  uses now) reaches end of life on 2027-04-30. Commit `.node-version` with the
  current 26.x, set `engines` to `>=26 <27`, and set Render's `NODE_VERSION` to
  26. First task: install Node 26 locally and run the full test suite, checking
  that the native image library (`@napi-rs/canvas`) loads; it uses Node's stable
  native-module interface, so it should. **Take the Node release pre-announced
  for 2026-11-11** (High severity, details pending) as soon as it is out.
- **DOMPurify 3.4.14 → latest.** `npm audit` today reports five new advisories
  (rated critical; they concern IN_PLACE and SAFE_FOR_TEMPLATES modes this app
  may not use — update regardless). Then a clean `npm audit` as a release gate.
- Keep pdfjs `isEvalSupported: false`, with a test that fails if it is removed.

**Request handling**
- **SSRF guard on every outbound fetch** of a user-supplied address, modelled on
  WebXRIDE's `lib/security/ssrf-guard.js` plus its 3.8 DNS pinning: http/https
  only, no credentials in URLs, block localhost / private / link-local /
  metadata ranges (IPv4 and IPv6, including the fullwidth-digit and octal IPv4
  tricks from CVE-2026-105483 / -106069), check every resolved address, pin the
  connection to the checked IP (prevents DNS rebinding), re-check on each
  redirect, cap size and time. Applies to URL conversion, images in articles,
  feeds, full-article fetching, catalogues and book downloads. Local mode may
  allow private addresses (your reader on the LAN) — hosted mode never.
- **Security headers on every page**: a real CSP on the main page (allowing
  Google Analytics' hosts when enabled), `X-Content-Type-Options`,
  `Referrer-Policy`, `frame-ancestors 'none'`, HSTS when hosted.
- **Per-route body limits** (PDF upload large, JSON small) instead of one 96 MB cap.
- **CSRF**: with cookie sessions (Phase 2), check `Origin`/`Referer` on every
  state-changing request — the strict WebXRIDE 3.8 version, *without* its old
  `X-Requested-With` bypass — plus `SameSite=Lax` cookies.
- **Production secret check at startup** (WebXRIDE's `production-secrets.js`):
  refuse to start hosted with missing, short or default secrets.
- **Rate limits** on sign-in, registration, password reset, email sending and
  conversions; persistent (database) rather than in-memory once there is a
  database. Behind Render's proxy, read the client IP from `X-Forwarded-For`
  correctly (WebXRIDE had to add `trust proxy` for exactly this).
- One shared `escapeHtml`, no inline event handlers in admin pages
  (WebXRIDE 3.8 lessons), and the eBook viewer's injected HTML sanitized
  server-side with DOMPurify as well as being script-stripped.

**Tests**: a `test/security.test.mjs` regression suite (as WebXRIDE's
`test:security`): SSRF blocklist and IP tricks, redirect safety, CSRF, secrets
check, headers present, pdfjs flag, no static file outside `public/`.

---

## 4. Phase 1 — Data layer for many users

**Status: built 2026-11-09** (local `v2`). Stores sit on collections and blob
storage (`lib/store/`): JSON files and folders on your Mac (unchanged paths),
or PostgreSQL (`pg`, named migrations) plus an S3-compatible bucket (signed with
`aws4fetch`) when `DATABASE_URL` is set. Each request runs as one owner.
Shared feed and article fetching (`fetch_cache`), per-library limits
(`lib/limits.mjs`, defaults until the Phase 3 Settings page), and Download all
eBooks. Tests run on embedded PGlite, and on a real PostgreSQL via
`TEST_DATABASE_URL`.

*Changed from the draft below:* user content is one `records` table (owner,
kind, id, JSON data) rather than a table per kind. It mirrors the JSON files,
so one set of store code serves both backends, and stays SQLite-friendly for
D1. Accounts (Phase 2) get proper tables.

**Storage behind interfaces.** Replace the direct JSON-file classes (`Outbox`,
`FeedStore`, `DraftStore`, `AssetStore`, `Removals`, config) with store
interfaces that take an owner, with two implementations:
- **Files** (today's behaviour) for the local single-user app.
- **Database + object storage** for hosted.

**Database: PostgreSQL on Render** (as WebXRIDE), using `pg` and a small
named-migration runner like WebXRIDE's `db/migrate.js` (no ORM). Tables, roughly:
`users`, `identities` (password / Google), `sessions`, `email_tokens`,
`invite_codes`, `applications` (requests for an invite), `feeds`, `library_items`
(today's outbox entries), `drafts`, `assets`, `removals`, `app_settings`
(key/JSONB, as WebXRIDE), `feed_directory` (the admin-managed Find feeds list),
`activity_log`, `error_log`. Keep the SQL portable to SQLite where cheap, so
Cloudflare D1 stays possible (Phase 5).

**Files: object storage** for EPUBs, PDF page images and draft images
(*decided*): **Backblaze B2 for Render installs, Cloudflare R2 for Cloudflare
installs.** Both speak the S3 interface, so the app has one storage driver,
pointed at either service by environment variables (endpoint, bucket, key ID,
secret key; all `sync: false` on Render). Local installs keep using folders on
disk. Expected size: about 10–20 MB for a typical user, so roughly 1–2 GB for
100 users.

**Shared feed fetching.** Many users will follow the same feeds (NPR, BBC…).
Fetch and parse each feed URL once per interval and share it; build editions
per user. Saves time and keeps the app polite to publishers.

**Per-user limits** (storage, items, feeds, conversions per day), set by the
admin, so one account cannot fill the bucket.

**Hosted vs reader sync.** Hosted users read in the browser (as today's hosted
mode). Reader sync stays a local-app feature in 2.0; per-user cloud sync (for
example to a Boox through each user's own Google Drive) is **deferred to a later
release** (*decided*).

**Download all my eBooks.** Instead, every user gets a **"Download all eBooks"**
button in the Library that returns one `.zip` of all their generated EPUBs,
built on the fly with `jszip` (already a dependency) and streamed so a large
library does not sit in memory. It works locally too.

---

## 5. Phase 2 — Accounts and sign-in

### 2a. Admin-created accounts (first, the WebXRIDE approach)
- Admin creates users, types a password or has the server generate a readable
  one (WebXRIDE's `generateRandomPassword` pattern), and hands it out; users can
  change it after signing in. **Sign-in is username (or email) and password
  only** (*decided*). There are no classes, teams or rosters, so WebXRIDE's class
  password and roster sign-in are not carried over.
- **Administrators are user accounts with an `admin` role**, not one shared
  `ADMIN_PASSWORD` (WebXRIDE's single shared, plaintext-compared admin password
  is a weakness worth leaving behind). A bootstrap: the first admin is created
  from env vars on first run.
- **Every password is hashed** with **scrypt from Node's built-in `crypto`**
  (salted, memory-hard, recommended by OWASP, and no extra dependency). A hash is
  one-way: the server can check a password but never recover it, which is
  stronger than encryption.
- **Admin lookup, only for passwords an admin set** (*decided*). When an admin
  creates or resets a user's password, the server also keeps an encrypted copy
  (AES-256-GCM) so the admin can look it up again or export it. The encryption
  key is a required environment variable (`PASSWORD_LOOKUP_KEY`, set on Render,
  never in git); without it, lookup is off. **As soon as the user sets their own
  password, the encrypted copy is deleted**, and from then on only the hash
  exists: no admin can ever see a password a user chose. The Users page shows
  which accounts still have an admin-set password.

### Sessions
- **Server-side sessions in the database**: random token in an
  `HttpOnly; Secure; SameSite=Lax` cookie, stored hashed, with expiry, rotation
  at sign-in, "sign out everywhere", and admin revocation. (WebXRIDE's stateless
  signed cookies plus a boot ID sign everyone out on every deploy — fine for a
  classroom tool, annoying for a reading app.)

### 2b. Self-registration with email verification
- Sign up with email + password → a verification email with a single-use,
  expiring link (token stored hashed) → account active.
- Password reset by email, same token pattern. Generic responses so the forms
  do not reveal which emails have accounts.
- **Email sending through Resend** (*decided: cheapest*). Its free tier
  covers 3,000 emails a month (100 a day), far more than verification and reset
  emails for this app need; Postmark's free tier is 100 a month and SendGrid no
  longer has a free plan. API key in `RESEND_API_KEY` on Render. Needs a
  **sending domain you own** (for example a subdomain of danpacheco.com), with
  the DNS records Resend gives you; to settle before 2b.

**Registration settings** (*decided*), global switches on the admin Settings page:

| Switch | Default | When on |
|---|---|---|
| **Invite code required** | Off (open registration) | The sign-up form asks for an invite code. Visitors without one see an **"Apply for an invite"** form (name, email, a line about why). |
| **New accounts need approval** | On | New accounts wait in a queue until an admin approves them; the user is told so and emailed when approved. Turn it off and anyone can register and start at once. |

- **Invite codes**: the admin generates codes on an Invites page, each with an
  optional label, number of uses (single-use by default) and expiry, and can
  revoke them. The page shows who used each code.
- **Applications**: the admin sees requests for invites, and approving one
  generates a code and emails it to the applicant; declining sends nothing.
- Google sign-in follows the same switches.

### 2c. Google sign-in
- OpenID Connect authorization-code flow with PKCE, `state` and `nonce`, from a
  Google Cloud OAuth client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in
  Render's environment).
- Links to an existing account when Google's verified email matches; users can
  have both a password and Google. The invite and approval switches apply here
  too.
- **Auth approach** (*decided: easiest that stays secure*): small, standard
  pieces rather than a framework. Node's built-in `crypto` for password hashing,
  tokens and encryption; **`openid-client`** (widely used, certified OpenID
  implementation) for Google; sessions in the database. A full auth framework
  such as better-auth would bring its own database schema and routing, which
  fights this app's plain `node:http` server and its local file mode, and would
  still need custom code for admin-set password lookup and the invite and
  approval rules. Each piece gets tests in `test/security.test.mjs`.

### Local mode
Accounts are off by default on your Mac (single user, as today). They can be
switched on with a setting for testing.

---

## 6. Phase 3 — Admin dashboard

Pattern from WebXRIDE: an `/admin` area with a tab bar (`admin-nav.js`), each
page backed by admin-only API routes. **Unlike WebXRIDE's main branch, admin
pages are served only after a server-side admin check**, not from the open
static folder.

| Page | Purpose | From WebXRIDE |
|---|---|---|
| **Overview** | Counts (users, active this week, items, storage), recent sign-ups, warnings | `admin.html` |
| **Users** | Create, edit, disable, delete; approve waiting accounts; reset password; look up an admin-set password; roles; CSV import/export; see a user's library size | `admin-users` |
| **Invites** | Generate, label and revoke invite codes; review applications for an invite | new |
| **Find feeds** | Add, edit, reorder, remove the publisher list and topics; live check of each URL — the roadmap item | new (replaces `lib/discover.mjs` list) |
| **Settings** | Invite code required, new accounts need approval, per-user limits, default feeds for new users, analytics on/off | "Editor Settings" + `app_settings` |
| **Legal pages** | Edit Terms and Privacy (needed once there are accounts and analytics) | `admin-legal` |
| **System text** | Edit welcome and other interface copy | `admin-system-text` |
| **Usage** | GA4 numbers (via the GA4 Data API), storage per user, conversions, feed fetch health | `origin/3.6` `admin-usage` |
| **Activity** | Sign-ins, failed sign-ins, admin actions (audit log) | `origin/3.6` `admin-activity` |
| **Error log** | Server and client errors | `origin/3.6` `admin-error-log` |

Not carried over (VR-specific): templates, submissions/review inbox, common
assets, snippets/Ridey AI, hosted pages, and **billing** (*decided: left out
for now*).

**No "view as user" peek** (*decided*). For each user the admin sees counts and
sizes only (feeds, books, notes, storage used, last sign-in), not titles or
contents. A personal library is private, and counts are enough to spot a
problem or a full account.

---

## 7. Phase 4 — Google Analytics

As WebXRIDE (`lib/analytics-config.js`, `analytics-html-inject.js`, commit
`2907134`, later `ddf97f1`):
- GA4 measurement ID from an env var (`GOOGLE_ANALYTICS_MEASUREMENT_ID`,
  validated `G-…`), never in the repository; an admin on/off switch in Settings;
  suppressed on localhost.
- The standard gtag snippet in the main page and reading pages, served by the
  server so the switch takes effect; CSP updated for Google's hosts.
- **Consent banner** (*decided: yes*). WebXRIDE has none. Analytics stays off
  until a visitor accepts, using Google's Consent Mode; declining is as easy as
  accepting, the choice is remembered, and it can be changed from a link in the
  footer. The Privacy page explains it.
- Do not send personal data (no emails or user IDs in events); optional custom
  events: item added, feed refreshed, reading page opened.
- Usage page in the dashboard through the GA4 Data API with a service account
  (`GA4_PROPERTY_ID`, `GA4_SERVICE_ACCOUNT_JSON`), as WebXRIDE 3.6.

---

## 8. Phase 5 — Deployment

### Render (main path)
- A **new Render service for 2.0 tracking the `v2` branch**, alongside the 1.0
  service on `main`, plus **Render Postgres**. Blueprint (`render.yaml`) on `v2`
  with every secret `sync: false` (filled in on Render, never in git): session
  secret, first-admin credentials, email API key, Google OAuth client, GA IDs,
  object-storage keys.
- `/healthz` health check (exists), `NODE_ENV=production`, Node 26, files in B2.
- **Costs** (*still open*). Render charges separately for the app (web service)
  and the database, each at a size you pick. Approximate tiers, to confirm on
  Render's pricing page:

  | | Free | Paid starting point |
  |---|---|---|
  | **Web service** | Sleeps after 15 minutes idle, ~1 minute to wake | Starter, about $7/month: always on, 512 MB memory. Standard, about $25/month, 2 GB, if large PDF conversions run out of memory |
  | **Postgres** | Deleted after 30 days | Basic, about $6/month: kept, backed up |

  Recommendation: free tiers while building and testing 2.0, then **Starter web
  + Basic Postgres (about $13/month)** when real users arrive, plus B2 at
  pennies.

### Cloudflare (explore)
Findings: plain **Workers** cannot run this app's conversion core — the native
image library (`@napi-rs/canvas`) cannot load there, jsdom is impractical in a
128 MB isolate, and PDF page rendering needs the canvas. **Cloudflare Containers**
(generally available since April 2026, Workers Paid $5/month plus usage, billed
only while awake) can run the existing Node server from a Docker image, but its
disk is temporary — storage must already be in R2 and a database, which
Phase 1 provides.

Recommended exploration, in order:
1. **Containers spike**: the 2.0 server in a Docker image on a Container, with
   R2 for files and Postgres (still on Render, or Neon) — proves Cloudflare
   hosting with almost no code change.
2. **Hybrid**: a Worker serves the interface, sign-in, library and admin APIs
   from **D1** (SQLite) and **R2**; conversions (PDF, Readability, images, EPUB
   build) run in a Container, or stay on Render as an internal service.
3. Pure Workers only if the converter is rewritten (linkedom, edge PDF.js builds,
   a WASM image codec) — not recommended.

Keeping SQL SQLite-compatible and storage behind interfaces (Phase 1) keeps
option 2 open without committing to it.

---

## 9. Order of work and rough size

| Step | What | Rough size |
|---|---|---|
| 0 | Security baseline (Node 26, DOMPurify, SSRF guard, headers, limits, tests) | 2–3 days |
| 1 | Store interfaces; Postgres + migrations; B2/R2 storage driver; owners on everything; shared feed fetching; Download all eBooks | 5–8 days |
| 2a | Users, roles, admin-created accounts, admin-set password lookup, sessions, sign-in UI | 3–4 days |
| 3 | Admin dashboard: Overview, Users, Find feeds, Settings, Legal, System text | 4–6 days |
| 4 | Google Analytics + consent banner + Privacy text | 1–2 days |
| 2b | Self-registration, email verification, password reset, invite codes, applications, approval queue | 3–4 days |
| 2c | Google sign-in | 1–2 days |
| 3+ | Usage, Activity, Error log pages | 2–3 days |
| 5 | Render blueprint for 2.0; Cloudflare Containers spike | 2–3 days |

Each step ends with tests and a working app; the local single-user app keeps
passing its current tests throughout.

---

## 10. Decisions

Decided 2026-11-09:

1. **Node 26** LTS.
2. **Storage: B2 for Render installs, R2 for Cloudflare installs**, through one S3 driver.
3. **Admin can look up only passwords an admin set**, encrypted with a key from the environment and deleted once the user picks their own; user-chosen passwords are hashed and never visible.
4. **Username/email + password only**; no classes, teams or rosters.
5. **Open registration**, with global admin switches for **invite code required** (with invite generation and an apply-for-invite form) and **new accounts need approval** (on to start).
6. **Resend** for email (cheapest); sending domain to pick before 2b.
7. **Small standard pieces**: Node `crypto` (scrypt), `openid-client`, database sessions.
8. **Consent banner**: yes.
9. **Billing**: left out for now.
10. **No "view as user"**: counts and sizes only.
11. **Hosted reader sync deferred** to a later release; **Download all eBooks** (one zip) added to 2.0.

Still open:

12. **Render sizes** (see §8): free while building, then Starter web + Basic Postgres (about $13/month) when real users arrive?
13. **Sending domain** for email (needed by Phase 2b).

---

## 11. Risks

- **Scope**: this is a large step from a single-user app. Phases are ordered so
  each is useful on its own; accounts + storage (1, 2a) are the core.
- **Native image library** must have builds for the chosen Node version and for
  any Container image (Linux x64/arm64 builds exist today).
- **Feed fetching at scale** needs the shared cache and per-user limits, or
  hosting costs and publisher rate limits bite.
- **Email deliverability** depends on domain setup (SPF/DKIM/DMARC).
- **Privacy**: personal libraries plus analytics require clear Terms/Privacy and
  careful admin access.
- **Node security cadence**: monthly-ish releases this year; plan a routine of
  updating the pinned version after each one.

---

## Sources

- WebXRIDE: `SECURITY_AUDIT.md`, `test/security-regression.js`, `lib/session.js`,
  `lib/security/*`, `lib/analytics-*`, `routes/roster-routes.js`,
  `lib/app-settings.js`, `db/migrate.js`, `render.yaml`, `RENDER_DEPLOY.md`;
  commits 4ceb497, 0ef23ef, 7228506, 9cce12f, d082908, ad04079, 2907134, ddf97f1.
- Node.js security releases: nodejs.org/en/blog/vulnerability (May 2025, July 2025,
  Dec 2025/Jan 2026, March 2026, June 2026, July 2026, October 2026, and the
  November 2026 pre-announcement); github.com/nodejs/release.
- Render: render.com/docs/node-version.
- pdfjs CVE-2024-4367: github.com/advisories/GHSA-wgrm-67xf-hhpq.
- Cloudflare: developers.cloudflare.com — Workers limits and Node.js
  compatibility, Containers (overview, limits, pricing, FAQ, April 2026 GA
  changelog), D1 limits, Workers static assets.
- `npm audit` of this project, 2026-11-09.
