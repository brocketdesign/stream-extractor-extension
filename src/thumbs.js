/**
 * Thumbnail previews for the stream lists (popup + grid page).
 *
 * Most pages offer no poster image to read, so a preview is generated from
 * the stream itself: fetch a slice of the file, decode it in a detached
 * <video>, and paint one frame to a canvas. The popup and the grid run in
 * extension pages, where host_permissions let fetch() cross origins, and
 * blob/MSE sources keep the canvas untainted so toDataURL works even though
 * the bytes came from another origin.
 *
 * Best effort by design: hotlink-protected or DRM streams simply get a
 * placeholder. The probe doubles as metadata - duration and size come back
 * even when no frame could be captured, which is often enough to tell two
 * look-alike entries apart.
 */

const Thumbs = (() => {
  const results = new Map(); // url -> Promise<{thumb, duration, size} | null>

  // Only so many decoders and connections at once, whoever asks first.
  let slots = 3;
  const waiting = [];

  // A usable frame almost always sits within the first few MB; past the cap
  // the read is cut off rather than pulling the whole file.
  const SLICE_CAP = 10 * 1024 * 1024;
  // MP4s that keep their index at the end are unreadable as a prefix, so a
  // slice that won't parse gets one full read - if the file is worth it.
  const FULL_RETRY_CAP = 60 * 1024 * 1024;

  function acquire() {
    return new Promise((resolve) => {
      if (slots > 0) {
        slots--;
        resolve();
      } else {
        waiting.push(resolve);
      }
    });
  }

  function release() {
    slots++;
    const next = waiting.shift();
    if (next) {
      slots--;
      next();
    }
  }

  /**
   * Range-GETs the head of a file, reading at most `cap` bytes. Servers that
   * ignore Range make this a plain GET, which the cap still cuts short.
   */
  async function fetchSlice(url, cap) {
    const ctrl = new AbortController();
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${cap - 1}` },
      signal: ctrl.signal,
      credentials: 'omit'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const total =
      Number((/\/(\d+)$/.exec(res.headers.get('content-range') || '') || [])[1]) ||
      (res.status === 200 ? Number(res.headers.get('content-length')) || 0 : 0);

    const chunks = [];
    let received = 0;
    let cut = false;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (received >= cap) {
          cut = true;
          break;
        }
      }
    } catch (e) {
      if (!cut) throw e; // a real network failure, not our own cut-off
    } finally {
      if (cut) ctrl.abort(); // don't leave the connection open behind us
    }

    return {
      blob: new Blob(chunks, { type: res.headers.get('content-type') || 'video/mp4' }),
      total,
      truncated: cut || (total > 0 && received < total)
    };
  }

  /** Draws the current frame, scaled down to keep data URLs small. */
  function paint(video) {
    if (!video.videoWidth || !video.videoHeight) return null;
    const scale = Math.min(1, 448 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      return canvas.toDataURL('image/jpeg', 0.72);
    } catch {
      return null; // tainted canvas - shouldn't happen for blob/MSE sources
    }
  }

  function durationOf(video) {
    return isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  }

  /**
   * Decodes a blob just far enough to paint one frame. The frame at 0s is
   * kept as a fallback: truncated slices and fragmented files often report
   * no duration, and a black-ish first frame still beats no preview.
   */
  function frameFromBlob(blob) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(blob);
      let settled = false;
      let seekPending = false;
      let fallback = null;

      const finish = (thumb) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        video.removeAttribute('src');
        video.load();
        resolve({ thumb: thumb || fallback, duration: durationOf(video) });
      };

      const timer = setTimeout(() => finish(null), 9000);

      video.muted = true;
      video.preload = 'auto';
      video.addEventListener('loadedmetadata', () => {
        const d = video.duration;
        if (isFinite(d) && d > 0.3) {
          seekPending = true;
          video.currentTime = Math.min(Math.max(d * 0.1, 0.1), 3);
        }
      });
      video.addEventListener('loadeddata', () => {
        fallback = paint(video);
        if (!seekPending) finish(fallback);
      });
      video.addEventListener('seeked', () => finish(paint(video)));
      video.addEventListener('error', () => finish(null));
      video.src = url;
    });
  }

  /** Previews an HLS stream through hls.js; MSE keeps the canvas untainted. */
  function hlsPreview(url) {
    return new Promise((resolve) => {
      if (!window.Hls || !Hls.isSupported()) return resolve(null);
      const video = document.createElement('video');
      video.muted = true;
      const hls = new Hls({ enableWorker: true, backBufferLength: 0, maxBufferLength: 2, maxMaxBufferLength: 4 });
      let settled = false;
      let sought = false;

      const finish = (thumb) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          hls.destroy();
        } catch {
          /* already gone */
        }
        resolve({ thumb, duration: durationOf(video), size: 0 });
      };

      const timer = setTimeout(() => finish(paint(video)), 15000);

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        // A thumbnail doesn't need 1080p - the cheapest level is fewest bytes.
        let low = 0;
        data.levels.forEach((l, i) => {
          if ((l.bitrate || Infinity) < (data.levels[low].bitrate || Infinity)) low = i;
        });
        hls.currentLevel = low;
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (sought) return;
        sought = true;
        const end = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
        const d = durationOf(video);
        const target = Math.min(Math.max(d * 0.1, 0.1), end - 0.05);
        if (target > 0.05 && target < end) video.currentTime = target;
        else finish(paint(video));
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) finish(paint(video));
      });
      video.addEventListener('seeked', () => {
        if (sought) finish(paint(video));
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    });
  }

  async function compute(stream) {
    const { url, kind } = stream;
    if (kind === 'dash' || kind === 'segment') return null; // nothing generic to decode DASH with

    await acquire();
    try {
      if (kind === 'hls' || /\.m3u8(\?|$)/i.test(url)) return await hlsPreview(url);

      let slice;
      try {
        slice = await fetchSlice(url, SLICE_CAP);
      } catch {
        return null;
      }
      const out = await frameFromBlob(slice.blob);
      if (out.thumb || !slice.truncated) return { ...out, size: slice.total };

      if (slice.total && slice.total <= FULL_RETRY_CAP) {
        try {
          const whole = await fetchSlice(url, FULL_RETRY_CAP);
          const retried = await frameFromBlob(whole.blob);
          return { ...retried, size: slice.total };
        } catch {
          /* keep whatever the prefix produced */
        }
      }
      return { ...out, size: slice.total };
    } finally {
      release();
    }
  }

  /** Preview + metadata for a detected stream; null when nothing could be read. */
  function preview(stream) {
    if (!stream || !stream.url) return Promise.resolve(null);
    if (!results.has(stream.url)) {
      results.set(stream.url, compute(stream).catch(() => null));
    }
    return results.get(stream.url);
  }

  /**
   * Poster for a fully downloaded file (library cards). Prefers ~10% in, like
   * the player's grabPoster.
   */
  function posterFromBlob(blob) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(blob);
      let settled = false;

      const finish = (poster) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        video.removeAttribute('src');
        video.load();
        resolve(poster);
      };

      const timer = setTimeout(() => finish(null), 10000);

      video.muted = true;
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = Math.min(Math.max(video.duration * 0.1, 0.1), 30);
      });
      video.addEventListener('seeked', () => {
        if (!video.videoWidth) return finish(null);
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        canvas.toBlob((b) => finish(b), 'image/jpeg', 0.7);
      });
      video.addEventListener('error', () => finish(null));
      video.src = url;
    });
  }

  return { preview, posterFromBlob };
})();
