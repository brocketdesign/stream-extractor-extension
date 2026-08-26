/**
 * Player tab. Two modes:
 *   ?src=…&kind=…&ref=…   a live stream, with download offered
 *   ?lib=<id>             replay of something already in the library
 *
 * Downloads run here rather than in the service worker because MV3 tears
 * workers down mid-job, and this tab also carries the DNR Referer rule.
 */

const params = new URLSearchParams(location.search);
const libId = params.get('lib');
const src = params.get('src') || '';
const kind = params.get('kind') || '';
const ref = params.get('ref') || '';
const pageUrl = params.get('page') || '';
const pageTitle = params.get('title') || '';

const video = document.getElementById('video');
const msg = document.getElementById('msg');
const qualityRow = document.getElementById('qualityRow');
const qualitySelect = document.getElementById('quality');
const downloadBtn = document.getElementById('download');
const cancelBtn = document.getElementById('cancel');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const shotBtn = document.getElementById('shot');
const shotsEl = document.getElementById('shots');
const alsoDisk = document.getElementById('alsoDisk');
const shotCount = document.getElementById('shotCount');
const stageSticky = document.getElementById('stageSticky');
const stageEl = document.querySelector('.stage');

let currentLibId = libId;
let objectUrl = null;
let abort = null;

function setMsg(text, cls = '') {
  msg.className = 'msg ' + cls;
  msg.textContent = text;
}

function hostOf(u) {
  try { return new URL(u).host; } catch { return ''; }
}

// ------------------------------------------------------------------ playback

async function startLibraryPlayback(id) {
  const rec = await Library.getVideo(id);
  if (!rec) { setMsg('That library item no longer exists.', 'error'); return; }
  objectUrl = URL.createObjectURL(rec.blob);
  video.src = objectUrl;
  document.title = 'Library — ' + (rec.title || 'video');
  document.getElementById('kind').textContent = rec.container || 'mp4';
  document.getElementById('srcHost').textContent = rec.pageHost ? 'saved from ' + rec.pageHost : '';
  document.getElementById('src').textContent = rec.streamUrl || '';
  setMsg(`Playing from library — ${formatBytes(rec.size)}, saved ${new Date(rec.savedAt).toLocaleString()}.`);
  // Already saved; downloading again would just duplicate it.
  downloadBtn.disabled = true;
  downloadBtn.textContent = '✓ In your library';
  alsoDisk.parentElement.hidden = true;
  document.getElementById('panel-download').querySelector('.hint').textContent =
    'Already saved. Use Save to disk from the library to write another copy.';
  selectTab(document.getElementById('tab-shots'));
  refreshShots();
}

function startStreamPlayback() {
  document.getElementById('src').textContent = src;
  document.getElementById('kind').textContent = kind || 'stream';
  document.getElementById('srcHost').textContent = hostOf(src);
  if (ref) {
    document.getElementById('ref').textContent = ref;
    document.getElementById('refline').hidden = false;
  }
  document.title = 'Stream — ' + (src.split('/').pop() || 'player').slice(0, 60);

  if (!src) { setMsg('No ?src= given.', 'error'); return; }

  const isHls = kind === 'hls' || /\.m3u8(\?|$)/i.test(src);
  if (!isHls) {
    video.src = src;
    video.play().catch(() => {});
    setMsg('Playing directly.');
    video.addEventListener('error', () => setMsg('The browser could not play this stream directly.', 'error'));
    return;
  }

  // hls.js feeds the video through MSE, which keeps the canvas untainted and
  // so keeps screenshots working. The native path below does not.
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      setMsg(`Playing HLS — ${data.levels.length} quality level${data.levels.length === 1 ? '' : 's'}.`);
      video.play().catch(() => {});
      populateQuality(data.levels);
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        setMsg(`Network error (${data.details}). The host may want a different Referer, or the link expired.`, 'error');
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        setMsg(`Media error (${data.details}) — recovering.`, 'error');
        hls.recoverMediaError();
      } else {
        setMsg(`Fatal error: ${data.details}`, 'error');
        hls.destroy();
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
    video.play().catch(() => {});
    setMsg('Playing with the browser’s native HLS support.');
  } else {
    setMsg('This browser cannot play HLS and hls.js failed to load.', 'error');
  }
}

function populateQuality(levels) {
  if (!levels || levels.length < 2) return;
  qualitySelect.textContent = '';
  levels
    .map((l, i) => ({ i, url: l.url && l.url[0], label: l.height ? `${l.height}p` : `${Math.round((l.bitrate || 0) / 1000)} kbps`, bitrate: l.bitrate || 0 }))
    .sort((a, b) => b.bitrate - a.bitrate)
    .forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l.url || '';
      opt.textContent = `${l.label} (${Math.round(l.bitrate / 1000)} kbps)`;
      qualitySelect.append(opt);
    });
  qualityRow.hidden = false;
}

// ------------------------------------------------------------------ download

downloadBtn.addEventListener('click', async () => {
  abort = new AbortController();
  downloadBtn.disabled = true;
  cancelBtn.hidden = false;
  progressWrap.hidden = false;
  progressFill.style.width = '0%';
  setMsg('Downloading…', 'busy');

  try {
    const isHls = kind === 'hls' || /\.m3u8(\?|$)/i.test(src);
    let blob, container;

    if (isHls) {
      const variantUrl = qualityRow.hidden ? null : qualitySelect.value || null;
      const result = await downloadHls(src, {
        signal: abort.signal,
        variantUrl,
        onProgress: ({ done, total, bytes }) => {
          progressFill.style.width = ((done / total) * 100).toFixed(1) + '%';
          progressText.textContent = `${done} / ${total} segments · ${formatBytes(bytes)}`;
        }
      });
      container = result.container;

      if (container === 'ts') {
        // Rewrap TS as MP4 so it plays outside a browser player.
        setMsg('Remuxing to MP4…', 'busy');
        progressText.textContent = 'remuxing (no re-encode)…';
        const parts = await result.blob.arrayBuffer();
        blob = await remuxTsToMp4([parts]);
        container = 'mp4';
      } else {
        blob = result.blob;
      }
    } else {
      // Progressive file: one request, with progress off Content-Length.
      const res = await fetch(src, { signal: abort.signal, credentials: 'omit' });
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
        if (total) progressFill.style.width = ((received / total) * 100).toFixed(1) + '%';
        progressText.textContent = formatBytes(received) + (total ? ' / ' + formatBytes(total) : '');
      }
      blob = new Blob(chunks, { type: res.headers.get('content-type') || 'video/mp4' });
      container = (src.split('?')[0].split('.').pop() || 'mp4').toLowerCase();
      if (!['mp4', 'webm', 'm4v', 'mov'].includes(container)) container = 'mp4';
    }

    setMsg('Saving…', 'busy');
    const filename = guessFilename(src, container);
    const poster = await grabPoster(blob);

    const rec = await Library.addVideo({
      title: pageTitle || filename,
      pageUrl,
      pageHost: hostOf(pageUrl) || hostOf(src),
      streamUrl: src,
      kind: kind || 'video',
      container,
      size: blob.size,
      duration: video.duration && isFinite(video.duration) ? video.duration : 0,
      blob,
      poster,
      savedToDisk: false
    });
    currentLibId = rec.id;

    if (alsoDisk.checked) {
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({ url, filename: 'Stream Extractor/' + filename, saveAs: false });
      await Library.updateVideo(rec.id, { savedToDisk: true });
      // The download needs the blob URL to outlive this call.
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }

    progressFill.style.width = '100%';
    progressText.textContent = `${formatBytes(blob.size)} saved as ${filename}`;
    setMsg(
      alsoDisk.checked
        ? `Done — added to your library and saved to Downloads/Stream Extractor/${filename}.`
        : 'Done — added to your library.'
    );
    downloadBtn.textContent = '✓ In your library';
  } catch (e) {
    if (e.name === 'AbortError') {
      setMsg('Download cancelled.');
      progressText.textContent = '';
    } else {
      setMsg('Download failed: ' + e.message, 'error');
      downloadBtn.disabled = false;
    }
  } finally {
    cancelBtn.hidden = true;
    abort = null;
  }
});

cancelBtn.addEventListener('click', () => abort && abort.abort());

/** Grabs a frame ~10% in, for the library card. Best-effort only. */
function grabPoster(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 10000);
    v.muted = true;
    v.src = url;
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = Math.min(Math.max(v.duration * 0.1, 0.1), 30);
    });
    v.addEventListener('seeked', () => {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth || 320;
      canvas.height = v.videoHeight || 180;
      canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => { clearTimeout(timer); finish(b); }, 'image/jpeg', 0.7);
    });
    v.addEventListener('error', () => { clearTimeout(timer); finish(null); });
  });
}

// ---------------------------------------------------------------- screenshot

shotBtn.addEventListener('click', async () => {
  if (!currentLibId) {
    setMsg('Download the video first — screenshots attach to a library item.', 'error');
    return;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (!canvas.width || !canvas.height) throw new Error('no frame available yet');
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((res, rej) =>
      // Throws SecurityError if the frame came from a tainted (cross-origin) source.
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('capture failed'))), 'image/png')
    );
    await Library.addShot(currentLibId, blob, video.currentTime, document.title);

    if (alsoDisk.checked !== false) {
      const url = URL.createObjectURL(blob);
      const stamp = Math.floor(video.currentTime);
      await chrome.downloads.download({
        url,
        filename: `Stream Extractor/screenshots/shot-${stamp}s-${Date.now()}.png`,
        saveAs: false
      });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    setMsg(`Screenshot captured at ${formatTime(video.currentTime)}.`);
    refreshShots();
  } catch (e) {
    const tainted = e.name === 'SecurityError';
    setMsg(
      tainted
        ? 'Cannot screenshot this stream directly (the browser blocks reading cross-origin frames). Download it first, then screenshot from the library.'
        : 'Screenshot failed: ' + e.message,
      'error'
    );
  }
});

async function refreshShots() {
  if (!currentLibId) return;
  const shots = await Library.listShots(currentLibId);
  shotCount.textContent = shots.length;
  shotCount.hidden = shots.length === 0;
  shotsEl.textContent = '';
  for (const shot of shots) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = URL.createObjectURL(shot.blob);
    img.addEventListener('click', () => {
      video.currentTime = shot.time;
      stageSticky.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    img.title = 'Jump to ' + formatTime(shot.time);
    const cap = document.createElement('figcaption');
    cap.textContent = formatTime(shot.time);
    fig.append(img, cap);
    shotsEl.append(fig);
  }
}

function formatTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// --------------------------------------------------------------------- misc

document.getElementById('copy').addEventListener('click', (e) => copy(src, e.target));
document.getElementById('copyff').addEventListener('click', (e) =>
  copy(`ffmpeg${ref ? ` -headers "Referer: ${ref}\\r\\n"` : ''} -i "${src}" -c copy out.mp4`, e.target)
);

async function copy(text, btn) {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => (btn.textContent = old), 1200);
}

// ---------------------------------------------------------------- tabs

const tabs = [...document.querySelectorAll('.tab')];

function selectTab(tab) {
  for (const t of tabs) {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected));
    document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
  }
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    next.focus();
    selectTab(next);
  });
});

/**
 * On narrow screens the tab bar sticks directly beneath the sticky video, so
 * it needs the video's rendered height. Measuring beats guessing - this holds
 * through rotation, resizes and the aspect-ratio box settling after load.
 */
function trackStageHeight() {
  const apply = () => {
    document.documentElement.style.setProperty('--stage-h', stageEl.offsetHeight + 'px');
  };
  apply();
  if (window.ResizeObserver) new ResizeObserver(apply).observe(stageEl);
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
}
trackStageHeight();

window.addEventListener('beforeunload', () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});

if (libId) {
  startLibraryPlayback(libId);
} else {
  startStreamPlayback();
  // The popup's Download button opens this tab with dl=1 to skip a click.
  if (params.get('dl') === '1') {
    // Give hls.js a beat to report quality levels first.
    setTimeout(() => downloadBtn.click(), 1200);
  }
}
