# A-pub reader

Local web app that turns PDFs, saved web pages, URLs, and things you write
yourself into EPUBs, then sends them to an Xteink reader running
[CrossPoint firmware](https://github.com/crosspoint-reader/crosspoint-reader)
over Wi-Fi.

```bash
a-pub
```

That starts the server and opens the browser. Ctrl-C stops it.

| | |
|---|---|
| `a-pub` | start and open the browser (`epub-drop` still works) |
| `a-pub -b` | start detached and get the prompt back |
| `a-pub stop` | stop it |
| `a-pub status` | is it running, and pointed at which reader |
| `a-pub logs` | follow the detached log |
| `a-pub update` | reinstall dependencies |
| `PORT=5000 a-pub` | use a different port |

You can also double-click **a-pub.command** in Finder, or run `npm start`
from the project directory.

### Installing the command

`bin/epub-drop` is symlinked onto your PATH under both names:

```bash
ln -sf "$PWD/bin/epub-drop" /opt/homebrew/bin/a-pub
ln -sf "$PWD/bin/epub-drop" /opt/homebrew/bin/epub-drop   # old name, still works
```

Re-run that if you move the project. It resolves its own symlink, so the app can
live anywhere. Requires Node.js; it installs dependencies on first run.

Binds to `127.0.0.1` only. Nothing leaves your machine except fetching a URL you
paste and uploading to your reader on the local network.

## The loop

**Drop or write → Convert → Preview → Sync Reader**, with the reader's
`/A-pub Books` folder visible and manageable from the same page.

| Step | What happens |
|---|---|
| Drop / write | PDFs and `.html` files, pasted URLs, a draft, a saved RSS feed, or a book from a catalogue |
| Convert | Produces an EPUB on disk under `out/` |
| Preview | The built EPUB — chapters or page images, whichever it is |
| Send | Uploads over Wi-Fi, or copies to the reader's SD card |

## Getting the reader ready

On the Xteink, open **File Transfer** and join Wi-Fi. The device serves uploads
only while that screen is open. It shows an IP address — put it in **Reader
address** if `crosspoint.local` doesn't resolve, or hit **Find reader** to probe
the network.

### Hotspot mode

When there is no shared Wi-Fi — a classroom, a plane, someone else's network —
the reader can run its own. On the device pick the hotspot option, join
`CrossPoint-Reader` from your Mac's Wi-Fi menu, then click **Hotspot** in the
header (or type `192.168.4.1`, the fixed address the firmware serves on in AP
mode). The header shows `hotspot` once connected; RSSI is reported as 0 in that
mode, so the label is the confirmation.

**Convert before you switch.** While joined to the reader's hotspot your Mac has
no route to the internet, so fetching URLs and pulling images out of web pages
will fail. Dropped PDFs, dropped HTML files, and drafts all convert fine offline
— it is only the network-dependent inputs that need your normal Wi-Fi. Sending
works either way.

`Find reader` also probes `192.168.4.1` directly, so it works in hotspot mode
even when UDP broadcast is filtered.

### USB, and why it is not an option

**Connecting an Xteink X4 to a computer by USB does not transfer files.** The
X4 is an ESP32-C3 whose USB port is serial/JTAG only — plugging it in gives you
a `/dev/cu.usbmodem*` device and no disk. The firmware does have a *USB Drive*
mode that hands the raw SD card to the host, but `FREEINK_CAP_USB_MSC` is set
only for the USB-OTG builds (X4 Pro, X4C, Paper Mono), so it is absent on the
base X4.

### Copying via the SD card

When a network won't cooperate — campus and guest Wi-Fi often stop devices from
talking to each other, so the reader can be online yet unreachable — the card
itself is the fallback, and it needs no network at all.

Eject the microSD card, put it in a card reader, and set **Send via** to that
drive. The picker labels a drive "looks like the reader's card" when the
firmware's own folders (`.crosspoint`, `Pushed Books`, `XTCache`) are present,
and sorts those first, so it won't quietly default to your backup disk. On the
USB-OTG models, *USB Drive* mode makes the card appear the same way.

Books land in the configured folder either way, so the reader's library looks
identical however they arrived. Browsing and deleting work over the card too,
under the same rule as Wi-Fi: the allowlist comes from a fresh listing of the
managed folder, so nothing outside it is reachable and directories are never
removed. Writes go to a `.part` file and are renamed into place, so pulling the
card mid-copy can't leave a half-written book the reader will try to open.

## Input types

**PDF** — `lib/pdf.mjs` rebuilds reflowable text from page geometry: lines from
glyph baselines, paragraphs from vertical gaps and first-line indents, headings
from a per-document font profile. Running heads and page numbers are stripped,
end-of-line hyphenation is healed, and two-column layouts are detected
conservatively. This is inherently lossy — anything uncertain is reported as a
warning rather than hidden.

Two cases get an explicit warning instead of a quietly bad book:

- **Scanned PDFs** have no text layer and are refused, with a pointer to OCR.
- **Slide decks** and image-heavy exports report their character-per-page count,
  because their content is in pictures that text extraction cannot reach.

For those, and for anything where layout matters more than reflow, use page
images (below).

**HTML and URLs** — Readability strips navigation and boilerplate, then the
markup is whitelisted down to tags an e-ink reader handles well. Remote images
are fetched and re-encoded for the device (see below); SVG is skipped.

**Drafts** — a built-in editor with three views over one document:

- **Write** — rich text; pasted markup from Word, Docs or the web is stripped to
  clean tags on the way in
- **Markdown** — the canonical source
- **Preview** — rendered through the real server-side pipeline

Markdown is what's stored, because it survives round-tripping through a
rich-text surface and maps onto the small tag vocabulary the reader renders
properly. Drafts autosave to `drafts/*.json`; ⌘S saves, ⌘↩ builds.

A built draft goes to **`/A-pub Notes`** on the reader rather than following the
**Send via** folder — your own writing is a different kind of thing from a book
or a downloaded reading, and keeping it in its own folder means it doesn't get
lost among them.

**Images in drafts** — use the toolbar **Image** button, paste a screenshot
straight in, or drop an image file onto the editor. Uploads are normalized on
arrival: decoded, downscaled past 1600×2400 (never scaled up), and re-encoded as
JPEG, so a phone photo doesn't end up inside an EPUB an ESP32 has to open.

JPEG, PNG, GIF, BMP and SVG are handled by the bundled decoder. HEIC — what
iPhones shoot by default — and TIFF are not, so those are converted with macOS's
built-in `sips` first. Anything that still can't be read is refused with a
message naming the format rather than a generic failure. Files are stored
content-addressed under `assets/`, so the same image pasted twice is kept once,
and the same bytes back the editor, the preview and the finished book. An image
always lands as its own block — never inside the heading your caret happened to
be in.

## Find books

Browse a catalogue feed, tick the titles you want, and they go into the queue.

This is deliberately **not** the RSS-to-EPUB path. A catalogue entry links to a
finished EPUB — Standard Ebooks typeset theirs with far more care than any
converter could manage — so the file is downloaded and queued **untouched**.
Nothing is re-extracted, re-typeset or re-encoded.

**Standard Ebooks — new releases** ships as a preset. Their subject and
complete-catalogue feeds need a (free) patron key, so only new releases works
anonymously; **Other feed…** takes any Atom or RSS feed whose entries carry
EPUB enclosures.

Details that matter in practice:

- **Which build gets downloaded.** Standard Ebooks offers several per title.
  The one labelled *compatible* targets older e-readers, which is exactly this
  device; the *advanced* build uses newer EPUB3 features an ESP32 reader is less
  likely to handle, and Kobo's `.kepub` is a different format wearing an `.epub`
  extension. Compatible is preferred, then the smallest plain EPUB.
- **Downloads are verified.** A catalogue can answer a request with an HTML
  error page and a 200. Queueing that would put a file on the reader that fails
  to open for no visible reason, so each download is checked for a zip header,
  an `application/epub+zip` mimetype and a container document before it counts.
- **Already-queued titles are marked**, so re-browsing does not invite
  duplicates.
- **Chapter counts come from the book.** The downloaded EPUB is opened and its
  spine counted, so the queue and the preview show the real structure.

Books follow the **Send via** controls like anything else, so they land in the
ordinary folder rather than the feeds folder. Pointing this at an article feed
reports how many entries had no EPUB and suggests adding it under **Feeds**
instead.

## The queue

The window is two columns: **Add content** on the left, **Push to reader** on
the right. Everything that produces an EPUB is on the left; everything that
moves one onto the device is on the right.

Anything converted goes into a queue that lives on disk, not in the page, and
stays there until it has been sent. That is what makes the normal sequence
work: the reader is usually *not* connected at the moment you build something.
You refresh feeds and convert readings on your own Wi-Fi, then join the
reader's hotspot — which has no internet — and push everything at once.

Because the queue is on disk it survives a page reload, a network switch and a
restart of the app. A dropped PDF, a pasted URL, a draft and a feed refresh all
land in the same list and look the same there, tagged with where they came from
and where they are going.

Sent items stay visible, dimmed, showing which device they went to — useful
when a transfer half-fails, or when you want the same book on a second reader.
**Clear** removes only what has already been sent, never something still
waiting. **×** on a row drops it from the queue and deletes its files.

An entry carries its own destination folder, so a feed edition goes to
`/A-pub Feeds` even when **Send via** is pointed elsewhere, and it carries the
filename of the edition it replaces — so a send that happens hours after the
build still removes the right old file.

## RSS feeds

Each saved feed becomes one EPUB that gets replaced on every refresh, so the
reader ends up with a current edition per feed rather than an accumulating pile.

Paste a feed URL and hit **Add feed**. The feed is fetched immediately so a typo
shows up now rather than at refresh time, and it is kept even if it's temporarily
down (the reason is shown on the row). **Refresh** on a row rebuilds that feed;
**Refresh all** does every feed, each independently, so one broken feed does not
stop the rest.

A refresh:

1. fetches the feed and takes the newest *N* items (per-feed, default 15),
2. optionally fetches each linked article in full,
3. builds one EPUB with one chapter per item,
4. queues it.

Refreshing never touches the device, so it works with the reader switched off
or in another building. Pushing the queue is a separate step — **Send to
reader** — and that is when the previous edition of the feed gets deleted.
Refreshing the same feed twice before sending replaces the queued copy rather
than queueing two.

Feeds always go to **`/A-pub Feeds`**, kept separate from the folder used for
one-off documents so the cleanup step can't touch anything else. Filenames are
dated (`The Verge - 2026-09-02.epub`), so freshness is visible in the reader’s
file list and a new day replaces the previous file rather than shadowing it.

**Full articles** (per feed, on by default) fetches each item’s page and runs it
through the normal article extractor. Many feeds ship only a truncated teaser,
which is the wrong thing to carry somewhere to read offline. It costs roughly a
second per item, and an item that fails — paywall, consent wall, timeout — keeps
the feed’s own text and is marked *summary only* in the book rather than being
dropped.


Removing a feed stops following it and leaves any EPUB already on the reader
alone; the confirmation says so, and you can delete it from **On the reader**.

Parsing covers RSS 2.0, Atom and RSS 1.0/RDF, prefers `content:encoded` over
`description`, reads `dc:creator` and Atom `author/name`, and decodes entities a
second time because publishers frequently double-encode them (`&amp;#8217;`
arrives where an apostrophe was meant). An item's own headings are demoted below
the chapter split, so a roundup post with internal headings stays one chapter
instead of scattering subheadings through the table of contents.

### Automatic refresh

Loading the main page refreshes every feed, with a **Refreshing Feeds** message
under the tabs while it runs. Clicking **Library** in the menu bar — even when
already on it — refreshes them again, whenever they were last refreshed. If every feed was refreshed in the last ten
minutes it is skipped, so coming back from a reading page does not fetch them
all again. A second request while a refresh-all is running (a reload, another
tab) waits for that run rather than starting its own, so nothing is built twice.

### Find feeds

**Find interesting feeds**, under the feed URL box, opens a list of feeds from
established publishers — public broadcasters, nonprofit newsrooms, science
publishers and magazines — grouped by topic. The list is hand-picked in
`lib/discover.mjs` rather than searched for, because searching the web for feeds
finds spam and dead blogs as readily as anything good. Each feed is fetched when
the list opens (results are cached for ten minutes; **Check again** skips the
cache), and only the ones that answer are shown, with their latest headline.
**Add** saves one exactly as if its URL had been pasted.

## Page images (fixed layout)

The **Page images** checkbox switches to the format comic and manga EPUBs use:
each page is a picture, declared `rendition:layout = pre-paginated`. Layout is
preserved exactly — figures, tables, equations, columns — and in exchange text
cannot reflow or be resized on the reader.

- **Resolution** — 480 px is the panel's native width; 960 px is sharper and
  zoomable at roughly 4× the file size.
- **Split PDF pages** — a whole letter page squeezed into a 6" screen leaves
  body text very small. Halves or thirds cut each page into stacked slices with
  a slight overlap, so text comes out much larger.
- **Text size** — applies to web pages and drafts, which have no page geometry
  to preserve and so are typeset directly at the panel size.

Hit **Preview** on a queued item to page through exactly what the reader will
display before sending anything.

### Why everything ships as JPEG

Every image this app puts on the device — page images, editor images, pictures
pulled out of web pages — is encoded as JPEG, and that is a correctness
requirement rather than a size optimization.

The firmware allocates its PNG decoder on demand and refuses to start unless
about **60 KB of heap is free** (PNGdec is ~44 KB plus 16 KB of headroom). The
JPEG path needs about **36 KB** (JPEGDEC is ~20 KB). An X4 has ~320 KB of RAM in
total and reports roughly 70 KB free while idle, so once the layout engine and
section cache are holding memory, a PNG decode fails the check. When it does,
the reader still reserves space for the image and draws nothing — an empty
outline. JPEG clears the bar with room to spare.

Quality is 90–92 and the images are flattened to grayscale first, so text edges
stay clean and the panel's own dithering hides the rest.

The firmware also ships decoders for JPEG and PNG only — no GIF, WebP or AVIF —
so those are converted rather than passed through and silently skipped.

## Reading in the browser

The **Library** tab lists everything the app has built — sent or not, marked
*not sent* until it reaches a reader — so a reader device is optional.

Clicking an item's title opens it as an ordinary web page at `/read/<id>`: a contents
list, then every chapter in order on one responsive page, with images served
back out of the EPUB. Fixed-layout books show their page images in a column.
From there, **Read as eBook** opens the device-shaped previewer described
below (via `/?epub=<id>`).

The page is built from the EPUB's own chapters, so it is served with a
Content-Security-Policy that forbids scripts outright.

## Previewing

Every item in the queue has a **Preview** link, whatever produced it — a
dropped PDF, a saved page, a pasted URL, a draft or a feed edition.

The preview reads the **built EPUB**, not the thing it was made from. That
distinction matters: the editor's Preview tab renders your markdown, which is
not quite the same as the chapters, table of contents and re-encoded images
that ended up inside the file. Reading the archive back is the only way to see
what the reader will actually get.

- **Reflowable books** show one chapter at a time, with a chapter picker, on a
  page shaped and typeset like the reader's. Embedded images are served back
  out of the archive, so a missing or unconvertible picture is visible as a gap
  here rather than a surprise on the device.
- **Fixed-layout books** page through their images at full resolution.

Arrow keys and Page Up/Down move; Escape closes. Chapter titles come from the
EPUB's own navigation document, so the picker is the same table of contents the
reader will show.

### Replacing files on the device

The firmware documents same-named uploads as overwriting, but 1.5.0 answers
`HTTP 400 — File already exists` instead. So sending is a delete-then-upload:
without that, refreshing a feed twice in one day could never reach the reader,
because the new edition carries the same dated filename as the one already on
the card and every send was rejected.

A send also **verifies before reporting a failure**. The device can finish
writing a file and then be slow to answer — it clears its EPUB cache for the
folder after an upload — so an upload whose response times out has very often
succeeded. Those are confirmed against a directory listing, comparing size so a
truncated write still counts as a failure.

Per-item outcomes appear on each queue row. A summary count alone is not
actionable when nine things went out and some did not arrive.

### Reading a preview

Reflowable books open **a page at a time in a portrait frame**, because that is
the point of previewing: you are checking how the book will behave on a reader,
and a tall scrolling column tells you nothing about where pages break or
whether a heading lands alone at the foot of a page.

The chapter is laid out in CSS columns exactly one page wide and the frame shows
one column, so turning a page is a horizontal translate rather than a re-layout
— instant even on a long chapter. Prev/Next roll over into the neighbouring
chapter, entering from the side you are travelling: stepping back from the start
of chapter 3 lands on the *last* page of chapter 2, not its first.

Two pairs of icon buttons in the viewer's bar set the layout. Every book opens
as flipping eBook pages; the width choice is remembered, scroll view is not:

- **Width:** eBook width (a page-shaped column) or full width (the whole window).
- **Height:** eBook height (one page at a time, with the page-turn effect) or
  scroll (the whole book in one continuous column, top to bottom). In scroll
  view Prev/Next are greyed out, the chapter picker jumps to a chapter, the
  position follows as you scroll, and the keyboard scrolls normally. Arrow keys, Page Up/Down and space turn pages; Escape
closes. Fixed-layout books ignore all of this and page through their images.

## Managing what's on the reader

Each item has one **On reader** switch — on its Library card and, mirrored,
in the **Queued to send** list on Add/Remove — and **Sync Reader** (at the top
of the Library, and on Add/Remove) makes the reader match the switches:

- **On** (the default): the item goes to the reader at the next sync, or stays
  there if it already is.
- **Off**: it is not sent, and if it is on the reader it is taken off at the
  next sync. The app keeps its copy, so it can still be read in the browser,
  and switching it back on sends it again.

The note beside each switch says where the item stands: *On the reader*,
*Goes over at the next sync*, *Comes off at the next sync* or *Not on the
reader*. A feed switches as a whole — its edition on the reader and the newer
one waiting to replace it — and stays switched across new editions; like the
Library, the queue shows only a feed's newest edition. A sync with
nothing to upload still carries out any removals, so switching items off and
syncing is enough to clear them from the device.

The older **On the reader** folder listing is hidden in favour of the switches
(its folder picker still holds the books-folder setting). Its server routes
list the managed folder and can delete from it.
Scope is enforced on the server, not in the browser: requests carry bare
filenames, the folder comes from saved config, and each name must appear in a
fresh device listing of that folder as a plain file. Nothing outside the folder
is reachable, directories are never removed, and pointing the folder at the
SD-card root disables deletion entirely rather than exposing your whole library.

## Removing everything

**Remove everything…** at the foot of **Add/Remove** starts the app over. You
type **I Agree** to confirm (the server checks the phrase too), and it removes:

- every built item, sent or not, and its local EPUB;
- every followed feed;
- every draft and the images pasted into them;
- any leftover built files in `out/` the queue no longer tracked.

Settings — the reader's address and the image options — are kept. With **Also
delete everything this app put on the reader** ticked (the default), each file
that reached the reader, including current feed editions, is queued for
deletion on the next sync. It cannot be undone.

## Device protocol

Per the firmware's `docs/webserver-endpoints.md`:

| | |
|---|---|
| `GET /api/status` | device model, firmware, Wi-Fi mode |
| `GET /api/files?path=` | directory listing |
| `POST /upload?path=` | multipart file upload |
| `POST /mkdir` | one folder level per call |
| `POST /delete` | `paths` as a JSON array |
| UDP `8134` | send `hello`, get `crosspoint (on <host>);81` |
| AP mode | reader serves on `192.168.4.1`, SSID `CrossPoint-Reader` |

Discovery is only used as a fallback when the configured host is still the
default `crosspoint.local`. If you've typed a specific address and it fails, you
get an error — silently uploading to a different device that happened to answer
a broadcast would be worse.

## Layout

```
bin/epub-drop     launcher: start, stop, status, logs
server.mjs        HTTP server and API; binds 127.0.0.1
lib/extract.mjs   HTML -> clean chapters (Readability + whitelist)
lib/pdf.mjs       PDF -> reflowable chapters (geometry -> paragraphs)
lib/render.mjs    PDF and text -> page images (fixed layout)
lib/epub.mjs      EPUB 3 writer, reflowable and pre-paginated
lib/markdown.mjs  markdown -> HTML, shared with the browser preview
lib/drafts.mjs    file-backed draft store
lib/assets.mjs    images used in drafts: normalize, store, resolve
lib/device.mjs    CrossPoint client: discovery, upload, mkdir, delete
lib/volume.mjs    offline transfer: the SD card as a mounted drive
lib/rss.mjs       RSS/Atom parsing and composing a feed into chapters
lib/books.mjs     catalogue browsing and verified EPUB downloads
lib/feeds.mjs     saved feeds and the refresh bookkeeping
lib/outbox.mjs    the pending-send queue, persisted across restarts
lib/epubread.mjs  reads a built EPUB back out again, for previewing
public/           UI (no build step)
out/              generated EPUBs and page images
drafts/           your drafts, one JSON per draft
feeds.json        saved RSS feeds
assets/           images placed in drafts, content-addressed
```

## Tests

```bash
npm test
```

424 assertions. The device layer runs against a mock CrossPoint firmware, so the
upload path is verified byte-exact without hardware. EPUBs are checked by
unzipping and parsing every XML part; page images are checked by decoding the
PNGs and sampling pixels, since a blank page is still a valid PNG.

## Notes

- `out/` grows with every conversion; delete it freely. `assets/` is not
  garbage-collected — deleting a draft leaves its images behind.
- The queue, drafts and feeds all persist across restarts. Deleting `out/`
  discards queued EPUBs; the index notices and drops those entries.
- The reader is 2.4 GHz only, and must be on the same network as this Mac.

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 Dan Pacheco ([danpacheco.com](https://danpacheco.com)).
