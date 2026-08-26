/**
 * Stream Extractor - content script.
 *
 * Runs in every frame (all_frames), so embed iframes get scanned in place -
 * no refetching the embed with a spoofed Referer the way the server-side
 * extractor has to. The player-config decoders are ported from server.js.
 */

const MEDIA_URL_RE = /https?:\/\/[^\s"'<>\\)]+?\.(?:m3u8|mpd|mp4|m4v|webm|flv)(?:\?[^\s"'<>\\)]*)?/gi;

function absolute(raw) {
  try {
    return new URL(raw, document.baseURI).href;
  } catch {
    return null;
  }
}

function kindOf(url) {
  const path = url.split('#')[0].split('?')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  if (path.endsWith('.webm')) return 'webm';
  if (path.endsWith('.flv')) return 'flv';
  if (/\.(mp4|m4v|mov)$/.test(path)) return 'mp4';
  return 'video';
}

/**
 * XOR-obfuscated embed config:
 *   var k="KEY", b=atob("BLOB"); ... fromCharCode(b[i] ^ k[i % k.length]); eval(o)
 * Decoding it just yields the original JS as a string, which we then regex.
 */
function decodeObfuscatedConfig(html) {
  const m = html.match(/var\s+k\s*=\s*"([^"]+)"\s*,\s*b\s*=\s*atob\(\s*"([^"]+)"\s*\)/);
  if (!m) return '';
  const key = m[1];
  let blob;
  try {
    blob = atob(m[2]);
  } catch {
    return '';
  }
  let out = '';
  for (let i = 0; i < blob.length; i++) {
    out += String.fromCharCode(blob.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

/** Player-config layouts that don't put the stream URL in the DOM verbatim. */
function scanPlayerConfigs(source, out) {
  // window.PLAYER_CFG = { code: "xxx", hosts: ["https://..."] }
  //   -> {hosts[0]}/{code}/index.m3u8
  const cfg = (source.match(/PLAYER_CFG\s*=\s*\{([^}]*)\}/) || [])[1];
  if (cfg) {
    const code = (cfg.match(/code\s*:\s*["']([^"']+)["']/) || [])[1];
    const hostsRaw = (cfg.match(/hosts\s*:\s*\[([^\]]*)\]/) || [])[1];
    if (code && hostsRaw) {
      const host = hostsRaw.split(',')[0].trim().replace(/^["']|["']$/g, '');
      if (host) {
        out.push({ url: host.replace(/\/+$/, '') + '/' + code + '/index.m3u8', kind: 'hls', source: 'config', label: 'PLAYER_CFG' });
      }
    }
  }

  // HLS = "hlsplaylist.php?s=...&idhls=....m3u8"
  const hls = (source.match(/HLS\s*=\s*"([^"]*(?:hlsplaylist|m3u8)[^"]*)"/i) || [])[1];
  if (hls) {
    const abs = absolute(hls.replace(/\\\//g, '/').replace(/&amp;/g, '&'));
    if (abs) out.push({ url: abs, kind: 'hls', source: 'config', label: 'HLS var' });
  }

  // jwplayer / video.js: file: "..." or sources: [{ file: "..." }]
  const file =
    (source.match(/file\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i) || [])[1] ||
    (source.match(/sources?\s*:\s*\[\{?\s*file\s*:\s*["']([^"']+)["']/i) || [])[1];
  if (file) {
    const abs = absolute(file.replace(/\\\//g, '/'));
    if (abs) out.push({ url: abs, kind: kindOf(abs), source: 'config', label: 'jwplayer file' });
  }
}

function scan() {
  const found = [];

  // 1. Real <video> / <audio> elements and their <source> children.
  for (const el of document.querySelectorAll('video, audio')) {
    for (const raw of [el.currentSrc, el.getAttribute('src')]) {
      if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) continue;
      const abs = absolute(raw);
      if (abs) found.push({ url: abs, kind: kindOf(abs), source: 'dom', label: '<' + el.tagName.toLowerCase() + '>' });
    }
    for (const s of el.querySelectorAll('source')) {
      const abs = absolute(s.getAttribute('src') || '');
      if (abs) found.push({ url: abs, kind: kindOf(abs), source: 'dom', label: '<source>' });
    }
  }

  // 2. Inline script bodies, plus anything the XOR blob decodes to.
  let inline = '';
  for (const s of document.querySelectorAll('script:not([src])')) inline += '\n' + s.textContent;
  const decoded = decodeObfuscatedConfig(inline || document.documentElement.innerHTML);
  const source = decoded + '\n' + inline;
  scanPlayerConfigs(source, found);

  // 3. Catch-all: any media URL sitting in the markup or decoded config.
  const haystack = source + '\n' + document.documentElement.innerHTML;
  for (const m of haystack.matchAll(MEDIA_URL_RE)) {
    const abs = absolute(m[0].replace(/\\\//g, '/').replace(/&amp;/g, '&'));
    if (abs) found.push({ url: abs, kind: kindOf(abs), source: 'dom', label: 'page source' });
  }

  return found.map((s) => ({ ...s, frameUrl: location.href, ts: Date.now() }));
}

function report() {
  const streams = scan();
  if (!streams.length) return;
  chrome.runtime.sendMessage({ type: 'ADD_STREAMS', streams }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'RESCAN') {
    const streams = scan();
    chrome.runtime.sendMessage({ type: 'ADD_STREAMS', streams }).catch(() => {});
    sendResponse({ found: streams.length });
  }
  return false;
});

report();
// Players often write their config in after load, so take a second look.
setTimeout(report, 2500);
