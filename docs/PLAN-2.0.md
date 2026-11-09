# A-Pub Reader 2.0 — plan for review

Status: **draft for review — no code has been changed.** Branch: `v2` (local).
Written 2026-11-09 from: this codebase as of 1.0.0; the WebXRIDE repository
(`pachecod/vr-hotspots-educational`, `main` at 2.8 plus its newer `2.8`, `3.6`
and `3.8.x` branches); Node.js security releases through October 2026; and
Cloudflare and Render documentation. Decisions that are yours to make are
marked **Decide**.

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

Grounded in the Node.js 2025–26 security releases and WebXRIDE's hardening
(`SECURITY_AUDIT.md`, its 2.8 → 3.8 security commits, `ad04079` "Pin Node
24.22.1 for the October security release").

**Runtime and dependencies**
- **Node 24 LTS, pinned.** Node 22 (what `render.yaml` uses now) reaches end of
  life on 2027-04-30; 20 is already end of life. Commit `.node-version`
  (`24.22.1`, matching WebXRIDE), set `engines` to `>=24.22.1 <25`, and set
  Render's `NODE_VERSION` to 24. **Upgrade again after the Node release
  pre-announced for 2026-11-11** (High severity, details pending).
  *Decide:* 24 (safe, what WebXRIDE uses) or 26 (Active LTS since 2026-10-28,
  longer life; needs a check that `@napi-rs/canvas` ships a build for it).
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

**Storage behind interfaces.** Replace the direct JSON-file classes (`Outbox`,
`FeedStore`, `DraftStore`, `AssetStore`, `Removals`, config) with store
interfaces that take an owner, with two implementations:
- **Files** (today's behaviour) for the local single-user app.
- **Database + object storage** for hosted.

**Database: PostgreSQL on Render** (as WebXRIDE), using `pg` and a small
named-migration runner like WebXRIDE's `db/migrate.js` (no ORM). Tables, roughly:
`users`, `identities` (password / Google), `sessions`, `email_tokens`,
`groups` + `group_members` (optional, for classes), `feeds`, `library_items`
(today's outbox entries), `drafts`, `assets`, `removals`, `app_settings`
(key/JSONB, as WebXRIDE), `feed_directory` (the admin-managed Find feeds list),
`activity_log`, `error_log`. Keep the SQL portable to SQLite where cheap, so
Cloudflare D1 stays possible (Phase 5).

**Files: object storage** for EPUBs, PDF page images and draft images.
*Decide:* **Cloudflare R2** (S3-compatible, no egress fees, and the natural fit
if Cloudflare comes later) or **Backblaze B2** (what WebXRIDE already uses —
one account for both apps). A Render persistent disk is the simplest but ties
data to one machine and needs a paid plan.

**Shared feed fetching.** Many users will follow the same feeds (NPR, BBC…).
Fetch and parse each feed URL once per interval and share it; build editions
per user. Saves time and keeps the app polite to publishers.

**Per-user limits** (storage, items, feeds, conversions per day), set by the
admin, so one account cannot fill the bucket.

**Hosted vs reader sync.** Hosted users read in the browser (as today's hosted
mode). Reader sync stays a local-app feature for now; per-user cloud sync to a
Boox via each user's own Google Drive is a possible later addition (noted in §10).

---

## 5. Phase 2 — Accounts and sign-in

### 2a. Admin-created accounts (first, the WebXRIDE approach)
- Admin creates users (and optionally groups/classes), types a password or has
  the server generate a readable one (WebXRIDE's `generateRandomPassword`
  pattern), and hands it out; users can change it after signing in.
- **Administrators are user accounts with an `admin` role**, not one shared
  `ADMIN_PASSWORD` (WebXRIDE's single shared, plaintext-compared admin password
  is a weakness worth leaving behind). A bootstrap: the first admin is created
  from env vars on first run.
- Passwords hashed with **bcrypt cost 12** (WebXRIDE uses 10) or Argon2id.
  *Decide:* WebXRIDE also stores passwords **reversibly encrypted** so admins
  can look them up and export CSV. Recommendation: **don't** — show a generated
  password once, and offer "reset password" instead. If you want lookup anyway,
  it needs its own required secret (as WebXRIDE 3.8 enforces).
- *Decide:* whether to copy WebXRIDE's **class password + roster** sign-in (pick
  class → class password → pick your name → personal password). Useful for
  classrooms with young students; most adult users would just use username/email
  + password.

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
- **Email sending** through an API provider. *Decide:* Resend, Postmark or
  SendGrid (all have free tiers; Resend and Postmark are simplest). Needs a
  sending domain with SPF/DKIM.
- Admin controls: registration on/off, optional **email-domain allowlist**
  (e.g. only `@syr.edu`), optional approval queue, invite codes.

### 2c. Google sign-in
- OpenID Connect authorization-code flow with PKCE, `state` and `nonce`, from a
  Google Cloud OAuth client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in
  Render's environment).
- Links to an existing account when Google's verified email matches; users can
  have both a password and Google. The domain allowlist applies here too.
- Implemented directly (a few hundred lines) or with a small, well-maintained
  library. *Decide:* hand-rolled with `openid-client`, or a fuller auth library
  such as better-auth.

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
| **Users** | Create, edit, disable, delete; reset password; roles; groups/classes; CSV import/export; see a user's library size | `admin-users` (+ roster) |
| **Find feeds** | Add, edit, reorder, remove the publisher list and topics; live check of each URL — the roadmap item | new (replaces `lib/discover.mjs` list) |
| **Settings** | Registration on/off, domain allowlist, per-user limits, default feeds for new users, analytics on/off | "Editor Settings" + `app_settings` |
| **Legal pages** | Edit Terms and Privacy (needed once there are accounts and analytics) | `admin-legal` |
| **System text** | Edit welcome and other interface copy | `admin-system-text` |
| **Usage** | GA4 numbers (via the GA4 Data API), storage per user, conversions, feed fetch health | `origin/3.6` `admin-usage` |
| **Activity** | Sign-ins, failed sign-ins, admin actions (audit log) | `origin/3.6` `admin-activity` |
| **Error log** | Server and client errors | `origin/3.6` `admin-error-log` |

Not carried over (VR-specific): templates, submissions/review inbox, common
assets, snippets/Ridey AI, hosted pages. *Decide:* **Billing** (Stripe plans per
group) — leave out unless you intend to charge.

*Decide:* a **"view as user" peek** (WebXRIDE's `admin-user-peek`) is handy for
support but is a privacy question for a personal library. Recommendation: show
counts and sizes only, unless the user grants access.

---

## 7. Phase 4 — Google Analytics

As WebXRIDE (`lib/analytics-config.js`, `analytics-html-inject.js`, commit
`2907134`, later `ddf97f1`):
- GA4 measurement ID from an env var (`GOOGLE_ANALYTICS_MEASUREMENT_ID`,
  validated `G-…`), never in the repository; an admin on/off switch in Settings;
  suppressed on localhost.
- The standard gtag snippet in the main page and reading pages, served by the
  server so the switch takes effect; CSP updated for Google's hosts.
- **Consent.** WebXRIDE has no consent banner. Recommendation: add one (and
  Google's Consent Mode), and mention analytics in the Privacy page —
  especially with students and possible EU visitors. *Decide.*
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
- `/healthz` health check (exists), `NODE_ENV=production`, Node 24.
- **Costs** (*Decide* plan levels): free web + free Postgres works for trying it
  (cold starts, and Render's free Postgres expires after a period); a real
  deployment wants a paid web instance and a paid Postgres, plus object storage
  (R2/B2: pennies at this scale).

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
| 0 | Security baseline (Node 24, DOMPurify, SSRF guard, headers, limits, tests) | 2–3 days |
| 1 | Store interfaces; Postgres + migrations; object storage; owners on everything; shared feed fetching | 5–8 days |
| 2a | Users, roles, admin-created accounts, sessions, sign-in UI | 3–4 days |
| 3 | Admin dashboard: Overview, Users, Find feeds, Settings, Legal, System text | 4–6 days |
| 4 | Google Analytics + consent + Privacy text | 1–2 days |
| 2b | Self-registration, email verification, password reset | 2–3 days |
| 2c | Google sign-in | 1–2 days |
| 3+ | Usage, Activity, Error log pages | 2–3 days |
| 5 | Render blueprint for 2.0; Cloudflare Containers spike | 2–3 days |

Each step ends with tests and a working app; the local single-user app keeps
passing its current tests throughout.

---

## 10. Decisions for you

1. **Node 24 or 26** for 2.0.
2. **Object storage: R2 or B2** (or a Render disk to start).
3. **Reversible passwords** for admin lookup (WebXRIDE does it) — recommend no.
4. **Classroom sign-in** (class password + roster) — copy it, or plain username/email + password?
5. **Who can register**: open, email-domain allowlist, invite code, or admin approval.
6. **Email provider**: Resend, Postmark or SendGrid; and the sending domain.
7. **Auth library**: hand-rolled with `openid-client` + bcrypt, or a fuller library.
8. **Analytics consent banner** — recommend yes.
9. **Billing** — leave out?
10. **Admin "view as user"** — counts only, or full peek?
11. **Hosted reader sync** later (e.g. each user's Google Drive for a Boox)?
12. **Render plan levels** for the 2.0 service and database.

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
