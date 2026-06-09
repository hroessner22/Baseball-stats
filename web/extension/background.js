// background.js — the service worker.
//
// Receives a "watch this game" request from DIAMOND:CONTEXT, opens MLB.tv,
// starts playback, then switches focus back to D:C so the now-hidden MLB tab
// auto-pops into picture-in-picture (via the Media Session handler that
// content-mlb.js registers). Falls back to the one-tap overlay if Chrome's
// auto-PiP doesn't fire.

// MLB.tv deep link for a gamePk. MLB changes this path from time to time; the
// in-page script falls back to finding the game in the listing, so a stale URL
// degrades to "open the listing" rather than a hard break.
function mlbTvUrl(gamePk) {
  return `https://www.mlb.com/tv/g${gamePk}`;
}

const pending = new Map();   // mlbTabId -> watch intent (until DC_MLB_READY)
const originTab = new Map(); // mlbTabId -> the DIAMOND:CONTEXT tab that asked

// One reused MLB.tv tab — never stack multiple (stacking holds multiple stream
// slots and trips MLB.tv's concurrent-stream cap, "content not available").
let mlbTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "DC_WATCH") {
    const origin = sender.tab?.id;
    const winId = sender.tab?.windowId;
    const url = msg.watchUrl || mlbTvUrl(msg.gamePk);

    const remember = (tabId) => {
      mlbTabId = tabId;
      pending.set(tabId, msg);
      if (origin != null) originTab.set(tabId, origin);
    };

    if (mlbTabId != null) {
      // Reuse the existing MLB tab (one stream only).
      chrome.tabs.update(mlbTabId, { url, active: true }).then(
        (t) => remember(t.id),
        () => chrome.tabs.create({ url, active: true, windowId: winId }).then((t) => remember(t.id))
      );
    } else {
      chrome.tabs.create({ url, active: true, windowId: winId }).then((t) => remember(t.id));
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

  // Feed is playing — switch focus back to DIAMOND:CONTEXT. That hides the MLB
  // tab, which triggers Chrome's automatic PiP (the Media Session handler).
  if (msg?.type === "DC_PLAYING" && sender.tab) {
    const origin = originTab.get(sender.tab.id);
    if (origin != null) {
      chrome.tabs.update(origin, { active: true }).catch(() => {});
    }
  }

  // Auto-PiP didn't engage after the tab was hidden — bring the MLB tab back
  // so the one-tap overlay is visible (graceful fallback).
  if (msg?.type === "DC_PIP_FAILED" && sender.tab) {
    chrome.tabs.update(sender.tab.id, { active: true }).catch(() => {});
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
  if (tabId === mlbTabId) mlbTabId = null;
});
