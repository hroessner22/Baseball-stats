// active-bets-strip.js
//
// A slim horizontal strip pinned above the bottom nav showing every
// active Kalshi position (bot OR manual). Each chip deep-links to
// /#game/{game_pk}/markets. Player-prop chips render a DraftKings-
// style progress bar — current stat value / target threshold, with
// a gradient fill that resolves green when the leg completes.
//
// Data sources:
//   • Kalshi.getPositions / getOrderbook  — live entry + live YES bid
//   • localStorage diamond_context_bot_fires — bot fire records
//     (player, stat, threshold, game_pk) for progress + deep-links
//   • MLB Stats API boxscore               — live player stats
//
// Refreshes every 30s; boxscore fetches cached 30s per game_pk so a
// 10-bet strip touching 5 distinct games costs 5 upstream calls per
// cycle, not 50.

(function () {
"use strict";

const REFRESH_MS = 30000;
const BOX_TTL_MS = 30000;
const LS_FIRES   = "diamond_context_bot_fires";
const LS_COLLAPSED = "diamond_context_strip_collapsed";
const root = (typeof globalThis !== "undefined") ? globalThis : window;

let stripEl = null;
let timer   = null;
let collapsed = readCollapsed();
const boxscoreCache = new Map();   // game_pk → { t, data }

function readCollapsed() {
    try { return localStorage.getItem(LS_COLLAPSED) === "1"; }
    catch { return false; }
}
function writeCollapsed(v) {
    try { localStorage.setItem(LS_COLLAPSED, v ? "1" : "0"); } catch {}
}

document.addEventListener("DOMContentLoaded", () => waitForKalshi(init));

function waitForKalshi(cb) {
    if (root.Kalshi) return cb();
    const id = setInterval(() => {
        if (root.Kalshi) { clearInterval(id); cb(); }
    }, 200);
}

function init() {
    stripEl = document.createElement("div");
    stripEl.id = "active-bets-strip";
    stripEl.className = "active-bets-strip";
    document.body.appendChild(stripEl);
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
    // Re-render the moment Kalshi (un)connects so the strip vanishes
    // immediately on disconnect instead of waiting 30s.
    document.addEventListener("kalshi-connection-change", refresh);
}

function getFires() {
    try { return JSON.parse(localStorage.getItem(LS_FIRES) || "[]"); }
    catch { return []; }
}

async function refresh() {
    if (!stripEl) return;
    if (!root.Kalshi || !root.Kalshi.isConnected || !root.Kalshi.isConnected()) {
        hide();
        return;
    }
    let positions;
    try {
        positions = await root.Kalshi.getPositions();
    } catch {
        return;   // Keep the previous render; a transient fetch error
                  // shouldn't blank the strip.
    }
    const mps = (positions?.market_positions || []).filter((p) => (p.position || 0) > 0);
    const fires = getFires();
    const fireMap = new Map();
    for (const f of fires) {
        if (f.ticker && !fireMap.has(f.ticker)) fireMap.set(f.ticker, f);
    }

    // If Kalshi shows active positions, that's the source of truth —
    // render those as active chips. Otherwise fall back to the local
    // bet log: show the last few placed bets as "recent" chips so
    // the user still sees something whether Kalshi has propagated
    // the fill yet or whether the position has already settled.
    let mode = "active";
    let entries;
    if (mps.length) {
        entries = await Promise.all(mps.map(async (p) => {
            const fire  = fireMap.get(p.ticker) || null;
            const entry = p.average_yes_price ?? p.average_cost_cents ?? 0;
            const qty   = p.position;
            let live = null;
            try {
                const ob = await root.Kalshi.getOrderbook(p.ticker);
                live = orderbookYesBidCents(ob);
            } catch { /* fall through */ }
            const pl = (live != null && qty > 0) ? ((live - entry) * qty / 100) : null;
            const progress = await computeProgress(fire);
            return { kind: "position", p, fire, live, entry, qty, pl, progress };
        }));
    } else if (fires.length) {
        mode = "recent";
        const top = fires.slice(0, 6);
        entries = await Promise.all(top.map(async (f) => {
            const progress = await computeProgress(f);
            return { kind: "recent", fire: f, progress };
        }));
    } else {
        hide();
        return;
    }

    const titleText = mode === "active"
        ? `ACTIVE · ${entries.length}`
        : `RECENT · ${entries.length}`;

    // Toggle pill on the LEFT — clicking collapses the strip to just
    // this button so the user can hide the chips without losing the
    // affordance to bring them back. State persists in localStorage.
    const toggleIcon  = collapsed ? "▲" : "▼";
    const toggleLabel = collapsed ? `${titleText}` : titleText;

    stripEl.innerHTML = `
      <button class="abs-toggle" data-strip-toggle
              aria-expanded="${!collapsed}"
              aria-label="${collapsed ? "Show active bets" : "Hide active bets"}"
              title="${collapsed ? "Show active bets" : "Hide active bets"}">
        <span class="abs-toggle-icon">${toggleIcon}</span>
        <span class="abs-toggle-label">${toggleLabel}</span>
      </button>
      ${collapsed ? "" : `
        <div class="abs-chips">${entries.map((e) => e.kind === "position" ? renderChip(e) : renderRecentChip(e)).join("")}</div>
      `}
    `;
    bindToggle();
    show();
    stripEl.classList.toggle("is-collapsed", collapsed);
}

// Compute the DK-style progress payload for a player-prop fire.
// Reused by both the active and recent chip renderers.
async function computeProgress(fire) {
    if (!fire || fire.kind !== "player_prop" || !fire.game_pk) return null;
    const box = await getBoxscoreCached(fire.game_pk);
    const cur = box ? extractPlayerStat(box, fire.player, fire.stat) : null;
    if (cur == null || !fire.threshold) return null;
    return {
        current: cur,
        target:  fire.threshold,
        pct:     Math.min(100, (cur / fire.threshold) * 100),
        hit:     cur >= fire.threshold,
    };
}

// Render a chip for a recent-but-no-longer-active bet from the
// local log. Looks like an active chip but tagged HISTORY in place
// of the dollar P/L.
function renderRecentChip({ fire, progress }) {
    const isManual = fire?.source === "manual";
    const srcTag = isManual
        ? `<span class="abs-src abs-src-user">YOU</span>`
        : `<span class="abs-src abs-src-bot">BOT</span>`;

    let label, progressEl = "";
    if (fire?.kind === "player_prop") {
        label = `${shortName(fire.player)} ${fire.threshold}+ ${shortStat(fire.stat)}`;
        if (progress) {
            const fillCls = progress.hit ? "abs-progress-bar hit" : "abs-progress-bar";
            progressEl = `
              <span class="abs-progress" title="${progress.current} of ${progress.target} ${shortStat(fire.stat)}">
                <span class="${fillCls}" style="width: ${progress.pct.toFixed(1)}%"></span>
              </span>
              <span class="abs-progress-text">${progress.current}/${progress.target}</span>
            `;
        }
    } else if (fire?.bet_team) {
        label = `${fire.bet_team} ML`;
    } else {
        const t = fire?.ticker || "";
        label = t.length > 24 ? t.slice(0, 24) + "…" : t;
    }
    const gamePk = fire?.game_pk;
    const href   = gamePk ? `#game/${gamePk}/markets` : "#";

    return `
      <a class="abs-chip abs-chip-recent ${progress?.hit ? "is-hit" : ""}"
         href="${href}"
         ${gamePk ? "" : "tabindex='-1'"}>
        ${srcTag}
        <span class="abs-label">${escapeText(label)}</span>
        ${progressEl}
        <span class="abs-price">${fire.price_cents}¢</span>
        <span class="abs-arrow">➜</span>
      </a>
    `;
}

function renderChip({ p, fire, live, entry, qty, pl, progress }) {
    // Manual bets carry source="manual"; bot fires either set
    // source="bot" or have no source field (backward compat with
    // pre-source-field log entries).
    const isManual = fire?.source === "manual";
    const srcTag = (fire && !isManual)
        ? `<span class="abs-src abs-src-bot">BOT</span>`
        : `<span class="abs-src abs-src-user">YOU</span>`;
    const plCls  = pl == null ? "" : pl >= 0 ? "abs-pl-pos" : "abs-pl-neg";
    const plText = pl != null ? `${pl >= 0 ? "+" : ""}$${pl.toFixed(2)}` : "";

    const gamePk = fire?.game_pk;
    const href   = gamePk ? `#game/${gamePk}/markets` : "#";

    let label, progressEl = "";
    if (fire?.kind === "player_prop") {
        label = `${shortName(fire.player)} ${fire.threshold}+ ${shortStat(fire.stat)}`;
        if (progress) {
            const fillCls = progress.hit ? "abs-progress-bar hit" : "abs-progress-bar";
            progressEl = `
              <span class="abs-progress" title="${progress.current} of ${progress.target} ${shortStat(fire.stat)}">
                <span class="${fillCls}" style="width: ${progress.pct.toFixed(1)}%"></span>
              </span>
              <span class="abs-progress-text">${progress.current}/${progress.target}</span>
            `;
        } else {
            progressEl = `<span class="abs-progress-text abs-progress-pending">—/${fire.threshold}</span>`;
        }
    } else if (fire?.bet_team) {
        label = `${fire.bet_team} ML`;
    } else {
        // User-placed bet on an unmapped ticker. Show a trimmed
        // version of the Kalshi ticker so the row still says
        // SOMETHING the user can recognize.
        const t = p.ticker || "";
        label = t.length > 24 ? t.slice(0, 24) + "…" : t;
    }

    const priceEl = live != null
        ? `<span class="abs-price">${entry}¢→${live}¢</span>`
        : `<span class="abs-price">${entry}¢</span>`;

    return `
      <a class="abs-chip ${progress?.hit ? "is-hit" : ""}"
         href="${href}"
         ${gamePk ? "" : "tabindex='-1'"}
         data-game-pk="${gamePk || ""}">
        ${srcTag}
        <span class="abs-label">${escapeText(label)}</span>
        ${progressEl}
        ${priceEl}
        ${plText ? `<span class="abs-pl ${plCls}">${plText}</span>` : ""}
        <span class="abs-arrow">➜</span>
      </a>
    `;
}

function bindToggle() {
    const btn = stripEl.querySelector("[data-strip-toggle]");
    if (!btn) return;
    btn.addEventListener("click", () => {
        collapsed = !collapsed;
        writeCollapsed(collapsed);
        refresh();
    });
}
function show() { stripEl.classList.add("is-visible"); }
function hide() { stripEl.classList.remove("is-visible"); }


// ── Boxscore plumbing ────────────────────────────────────────────

async function getBoxscoreCached(gamePk) {
    const c = boxscoreCache.get(gamePk);
    if (c && Date.now() - c.t < BOX_TTL_MS) return c.data;
    try {
        const res = await fetch(
            `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`
        );
        if (!res.ok) return null;
        const data = await res.json();
        boxscoreCache.set(gamePk, { t: Date.now(), data });
        return data;
    } catch { return null; }
}

function extractPlayerStat(box, playerName, stat) {
    // Walk both team rosters from the boxscore payload and match by
    // normalized fullName. Box returns stats in batting / pitching
    // sub-objects — we read whichever matches the stat key.
    const teams = box?.teams || {};
    const target = norm(playerName);
    for (const sideKey of ["home", "away"]) {
        const side = teams[sideKey];
        if (!side) continue;
        const players = side.players || {};
        for (const key of Object.keys(players)) {
            const pl = players[key];
            const fullName = pl?.person?.fullName || "";
            if (norm(fullName) !== target) continue;
            const bat = pl?.stats?.batting   || {};
            const pit = pl?.stats?.pitching  || {};
            switch (stat) {
                case "home_runs":   return bat.homeRuns    ?? 0;
                case "hits":        return bat.hits        ?? 0;
                case "total_bases": return bat.totalBases  ?? 0;
                case "strikeouts":  return pit.strikeOuts  ?? 0;
                default:            return null;
            }
        }
    }
    return null;
}


// ── Tiny utilities ───────────────────────────────────────────────

function norm(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function shortName(s) {
    const parts = String(s || "").trim().split(/\s+/);
    if (parts.length < 2) return s;
    return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}
function shortStat(s) {
    switch (s) {
        case "home_runs":   return "HR";
        case "total_bases": return "TB";
        case "hits":        return "H";
        case "strikeouts":  return "K";
        default: return String(s || "").toUpperCase();
    }
}
function escapeText(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}
function orderbookYesBidCents(ob) {
    if (!ob) return null;
    const yesBook = ob.yes || [];
    if (!yesBook.length) return null;
    const bestYesBid = yesBook[yesBook.length - 1];
    const c = Number(bestYesBid[0]);
    if (!Number.isFinite(c) || c < 1 || c > 99) return null;
    return c;
}

})();
