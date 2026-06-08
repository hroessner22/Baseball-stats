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
      // No player showed up. If it's because the MLB.tv session expired,
      // tell DIAMOND:CONTEXT so it can prompt a one-time re-login (we never
      // handle the password — the user signs in themselves and the browser
      // session carries from there).
      if (looksLoggedOut()) {
        chrome.runtime.sendMessage({ type: "DC_LOGIN_REQUIRED" });
      }
      return;
    }

    await tryPlay(video);

    // The key line: pop to PiP automatically the moment this tab is hidden.
    video.autoPictureInPicture = true;

    // Also try to pop immediately — works if a recent user gesture carries
    // over or the tab is already backgrounded. If it throws (needs a
    // gesture in this tab), the autoPictureInPicture flag above covers it
    // as soon as the user tabs away.
    try {
      if (
        document.pictureInPictureEnabled &&
        video !== document.pictureInPictureElement
      ) {
        await video.requestPictureInPicture();
      }
    } catch (_) {
      /* handled by autoPictureInPicture on tab-hide */
    }
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

  // Did we land on a login / signed-out page rather than the player? Checks
  // the URL, a visible password field, and the usual "log in to watch" copy.
  // Best-effort — MLB's auth pages shift, so this errs toward prompting.
  function looksLoggedOut() {
    const url = location.href.toLowerCase();
    if (/\/login|\/account\/login|signin|sign-in/.test(url)) return true;
    if (document.querySelector('input[type="password"]')) return true;
    const txt = (document.body?.innerText || "").toLowerCase();
    return /(log|sign) ?in to (watch|mlb\.tv)|please (log|sign) ?in/.test(txt);
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
