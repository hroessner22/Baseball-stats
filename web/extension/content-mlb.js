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

  // Proactively offer PiP on ANY MLB.tv video page — not just tabs the
  // extension opened. MLB hides the native Picture-in-Picture control, but
  // the requestPictureInPicture() API still works, so we supply our own
  // one-tap button whenever a feed is playing. This is what makes PiP
  // possible at all on MLB.tv.
  offerPiPWhenReady();

  let autoPipArmed = false;

  async function offerPiPWhenReady() {
    for (let i = 0; i < 90; i++) {
      const v = pickVideo();
      if (v) armAutoPip(v); // set up automatic PiP as soon as a feed exists
      if (
        v &&
        !document.getElementById("dc-pip-overlay") &&
        document.pictureInPictureElement !== v
      ) {
        showPiPOverlay(v);
        return;
      }
      await sleep(1000);
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

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

    armAutoPip(video);          // register the Media Session auto-PiP path
    await tryPlay(video);
    showPiPOverlay(video);      // one-tap fallback, always available

    // Tell the worker we're playing so it switches focus back to
    // DIAMOND:CONTEXT — hiding this tab triggers Chrome's automatic PiP.
    const announce = () => chrome.runtime.sendMessage({ type: "DC_PLAYING" });
    if (!video.paused && video.readyState >= 2) announce();
    else video.addEventListener("playing", announce, { once: true });

    // If auto-PiP doesn't engage shortly after this tab is hidden, ask the
    // worker to bring this tab back so the one-tap overlay is usable.
    let checked = false;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && !checked) {
        checked = true;
        setTimeout(() => {
          if (!document.pictureInPictureElement) {
            chrome.runtime.sendMessage({ type: "DC_PIP_FAILED" });
          }
        }, 2500);
      }
    });
  }

  // One-tap PiP fallback overlay (used when Chrome's automatic PiP doesn't
  // fire). requestPictureInPicture() needs a user gesture, so a single click
  // on this button — a gesture in THIS tab — pops the feed into PiP.
  function showPiPOverlay(video) {
    if (document.getElementById("dc-pip-overlay")) return;
    const el = document.createElement("div");
    el.id = "dc-pip-overlay";
    el.textContent = "▶ Watch in the corner (picture-in-picture)";
    Object.assign(el.style, {
      position: "fixed",
      zIndex: "2147483647",
      left: "50%",
      top: "16px",
      transform: "translateX(-50%)",
      background: "#3B82F6",
      color: "#fff",
      font: "600 14px system-ui, sans-serif",
      padding: "12px 18px",
      borderRadius: "8px",
      boxShadow: "0 6px 20px rgba(0,0,0,.45)",
      cursor: "pointer",
      pointerEvents: "auto",
    });
    // Clicking the button itself is the user gesture that PiP requires. We
    // bind to the button (not the whole document) so it doesn't hijack
    // clicks elsewhere on the page.
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      el.remove();
      // One button does it all: start playback (MLB often needs a play click
      // first) AND pop to picture-in-picture — both inside this click so they
      // count as a user gesture.
      startAndPip(video);
    });
    document.body.appendChild(el);
  }

  // Play the feed (if paused) and float it into PiP. requestPictureInPicture
  // needs the video to have a frame (readyState ≥ 1) plus a recent user
  // gesture, so we try right away (covers an already-buffered/paused feed)
  // and again the moment playback actually starts — both land inside the
  // click's activation window.
  function startAndPip(video) {
    const p = video.play();
    if (p && p.catch) p.catch(() => clickPlayButton());
    pip(video);
    const onReady = () => pip(video);
    video.addEventListener("playing", onReady, { once: true });
    video.addEventListener("loadeddata", onReady, { once: true });
    setTimeout(() => {
      video.removeEventListener("playing", onReady);
      video.removeEventListener("loadeddata", onReady);
    }, 8000);
  }

  function pip(video) {
    try {
      if (
        document.pictureInPictureEnabled &&
        video !== document.pictureInPictureElement &&
        video.readyState >= 1
      ) {
        video.requestPictureInPicture();
      }
    } catch (_) {}
  }

  function clickPlayButton() {
    const b = document.querySelector(
      '[aria-label*="play" i], button[title*="play" i], .bmpui-ui-playbacktogglebutton'
    );
    if (b) b.click();
  }

  // Automatic PiP — no overlay click. Registers the Media Session
  // "enterpictureinpicture" action so Chrome floats the feed into PiP on its
  // own when you switch back to DIAMOND:CONTEXT, and sets autoPictureInPicture
  // where supported. Best-effort (Chrome only auto-fires when its auto-PiP is
  // available + the feed is playing), so the overlay button stays as a
  // guaranteed one-click fallback.
  function armAutoPip(video) {
    if (autoPipArmed) return;
    autoPipArmed = true;
    try { video.autoPictureInPicture = true; } catch (_) {}
    try {
      navigator.mediaSession.setActionHandler("enterpictureinpicture", () => pip(video));
    } catch (_) {}
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
