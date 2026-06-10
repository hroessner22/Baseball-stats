// watch-widget.js
//
// A persistent "Watch" widget pinned to every DIAMOND:CONTEXT page (not just
// the Watch tab). It always shows the featured game and a one-click Watch
// button that hands off to the companion Chrome extension — which opens the
// game on MLB.tv and floats it into a corner picture-in-picture window.
//
// Why a widget and not an embedded player: MLB.tv is DRM-protected and cannot
// be embedded in the page. The corner PiP (driven by the extension) is the
// only way to watch the live game over the app, so this widget is the
// always-present launcher for it.
//
// First-run onboarding: if the extension isn't installed, the button opens a
// setup panel (install the extension + Hammerspoon, sign into MLB.tv). Each
// viewer watches with their own MLB.tv login on their own device.

(function () {
  "use strict";

  const REFRESH_MS = 30000;
  const MLBN_URL = "https://www.mlb.com/tv/watch/mlbn"; // always-on fallback feed
  const LS_COLLAPSED = "diamond_context_watch_widget_collapsed";

  // One-time cleanup: an earlier build had a "×" that hid the widget forever
  // via this key. Remove it so anyone who dismissed it gets the widget back —
  // the widget now collapses to an icon instead of vanishing.
  try { localStorage.removeItem("diamond_context_watch_widget_hidden"); } catch {}

  let rootEl = null;
  let timer = null;
  let games = [];

  // The content-bridge content script sets this on <html> when the extension
  // is installed. Re-checked on every render so it flips live once installed.
  function extInstalled() {
    return document.documentElement.dataset.dcWatchExt === "1";
  }

  // Collapsed = shrunk to a small TV icon (never fully hidden, so it can't be
  // lost). Persists across pages.
  function collapsed() {
    try { return localStorage.getItem(LS_COLLAPSED) === "1"; } catch { return false; }
  }
  function setCollapsed(v) {
    try { localStorage.setItem(LS_COLLAPSED, v ? "1" : "0"); } catch {}
  }

  // ── data ────────────────────────────────────────────────────────────
  async function refresh() {
    try {
      const res = await fetch("/api/games/today");
      if (!res.ok) return;
      const data = await res.json();
      games = data.games || [];
      render();
    } catch { /* keep last render */ }
  }

  // Featured game: the first live game (most interesting), else the soonest
  // upcoming one.
  function featured() {
    const live = games.filter((g) => g.status === "Live" && g.inning);
    if (live.length) {
      live.sort((a, b) => leverage(b) - leverage(a));
      return { game: live[0], live: true };
    }
    const up = games
      .filter((g) => g.status === "Preview")
      .sort((a, b) => new Date(a.start_time || 0) - new Date(b.start_time || 0));
    if (up.length) return { game: up[0], live: false };
    return { game: null, live: false };
  }

  function leverage(g) {
    const diff = Math.abs((g.home_score ?? 0) - (g.away_score ?? 0));
    const close = Math.max(0, 5 - diff) / 5;
    const inn = Math.min(g.inning || 0, 9) / 9;
    return close * 0.6 + inn * 0.4;
  }

  // ── handoff ─────────────────────────────────────────────────────────
  // mode "shift" (in-game / board Watch): shift the field down, keep everything,
  //   you PiP manually. mode "fullscreen" (bottom Watch tab): hide all chrome,
  //   just the field on its own screen.
  function watch(gamePk, away, home, watchUrl, mode) {
    if (!extInstalled()) { openSetup(); return; }
    mode = mode === "fullscreen" ? "fullscreen" : "shift";
    if (gamePk) {
      try { location.hash = "#game/" + gamePk; } catch {}
    }
    setTheater(true, mode);
    const send = () => {
      window.postMessage(
        { source: "diamond-context", type: "DC_WATCH", gamePk, away, home, watchUrl },
        "*"
      );
    };
    // Let the view/layout settle, then hand off to the extension.
    setTimeout(send, 420);
  }

  // The video box, dead simple:
  //   • width  = the EXACT field width, at the field's left edge
  //   • top    = right below the WATCH tab row
  //   • bottom = right above the field
  // Returned in screen CSS px (what chrome.windows uses).
  function computeVideoRect() {
    try {
      const svg = document.querySelector(".field-pane .field-canvas svg");
      if (!svg) return null;
      const f = svg.getBoundingClientRect(); // the field itself

      // Bottom of the tab row that holds the WATCH tab.
      const watchTab = [...document.querySelectorAll("a,button")].find((e) => {
        const t = (e.textContent || "").trim();
        const w = e.getBoundingClientRect().width;
        return /^▶?\s*watch$/i.test(t) && w > 0 && w < 300;
      });
      let tabBottom;
      if (watchTab) {
        let row = watchTab;
        while (
          row.parentElement &&
          row.parentElement.getBoundingClientRect().height < 80
        ) {
          row = row.parentElement;
        }
        tabBottom = row.getBoundingClientRect().bottom;
      } else {
        tabBottom = f.top - 300; // fallback if the tab row can't be found
      }

      const M = 8; // small breathing room top & bottom
      const left = f.left;
      const width = f.width;
      const top = tabBottom + M;
      const height = f.top - M - top;
      if (height < 60) return null; // theater layout hasn't opened the gap yet

      const sx = Math.round(window.screenX + left);
      const sy = Math.round(
        window.screenY + (window.outerHeight - window.innerHeight) + top
      );
      return { left: sx, top: sy, width: Math.round(width), height: Math.round(height) };
    } catch {
      return null;
    }
  }

  // ── theater mode ────────────────────────────────────────────────────
  // Two layouts (persisted, survive navigation; a floating "exit" chip turns
  // them off):
  //   "shift"      → body.dc-watching : shift the field down, keep everything,
  //                  manual PiP above the field.
  //   "fullscreen" → body.dc-theater  : hide all chrome, just the field.
  const LS_THEATER = "diamond_context_theater";
  function theaterMode() {
    try {
      const v = localStorage.getItem(LS_THEATER);
      return v === "fullscreen" || v === "shift" ? v : null;
    } catch { return null; }
  }
  function setTheater(on, mode) {
    mode = mode === "fullscreen" ? "fullscreen" : "shift";
    try { localStorage.setItem(LS_THEATER, on ? mode : "0"); } catch {}
    document.body.classList.toggle("dc-theater", on && mode === "fullscreen");
    document.body.classList.toggle("dc-watching", on && mode === "shift");

    let exit = document.getElementById("dcw-exit-theater");
    if (on && !exit) {
      exit = document.createElement("button");
      exit.id = "dcw-exit-theater";
      exit.textContent = "✕ Exit theater";
      exit.addEventListener("click", () => setTheater(false));
      document.body.appendChild(exit);
    } else if (!on && exit) {
      exit.remove();
    }

    if (!on) {
      // Exiting the video player on the site closes the MLB.tv window too.
      window.postMessage({ source: "diamond-context", type: "DC_CLOSE_WATCH" }, "*");
    }
    // Placement is fully automatic now (computeVideoRect → the exact box above
    // the field), so there's no manual "save spot" button anymore.
  }

  // Brief toast in the corner.
  function toast(text, ok) {
    const t = document.createElement("div");
    t.className = "watch-login-toast";
    t.style.borderColor = ok ? "#2ecc71" : "#e74c3c";
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // (No save/reset confirmations needed — placement is automatic.)

  // ── render ──────────────────────────────────────────────────────────
  function render() {
    if (!rootEl) return;

    // Collapsed: just a small TV icon that re-expands on click.
    if (collapsed()) {
      rootEl.classList.add("is-collapsed");
      rootEl.innerHTML = `<button class="dcw-grip-btn" title="Watch a game">📺</button>`;
      return;
    }
    rootEl.classList.remove("is-collapsed");

    const { game, live } = featured();
    const ready = extInstalled();

    if (!game) {
      rootEl.innerHTML = shell(`<span class="dcw-label">No games today</span>`);
      return;
    }

    const matchup = `${esc(game.away)} <span class="dcw-at">@</span> ${esc(game.home)}`;
    const status = live
      ? `<span class="dcw-live">● LIVE</span> ${esc(stateText(game))}`
      : `${esc(startText(game))}`;

    // Live game → open THAT game on MLB.tv (the one we cued from). Not on yet →
    // fall back to the always-on MLBN feed.
    const target = live
      ? { pk: game.game_pk, url: null, label: "▶ Watch" }
      : { pk: game.game_pk, url: MLBN_URL, label: "▶ Watch MLBN" };

    rootEl.innerHTML = shell(`
      <div class="dcw-info">
        <div class="dcw-teams">${matchup}</div>
        <div class="dcw-status">${status}</div>
      </div>
      <button class="dcw-btn ${live ? "is-live" : ""}"
              data-pk="${esc(game.game_pk)}"
              data-away="${esc(game.away)}"
              data-home="${esc(game.home)}"
              data-url="${target.url || ""}">${target.label}</button>
      ${ready ? "" : `<span class="dcw-setup" title="Set up corner-watch">⚙︎ setup</span>`}
    `);
  }

  function shell(inner) {
    return `
      <span class="dcw-grip" title="DIAMOND:CONTEXT — Watch">📺</span>
      ${inner}
      <button class="dcw-x" title="Minimize">–</button>
    `;
  }

  // ── setup / onboarding panel ────────────────────────────────────────
  function openSetup() {
    if (document.getElementById("dcw-setup-panel")) return;
    const p = document.createElement("div");
    p.id = "dcw-setup-panel";
    p.innerHTML = `
      <div class="dcw-panel-head">
        <strong>Set up corner-watch</strong>
        <button class="dcw-panel-x" title="Close">×</button>
      </div>
      <p class="dcw-panel-sub">Watch the live game in a floating corner window
      over DIAMOND:CONTEXT. One-time setup, per device (macOS + Chrome):</p>
      <ol class="dcw-steps">
        <li><strong>Install the Watch extension</strong> — Chrome →
          <code>chrome://extensions</code> → Developer mode → Load unpacked →
          the <code>web/extension/</code> folder.</li>
        <li><strong>Install Hammerspoon</strong> (snaps the window to the corner)
          — <code>brew install --cask hammerspoon</code>, launch it, and grant
          Accessibility permission. <a href="https://www.hammerspoon.org/"
          target="_blank" rel="noopener">hammerspoon.org ↗</a></li>
        <li><strong>Sign in to MLB.tv</strong> with your subscription —
          <a href="https://www.mlb.com/login" target="_blank" rel="noopener">mlb.com/login ↗</a></li>
      </ol>
      <p class="dcw-panel-foot">Done it? Reload this page and the Watch button
      goes live.</p>
    `;
    document.body.appendChild(p);
    p.querySelector(".dcw-panel-x").addEventListener("click", () => p.remove());
  }

  // ── helpers ─────────────────────────────────────────────────────────
  function stateText(g) {
    const half = g.half === "top" ? "▲" : "▼";
    const parts = [`${half} ${ordinal(g.inning)}`];
    if (g.outs != null) parts.push(`${g.outs} out`);
    return parts.join(" · ");
  }
  function startText(g) {
    try {
      const t = new Date(g.start_time);
      return t.toLocaleTimeString("en-US", {
        timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
      }) + " ET";
    } catch { return "Today"; }
  }
  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── mount ───────────────────────────────────────────────────────────
  // The floating launcher widget is gone — watching is launched from the game
  // cards (Hot/board) and the Watch tab. We only keep the handoff (window.DCWatch)
  // and restore the theater layout across navigation.
  function mount() {
    const m = theaterMode();
    if (m) setTheater(true, m);
  }

  // Handoff API:
  //   start()   — in-game / board Watch → field-shift + manual PiP.
  //   theater() — bottom Watch tab      → full-screen separate screen.
  window.DCWatch = {
    start(gamePk, live) {
      watch(gamePk, null, null, live ? null : MLBN_URL, "shift");
    },
    theater(gamePk, watchUrl) {
      watch(gamePk, null, null, watchUrl, "fullscreen");
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
