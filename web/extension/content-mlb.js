// content-mlb.js — runs on mlb.com.
//
// When DIAMOND:CONTEXT asks to watch a game, make sure the right game is
// playing. That's it — no picture-in-picture. The MLB.tv window itself is
// placed into D:C's theater area by the Hammerspoon helper, which needs no
// user gesture, so the whole flow is automatic on the Watch click.

(function () {
  // Announce we're loaded so the worker hands us the watch intent.
  chrome.runtime.sendMessage({ type: "DC_MLB_READY" });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "DC_ENTER_PIP") startWatch(msg);
  });

  async function startWatch(intent) {
    // If the deep link missed and we're on a listing, click into the game.
    await maybeClickIntoGame(intent);

    const video = await waitForVideo();
    if (!video) {
      // No player showed up. If the MLB.tv session is signed out, prompt
      // DIAMOND:CONTEXT and send this window to MLB's login so the user can
      // sign in — then re-click Watch. We never handle the password.
      if (looksLoggedOut()) {
        chrome.runtime.sendMessage({ type: "DC_LOGIN_REQUIRED" });
        if (!/\/login/i.test(location.href)) {
          location.href = "https://www.mlb.com/login";
        }
      }
      return;
    }

    await tryPlay(video);
    enablePip(video);
  }

  // Picture-in-Picture needs ONE user click in this tab (a hard browser rule —
  // it can't be started programmatically). So we drop a big, unmissable button
  // on top of the MLB.tv window: one click pops the game into PiP, then this
  // bare window minimizes and DIAMOND:CONTEXT + Hammerspoon snap the PiP window
  // into the box above the field.
  let pipBtn = null;

  function removePipButton() {
    if (pipBtn) { pipBtn.remove(); pipBtn = null; }
  }

  function showPipButton(video) {
    if (pipBtn || document.pictureInPictureElement === video) return;
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
      // Re-find the active video at click time — the player may have swapped
      // elements (ads → game) since the button appeared.
      const v = pickVideo() || video;
      try {
        try { v.disablePictureInPicture = false; } catch (_) {}
        if (v.paused) { try { await v.play(); } catch (_) {} }
        await v.requestPictureInPicture();
      } catch (_) {
        pipBtn.textContent = "Click the video first, then tap here";
      }
    });
    document.documentElement.appendChild(pipBtn);
  }

  function enablePip(video) {
    if (!("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled) return;
    try { video.disablePictureInPicture = false; } catch (_) {}
    try { video.autoPictureInPicture = true; } catch (_) {}

    // Once it's floating, minimize this bare window; if the user closes PiP,
    // bring the button back.
    video.addEventListener("enterpictureinpicture", () => {
      removePipButton();
      chrome.runtime.sendMessage({ type: "DC_PIP_ON" });
    });
    video.addEventListener("leavepictureinpicture", () => showPipButton(video));

    showPipButton(video);
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
