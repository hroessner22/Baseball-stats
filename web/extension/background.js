// background.js — the service worker.
//
// Receives a "watch this game" request from DIAMOND:CONTEXT and opens MLB.tv
// in its own popup window. The Hammerspoon helper then places that window
// into the theater area over D:C — no picture-in-picture, no click needed.

// MLB.tv deep link for a gamePk. MLB changes this path occasionally; the
// in-page script falls back to the listing, so a stale URL degrades to "open
// the listing" rather than a hard break.
function mlbTvUrl(gamePk) {
  return `https://www.mlb.com/tv/g${gamePk}`;
}

const pending = new Map();   // mlbTabId -> watch intent (until DC_MLB_READY)
const originTab = new Map(); // mlbTabId -> the DIAMOND:CONTEXT tab that asked

// One reused MLB.tv window — never stack multiple (stacking holds multiple
// stream slots and trips MLB.tv's concurrent-stream cap, "content not available").
let watchWindowId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "DC_WATCH") {
    const origin = sender.tab?.id;
    const url = msg.watchUrl || mlbTvUrl(msg.gamePk);

    const open = () => {
      chrome.windows
        .create({ url, type: "popup", width: 820, height: 500, focused: true })
        .then((win) => {
          watchWindowId = win.id;
          const tab = win.tabs && win.tabs[0];
          if (tab) {
            pending.set(tab.id, msg);
            if (origin != null) originTab.set(tab.id, origin);
          }
        });
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
