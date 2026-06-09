// content-bridge.js — runs inside the DIAMOND:CONTEXT page.
//
// Two jobs:
//   1. Tell the page the extension is installed, so the Watch tab can swap
//      its "install the extension" notice for the live controls. Content
//      scripts run in an isolated world, so we signal the page through a
//      DOM attribute it can read.
//   2. Relay the page's "watch this game" request (sent via postMessage,
//      which crosses the isolated-world boundary) to the service worker.

(function () {
  // <html> exists at document_start; the Watch tab reads this later.
  document.documentElement.dataset.dcWatchExt = "1";

  // Safe send: when the extension is reloaded, this content script keeps
  // running in the already-open page but its connection is dead ("Extension
  // context invalidated"). The page heartbeats every 600ms, so without this
  // guard that throws repeatedly. Check the context is alive and swallow any
  // failure (next page refresh injects a fresh content script).
  function relay(message) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return; // context gone
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {
      /* extension reloaded / worker unavailable */
    }
  }

  // Page → worker: watch / save-position / reset-position requests.
  window.addEventListener("message", (event) => {
    // Only trust messages from this same window / our own page code.
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "diamond-context") return;

    if (msg.type === "DC_WATCH") {
      relay({
        type: "DC_WATCH",
        gamePk: msg.gamePk,
        away: msg.away,
        home: msg.home,
        date: msg.date,
        watchUrl: msg.watchUrl, // when set (test mode), overrides the deep link
        rect: msg.rect, // exact screen rect to float the video above the field
      });
    } else if (msg.type === "DC_SAVE_WATCH_POS") {
      relay({ type: "DC_SAVE_WATCH_POS" });
    } else if (msg.type === "DC_GET_WATCH_POS") {
      relay({ type: "DC_GET_WATCH_POS" });
    } else if (msg.type === "DC_CLOSE_WATCH") {
      relay({ type: "DC_CLOSE_WATCH" });
    } else if (msg.type === "DC_PLACE_PIP") {
      relay({ type: "DC_PLACE_PIP", rect: msg.rect });
    } else if (msg.type === "DC_RESET_WATCH_POS") {
      relay({ type: "DC_RESET_WATCH_POS" });
    }
  });

  // Worker → page: surface a one-time "sign in to MLB.tv" prompt. Tagged
  // "diamond-context-ext" so it can't be confused with the page's own
  // outgoing "diamond-context" messages above.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "DC_LOGIN_REQUIRED") {
      window.postMessage(
        { source: "diamond-context-ext", type: "DC_LOGIN_REQUIRED" },
        "*"
      );
    } else if (msg?.type === "DC_WATCH_POS_SAVED") {
      window.postMessage(
        { source: "diamond-context-ext", type: "DC_WATCH_POS_SAVED", ok: !!msg.ok, bounds: msg.bounds || null },
        "*"
      );
    } else if (msg?.type === "DC_WATCH_POS_STATE") {
      window.postMessage(
        { source: "diamond-context-ext", type: "DC_WATCH_POS_STATE", bounds: msg.bounds || null },
        "*"
      );
    } else if (msg?.type === "DC_WATCH_POS_RESET") {
      window.postMessage(
        { source: "diamond-context-ext", type: "DC_WATCH_POS_RESET", ok: !!msg.ok },
        "*"
      );
    }
  });
})();
