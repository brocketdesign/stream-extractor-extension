/**
 * MPEG-TS -> MP4 remuxing via mux.js.
 *
 * HLS usually ships MPEG-TS segments, which nothing outside a browser player
 * will open - not QuickTime, not Photos, not a <video> tag. Remuxing rewraps
 * the same H.264/AAC elementary streams in an MP4 container: lossless, no
 * re-encode, and the result plays everywhere.
 */

/**
 * @param {ArrayBuffer[]} parts  TS segments, in playback order
 * @param {(p:{done:number,total:number}) => void} [onProgress]
 * @returns {Promise<Blob>} an MP4 blob
 */
function remuxTsToMp4(parts, onProgress) {
  return new Promise((resolve, reject) => {
    if (!window.muxjs) {
      reject(new Error('mux.js is not loaded'));
      return;
    }

    const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
    const chunks = [];
    let initSegment = null;

    transmuxer.on('data', (segment) => {
      // Every event carries the init segment; only the first copy belongs in
      // the file, or players see a second moov and give up.
      if (!initSegment) {
        initSegment = new Uint8Array(segment.initSegment);
        chunks.push(initSegment);
      }
      chunks.push(new Uint8Array(segment.data));
    });

    transmuxer.on('error', (e) => reject(new Error('Remux failed: ' + (e && e.message ? e.message : e))));

    transmuxer.on('done', () => {
      if (!chunks.length) {
        reject(new Error('Remux produced no output — the stream may not be MPEG-TS.'));
        return;
      }
      resolve(new Blob(chunks, { type: 'video/mp4' }));
    });

    try {
      for (let i = 0; i < parts.length; i++) {
        transmuxer.push(new Uint8Array(parts[i]));
        if (onProgress) onProgress({ done: i + 1, total: parts.length });
      }
      transmuxer.flush();
    } catch (e) {
      reject(e);
    }
  });
}

/** MPEG-TS packets are 188 bytes and start with the sync byte 0x47. */
function looksLikeTs(buffer) {
  const b = new Uint8Array(buffer.slice ? buffer.slice(0, 1000) : buffer);
  return b[0] === 0x47 && (b[188] === 0x47 || b.length < 189);
}
