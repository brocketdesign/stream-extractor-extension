/**
 * "See all" grid: every video detected on the source tab, with previews,
 * multi-select and a batch download queue. Opened from the popup.
 *
 * Downloads run here for the same reason they run in the player tab - MV3
 * service workers get torn down mid-job. This tab also carries the DNR
 * Referer rule the background script pinned to it, so segment and file
 * fetches look like they came from the page the streams were found on.
 */

const params = new URLSearchParams(location.search);
const sourceTabId = Number(params.get('tab')) || 0;
const pageUrl = params.get('page') || '';
const pageTitle = params.get('title') || '';

const gridEl = document.getElementById('grid');
const statusEl = document.getElementById('status');
const emptyEl = document.getElementById('empty');
const selectAllEl = document.getElementById('selectAll');
const downloadSelBtn = document.getElementById('downloadSel');
const refreshBtn = document.getElementById('refresh');
const alsoDisk = document.getElementById('alsoDisk');
const runbar = document.getElementById('runbar');
const runFill = document.getElementById('runFill');
const runText = document.getElementById('runText');
const cancelRunBtn = document.getElementById('cancelRun');

const PLAY_SVG =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<rect x="3" y="5" width="18" height="14" rx="2.5"/>' +
  '<path d="M10.2 9.4v5.2l4.6-2.6z" fill="currentColor" stroke="none"/></svg>';

let streams = []; // playable only - segments never reach this page
const cards = new Map(); // url -> card record
const thumbOwners = new Map(); // thumb element -> url, for the lazy loader
const selected = new Set();
const locked = new Set(); // queued or mid-download: selection frozen
const done = new Set();
const meta = new Map(); // url -> preview probe result {thumb, duration, size}

// ------------------------------------------------------------------ setup

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

function basename(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last) || hostOf(url) || 'stream';
  } catch {
    return 'stream';
  }
}

function formatTime(s) {
  if (!isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      observer.unobserve(en.target);
      const url = thumbOwners.get(en.target);
      const rec = url && cards.get(url);
      if (rec) preview(rec);
    }
  },
  { rootMargin: '250px' }
);

function preview(rec) {
  Thumbs.preview(rec.s).then((r) => {
    if (!r) {
      rec.thumb.classList.remove('is-loading');
      rec.thumb.classList.add('is-failed');
      return;
    }
    meta.set(rec.s.url, r);
    rec.thumb.classList.remove('is-loading');
    if (r.thumb) {
      rec.img.src = r.thumb;
      rec.thumb.classList.add('has-frame');
    } else {
      rec.thumb.classList.add('is-failed');
    }
    if (r.duration) {
      rec.dur.textContent = formatTime(r.duration);
      rec.dur.hidden = false;
    }
    if (r.size) rec.sub.textContent = rec.subBase + ' · ' + formatBytes(r.size);
  });
}

// ------------------------------------------------------------------ cards

function cardFor(s) {
  const li = el('li', 'card');
  li.dataset.url = s.url;
  li.setAttribute('role', 'checkbox');
  li.setAttribute('aria-checked', 'false');
  li.setAttribute('aria-label', 'Select ' + basename(s.url));
  li.tabIndex = 0;

  const thumb = el('div', 'card__thumb is-loading');
  const img = el('img');
  img.alt = '';
  // The page's own poster (when the DOM had one) shows instantly; the probe
  // replaces it with a real frame from the stream.
  if (s.poster) img.src = s.poster;
  const glyph = el('span', 'card__glyph');
  glyph.innerHTML = PLAY_SVG;
  const kindBadge = el('span', 'kind ' + s.kind, s.kind);
  const dur = el('span', 'card__dur');
  dur.hidden = true;
  const check = el('span', 'card__check', '✓');
  thumb.append(img, glyph, kindBadge, dur, check);

  const bar = el('div', 'card__bar');
  const fill = el('div', 'fill');
  bar.append(fill);
  bar.hidden = true;

  const subBase = hostOf(s.url) + (s.label ? ' · ' + s.label : ' · ' + s.source);
  const name = el('div', 'card__name', basename(s.url));
  name.title = s.url;
  const sub = el('div', 'card__sub', subBase);
  const metaRow = el('div', 'card__meta');
  metaRow.append(name, sub);

  const actions = el('div', 'card__actions');
  const playBtn = el('button', 'btn btn--sm', '▶ Play');
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({
      type: 'OPEN_PLAYER',
      url: s.url,
      kind: s.kind,
      pageUrl: s.frameUrl || pageUrl,
      tabUrl: pageUrl,
      tabTitle: pageTitle
    });
  });
  const dlBtn = el('button', 'btn btn--sm btn--ghost', '⬇');
  dlBtn.title = 'Download just this one';
  dlBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    enqueue([s.url]);
  });
  actions.append(playBtn, dlBtn);

  const statusLine = el('div', 'card__status');

  const toggle = () => toggleSelect(s.url);
  li.addEventListener('click', toggle);
  li.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggle();
    }
  });

  li.append(thumb, bar, metaRow, actions, statusLine);

  const rec = { s, li, img, thumb, dur, sub, subBase, bar, fill, statusLine, dlBtn };
  cards.set(s.url, rec);
  thumbOwners.set(thumb, s.url);
  observer.observe(thumb);
  return li;
}

function setCardState(url, state, text) {
  const rec = cards.get(url);
  if (!rec) return;
  if (state) rec.li.dataset.state = state;
  else delete rec.li.dataset.state;
  rec.statusLine.textContent = text || '';
  rec.bar.hidden = state !== 'active';
  if (state !== 'active') rec.fill.style.width = '0';
}

// -------------------------------------------------------------- selection

function applySelection(rec, on) {
  rec.li.classList.toggle('is-selected', on);
  rec.li.setAttribute('aria-checked', String(on));
}

function toggleSelect(url) {
  if (locked.has(url) || done.has(url)) return;
  if (selected.has(url)) {
    selected.delete(url);
    applySelection(cards.get(url), false);
  } else {
    selected.add(url);
    applySelection(cards.get(url), true);
  }
  updateToolbar();
}

function selectable() {
  return streams.filter((s) => !locked.has(s.url) && !done.has(s.url));
}

function updateToolbar() {
  const canPick = selectable();
  const picked = canPick.filter((s) => selected.has(s.url)).length;
  selectAllEl.checked = canPick.length > 0 && picked === canPick.length;
  selectAllEl.indeterminate = picked > 0 && picked < canPick.length;
  selectAllEl.disabled = canPick.length === 0;
  downloadSelBtn.disabled = picked === 0;
  downloadSelBtn.textContent = picked ? `⬇ Download ${picked} selected` : '⬇ Download selected';
}

selectAllEl.addEventListener('change', () => {
  const on = selectAllEl.checked;
  for (const s of selectable()) {
    if (on) selected.add(s.url);
    else selected.delete(s.url);
    applySelection(cards.get(s.url), on);
  }
  updateToolbar();
});

// ------------------------------------------------------- download queue
//
// One job at a time: a page can hold dozens of videos and firing all their
// fetches at once would trip CDN rate limits and melt the remuxer.

const queue = [];
let pumping = false;
let currentAbort = null;
let cancelRun = false;
let runTotal = 0;
let runDone = 0;

function enqueue(urls) {
  let added = 0;
  for (const url of urls) {
    if (locked.has(url) || done.has(url)) continue;
    locked.add(url);
    selected.delete(url);
    applySelection(cards.get(url), false);
    queue.push(url);
    setCardState(url, 'active', 'queued…');
    added++;
  }
  if (!added) return;
  runTotal += added;
  pump();
}

function paintRunbar() {
  runFill.style.width = runTotal ? ((runDone / runTotal) * 100).toFixed(1) + '%' : '0';
  const current = pumping && !cancelRun ? runDone + 1 : runDone;
  runText.textContent = `${current} / ${runTotal} downloading…`;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  cancelRun = false;
  runbar.hidden = false;
  paintRunbar();

  while (queue.length && !cancelRun) {
    const url = queue.shift();
    await runOne(url);
    runDone++;
    paintRunbar();
  }

  // A cancelled run drops whatever never started.
  for (const url of queue.splice(0)) {
    locked.delete(url);
    setCardState(url, '', '');
  }
  runTotal = 0;
  runDone = 0;
  pumping = false;
  runbar.hidden = true;
  updateToolbar();
}

cancelRunBtn.addEventListener('click', () => {
  cancelRun = true;
  if (currentAbort) currentAbort.abort();
});

/** The grid's own preview, reused as the library poster when it exists. */
function previewBlobOf(url) {
  const r = meta.get(url);
  if (!r || !r.thumb) return null;
  const [head, b64] = r.thumb.split(',');
  const mime = (/image\/[a-z]+/i.exec(head) || [])[0] || 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function runOne(url) {
  const rec = cards.get(url);
  const s = rec ? rec.s : streams.find((x) => x.url === url);
  if (!s) return;

  currentAbort = new AbortController();
  const signal = currentAbort.signal;
  const progress = (frac, text) => {
    if (rec) {
      rec.fill.style.width = (frac * 100).toFixed(1) + '%';
      if (text) rec.statusLine.textContent = text;
    }
  };

  try {
    let blob;
    let container;
    let expectedSeconds = 0;
    let warnings = [];

    const isHls = s.kind === 'hls' || /\.m3u8(\?|$)/i.test(url);
    if (isHls) {
      const result = await downloadHls(url, {
        signal,
        onProgress: ({ done, total, bytes }) =>
          progress(done / total, `${done} / ${total} segments · ${formatBytes(bytes)}`)
      });
      container = result.container;
      expectedSeconds = result.duration;

      if (container === 'ts') {
        // Rewrap TS as MP4, segment by segment, so timestamps can be rebased.
        setCardState(url, 'active', 'remuxing to MP4…');
        const remuxed = await remuxTsToMp4(result.parts, result.segments, ({ done, total }) =>
          progress(done / total, `remuxing ${done} / ${total} segments`)
        );
        blob = remuxed.blob;
        warnings = remuxed.warnings;
        container = 'mp4';
      } else {
        blob = result.blob;
      }
    } else {
      const res = await fetch(url, { signal, credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        progress(total ? received / total : 0, formatBytes(received) + (total ? ' / ' + formatBytes(total) : ''));
      }
      blob = new Blob(chunks, { type: res.headers.get('content-type') || 'video/mp4' });
      container = (url.split('?')[0].split('.').pop() || 'mp4').toLowerCase();
      if (!['mp4', 'webm', 'm4v', 'mov'].includes(container)) container = 'mp4';
    }

    // Decode-check before it reaches the library or the disk - a remux can
    // produce a structurally valid MP4 with a nonsense timeline.
    if (s.kind !== 'audio') {
      setCardState(url, 'active', 'checking playback…');
      const verified = await verifyPlayable(blob, expectedSeconds);
      if (!verified.ok) throw new Error(`the download finished but ${verified.reason}`);
      if (verified.duration) expectedSeconds = verified.duration;
    }

    setCardState(url, 'active', 'saving…');
    const filename = guessFilename(url, container);
    const poster = previewBlobOf(url) || (await Thumbs.posterFromBlob(blob));

    const record = await Library.addVideo({
      title: filename,
      pageUrl,
      pageHost: hostOf(pageUrl) || hostOf(url),
      streamUrl: url,
      kind: s.kind || 'video',
      container,
      size: blob.size,
      duration: expectedSeconds || (meta.get(url) || {}).duration || 0,
      blob,
      poster,
      savedToDisk: false
    });

    if (alsoDisk.checked) {
      const objUrl = URL.createObjectURL(blob);
      await chrome.downloads.download({ url: objUrl, filename: 'Stream Extractor/' + filename, saveAs: false });
      await Library.updateVideo(record.id, { savedToDisk: true });
      // The download needs the blob URL to outlive this call.
      setTimeout(() => URL.revokeObjectURL(objUrl), 120000);
    }

    done.add(url);
    setCardState(url, 'done', warnings.length ? `saved · ${warnings[0]}` : `saved as ${filename} (${formatBytes(blob.size)})`);
    if (rec) rec.fill.style.width = '100%';
  } catch (e) {
    if (e.name === 'AbortError') setCardState(url, '', 'cancelled');
    else setCardState(url, 'failed', 'failed — ' + e.message);
  } finally {
    locked.delete(url);
    currentAbort = null;
    updateToolbar();
  }
}

downloadSelBtn.addEventListener('click', () => {
  enqueue([...selected]);
});

// ------------------------------------------------------------------ data

async function load() {
  const data = await chrome.runtime.sendMessage({ type: 'GET_STREAMS', tabId: sourceTabId });
  streams = (data.streams || []).filter((s) => s.kind !== 'segment');
  render();
}

function render() {
  gridEl.textContent = '';
  cards.clear();
  thumbOwners.clear();

  if (!streams.length) {
    gridEl.hidden = true;
    emptyEl.hidden = false;
    statusEl.textContent = '';
    updateToolbar();
    return;
  }

  gridEl.hidden = false;
  emptyEl.hidden = true;

  const host = hostOf(pageUrl) || hostOf(streams[0].frameUrl || streams[0].url);
  document.getElementById('pageTitle').textContent = pageTitle || (host ? 'Videos on ' + host : 'Videos on this page');
  document.getElementById('pageSub').textContent = host || '';
  document.title = `${streams.length} videos — Stream Extractor`;
  statusEl.textContent =
    `${streams.length} video${streams.length === 1 ? '' : 's'} detected. ` +
    'Click cards to select, then Download selected.';

  for (const s of streams) gridEl.append(cardFor(s));

  // Restore state across a Refresh: selections, finished items, queued ones.
  for (const url of selected) {
    const rec = cards.get(url);
    if (rec && !locked.has(url) && !done.has(url)) applySelection(rec, true);
    else if (rec && !done.has(url)) selected.delete(url);
  }
  for (const url of done) setCardState(url, 'done', 'already saved');
  for (const url of locked) setCardState(url, 'active', 'queued…');
  updateToolbar();
}

refreshBtn.addEventListener('click', load);

load();
