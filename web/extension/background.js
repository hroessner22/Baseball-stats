// background.js — the service worker.
//
// On a Watch click, open MLB.tv in a popup window ALREADY sized and positioned
// into the theater area over DIAMOND:CONTEXT — computed from the D:C window's
// own bounds, so it appears correct instantly (no snap, no manual adjust, no
// picture-in-picture). Hammerspoon is no longer needed to move it.

// ── Theater placement (fractions of the D:C window) — tweak to taste ──
const VID_WIDTH_FRAC = 0.52;   // video window width ÷ D:C window width
const VID_CENTER_FRAC = 0.32;  // horizontal center (~the live-view/field column)
const TOP_OFFSET = 250;        // px below the D:C window's top (clears chrome + header + tabs)
const TITLEBAR = 96;           // popup title bar + player chrome added to 16:9 height

function mlbTvUrl(gamePk) {
  return `https://www.mlb.com/tv/g${gamePk}`;
}

// Compute the popup's screen rect from the D:C window's bounds.
function theaterRect(dc) {
  const w = Math.round(dc.width * VID_WIDTH_FRAC);
  const h = Math.round((w * 9) / 16) + TITLEBAR;
  let left = Math.round(dc.left + dc.width * VID_CENTER_FRAC - w / 2);
  if (left < dc.left + 8) left = dc.left + 8; // keep it on-screen
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

    const open = () => {
      // Position relative to the D:C window so it lands in the theater area.
      const create = (rect) => {
        chrome.windows
          .create({ url, type: "popup", focused: true, ...rect })
          .then((win) => {
            watchWindowId = win.id;
            const tab = win.tabs && win.tabs[0];
            if (tab) {
              pending.set(tab.id, msg);
              if (origin != null) originTab.set(tab.id, origin);
            }
          });
      };
      if (dcWindowId != null) {
        chrome.windows.get(dcWindowId, (dc) => {
          create(dc ? theaterRect(dc) : { width: 820, height: 500 });
        });
      } else {
        create({ width: 820, height: 500 });
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
