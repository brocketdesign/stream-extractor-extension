const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const segToggle = document.getElementById('showSegments');

let current = { pageUrl: '', streams: [] };

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

function ffmpegCmd(url, referer) {
  const ref = referer ? ` -headers "Referer: ${referer}\\r\\n"` : '';
  return `ffmpeg${ref} -i "${url}" -c copy out.mp4`;
}

function render() {
  const showSegments = segToggle.checked;
  const streams = current.streams.filter((s) => showSegments || s.kind !== 'segment');
  listEl.textContent = '';

  if (!streams.length) {
    statusEl.textContent = current.streams.length
      ? 'Only HLS segments found — tick the box below to see them.'
      : 'No streams detected yet. Start the video, then hit Rescan.';
    return;
  }
  statusEl.textContent = `${streams.length} stream${streams.length === 1 ? '' : 's'} found.`;

  for (const s of streams) {
    const li = document.createElement('li');

    const row = document.createElement('div');
    row.className = 'row';
    const kind = document.createElement('span');
    kind.className = 'kind ' + s.kind;
    kind.textContent = s.kind;
    const origin = document.createElement('span');
    origin.className = 'origin';
    origin.textContent = originLabel(s.url) + (s.label ? ' · ' + s.label : ' · ' + s.source);
    row.append(kind, origin);

    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = shorten(s.url);

    const btns = document.createElement('div');
    btns.className = 'btns';
    btns.append(
      button('▶ Play', () => {
        chrome.runtime.sendMessage({
          type: 'OPEN_PLAYER',
          url: s.url,
          kind: s.kind,
          pageUrl: s.frameUrl || current.pageUrl
        });
        window.close();
      }),
      button('Open raw', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_RAW', url: s.url });
        window.close();
      }),
      button('Copy URL', (btn) => copy(s.url, btn)),
      button('Copy ffmpeg', (btn) =>
        copy(ffmpegCmd(s.url, originLabel(s.frameUrl || current.pageUrl) ? new URL(s.frameUrl || current.pageUrl).origin + '/' : ''), btn)
      )
    );

    li.append(row, url, btns);
    listEl.append(li);
  }
}

function button(text, onClick) {
  const b = document.createElement('button');
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

segToggle.addEventListener('change', render);
refresh();
