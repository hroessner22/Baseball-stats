// background.js — the service worker.
//
// Receives a "watch this game" request from the DIAMOND:CONTEXT page,
// opens the game on MLB.tv, and once the player page reports in, tells it
// to start playback and float into picture-in-picture.

// MLB.tv deep link for a gamePk. MLB changes this path from time to time;
// if it stops landing on the player, update it here. It degrades safely:
// the in-page script (content-mlb.js) falls back to finding the game in
// the MLB.tv listing by team name, so a stale URL means "open the listing"
// rather than a hard break.
function mlbTvUrl(gamePk) {
  return `https://www.mlb.com/tv/g${gamePk}`;
}

// mlbTabId -> the watch intent, held until that tab's content script reports
// it has loaded (DC_MLB_READY). We only auto-play + auto-PiP on tabs we
// opened for a watch request, never on tabs the user opened themselves.
const pending = new Map();

// mlbTabId -> the DIAMOND:CONTEXT tab that asked for this game. Kept for the
// life of the MLB tab so we can route a "you're signed out" prompt back to
// the app where the user is looking.
const originTab = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "DC_WATCH") {
    const origin = sender.tab?.id;
    chrome.tabs.create({ url: mlbTvUrl(msg.gamePk), active: true }).then((tab) => {
      pending.set(tab.id, msg);
      if (origin != null) originTab.set(tab.id, origin);
    });
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
