/**
 * MPEG-TS -> MP4 remuxing via mux.js.
 *
 * HLS usually ships MPEG-TS segments, which nothing outside a browser player
 * will open - not QuickTime, not Photos, not a <video> tag. Remuxing rewraps
 * the same H.264/AAC elementary streams in an MP4 container: lossless, no
 * re-encode.
 *
 * Segments are pushed one at a time with an explicit base decode time rather
 * than as one fused buffer. MPEG-TS timestamps restart at ad breaks and codec
 * changes (EXT-X-DISCONTINUITY) and wrap every ~26.5 hours, and a raw
 * concatenation carries those jumps straight into the output: the file still
 * has a video track, but its frames are scheduled hours from the audio, so it
 * plays as sound over a frozen or blank picture. Rebasing each segment onto a
 * continuous timeline is what keeps audio and video together.
 */

/**
 * Repairs impossible sample durations left behind by a timeline break.
 *
 * At an EXT-X-DISCONTINUITY the presentation timestamps can jump backwards.
 * The delta is written into the fragment as an unsigned 32-bit sample
 * duration, so a negative gap becomes a value near 2^32 - about 13 hours at
 * the 90kHz clock. One such sample is enough to push every frame after it
 * hours away from the audio, which plays back as sound over a still picture.
 *
 * Each outlier is replaced with the track's median sample duration, which is
 * what that frame should have had anyway.
 *
 * @returns {number} how many samples were repaired
 */
function repairTimeline(chunk) {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let repaired = 0;

  (function walk(start, end) {
    let p = start;
    while (p + 8 <= end) {
      const size = view.getUint32(p);
      const type = String.fromCharCode(chunk[p + 4], chunk[p + 5], chunk[p + 6], chunk[p + 7]);
      if (size < 8) break;

      if (type === 'moof' || type === 'traf') walk(p + 8, Math.min(p + size, end));

      if (type === 'trun') {
        const flags = view.getUint32(p + 8) & 0xffffff;
        if (flags & 0x100) {
          const count = view.getUint32(p + 12);
          let cursor = p + 16;
          if (flags & 0x1) cursor += 4; // data-offset
          if (flags & 0x4) cursor += 4; // first-sample-flags

          // Per-sample record width depends on which optional fields are present.
          const stride =
            4 +
            ((flags & 0x200) ? 4 : 0) +
            ((flags & 0x400) ? 4 : 0) +
            ((flags & 0x800) ? 4 : 0);

          const offsets = [];
          const durations = [];
          for (let i = 0; i < count; i++) {
            const at = cursor + i * stride;
            if (at + 4 > end) break;
            offsets.push(at);
            durations.push(view.getUint32(at));
          }

          if (durations.length) {
            const sorted = [...durations].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            if (median > 0) {
              const limit = median * 10;
              for (let i = 0; i < durations.length; i++) {
                if (durations[i] > limit) {
                  view.setUint32(offsets[i], median);
                  repaired++;
                }
              }
            }
          }
        }
      }

      p += size;
    }
  })(0, chunk.byteLength);

  return repaired;
}

/**
 * Writes the real total duration into the moov.
 *
 * mux.js emits fragmented MP4 aimed at Media Source Extensions, where the
 * player is told the duration out of band and the moov leaves it at zero (or
 * at whatever the first fragment covered). Opened as a plain file instead,
 * that is all a player has to go on, so it reports the length of one segment.
 * Patching mvhd/tkhd/mdhd makes the file self-describing.
 */
function patchMovieDuration(init, totalSeconds) {
  if (!init || totalSeconds <= 0) return;
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  let movieTimescale = 0;

  const write = (offset, version, value) => {
    if (version === 1) {
      // 64-bit: the high word stays zero for any plausible runtime.
      view.setUint32(offset, 0);
      view.setUint32(offset + 4, value >>> 0);
    } else {
      view.setUint32(offset, value >>> 0);
    }
  };

  (function walk(start, end) {
    let p = start;
    while (p + 8 <= end) {
      const size = view.getUint32(p);
      const type = String.fromCharCode(init[p + 4], init[p + 5], init[p + 6], init[p + 7]);
      if (size < 8) break;
      const payload = p + 8;
      const version = init[payload];

      if (type === 'mvhd') {
        const tsOffset = payload + (version === 1 ? 20 : 12);
        movieTimescale = view.getUint32(tsOffset);
        write(tsOffset + 4, version, Math.round(totalSeconds * movieTimescale));
      } else if (type === 'tkhd') {
        // tkhd duration is expressed in the movie timescale.
        const durOffset = payload + (version === 1 ? 28 : 20);
        if (movieTimescale) write(durOffset, version, Math.round(totalSeconds * movieTimescale));
      } else if (type === 'mdhd') {
        const tsOffset = payload + (version === 1 ? 20 : 12);
        const trackTimescale = view.getUint32(tsOffset);
        write(tsOffset + 4, version, Math.round(totalSeconds * trackTimescale));
      }

      if (['moov', 'trak', 'mdia'].includes(type)) walk(payload, Math.min(p + size, end));
      p += size;
    }
  })(0, init.byteLength);
}

/**
 * @param {ArrayBuffer[]} parts    TS segments in playback order
 * @param {{duration:number, discontinuity:boolean}[]} segments  metadata, aligned to parts
 * @param {(p:{done:number,total:number}) => void} [onProgress]
 * @returns {Promise<{blob: Blob, warnings: string[]}>}
 */
async function remuxTsToMp4(parts, segments = [], onProgress) {
  if (!window.muxjs) throw new Error('mux.js is not loaded');
  if (!parts.length) throw new Error('Nothing to remux.');

  const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
  const chunks = [];
  const warnings = [];
  let initSegment = null;
  let configChanges = 0;
  let sawVideo = false;
  let sawAudio = false;

  // One persistent listener resolves whichever flush is in flight; mux.js
  // Stream has no reliable off(), so we never stack listeners.
  let pendingFlush = null;

  transmuxer.on('data', (segment) => {
    if (segment.initSegment) {
      const init = new Uint8Array(segment.initSegment);
      if (!initSegment) {
        // Only the first init segment belongs in the file - a second moov
        // makes players give up on it.
        initSegment = init;
        chunks.push(init);
      } else if (init.byteLength !== initSegment.byteLength) {
        configChanges++;
      }
    }
    if (segment.type === 'video' || segment.type === 'combined') sawVideo = true;
    if (segment.type === 'audio' || segment.type === 'combined') sawAudio = true;
    chunks.push(new Uint8Array(segment.data));
  });

  transmuxer.on('done', () => {
    const resolve = pendingFlush;
    pendingFlush = null;
    if (resolve) resolve();
  });

  // All segments go through one push/flush pass. Flushing per segment looked
  // tempting for rebasing timestamps, but each flush emits its own moov and
  // only the first can be kept - the resulting file decodes, reports a sane
  // duration, and renders nothing at all. One pass keeps a single coherent
  // moov; the duration is corrected afterwards instead.
  const total = parts.length;
  for (let i = 0; i < total; i++) {
    transmuxer.push(new Uint8Array(parts[i]));
    if (onProgress) onProgress({ done: i + 1, total });
  }

  await new Promise((resolve) => {
    pendingFlush = resolve;
    transmuxer.flush();
  });

  const elapsed = segments.reduce((n, seg) => n + (seg.duration || 0), 0);

  if (!chunks.length) {
    throw new Error('Remux produced no output — the stream may not be MPEG-TS.');
  }
  if (!sawVideo && sawAudio) {
    throw new Error('This stream carried audio but no video track, so the file would be audio only.');
  }
  // Repair timeline breaks before anything reads the file. The init segment
  // holds no samples, so only the media chunks need walking.
  let repairedSamples = 0;
  for (const chunk of chunks) {
    if (chunk !== initSegment) repairedSamples += repairTimeline(chunk);
  }
  if (repairedSamples) {
    warnings.push(
      `Repaired ${repairedSamples} broken timestamp${repairedSamples === 1 ? '' : 's'} ` +
        'left by an ad break or stream reset.'
    );
  }

  // elapsed is the summed playlist duration, which is what the file should say.
  patchMovieDuration(initSegment, elapsed);

  if (configChanges) {
    warnings.push(
      `The stream changed format ${configChanges} time${configChanges === 1 ? '' : 's'} ` +
        '(likely an ad break). Playback may shift resolution partway through.'
    );
  }

  return { blob: new Blob(chunks, { type: 'video/mp4' }), warnings };
}

/**
 * Decodes the finished file before we hand it over. A remux can produce a
 * structurally valid MP4 whose timeline is nonsense, and the only honest way
 * to know is to make a real decoder open it.
 *
 * @returns {Promise<{ok:boolean, reason?:string, width?:number, duration?:number}>}
 */
function verifyPlayable(blob, expectedSeconds) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: 'the browser could not open it' }), 20000);

    video.muted = true;
    video.preload = 'metadata';

    video.addEventListener('loadedmetadata', () => {
      const { videoWidth: width, duration } = video;

      if (!width) return finish({ ok: false, reason: 'it has no video track', duration });
      if (!isFinite(duration) || duration <= 0) {
        return finish({ ok: false, reason: 'its timeline is invalid', width, duration });
      }
      // A blown-up timeline is the discontinuity failure: the picture ends up
      // scheduled far from the audio, so it plays as sound over a still frame.
      if (expectedSeconds > 0) {
        const ratio = duration / expectedSeconds;
        if (ratio > 1.5 || ratio < 0.5) {
          return finish({
            ok: false,
            reason: `its duration is ${Math.round(duration)}s but the playlist says ${Math.round(expectedSeconds)}s`,
            width,
            duration
          });
        }
      }
      // Duration and a video track are not enough: a file can satisfy both and
      // still paint nothing. Decode a frame and look at it.
      const target = Math.min(duration * 0.6, Math.max(duration - 0.5, 0));
      let checked = false;
      video.addEventListener('seeked', () => {
        if (checked) return;
        checked = true;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0);
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const colours = new Set();
          for (let i = 0; i < data.length; i += 4 * 97) {
            colours.add((data[i] >> 3) + ',' + (data[i + 1] >> 3) + ',' + (data[i + 2] >> 3));
          }
          if (colours.size <= 1) {
            return finish({ ok: false, reason: 'it plays no picture (audio only)', width, duration });
          }
        } catch {
          // Tainted canvas or no 2d context - fall through and accept.
        }
        finish({ ok: true, width, duration });
      }, { once: true });

      video.currentTime = target;
      // If seeking never completes, accept on the metadata checks alone.
      setTimeout(() => { if (!checked) { checked = true; finish({ ok: true, width, duration }); } }, 8000);
    });

    video.addEventListener('error', () => finish({ ok: false, reason: 'the browser rejected the file' }));
    video.src = url;
  });
}

/** MPEG-TS packets are 188 bytes and start with the sync byte 0x47. */
function looksLikeTs(buffer) {
  const b = new Uint8Array(buffer.slice ? buffer.slice(0, 1000) : buffer);
  return b[0] === 0x47 && (b[188] === 0x47 || b.length < 189);
}
