/**
 * The in-page "stream detected" prompt.
 *
 * Rendered into a shadow root so no page stylesheet can reach it, and only
 * ever in the top frame - an embed iframe finding its own stream shouldn't
 * paint a second toast over the first.
 */

const TOAST_HOST_ID = 'stream-extractor-toast-host';

let toastHost = null;
let toastRoot = null;
let hideTimer = null;
let latest = null;

const TOAST_CSS = `
  :host { all: initial; }
  .card {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 2147483647;
    width: 310px;
    box-sizing: border-box;
    padding: 13px 14px;
    border-radius: 12px;
    background: #17171b;
    border: 1px solid #34343d;
    box-shadow: 0 8px 30px rgba(0,0,0,.45);
    color: #ececee;
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    animation: slide .22s cubic-bezier(.2,.8,.3,1);
  }
  @keyframes slide { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  .card.leaving { opacity: 0; transform: translateY(10px); transition: opacity .18s ease, transform .18s ease; }
  @media (prefers-reduced-motion: reduce) {
    .card, .card.leaving { animation: none; transition: none; }
  }
  .top { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
  .kind {
    font-size: 9.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
    padding: 2.5px 6px; border-radius: 4px; background: #d63b2c; color: #fff;
  }
  .title { font-weight: 600; font-size: 13px; }
  .close {
    margin-left: auto; background: none; border: 0; color: #85858f; cursor: pointer;
    font-size: 15px; line-height: 1; padding: 2px 4px; border-radius: 4px; font-family: inherit;
  }
  .close:hover { color: #ececee; background: #26262d; }
  .sub {
    font-size: 11.5px; color: #9797a1; margin-bottom: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .row { display: flex; gap: 6px; }
  button.act {
    flex: 1; font: inherit; font-size: 12px; font-weight: 500; padding: 7px 10px;
    border-radius: 7px; cursor: pointer; border: 1px solid #3d3d46;
    background: #212127; color: #ececee; transition: background .14s ease;
  }
  button.act:hover { background: #2b2b33; }
  button.act.primary { background: #d63b2c; border-color: #d63b2c; color: #fff; font-weight: 600; }
  button.act.primary:hover { background: #e6472f; }
  button.act:focus-visible, .close:focus-visible { outline: 2px solid #5b9dff; outline-offset: 2px; }
  .mute {
    display: block; margin-top: 9px; background: none; border: 0; padding: 0;
    color: #6d6d78; font: inherit; font-size: 10.5px; cursor: pointer; text-decoration: underline;
  }
  .mute:hover { color: #9797a1; }
`;

function buildToast() {
  toastHost = document.createElement('div');
  toastHost.id = TOAST_HOST_ID;
  toastRoot = toastHost.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = TOAST_CSS;

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="top">
      <span class="kind" data-kind></span>
      <span class="title" data-title>Stream detected</span>
      <button class="close" data-close title="Dismiss" aria-label="Dismiss">✕</button>
    </div>
    <div class="sub" data-sub></div>
    <div class="row">
      <button class="act primary" data-play>▶ Play</button>
      <button class="act" data-download>⬇ Download</button>
    </div>
    <button class="mute" data-mute>Don't show this again</button>
  `;

  card.querySelector('[data-close]').addEventListener('click', hideToast);
  card.querySelector('[data-play]').addEventListener('click', () => openLatest(false));
  card.querySelector('[data-download]').addEventListener('click', () => openLatest(true));
  card.querySelector('[data-mute]').addEventListener('click', async () => {
    await chrome.storage.local.set({ notifyOnDetect: false });
    hideToast();
  });

  // Don't yank it away while it's being read.
  card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  card.addEventListener('mouseleave', scheduleHide);

  toastRoot.append(style, card);
  (document.body || document.documentElement).append(toastHost);
  return card;
}

function openLatest(autoDownload) {
  if (!latest) return;
  chrome.runtime.sendMessage({
    type: 'OPEN_PLAYER',
    url: latest.url,
    kind: latest.kind,
    pageUrl: location.href,
    tabUrl: location.href,
    tabTitle: document.title,
    autoDownload
  });
  hideToast();
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideToast, 9000);
}

function hideToast() {
  clearTimeout(hideTimer);
  if (!toastHost) return;
  const card = toastRoot.querySelector('.card');
  if (card) card.classList.add('leaving');
  const host = toastHost;
  toastHost = null;
  toastRoot = null;
  setTimeout(() => host.remove(), 200);
}

async function showToast(stream, count) {
  if (window.top !== window) return;
  const prefs = await chrome.storage.local.get('notifyOnDetect');
  if (prefs.notifyOnDetect === false) return;

  latest = stream;
  const card = toastHost ? toastRoot.querySelector('.card') : buildToast();

  card.querySelector('[data-kind]').textContent = stream.kind;
  card.querySelector('[data-title]').textContent =
    count > 1 ? `${count} streams detected` : 'Stream detected';

  let host = '';
  try { host = new URL(stream.url).host; } catch { /* leave blank */ }
  card.querySelector('[data-sub]').textContent =
    host + (count > 1 ? ` · showing the best of ${count}` : '');

  scheduleHide();
}
