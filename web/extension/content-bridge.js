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

  // Page → worker: a "watch this game" request.
  window.addEventListener("message", (event) => {
    // Only trust messages from this same window / our own page code.
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "diamond-context" || msg.type !== "DC_WATCH") return;

    chrome.runtime.sendMessage({
      type: "DC_WATCH",
      gamePk: msg.gamePk,
      away: msg.away,
      home: msg.home,
      date: msg.date,
      watchUrl: msg.watchUrl, // when set (test mode), overrides the deep link
      rect: msg.rect, // exact screen rect to float the video above the field
    });
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
    }
  });
})();
