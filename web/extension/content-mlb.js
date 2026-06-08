// content-mlb.js — runs on mlb.com.
//
// When DIAMOND:CONTEXT asks to watch a game, make sure the right game is
// playing, then float it into picture-in-picture.
//
// On the PiP corner: web/extension APIs cannot programmatically pin a
// native PiP window to a screen corner — the OS owns its position, and
// Chrome restores wherever you last dragged it. So the reliable path here
// is `video.autoPictureInPicture`: the instant you switch back to
// DIAMOND:CONTEXT (or any other tab), Chrome floats the game out on its
// own, always-on-top and draggable. Drag it to the bottom-right once and
// Chrome remembers it there.

(function () {
  // Announce we're loaded. The worker only responds for tabs it opened in
  // answer to a watch request.
  chrome.runtime.sendMessage({ type: "DC_MLB_READY" });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "DC_ENTER_PIP") startWatch(msg);
  });

  async function startWatch(intent) {
    // If the deep link missed and we're on a listing, click into the game.
    await maybeClickIntoGame(intent);

    const video = await waitForVideo();
    if (!video) {
      // No player showed up. If it's because the MLB.tv session is signed
      // out, prompt DIAMOND:CONTEXT (the one-click toast) AND send this tab
      // to MLB's login so the user can sign in right here — then they re-click
      // Watch. We never handle the password: the user signs in themselves and
      // the browser session carries every click after that.
      if (looksLoggedOut()) {
        chrome.runtime.sendMessage({ type: "DC_LOGIN_REQUIRED" });
        if (!/\/login/i.test(location.href)) {
          location.href = "https://www.mlb.com/login";
        }
      }
      return;
    }

    await tryPlay(video);
    await enablePiP(video);
  }

  // Float the feed into picture-in-picture.
  //
  // requestPictureInPicture() requires a user gesture, and the Watch click
  // happened in the DIAMOND:CONTEXT tab (a gesture there doesn't carry to
  // this one). video.autoPictureInPicture isn't supported in this Chrome
  // either. So: try once (covers browsers/States where it's allowed), and
  // if that's blocked, show a one-tap overlay — the user's first click in
  // THIS tab is a gesture that pops PiP. After it floats out, switching back
  // to DIAMOND:CONTEXT leaves the PiP window on top; drag it to the corner
  // once and Chrome keeps it there.
  async function enablePiP(video) {
    video.autoPictureInPicture = true; // harmless where unsupported; helps Safari
    try {
      if (
        document.pictureInPictureEnabled &&
        video !== document.pictureInPictureElement
      ) {
        await video.requestPictureInPicture();
        return; // a gesture was available — done
      }
    } catch (_) {
      /* needs a gesture in this tab — fall through to the overlay */
    }
    showPiPOverlay(video);
  }

  function showPiPOverlay(video) {
    if (document.getElementById("dc-pip-overlay")) return;
    const el = document.createElement("div");
    el.id = "dc-pip-overlay";
    el.textContent = "▶ Click anywhere to watch in the corner";
    Object.assign(el.style, {
      position: "fixed",
      zIndex: "2147483647",
      left: "50%",
      top: "16px",
      transform: "translateX(-50%)",
      background: "#3B82F6",
      color: "#fff",
      font: "600 14px system-ui, sans-serif",
      padding: "10px 16px",
      borderRadius: "8px",
      boxShadow: "0 6px 20px rgba(0,0,0,.45)",
      cursor: "pointer",
      pointerEvents: "auto",
    });
    const go = async () => {
      document.removeEventListener("click", go, true);
      el.remove();
      try {
        await video.requestPictureInPicture();
      } catch (_) {}
    };
    // Capture phase so the very first click anywhere (including the MLB
    // player itself) triggers PiP before the page consumes it.
    document.addEventListener("click", go, true);
    document.body.appendChild(el);
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
  //
  // The reliable signal (verified against the live MLB.tv DOM): a signed-IN
  // page always carries account chrome — "Log out", "Account Settings",
  // "Manage Subscriptions". If any of those are present we're authenticated,
  // so never redirect to login (this guards against a slow-loading video
  // being mistaken for a logout). Otherwise fall back to the usual cues:
  // a login URL, a password field, or "sign in / not available" copy.
  function looksLoggedOut() {
    const txt = (document.body?.innerText || "").toLowerCase();
    if (/log ?out|account settings|manage subscriptions/.test(txt)) return false;

    const url = location.href.toLowerCase();
    if (/\/login|\/account\/login|signin|sign-in/.test(url)) return true;
    if (document.querySelector('input[type="password"]')) return true;
    // Signed-out / paywall copy seen on the live MLB.tv player: a sign-in or
    // "Authenticate" CTA, the "Already A Subscriber?" / Buy / All Packages
    // upsell, or the generic "content not available" error.
    return /(log|sign) ?in|authenticate|already a subscriber|all packages|subscribe|content you requested is not available/.test(
      txt
    );
  }

  // Listing-page fallback: find a card mentioning the matchup and click its
  // watch link. Selectors are loose on purpose — MLB's markup shifts, and
  // we pass team abbreviations (e.g. "NYY"), so matching is best-effort.
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
