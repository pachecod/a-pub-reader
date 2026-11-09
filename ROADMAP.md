# Future plans

Ideas that are agreed in principle but not built yet.

## Manage the Find feeds list from the app

**Today.** The feeds offered by **Find interesting feeds** are a fixed list of
publishers written into `lib/discover.mjs` (`DIRECTORY`: groups of
`{ name, url, about }`). Changing it means editing that file and redeploying.

**The plan.** An administrator signs in and manages the list from the app:

- **Sign-in for an administrator**, separate from everyday use. Hosted, the app
  already has one shared password (`APP_PASSWORD`); this needs an admin role on
  top of it, for example an `ADMIN_PASSWORD` set in Render's environment (never
  in the repository), or proper accounts if more than one person will manage it.
- **An admin page** to add, edit, remove and reorder feeds and topics: name,
  URL, one-line description and group. Adding a feed should fetch it once and
  show its title and latest headline, so a broken or wrong URL is caught before
  it is saved (the same check Find feeds runs today).
- **Store the list as data**, not code: a JSON file in the app's data folder
  (`EPUB_DROP_STATE`), seeded from today's `DIRECTORY` on first run, so the
  built-in list stays the default and edits survive restarts. Hosted, that needs
  Render's paid plan with a disk, or the list resets with everything else.
- **Find feeds reads the stored list**, keeping its live check (only feeds that
  answer are shown), its ten-minute cache (cleared when the list changes) and
  the "✓ Following" marks.

**Questions to settle first.** Who the administrators are (just you, or
instructors and others); whether everyday users should be able to suggest feeds
for an admin to approve; and whether the list is per installation or shared
between your own copy and the hosted one.
