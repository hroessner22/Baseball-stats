// background.js — the service worker.
//
// On a Watch click, open MLB.tv in a popup window placed EXACTLY into the gap
// directly above the field. The DIAMOND:CONTEXT page measures that gap itself
// (it knows precisely where the field sits) and sends the target rect in the
// DC_WATCH message, so the window lands over the field column — clear of the
// left cards and the right stats panel — with no picture-in-picture and no
// manual adjusting. We re-apply the bounds a few times after creation because
// Chrome occasionally ignores create-time bounds for popups.

function mlbTvUrl(gamePk) {
  return `https://www.mlb.com/tv/g${gamePk}`;
}

// Fallback only — used when the page couldn't measure a rect (e.g. not on a
// game's live view). Fractions of the D:C window, above the field column.
const VID_WIDTH_FRAC = 0.34;
const VID_CENTER_FRAC = 0.38;
const TOP_OFFSET = 200;
const TITLEBAR = 28;

function fallbackRect(dc) {
  const w = Math.round(dc.width * VID_WIDTH_FRAC);
  const h = Math.round((w * 9) / 16) + TITLEBAR;
  let left = Math.round(dc.left + dc.width * VID_CENTER_FRAC - w / 2);
  if (left < dc.left + 8) left = dc.left + 8;
  return { left, top: Math.round(dc.top + TOP_OFFSET), width: w, height: h };
}

const pending = new Map();   // mlbTabId -> watch intent (until DC_MLB_READY)
const originTab = new Map(); // mlbTabId -> the DIAMOND:CONTEXT tab that asked

// One reused MLB.tv window — never stack multiple (stacking holds multiple
// stream slots and trips MLB.tv's concurrent-stream cap, "content not available").
let watchWindowId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "DC_WATCH") {
    const origin = sender.tab?.id;
    const dcWindowId = sender.tab?.windowId;
    const url = msg.watchUrl || mlbTvUrl(msg.gamePk);

    const create = (bounds) => {
      chrome.windows
        .create({ url, type: "popup", focused: true, ...bounds })
        .then((win) => {
          watchWindowId = win.id;
          const tab = win.tabs && win.tabs[0];
          if (tab) {
            pending.set(tab.id, msg);
            if (origin != null) originTab.set(tab.id, origin);
          }
          // Re-apply the bounds: Chrome sometimes ignores create-time bounds
          // for popups, and the page-measured rect is the source of truth.
          const reapply = () =>
            chrome.windows.update(win.id, {
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            });
          setTimeout(reapply, 300);
          setTimeout(reapply, 1000);
          setTimeout(reapply, 2000);
        });
    };

    const open = () => {
      // Prefer the exact rect the page measured (directly above the field).
      if (msg.rect && msg.rect.width) {
        create(msg.rect);
      } else if (dcWindowId != null) {
        chrome.windows.get(dcWindowId, (dc) => {
          create(dc ? fallbackRect(dc) : { width: 520, height: 320 });
        });
      } else {
        create({ width: 520, height: 320 });
      }
    };

    // Reuse the single watch window: close the old one first.
    if (watchWindowId != null) {
      const old = watchWindowId;
      watchWindowId = null;
      chrome.windows.remove(old).then(open, open);
    } else {
      open();
    }
    sendResponse?.({ ok: true });
    return true;
  }

  if (msg?.type === "DC_MLB_READY" && sender.tab) {
    const intent = pending.get(sender.tab.id);
    if (intent) {
      chrome.tabs.sendMessage(sender.tab.id, { type: "DC_ENTER_PIP", ...intent });
      pending.delete(sender.tab.id);
    }
  }

  if (msg?.type === "DC_LOGIN_REQUIRED" && sender.tab) {
    const origin = originTab.get(sender.tab.id);
    if (origin != null) {
      chrome.tabs.sendMessage(origin, { type: "DC_LOGIN_REQUIRED" });
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pending.delete(tabId);
  originTab.delete(tabId);
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === watchWindowId) watchWindowId = null;
});
