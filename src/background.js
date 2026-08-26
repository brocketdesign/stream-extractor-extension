/**
 * Stream Extractor - background service worker.
 *
 * Two detection paths feed one per-tab store:
 *   1. passive webRequest sniffing (catches whatever the player actually loads,
 *      no matter how obfuscated the page is about it)
 *   2. reports pushed up from the content script's DOM / player-config scan
 *
 * MV3 service workers get torn down between events, so the in-memory cache is
 * mirrored into chrome.storage.session and rehydrated on demand.
 */

const MAX_PER_TAB = 300;

const MEDIA_EXT = {
  m3u8: 'hls',
  mpd: 'dash',
  mp4: 'mp4',
  m4v: 'mp4',
  webm: 'webm',
  mov: 'mp4',
  flv: 'flv',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ts: 'segment',
  m4s: 'segment',
  cmfv: 'segment',
  cmfa: 'segment'
};

const CONTENT_TYPE_KIND = [
  [/mpegurl/i, 'hls'],
  [/dash\+xml/i, 'dash'],
  [/video\/mp4/i, 'mp4'],
  [/video\/webm/i, 'webm'],
  [/^audio\//i, 'audio'],
  [/^video\//i, 'video']
];

/** Rank used to decide what the popup shows first. */
const KIND_RANK = {
  hls: 0,
  dash: 1,
  mp4: 2,
  webm: 3,
  video: 4,
  flv: 5,
  audio: 6,
  segment: 9
};

function extOf(url) {
  const path = url.split('#')[0].split('?')[0];
  const dot = path.lastIndexOf('.');
  if (dot === -1) return '';
  return path.slice(dot + 1).toLowerCase();
}

/** Returns a kind string, or null when this isn't media we care about. */
function classify(url, contentType) {
  const byExt = MEDIA_EXT[extOf(url)];
  if (byExt) return byExt;
  if (contentType) {
    for (const [re, kind] of CONTENT_TYPE_KIND) {
      if (re.test(contentType)) return kind;
    }
  }
  // Extensionless manifests are common; fall back to a path hint.
  if (/[/.](master|index|playlist|manifest)\b/i.test(url) && /m3u8|mpegurl/i.test(url)) return 'hls';
  return null;
}

// ---------------------------------------------------------------- tab store

let cache = null;
let hydrating = null;
let flushTimer = null;

function hydrate() {
  if (cache) return Promise.resolve(cache);
  if (!hydrating) {
    hydrating = chrome.storage.session
      .get('tabs')
      .then((d) => {
        cache = d.tabs || {};
        hydrating = null;
        return cache;
      })
      .catch(() => {
        cache = {};
        hydrating = null;
        return cache;
      });
  }
  return hydrating;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    chrome.storage.session.set({ tabs: cache }).catch(() => {});
  }, 300);
}

function entryFor(tabId) {
  if (!cache[tabId]) cache[tabId] = { pageUrl: '', streams: [], toasted: false };
  return cache[tabId];
}

/**
 * Adds streams to a tab, deduped by URL. Returns the number actually added so
 * the badge only repaints when something changed.
 */
async function addStreams(tabId, incoming) {
  if (tabId == null || tabId < 0 || !incoming.length) return 0;
  await hydrate();
  const entry = entryFor(tabId);
  const seen = new Set(entry.streams.map((s) => s.url));
  let added = 0;

  for (const s of incoming) {
    if (!s.url || seen.has(s.url)) continue;
    if (!/^https?:\/\//i.test(s.url)) continue;
    seen.add(s.url);
    entry.streams.push(s);
    added++;
  }

  if (!added) return 0;
  maybeToast(tabId, entry);
  if (entry.streams.length > MAX_PER_TAB) {
    // Drop oldest segments first - they're the noisiest and least useful.
    entry.streams.sort((a, b) => (a.kind === 'segment' ? 1 : 0) - (b.kind === 'segment' ? 1 : 0));
    entry.streams.length = MAX_PER_TAB;
  }
  scheduleFlush();
  paintBadge(tabId, entry);
  return added;
}

/**
 * Offers the stream in-page so it takes one click instead of three. Fires once
 * per page, ~1.2s after the first hit, so the burst of requests a player makes
 * on startup settles and we can offer the best of them rather than the first.
 */
const toastTimers = {};

function maybeToast(tabId, entry) {
  if (entry.toasted || toastTimers[tabId]) return;
  toastTimers[tabId] = setTimeout(() => {
    delete toastTimers[tabId];
    const playable = entry.streams
      .filter((s) => s.kind !== 'segment')
      .sort((a, b) => (KIND_RANK[a.kind] ?? 8) - (KIND_RANK[b.kind] ?? 8));
    if (!playable.length) return;
    entry.toasted = true;
    scheduleFlush();
    chrome.tabs
      .sendMessage(tabId, { type: 'STREAM_TOAST', stream: playable[0], count: playable.length }, { frameId: 0 })
      .catch(() => {
        // No content script here (chrome://, PDF viewer, a frame that died) -
        // the badge still tells the story, so this is not worth reporting.
      });
  }, 1200);
}

function playableCount(entry) {
  return entry.streams.filter((s) => s.kind !== 'segment').length;
}

function paintBadge(tabId, entry) {
  const n = playableCount(entry);
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#c0392b' }).catch(() => {});
}

async function clearTab(tabId, pageUrl) {
  await hydrate();
  clearTimeout(toastTimers[tabId]);
  delete toastTimers[tabId];
  cache[tabId] = { pageUrl: pageUrl || '', streams: [], toasted: false };
  scheduleFlush();
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

// ------------------------------------------------------------- webRequest

const REQUEST_FILTER = {
  urls: ['http://*/*', 'https://*/*'],
  types: ['media', 'xmlhttprequest', 'object', 'other']
};

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const kind = classify(details.url, null);
    if (!kind) return;
    addStreams(details.tabId, [
      {
        url: details.url,
        kind,
        source: 'network',
        frameUrl: details.initiator || '',
        ts: details.timeStamp
      }
    ]);
  },
  REQUEST_FILTER
);

// Catches manifests served without a telltale extension.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const header = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === 'content-type'
    );
    const contentType = header ? header.value : '';
    const kind = classify(details.url, contentType);
    if (!kind) return;
    addStreams(details.tabId, [
      {
        url: details.url,
        kind,
        source: 'network',
        contentType,
        frameUrl: details.initiator || '',
        ts: details.timeStamp
      }
    ]);
  },
  REQUEST_FILTER,
  ['responseHeaders']
);

// A top-frame navigation means a new page - start its list over.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  clearTab(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await hydrate();
  delete cache[tabId];
  scheduleFlush();
  removeRefererRule(tabId);
});

// ------------------------------------------------- referer spoofing (DNR)

/**
 * Hotlink-protected CDNs reject requests that don't carry the embed's Referer.
 * Requests from the player tab get one pinned on via a session DNR rule.
 */
// DNR rule ids must be >= 1, and a tabId can legitimately be 0.
function ruleIdFor(tabId) {
  return tabId + 1;
}

async function addRefererRule(tabId, referer) {
  if (!referer) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleIdFor(tabId)],
      addRules: [
        {
          id: ruleIdFor(tabId),
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'referer', operation: 'set', value: referer }]
          },
          condition: { tabIds: [tabId], resourceTypes: ['xmlhttprequest', 'media', 'other'] }
        }
      ]
    });
  } catch (e) {
    console.warn('[stream-extractor] could not set referer rule:', e);
  }
}

function removeRefererRule(tabId) {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleIdFor(tabId)] }).catch(() => {});
}

function originOf(url) {
  try {
    return new URL(url).origin + '/';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ADD_STREAMS') {
    const tabId = sender.tab ? sender.tab.id : null;
    addStreams(tabId, msg.streams || []).then((n) => sendResponse({ added: n }));
    return true;
  }

  if (msg.type === 'GET_STREAMS') {
    hydrate().then(() => {
      const entry = cache[msg.tabId] || { pageUrl: '', streams: [] };
      const streams = entry.streams
        .slice()
        .sort((a, b) => (KIND_RANK[a.kind] ?? 8) - (KIND_RANK[b.kind] ?? 8));
      sendResponse({ pageUrl: entry.pageUrl, streams });
    });
    return true;
  }

  if (msg.type === 'CLEAR') {
    clearTab(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'OPEN_PLAYER') {
    const referer = msg.referer || originOf(msg.pageUrl || msg.url);
    const query = new URLSearchParams({
      src: msg.url,
      kind: msg.kind || '',
      ref: referer,
      // Where it came from, so library entries can be traced back to a site.
      page: msg.tabUrl || msg.pageUrl || '',
      title: msg.tabTitle || ''
    });
    if (msg.autoDownload) query.set('dl', '1');

    const url = chrome.runtime.getURL('src/player.html?' + query.toString());
    chrome.tabs.create({ url }).then(async (tab) => {
      await addRefererRule(tab.id, referer);
      sendResponse({ tabId: tab.id });
    });
    return true;
  }

  if (msg.type === 'OPEN_LIBRARY') {
    const url = chrome.runtime.getURL('src/library.html');
    // Reuse an already-open library tab rather than stacking duplicates.
    chrome.tabs.query({ url }).then((tabs) => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.tabs.reload(tabs[0].id);
      } else {
        chrome.tabs.create({ url });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'OPEN_RAW') {
    chrome.tabs.create({ url: msg.url }).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
