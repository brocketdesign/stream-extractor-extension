const params = new URLSearchParams(location.search);
const src = params.get('src') || '';
const kind = params.get('kind') || '';
const ref = params.get('ref') || '';

const video = document.getElementById('video');
const msg = document.getElementById('msg');

document.getElementById('src').textContent = src;
document.getElementById('kind').textContent = kind || 'stream';
if (ref) {
  document.getElementById('ref').textContent = ref;
  document.getElementById('refline').hidden = false;
}
document.title = 'Stream — ' + (src.split('/').pop() || 'player').slice(0, 60);

function fail(text) {
  msg.className = 'msg error';
  msg.textContent = text;
}

function ok(text) {
  msg.className = 'msg';
  msg.textContent = text;
}

if (!src) {
  fail('No ?src= given.');
} else if (kind === 'hls' || /\.m3u8(\?|$)/i.test(src)) {
  // Safari and friends play HLS natively; everywhere else needs hls.js.
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
    ok('Playing with the browser’s native HLS support.');
  } else if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      ok(`Playing HLS — ${data.levels.length} quality level${data.levels.length === 1 ? '' : 's'}.`);
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        fail(`Network error loading the stream (${data.details}). The host may require a different Referer, or the link may have expired.`);
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        fail(`Media error (${data.details}) — trying to recover.`);
        hls.recoverMediaError();
      } else {
        fail(`Fatal error: ${data.details}`);
        hls.destroy();
      }
    });
  } else {
    fail('This browser cannot play HLS and hls.js failed to load.');
  }
} else {
  video.src = src;
  ok('Playing directly.');
  video.addEventListener('error', () => fail('The browser could not play this stream directly.'));
}

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
