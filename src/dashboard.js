/**
 * The library dashboard: everything saved, grouped by where it came from,
 * with replay and per-video screenshots.
 */

const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const hostFilter = document.getElementById('hostFilter');
const usageEl = document.getElementById('usage');

let videos = [];
const objectUrls = [];

function trackUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

function formatDuration(s) {
  if (!s || !isFinite(s)) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = ('btn btn--sm ' + (cls || '')).trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function openPlayer(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/player.html?lib=' + encodeURIComponent(id)) });
}

async function card(rec) {
  const el = document.createElement('article');
  el.className = 'card';

  if (rec.poster) {
    const img = document.createElement('img');
    img.className = 'poster';
    img.src = trackUrl(rec.poster);
    img.addEventListener('click', () => openPlayer(rec.id));
    el.append(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'poster blank';
    ph.textContent = '▶';
    ph.addEventListener('click', () => openPlayer(rec.id));
    el.append(ph);
  }

  const body = document.createElement('div');
  body.className = 'body';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = rec.title || 'Untitled';

  const from = document.createElement('div');
  from.className = 'meta';
  from.textContent = rec.pageHost ? 'from ' + rec.pageHost : 'source unknown';
  if (rec.pageUrl) from.title = rec.pageUrl;

  const when = document.createElement('div');
  when.className = 'meta meta--faint';
  when.textContent = new Date(rec.savedAt).toLocaleString();

  const badges = document.createElement('div');
  badges.className = 'badges';
  for (const [text, cls] of [
    [(rec.container || 'mp4').toUpperCase(), ''],
    [formatBytes(rec.size), ''],
    [formatDuration(rec.duration), ''],
    [rec.savedToDisk ? 'on disk' : '', 'badge--good'],
    [rec.shots ? `${rec.shots} shot${rec.shots === 1 ? '' : 's'}` : '', 'badge--violet']
  ]) {
    if (!text) continue;
    const b = document.createElement('span');
    b.className = ('badge ' + cls).trim();
    b.textContent = text;
    badges.append(b);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    button('▶ Play', 'btn--primary', () => openPlayer(rec.id)),
    button(rec.savedToDisk ? 'Save again' : '⬇ Save to disk', '', async (e) => {
      const btn = e.target;
      btn.textContent = 'Saving…';
      const full = await Library.getVideo(rec.id);
      const url = URL.createObjectURL(full.blob);
      const name = (rec.title || 'video').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60);
      await chrome.downloads.download({
        url,
        filename: `Stream Extractor/${name}.${rec.container || 'mp4'}`,
        saveAs: false
      });
      await Library.updateVideo(rec.id, { savedToDisk: true });
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      btn.textContent = 'Saved ✓';
      render();
    }),
    button('Delete', 'btn--danger', async () => {
      if (!confirm(`Delete "${rec.title || 'this video'}" and its screenshots from the library?\n\nAnything already written to your Downloads folder stays there.`)) return;
      await Library.deleteVideo(rec.id);
      load();
    })
  );

  body.append(title, from, when, badges, actions);

  if (rec.shots) {
    const shots = await Library.listShots(rec.id);
    const strip = document.createElement('div');
    strip.className = 'shots';
    for (const shot of shots) {
      const img = document.createElement('img');
      img.src = trackUrl(shot.blob);
      img.title = 'Open frame at ' + formatDuration(shot.time);
      img.addEventListener('click', () => window.open(img.src, '_blank'));
      strip.append(img);
    }
    body.append(strip);
  }

  el.append(body);
  return el;
}

async function render() {
  const host = hostFilter.value;
  const shown = host ? videos.filter((v) => v.pageHost === host) : videos;

  grid.textContent = '';
  emptyEl.hidden = videos.length > 0;

  for (const rec of shown) grid.append(await card(rec));
}

async function load() {
  for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
  videos = await Library.listVideos();

  const hosts = [...new Set(videos.map((v) => v.pageHost).filter(Boolean))].sort();
  const previous = hostFilter.value;
  hostFilter.textContent = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = `All sites (${videos.length})`;
  hostFilter.append(all);
  for (const h of hosts) {
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = `${h} (${videos.filter((v) => v.pageHost === h).length})`;
    hostFilter.append(opt);
  }
  hostFilter.value = previous;

  const est = await Library.usage();
  usageEl.textContent = est && est.usage ? `${formatBytes(est.usage)} stored` : '';

  render();
}

hostFilter.addEventListener('change', render);
load();
