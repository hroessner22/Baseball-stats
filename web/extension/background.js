// background.js — the service worker.
//
// Watch → open MLB.tv as a TAB right next to the DIAMOND:CONTEXT tab (same
// window). Reuse that one tab on later watches; close it when you exit. If you
// click the blue PiP button in that tab, we bring D:C back to the front so the
// floating player sits over it, and (while you're on D:C) the page + Hammerspoon
// helper snap the PiP window into the box above the field.

function mlbTvUrl(gamePk) {
  return `https://www.mlb.com/tv/g${gamePk}`;
}

const pending = new Map();   // mlbTabId -> watch intent (until DC_MLB_READY)
const originTab = new Map(); // mlbTabId -> the DIAMOND:CONTEXT tab that asked
let watchTabId = null;       // the single reused MLB.tv tab

// Send to a tab, consuming the "Receiving end does not exist" lastError that
// Chrome logs when the tab has no content script (e.g. it was closed).
function tabSend(tabId, message) {
  try {
    chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError);
  } catch (_) {
    /* tab gone */
  }
}

function openWatch(msg, sender) {
  const url = msg.watchUrl || mlbTvUrl(msg.gamePk);
  const dcTabId = sender.tab && sender.tab.id;
  const dcWindowId = sender.tab && sender.tab.windowId;
  const index = ((sender.tab && sender.tab.index) ?? -1) + 1; // right next to D:C

  const track = (tab) => {
    if (!tab) return;
    watchTabId = tab.id;
    pending.set(tab.id, msg);
    if (dcTabId != null) originTab.set(tab.id, dcTabId);
  };

  const createNew = () =>
    chrome.tabs.create({ windowId: dcWindowId, index, url, active: true }, (tab) => {
      void chrome.runtime.lastError;
      track(tab);
    });

  // Reuse the existing MLB.tv tab if it's still open; otherwise open one.
  if (watchTabId != null) {
    chrome.tabs.update(watchTabId, { url, active: true }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        watchTabId = null;
        createNew();
      } else {
        track(tab);
      }
    });
  } else {
    createNew();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "DC_WATCH") {
    openWatch(msg, sender);
    sendResponse?.({ ok: true });
    return true;
  }

  // Exit theater → close the MLB.tv tab.
  if (msg?.type === "DC_CLOSE_WATCH") {
    if (watchTabId != null) {
      chrome.tabs.remove(watchTabId, () => void chrome.runtime.lastError);
      watchTabId = null;
    }
    sendResponse?.({ ok: true });
    return true;
  }

  // PiP engaged in the MLB tab → bring D:C to the front so the floating player
  // sits over it.
  if (msg?.type === "DC_PIP_ON" && sender.tab) {
    const dcTabId = originTab.get(sender.tab.id);
    if (dcTabId != null) {
      chrome.tabs.update(dcTabId, { active: true }, () => void chrome.runtime.lastError);
    }
    return;
  }

  // While you're on D:C, heartbeat the box above the field → Hammerspoon snaps
  // Chrome's PiP window there. (The page can't reach http://localhost itself.)
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
      tabSend(sender.tab.id, { type: "DC_ENTER_PIP", ...intent });
      pending.delete(sender.tab.id);
    }
  }

  if (msg?.type === "DC_LOGIN_REQUIRED" && sender.tab) {
    const origin = originTab.get(sender.tab.id);
    if (origin != null) tabSend(origin, { type: "DC_LOGIN_REQUIRED" });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pending.delete(tabId);
  originTab.delete(tabId);
  if (tabId === watchTabId) watchTabId = null;
});
