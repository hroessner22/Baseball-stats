// background.js — the service worker.
//
// On a Watch click, open MLB.tv in a popup window placed where the user wants
// it. The user drags/resizes that window once and clicks "Save video spot" in
// DIAMOND:CONTEXT; we read the window's actual bounds and store them. Every
// later watch reopens the window at those saved bounds.
//
// Placement priority for each watch:
//   1. saved bounds  (chrome.storage.local "dcWatchBounds") — what the user set
//   2. msg.rect      — the rect the page measured above the field (good default)
//   3. fallback rect — fractions of the D:C window, if nothing else is known
// After creating the popup we re-apply the bounds a few times, because Chrome
// occasionally ignores create-time bounds for popups.

const BOUNDS_KEY = "dcWatchBounds";

// Placement is automatic now (the page measures the exact box above the field).
// Wipe any position saved by the old manual "save spot" flow so it can't
// override the correct automatic placement.
chrome.storage.local.remove(BOUNDS_KEY);

function mlbTvUrl(gamePk) {
  return `https://www.mlb.com/tv/g${gamePk}`;
}

// Fallback only — fractions of the D:C window, above the field column.
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

// Find the open MLB.tv window. Prefer the one we opened; if the service worker
// was torn down (losing watchWindowId), fall back to any open mlb.com window.
function findWatchWindow(cb) {
  if (watchWindowId != null) {
    chrome.windows.get(watchWindowId, { populate: false }, (w) => {
      if (!chrome.runtime.lastError && w) return cb(w);
      watchWindowId = null;
      findWatchWindow(cb);
    });
    return;
  }
  chrome.tabs.query({ url: ["*://*.mlb.com/*", "*://*.mlb.tv/*"] }, (tabs) => {
    if (tabs && tabs.length) {
      watchWindowId = tabs[0].windowId;
      chrome.windows.get(watchWindowId, (w) => cb(w || null));
    } else {
      cb(null);
    }
  });
}

function openWatch(msg, origin, dcWindowId) {
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
        if (bounds && bounds.width) {
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
        }
      });
  };

  // Placement is automatic: the page measures the exact box above the field
  // and sends it as msg.rect — that's authoritative. Fall back to a fraction
  // of the D:C window only if no rect arrived.
  if (msg.rect && msg.rect.width) {
    create(msg.rect);
  } else if (dcWindowId != null) {
    chrome.windows.get(dcWindowId, (dc) => {
      create(dc ? fallbackRect(dc) : { width: 520, height: 320 });
    });
  } else {
    create({ width: 520, height: 320 });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "DC_WATCH") {
    const origin = sender.tab?.id;
    const dcWindowId = sender.tab?.windowId;
    const go = () => openWatch(msg, origin, dcWindowId);

    // Reuse the single watch window: close the old one first.
    if (watchWindowId != null) {
      const old = watchWindowId;
      watchWindowId = null;
      chrome.windows.remove(old).then(go, go);
    } else {
      go();
    }
    sendResponse?.({ ok: true });
    return true;
  }

  // Save the MLB.tv window's CURRENT position/size so every future watch
  // reopens it exactly there.
  if (msg?.type === "DC_SAVE_WATCH_POS") {
    const origin = sender.tab?.id;
    findWatchWindow((win) => {
      if (!win) {
        if (origin != null)
          chrome.tabs.sendMessage(origin, { type: "DC_WATCH_POS_SAVED", ok: false });
        return;
      }
      const bounds = {
        left: win.left,
        top: win.top,
        width: win.width,
        height: win.height,
      };
      chrome.storage.local.set({ [BOUNDS_KEY]: bounds }, () => {
        if (origin != null)
          chrome.tabs.sendMessage(origin, { type: "DC_WATCH_POS_SAVED", ok: true, bounds });
      });
    });
    sendResponse?.({ ok: true });
    return true;
  }

  // Close the MLB.tv window — fired when the user exits the video player on
  // the site (Exit theater).
  if (msg?.type === "DC_CLOSE_WATCH") {
    findWatchWindow((win) => {
      if (win) {
        const p = chrome.windows.remove(win.id);
        if (p && p.catch) p.catch(() => {});
      }
      watchWindowId = null;
    });
    sendResponse?.({ ok: true });
    return true;
  }

  // Report whether a position is saved (so the page can confirm it).
  if (msg?.type === "DC_GET_WATCH_POS") {
    const origin = sender.tab?.id;
    chrome.storage.local.get(BOUNDS_KEY, (data) => {
      const saved = (data && data[BOUNDS_KEY]) || null;
      if (origin != null)
        chrome.tabs.sendMessage(origin, { type: "DC_WATCH_POS_STATE", bounds: saved });
    });
    sendResponse?.({ ok: true });
    return true;
  }

  // Forget the saved position (use the measured default again).
  if (msg?.type === "DC_RESET_WATCH_POS") {
    chrome.storage.local.remove(BOUNDS_KEY);
    const origin = sender.tab?.id;
    if (origin != null)
      chrome.tabs.sendMessage(origin, { type: "DC_WATCH_POS_RESET", ok: true });
    sendResponse?.({ ok: true });
    return true;
  }

  // The video is now floating in Picture-in-Picture (stays on top of D:C), so
  // minimize the bare MLB.tv window — only the PiP player remains visible.
  if (msg?.type === "DC_PIP_ON" && sender.tab) {
    chrome.windows.update(sender.tab.windowId, { state: "minimized" });
    return;
  }

  // The page (while you're viewing D:C) heartbeats the exact box above the
  // field; relay it to the Hammerspoon helper, which snaps Chrome's PiP window
  // there. Pages can't reach http://localhost (mixed content / https), but the
  // service worker can with host permission.
  if (msg?.type === "DC_PLACE_PIP" && msg.rect) {
    fetch("http://127.0.0.1:27894/pip", {
      method: "POST",
      body: JSON.stringify(msg.rect),
    }).catch(() => {});
    return;
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
