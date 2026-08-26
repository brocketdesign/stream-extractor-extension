/**
 * HLS downloading: manifest parsing, AES-128 decryption, segment assembly.
 *
 * This runs in the player tab rather than the service worker on purpose - MV3
 * workers get torn down mid-job, and a long download must outlive that. The
 * tab also carries the DNR Referer rule, so segment fetches look like they came
 * from the embed.
 */

function resolveUrl(raw, base) {
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

/** Parses `A=1,B="quoted,with,commas",C=0x1F` into an object. */
function parseAttrs(input) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m;
  while ((m = re.exec(input)) !== null) {
    attrs[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

/**
 * Parses a playlist into either a master (variants) or a media playlist
 * (segments). Callers check `isMaster`.
 */
function parseM3u8(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const out = { isMaster: false, variants: [], segments: [], map: null, totalDuration: 0 };

  let pendingVariant = null;
  let pendingDuration = 0;
  let pendingByteRange = null;
  let key = null;
  let mediaSequence = 0;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      out.isMaster = true;
      const a = parseAttrs(line.slice(line.indexOf(':') + 1));
      pendingVariant = {
        bandwidth: parseInt(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || '0', 10),
        resolution: a.RESOLUTION || '',
        codecs: a.CODECS || ''
      };
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(line.indexOf(':') + 1));
      key =
        !a.METHOD || a.METHOD === 'NONE'
          ? null
          : { method: a.METHOD, uri: resolveUrl(a.URI, baseUrl), iv: a.IV || null };
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(line.indexOf(':') + 1));
      out.map = { url: resolveUrl(a.URI, baseUrl), byteRange: a.BYTERANGE || null };
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8).split(',')[0]) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = line.slice(17).trim();
      continue;
    }

    if (line.startsWith('#')) continue;

    // A bare line is a URI - belongs to whichever tag came before it.
    const url = resolveUrl(line, baseUrl);
    if (!url) continue;

    if (pendingVariant) {
      out.variants.push({ ...pendingVariant, url });
      pendingVariant = null;
    } else {
      out.segments.push({
        url,
        duration: pendingDuration,
        byteRange: pendingByteRange,
        key,
        sequence: mediaSequence + out.segments.length
      });
      out.totalDuration += pendingDuration;
      pendingDuration = 0;
      pendingByteRange = null;
    }
  }

  out.variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return out;
}

/** `length@offset` -> a Range header value. */
function byteRangeHeader(spec, previousEnd) {
  const [lenStr, offStr] = spec.split('@');
  const length = parseInt(lenStr, 10);
  const offset = offStr !== undefined ? parseInt(offStr, 10) : previousEnd;
  if (!Number.isFinite(length) || !Number.isFinite(offset)) return null;
  return { header: `bytes=${offset}-${offset + length - 1}`, end: offset + length };
}

async function fetchBuffer(url, { signal, range } = {}) {
  const headers = range ? { Range: range } : undefined;
  const res = await fetch(url, { signal, headers, credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`);
  return res.arrayBuffer();
}

/** HLS AES-128 is CBC with PKCS#7, which WebCrypto handles directly. */
function ivFor(segment) {
  if (segment.key.iv) {
    const hex = segment.key.iv.replace(/^0x/i, '');
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
    return bytes;
  }
  // Default IV is the media sequence number, big-endian in the low 8 bytes.
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, segment.sequence >>> 0);
  return bytes;
}

const keyCache = new Map();

async function cryptoKeyFor(segment, signal) {
  if (keyCache.has(segment.key.uri)) return keyCache.get(segment.key.uri);
  const raw = await fetchBuffer(segment.key.uri, { signal });
  const imported = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
  keyCache.set(segment.key.uri, imported);
  return imported;
}

async function fetchSegment(segment, signal, previousEnd) {
  let range = null;
  if (segment.byteRange) {
    const r = byteRangeHeader(segment.byteRange, previousEnd);
    if (r) range = r.header;
  }
  let buf = await fetchBuffer(segment.url, { signal, range });

  if (segment.key) {
    if (segment.key.method !== 'AES-128') {
      throw new Error(`Unsupported encryption: ${segment.key.method} (likely DRM)`);
    }
    const cryptoKey = await cryptoKeyFor(segment, signal);
    buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(segment) }, cryptoKey, buf);
  }
  return buf;
}

/**
 * Downloads every segment of a media playlist and returns one Blob.
 * `onProgress({done, total, bytes})` fires as segments land.
 */
async function downloadHls(playlistUrl, { signal, onProgress, variantUrl } = {}) {
  const firstText = await (await fetch(playlistUrl, { signal, credentials: 'omit' })).text();
  let parsed = parseM3u8(firstText, playlistUrl);
  let mediaUrl = playlistUrl;

  if (parsed.isMaster) {
    const chosen = variantUrl || (parsed.variants[0] && parsed.variants[0].url);
    if (!chosen) throw new Error('Master playlist listed no variants.');
    mediaUrl = chosen;
    const text = await (await fetch(mediaUrl, { signal, credentials: 'omit' })).text();
    parsed = parseM3u8(text, mediaUrl);
  }

  if (!parsed.segments.length) throw new Error('Playlist contained no segments.');

  const parts = new Array(parsed.segments.length);
  let bytes = 0;
  let done = 0;

  if (parsed.map && parsed.map.url) {
    // fMP4 init segment has to lead, or the result is unplayable.
    const init = await fetchBuffer(parsed.map.url, { signal });
    parts.unshift(init);
    bytes += init.byteLength;
  }

  // Byte-range playlists are sequential by nature; everything else fans out.
  const usesByteRange = parsed.segments.some((s) => s.byteRange);
  const concurrency = usesByteRange ? 1 : 6;
  const offset = parsed.map && parsed.map.url ? 1 : 0;
  let cursor = 0;
  let previousEnd = 0;

  async function worker() {
    while (cursor < parsed.segments.length) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const i = cursor++;
      const seg = parsed.segments[i];
      const buf = await fetchSegment(seg, signal, previousEnd);
      if (seg.byteRange) {
        const r = byteRangeHeader(seg.byteRange, previousEnd);
        if (r) previousEnd = r.end;
      }
      parts[i + offset] = buf;
      bytes += buf.byteLength;
      done++;
      if (onProgress) onProgress({ done, total: parsed.segments.length, bytes });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, parsed.segments.length) }, worker));

  const isFmp4 = Boolean(parsed.map && parsed.map.url);
  return {
    blob: new Blob(parts.filter(Boolean), { type: isFmp4 ? 'video/mp4' : 'video/mp2t' }),
    container: isFmp4 ? 'mp4' : 'ts',
    duration: parsed.totalDuration
  };
}

/** A filename that won't upset the filesystem, with the right extension. */
function guessFilename(url, container) {
  let stem = 'stream';
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || '';
    const named = /^(index|master|playlist|manifest)\b/i.test(last) ? parts[parts.length - 2] : last;
    stem = (named || 'stream').replace(/\.[a-z0-9]+$/i, '');
  } catch {
    /* fall through to the default */
  }
  stem = stem.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'stream';
  return `${stem}.${container}`;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}
