// content-mlb.js — runs on mlb.com.
//
// On an MLB.tv page it puts a big blue "Pop into Picture-in-Picture" button on
// screen (always — it doesn't wait for a video to appear). One click pops the
// game into PiP; D:C comes back to the front and the PiP snaps into the box
// above the field. Also makes sure the right game is playing and handles a
// signed-out session.

(function () {
  // Safe send — ignore "Extension context invalidated" after an extension reload.
  function safeSend(message) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {}
  }

  // Announce we're loaded so the worker hands us the watch intent.
  safeSend({ type: "DC_MLB_READY" });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "DC_ENTER_PIP") startWatch(msg);
  });

  // Show the PiP button IMMEDIATELY on any MLB.tv page — never gate it on a
  // video being detected (pre-game / MLB.TV HOME pages may not have one yet).
  // The button finds the playing video when you click it.
  if (/\/tv\b/.test(location.pathname)) showPipButton();

  async function startWatch(intent) {
    showPipButton(); // make sure the button is up no matter what
    // If the deep link missed and we're on a listing, click into the game.
    await maybeClickIntoGame(intent);

    const video = await waitForVideo();
    if (!video) {
      // No player showed up. If the MLB.tv session is signed out, prompt
      // DIAMOND:CONTEXT and send this tab to MLB's login so the user can sign
      // in — then re-click Watch. We never handle the password.
      if (looksLoggedOut()) {
        safeSend({ type: "DC_LOGIN_REQUIRED" });
        if (!/\/login/i.test(location.href)) {
          location.href = "https://www.mlb.com/login";
        }
      }
      return;
    }

    wirePip(video);
    await tryPlay(video);
  }

  // The big blue PiP button. Picture-in-Picture needs ONE user click in this
  // tab (a hard browser rule — it can't be started from code), so this button
  // IS that click: tap it → the game pops into PiP → D:C comes forward and the
  // PiP snaps into the box above the field.
  let pipBtn = null;

  function removePipButton() {
    if (pipBtn) { pipBtn.remove(); pipBtn = null; }
  }

  // Wire a video so entering PiP brings D:C forward, and closing PiP restores
  // the button. Idempotent per element.
  function wirePip(video) {
    if (!video || video.__dcPipWired) return;
    video.__dcPipWired = true;
    try { video.disablePictureInPicture = false; } catch (_) {}
    try { video.autoPictureInPicture = true; } catch (_) {}
    video.addEventListener("enterpictureinpicture", () => {
      removePipButton();
      safeSend({ type: "DC_PIP_ON" });
    });
    video.addEventListener("leavepictureinpicture", () => showPipButton());
  }

  function showPipButton() {
    if (pipBtn) return;
    pipBtn = document.createElement("button");
    pipBtn.textContent = "▶ Pop into Picture-in-Picture";
    pipBtn.style.cssText = [
      "position:fixed", "top:12px", "left:50%", "transform:translateX(-50%)",
      "z-index:2147483647", "padding:16px 26px", "font:700 17px system-ui,sans-serif",
      "color:#fff", "background:#1a73e8", "border:0", "border-radius:999px",
      "box-shadow:0 8px 28px rgba(0,0,0,.55)", "cursor:pointer",
    ].join(";");
    pipBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const v = pickVideo();
      if (!v) {
        pipBtn.textContent = "Press play, then tap here";
        return;
      }
      wirePip(v);
      try {
        try { v.disablePictureInPicture = false; } catch (_) {}
        if (v.paused) { try { await v.play(); } catch (_) {} }
        await v.requestPictureInPicture();
      } catch (_) {
        pipBtn.textContent = "Click the video first, then tap here";
      }
    });
    (document.body || document.documentElement).appendChild(pipBtn);
  }

  // Largest visible <video> on the page is the game feed.
  function pickVideo() {
    const vids = [...document.querySelectorAll("video")].filter(
      (v) => v.offsetWidth > 200
    );
    vids.sort(
      (a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight
    );
    return vids[0] || null;
  }

  function waitForVideo(timeoutMs = 20000) {
    return new Promise((resolve) => {
      const now = pickVideo();
      if (now) return resolve(now);
      const started = Date.now();
      const iv = setInterval(() => {
        const v = pickVideo();
        if (v || Date.now() - started > timeoutMs) {
          clearInterval(iv);
          resolve(v || null);
        }
      }, 500);
    });
  }

  async function tryPlay(video) {
    try {
      await video.play();
      return;
    } catch (_) {
      /* autoplay blocked — click the player's play button instead */
    }
    const btn = document.querySelector(
      '[aria-label*="play" i], button[title*="play" i], .bmpui-ui-playbacktogglebutton'
    );
    if (btn) btn.click();
  }

  // Did we land on a signed-out / paywall page rather than the player?
  // A signed-IN page carries account chrome ("Log out" / "Account Settings" /
  // "Manage Subscriptions") — if present, never treat as logged out. Else fall
  // back to login-URL / password field / "sign in / not available" copy.
  function looksLoggedOut() {
    const txt = (document.body?.innerText || "").toLowerCase();
    if (/log ?out|account settings|manage subscriptions/.test(txt)) return false;

    const url = location.href.toLowerCase();
    if (/\/login|\/account\/login|signin|sign-in/.test(url)) return true;
    if (document.querySelector('input[type="password"]')) return true;
    return /(log|sign) ?in|authenticate|already a subscriber|all packages|subscribe|content you requested is not available/.test(
      txt
    );
  }

  // Listing-page fallback: find a card mentioning the matchup and click its
  // watch link. Loose on purpose — MLB's markup shifts and we pass team
  // abbreviations (e.g. "NYY"), so matching is best-effort.
  async function maybeClickIntoGame(intent) {
    if (pickVideo()) return; // already on the player
    const wanted = [intent?.away, intent?.home]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    if (!wanted.length) return;

    const hit = [...document.querySelectorAll("a[href]")].find((a) => {
      const text = (a.textContent || "").toLowerCase();
      const href = a.getAttribute("href") || "";
      const looksLikeWatch = href.includes("/tv/") || text.includes("watch");
      return looksLikeWatch && wanted.some((w) => text.includes(w));
    });
    if (hit) {
      hit.click();
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
})();
