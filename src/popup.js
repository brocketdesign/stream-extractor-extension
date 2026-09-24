const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const segToggle = document.getElementById('showSegments');
const seeAllBtn = document.getElementById('seeAll');

// The popup stays glanceable; the grid page ("See all") holds everything.
const POPUP_MAX = 6;

const PLAY_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<rect x="3" y="5" width="18" height="14" rx="2.5"/>' +
  '<path d="M10.2 9.4v5.2l4.6-2.6z" fill="currentColor" stroke="none"/></svg>';

let current = { pageUrl: '', streams: [] };
let activeTab = null;

function shorten(url, max = 140) {
  return url.length > max ? url.slice(0, max) + '…' : url;
}

function originLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function formatDuration(s) {
  if (!isFinite(s) || s <= 0) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function ffmpegCmd(url, referer) {
  const ref = referer ? ` -headers "Referer: ${referer}\\r\\n"` : '';
  return `ffmpeg${ref} -i "${url}" -c copy out.mp4`;
}

function render() {
  const showSegments = segToggle.checked;
  const playable = current.streams.filter((s) => s.kind !== 'segment');
  const segments = showSegments ? current.streams.filter((s) => s.kind === 'segment') : [];
  const shown = playable.slice(0, POPUP_MAX);
  listEl.textContent = '';

  if (!playable.length && !segments.length) {
    statusEl.textContent = current.streams.length
      ? 'Only HLS segments found — tick the box below to see them.'
      : 'No streams detected yet. Start the video, then hit Rescan.';
    seeAllBtn.hidden = true;
    return;
  }

  if (!playable.length && segments.length) {
    statusEl.textContent = `${segments.length} HLS segment${segments.length === 1 ? '' : 's'} shown — no playable stream found yet.`;
  } else {
    statusEl.textContent =
      playable.length > shown.length
        ? `${playable.length} streams found — showing ${shown.length}.`
        : `${playable.length} stream${playable.length === 1 ? '' : 's'} found.`;
  }
  seeAllBtn.hidden = playable.length === 0;
  seeAllBtn.textContent = `See all ${playable.length} video${playable.length === 1 ? '' : 's'} →`;

  for (const s of shown) listEl.append(item(s, true));
  for (const s of segments) listEl.append(item(s, false));
}

function item(s, withThumb) {
  const li = document.createElement('li');
  if (withThumb) li.className = 'item';

  const body = document.createElement('div');
  body.className = 'item__body';

  const row = document.createElement('div');
  row.className = 'row';
  const kind = document.createElement('span');
  kind.className = 'kind ' + s.kind;
  kind.textContent = s.kind;
  const origin = document.createElement('span');
  origin.className = 'origin';
  const originText = originLabel(s.url) + (s.label ? ' · ' + s.label : ' · ' + s.source);
  origin.textContent = originText;
  const dur = document.createElement('span');
  dur.className = 'dur';
  dur.hidden = true;
  row.append(kind, origin, dur);

  const url = document.createElement('div');
  url.className = 'url';
  url.textContent = shorten(s.url);

  const btns = document.createElement('div');
  btns.className = 'btn-row';
  btns.append(
    button('▶ Play', () => {
      chrome.runtime.sendMessage({
        type: 'OPEN_PLAYER',
        url: s.url,
        kind: s.kind,
        pageUrl: s.frameUrl || current.pageUrl,
        tabUrl: activeTab ? activeTab.url : '',
        tabTitle: activeTab ? activeTab.title : ''
      });
      window.close();
    }, 'btn--primary'),
    button('⬇ Download', () => {
      chrome.runtime.sendMessage({
        type: 'OPEN_PLAYER',
        url: s.url,
        kind: s.kind,
        pageUrl: s.frameUrl || current.pageUrl,
        autoDownload: true,
        tabUrl: activeTab ? activeTab.url : '',
        tabTitle: activeTab ? activeTab.title : ''
      });
      window.close();
    }),
    button('Open raw', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_RAW', url: s.url });
      window.close();
    }, 'btn--ghost'),
    button('Copy URL', (btn) => copy(s.url, btn), 'btn--ghost'),
    button('Copy ffmpeg', (btn) =>
      copy(ffmpegCmd(s.url, originLabel(s.frameUrl || current.pageUrl) ? new URL(s.frameUrl || current.pageUrl).origin + '/' : ''), btn)
    , 'btn--ghost')
  );

  body.append(row, url, btns);

  if (withThumb) {
    li.append(thumbFor(s, dur, origin, originText), body);
  } else {
    li.append(body);
  }
  return li;
}

/**
 * Small preview beside each entry. The page's own poster (rare, but free)
 * shows instantly; the probe then swaps in a real frame and fills in the
 * duration and size, which is usually what tells two entries apart.
 */
function thumbFor(s, durEl, originEl, originText) {
  const wrap = document.createElement('div');
  wrap.className = 'thumb is-loading';
  wrap.title = originLabel(s.url);
  const img = document.createElement('img');
  img.alt = '';
  if (s.poster) img.src = s.poster;
  const glyph = document.createElement('span');
  glyph.className = 'thumb__glyph';
  glyph.innerHTML = PLAY_SVG;
  wrap.append(img, glyph);

  Thumbs.preview(s).then((r) => {
    if (!wrap.isConnected) return; // the popup re-rendered or closed
    wrap.classList.remove('is-loading');
    if (r && r.thumb) {
      img.src = r.thumb;
      wrap.classList.add('has-frame');
    }
    if (r && r.duration) {
      durEl.textContent = formatDuration(r.duration);
      durEl.hidden = false;
    }
    if (r && r.size) originEl.textContent = originText + ' · ' + formatBytes(r.size);
  });

  return wrap;
}

function button(text, onClick, cls = '') {
  const b = document.createElement('button');
  b.className = ('btn btn--sm ' + cls).trim();
  b.textContent = text;
  b.addEventListener('click', () => onClick(b));
  return b;
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = old), 1200);
  } catch {
    btn.textContent = 'Copy failed';
  }
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  return tab ? tab.id : null;
}

async function refresh() {
  const tabId = await activeTabId();
  if (tabId == null) return;
  current = await chrome.runtime.sendMessage({ type: 'GET_STREAMS', tabId });
  render();
}

document.getElementById('rescan').addEventListener('click', async () => {
  const tabId = await activeTabId();
  statusEl.textContent = 'rescanning…';
  try {
    // Fans out to every frame, so embed iframes get rescanned too.
    await chrome.tabs.sendMessage(tabId, { type: 'RESCAN' });
  } catch {
    // No content script on this page (chrome://, PDF viewer, …) - network
    // sniffing results are still valid, so just re-read the store.
  }
  setTimeout(refresh, 400);
});

document.getElementById('clear').addEventListener('click', async () => {
  const tabId = await activeTabId();
  await chrome.runtime.sendMessage({ type: 'CLEAR', tabId });
  refresh();
});

const notifyToggle = document.getElementById('notifyToggle');

chrome.storage.local.get('notifyOnDetect').then((d) => {
  notifyToggle.checked = d.notifyOnDetect !== false;
});
notifyToggle.addEventListener('change', () => {
  chrome.storage.local.set({ notifyOnDetect: notifyToggle.checked });
});

document.getElementById('libraryLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY' });
  window.close();
});

seeAllBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'OPEN_GRID',
    tabId: activeTab ? activeTab.id : null,
    tabUrl: activeTab ? activeTab.url : '',
    title: activeTab ? activeTab.title : ''
  });
  window.close();
});

segToggle.addEventListener('change', render);
refresh();
