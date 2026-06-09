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
  function watch(gamePk, away, home, watchUrl) {
    if (extInstalled()) {
      window.postMessage(
        { source: "diamond-context", type: "DC_WATCH", gamePk, away, home, watchUrl },
        "*"
      );
      // Enter "theater" layout: the PiP gets centered over this window by the
      // Hammerspoon helper, so shrink the field to sit below it.
      setTheater(true);
    } else {
      openSetup();
    }
  }

  // ── theater mode ────────────────────────────────────────────────────
  // Shrinks the field (body.dc-watching) so the centered PiP has room above
  // it. Persists so it survives navigation; a floating "exit" chip turns it
  // off. The PiP itself is positioned by the Hammerspoon helper.
  const LS_THEATER = "diamond_context_theater";
  function theaterOn() {
    try { return localStorage.getItem(LS_THEATER) === "1"; } catch { return false; }
  }
  function setTheater(on) {
    try { localStorage.setItem(LS_THEATER, on ? "1" : "0"); } catch {}
    document.body.classList.toggle("dc-watching", on);
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
  }

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

    // Live game → watch it. No live game → offer the always-on MLBN feed so
    // the corner-watch is always usable (and testable before first pitch).
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
  function mount() {
    rootEl = document.createElement("div");
    rootEl.className = "dcw-widget";
    document.body.appendChild(rootEl);

    // delegated clicks
    rootEl.addEventListener("click", (e) => {
      // collapsed icon -> expand
      if (e.target.closest(".dcw-grip-btn")) { setCollapsed(false); render(); return; }
      // minimize -> collapse to icon (never fully hidden)
      if (e.target.closest(".dcw-x")) { setCollapsed(true); render(); return; }
      if (e.target.closest(".dcw-setup")) { openSetup(); return; }
      const btn = e.target.closest(".dcw-btn");
      if (btn) {
        watch(btn.dataset.pk, btn.dataset.away, btn.dataset.home, btn.dataset.url || null);
        const orig = btn.textContent;
        btn.textContent = extInstalled() ? "Opening…" : "Set up ↗";
        setTimeout(() => { btn.textContent = orig; }, 2200);
      }
    });

    if (theaterOn()) setTheater(true); // restore theater layout across navigation
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
  }

  // Expose the handoff so other UI (e.g. the in-game red "▶ Watch" tab) can
  // trigger the exact same flow: extension → MLB.tv → auto-PiP → theater.
  // For a live game pass watchUrl=null (per-game deep link); otherwise the
  // always-on MLBN feed.
  window.DCWatch = {
    start(gamePk, live) {
      watch(gamePk, null, null, live ? null : MLBN_URL);
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
