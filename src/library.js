/**
 * IndexedDB-backed library of saved videos and screenshots.
 *
 * A file written to the Downloads folder is out of the extension's reach - it
 * can't be read back, so it can't be replayed or screenshotted here. Keeping a
 * copy in IndexedDB is what makes the dashboard possible; saving to disk is a
 * separate, additional step.
 */

const DB_NAME = 'stream-extractor-library';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('videos')) {
        const videos = db.createObjectStore('videos', { keyPath: 'id' });
        videos.createIndex('savedAt', 'savedAt');
        videos.createIndex('pageHost', 'pageHost');
      }
      if (!db.objectStoreNames.contains('shots')) {
        const shots = db.createObjectStore('shots', { keyPath: 'id' });
        shots.createIndex('videoId', 'videoId');
        shots.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
}

const Library = {
  async addVideo(record) {
    const db = await openDb();
    const entry = { id: newId(), savedAt: Date.now(), shots: 0, ...record };
    await tx(db, 'videos', 'readwrite', (s) => s.put(entry));
    return entry;
  },

  async listVideos() {
    const db = await openDb();
    const all = await tx(db, 'videos', 'readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => b.savedAt - a.savedAt);
  },

  async getVideo(id) {
    const db = await openDb();
    return tx(db, 'videos', 'readonly', (s) => s.get(id));
  },

  async updateVideo(id, patch) {
    const db = await openDb();
    const existing = await tx(db, 'videos', 'readonly', (s) => s.get(id));
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    await tx(db, 'videos', 'readwrite', (s) => s.put(merged));
    return merged;
  },

  async deleteVideo(id) {
    const db = await openDb();
    const shots = await this.listShots(id);
    await tx(db, 'videos', 'readwrite', (s) => s.delete(id));
    for (const shot of shots) await tx(db, 'shots', 'readwrite', (s) => s.delete(shot.id));
  },

  async addShot(videoId, blob, time, title) {
    const db = await openDb();
    const shot = { id: newId(), videoId, blob, time, title: title || '', createdAt: Date.now() };
    await tx(db, 'shots', 'readwrite', (s) => s.put(shot));
    const video = await tx(db, 'videos', 'readonly', (s) => s.get(videoId));
    if (video) {
      video.shots = (video.shots || 0) + 1;
      await tx(db, 'videos', 'readwrite', (s) => s.put(video));
    }
    return shot;
  },

  async listShots(videoId) {
    const db = await openDb();
    const all = await tx(db, 'shots', 'readonly', (s) => s.getAll());
    return (all || [])
      .filter((s) => !videoId || s.videoId === videoId)
      .sort((a, b) => a.time - b.time);
  },

  async deleteShot(id) {
    const db = await openDb();
    const shot = await tx(db, 'shots', 'readonly', (s) => s.get(id));
    await tx(db, 'shots', 'readwrite', (s) => s.delete(id));
    if (shot) {
      const video = await tx(db, 'videos', 'readonly', (s) => s.get(shot.videoId));
      if (video && video.shots) {
        video.shots--;
        await tx(db, 'videos', 'readwrite', (s) => s.put(video));
      }
    }
  },

  async usage() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    return navigator.storage.estimate();
  }
};
