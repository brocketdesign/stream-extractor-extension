# Stream Extractor — Chrome extension

Browse normally. When a page has video on it, the toolbar icon shows how many
streams were found — click it, pick one, and it opens in a built-in player tab.
From there you can download it as a real MP4, keep it in a library dashboard
that remembers which site it came from, and replay it or screenshot scenes
later.

Companion to [stream-extractor](https://github.com/brocketdesign/stream-extractor)
(the server-side extractor). This one runs entirely in the browser, so it sees
the page with your session, your cookies, and the traffic the player actually
makes.

## Why an extension finds more than a scraper

The server has to fetch the page, guess which iframe is the player, spoof a
`Referer`, and decode the config without ever running it. The extension skips
most of that:

- **It watches real network traffic.** Whatever the player loads, we see —
  no matter how the URL was assembled. Obfuscation that defeats static
  scraping doesn't matter once the request goes out.
- **It runs inside the embed.** The content script is injected into every
  frame, so an embed iframe gets scanned in place. No refetch, no referer
  spoofing, no login wall.
- **It sees the page you see.** Paywalled, region-locked, and logged-in pages
  work because it's your browser doing the looking.

## Install

Not on the Web Store — load it unpacked:

1. Clone this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. **Load unpacked** → select the repo folder.
5. Pin the icon so the badge count stays visible.

## Use

1. Browse to a video page and **start the video** — network detection needs the
   player to actually request something.
2. The badge shows the number of playable streams found.
3. Click the icon for the list. Each entry gives you:

| Button | What it does |
|---|---|
| **▶ Play** | Opens the built-in player tab (hls.js, with `Referer` spoofing) |
| **⬇ Download** | Opens the player and starts downloading straight away |
| **Open raw** | Opens the stream URL directly — fine for `.mp4`, not for HLS |
| **Copy URL** | The stream URL to the clipboard |
| **Copy ffmpeg** | A ready-to-run `ffmpeg` command, `Referer` header included |

**Rescan** re-runs the DOM scan in every frame. **Clear** forgets the tab.
HLS segments (`.ts`, `.m4s`) are hidden behind the checkbox — you almost always
want the `.m3u8` that lists them, not the segments themselves.

## Downloading

**⬇ Download** in the popup, or the button in the player tab. HLS is fetched
segment by segment (6 at a time), decrypted if needed, and stitched back
together with a live progress readout. You can cancel mid-download.

Every download lands in two places:

- **Your library** — an IndexedDB copy inside the extension, which is what
  makes replay and screenshots possible.
- **`~/Downloads/Stream Extractor/`** — a real file on disk, if you leave
  *also save a file to Downloads* ticked.

Both are needed, and they aren't redundant: an extension **cannot read a file
it wrote to your Downloads folder**. Chrome gives no read access to that path,
so a disk-only copy could never be replayed or screenshotted here.

### Everything comes out as MP4

HLS almost always ships **MPEG-TS** segments, and a `.ts` file opens in
essentially nothing — not QuickTime, not Photos, not a `<video>` tag. So TS
downloads are remuxed to MP4 with [mux.js](https://github.com/videojs/mux.js)
before being saved: the same H.264/AAC streams rewrapped in a new container.
Lossless, no re-encoding, a couple of seconds.

The result plays in the dashboard, opens in QuickTime, and imports into Photos.

> **On the macOS Photos gallery:** files land in `~/Downloads/Stream Extractor/`
> as real MP4s, which Photos accepts — but it won't pick them up on its own.
> Drag them in, or **File → Import**. Nothing can make Photos watch a folder.

Also handled: **AES-128 encrypted** playlists (decrypted via WebCrypto, keys
fetched and cached), **fMP4** playlists with `EXT-X-MAP` init segments, byte-range
playlists, and quality selection when the master playlist offers variants.

## Library dashboard

Open it from the **Library →** link in the popup or the player.

A grid of everything saved, newest first, showing the poster frame, **which site
it came from**, when it was saved, size, duration, and screenshot count. Filter
by site with the dropdown. Each card gives you Play, Save to disk, and Delete,
with total storage used in the header.

**Play** replays from the library — no network, works offline, and the source
site can be long gone.

### Screenshots

While a video plays, **📷 Capture current frame** grabs the frame at the exact
current timestamp. Shots are stored against that video and appear as a filmstrip
under the player and on its dashboard card; click one to jump back to that
moment. A PNG copy also goes to `~/Downloads/Stream Extractor/screenshots/`.

Screenshots work reliably on library playback, because the file is local and
same-origin. On a *live* stream they usually work too — hls.js feeds video
through MSE, which keeps the canvas untainted — but a stream playing via the
browser's native HLS path taints the canvas and the browser blocks the capture.
You'll get a message saying so; download it first and screenshot from the library.

## How detection works

Two independent paths feed one per-tab list:

**1. Passive network sniffing** (`src/background.js`) — a non-blocking
`chrome.webRequest` listener classifies every request by extension and by
`Content-Type`, catching manifests served without a telltale suffix. This is
the path that catches almost everything.

**2. DOM and player-config scanning** (`src/content.js`) — runs in every frame
and handles the cases where the URL is present but never requested (yet):

- `<video>` / `<audio>` / `<source>` elements
- `window.PLAYER_CFG = { code, hosts }` → `{hosts[0]}/{code}/index.m3u8`
- XOR-obfuscated configs — `var k="KEY", b=atob("BLOB")`, decoded then regexed
- jwplayer / video.js `file:` and `sources: [{ file: … }]`
- a catch-all sweep for media URLs sitting in the markup

The config decoders are ported from `server.js` in the companion repo, so
anything that works there works here.

### Referer spoofing

Hotlink-protected CDNs reject requests without the embed's `Referer`. When you
hit **Play**, a session-scoped `declarativeNetRequest` rule pins the right
`Referer` onto requests from that player tab only, and is torn down when the
tab closes.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `webRequest` | Observe media requests (read-only; nothing is blocked or altered) |
| `webNavigation` | Reset a tab's list when you navigate to a new page |
| `declarativeNetRequestWithHostAccess` | Set `Referer` on the player tab's requests |
| `storage` | `chrome.storage.session` cache — MV3 workers get torn down constantly |
| `tabs` | Open the player tab, badge the right tab |
| `downloads` | Write finished videos and screenshots to your Downloads folder |
| `unlimitedStorage` | Video files in IndexedDB blow past the default quota fast |
| `<all_urls>` | Video lives on arbitrary hosts, so the scan can't be host-scoped |

Nothing is collected and nothing leaves your machine. There is no analytics
code, no remote endpoint, and no network call the extension makes on its own —
it only ever reads requests the page was already making.

## Layout

```
manifest.json         MV3 manifest
src/background.js     service worker: sniffing, per-tab store, referer rules
src/content.js        in-page DOM + player-config scanner (all frames)
src/popup.*           the stream list
src/player.*          player tab: playback, downloading, screenshots
src/download.js       HLS manifest parsing, AES-128, segment assembly
src/remux.js          MPEG-TS -> MP4 via mux.js
src/library.js        IndexedDB store for saved videos and screenshots
src/library.html      the dashboard
src/dashboard.{js,css}  dashboard rendering
vendor/hls.min.js     hls.js v1.5.20 (Apache-2.0, see hls.LICENSE.txt)
vendor/mux.min.js     mux.js v7.0.3 (Apache-2.0, see mux.LICENSE.txt)
tools/make-icons.js   regenerates icons/ — no image tooling needed
```

MV3 forbids remote scripts, so both libraries are vendored rather than pulled
from a CDN. Downloads run in the **player tab**, not the service worker — MV3
tears workers down mid-job, and a long download has to outlive that.

## Limitations

- **DRM (Widevine/FairPlay) streams won't play or download.** You'll see the
  manifest URL, but the content is encrypted and this does nothing about that.
  AES-128, the ordinary HLS encryption, *is* handled — DRM is a different thing.
- **Downloads are assembled in memory**, so a multi-GB stream can strain a tab.
  For very long videos the `Copy ffmpeg` command is the better tool — it streams
  to disk and carries the right `Referer`.
- **Live streams** download only what the playlist currently lists, not an
  ongoing recording.
- **DASH (`.mpd`) downloads aren't supported** — detection and playback work,
  but assembly doesn't. Use the ffmpeg command for those.
- Blob URLs (`blob:`) can't be opened outside their page; the underlying
  manifest usually shows up via network sniffing anyway.
- Some CDNs bind tokens to IP or a short TTL, so a copied URL may expire fast.
- Start the video before scanning — network detection has nothing to see until
  the player makes a request.

## Legal

For personal, educational, and archival use. Only extract content you have the
right to access, and respect the terms of service and copyright of any source
site.

## License

[MIT](LICENSE). Bundled hls.js is Apache-2.0 — see `vendor/hls.LICENSE.txt`.
