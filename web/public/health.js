// Frontend health monitor + visible status indicator.
//
// Pings /api/health every 30s, classifies overall status (ok /
// degraded / down), and pins a small colored dot to the bottom-right
// of every page. Hovering the dot shows which checks failed and when.
//
// Auto-recovery: when /api/markets transitions from FAIL → OK between
// two consecutive polls, automatically triggers a refresh of any
// markets view currently on screen so the user doesn't have to wait
// for the next 10s dashboard poll to repopulate.
//
// Cheap by design — one tiny fetch every 30s, no heavyweight
// dependencies, never blocks anything else.

(function (root) {
"use strict";

const POLL_MS  = 30_000;
const RECOVERY_RETRY_MS = 5_000;   // when broken, poll faster so recovery is snappy
let lastHealth        = null;     // last full response from /api/health
let lastMarketsOk     = null;     // true/false/null, used to detect transitions
let inFlight          = false;
let degradedSince     = null;     // timestamp when health first went non-OK
let degradedActionsApplied = false;

async function checkHealth(opts = {}) {
    if (inFlight) return;
    inFlight = true;
    try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (!data) throw new Error(`HTTP ${res.status}`);
        const prev = lastMarketsOk;
        const now  = data.checks?.our_markets?.ok === true;
        lastHealth = data;
        lastMarketsOk = now;
        renderIndicator();
        applyDegradedAdaptations(data);

        // Auto-recovery: markets just came back from failing.
        // Trigger a dashboard refresh so the user immediately sees
        // the recovered data instead of waiting up to 10s.
        if (prev === false && now === true) {
            try {
                if (typeof root.refreshMarketsDashboard === "function") {
                    root.refreshMarketsDashboard();
                }
            } catch { /* best-effort */ }
        }
    } catch (e) {
        lastHealth = {
            ok: false,
            checks: {},
            error: String(e.message || e),
            timestamp: new Date().toISOString(),
        };
        renderIndicator();
    } finally {
        inFlight = false;
    }
    // Schedule the next check — faster when degraded so we can
    // surface a recovery quickly.
    const nextDelay = lastHealth?.ok ? POLL_MS : RECOVERY_RETRY_MS;
    if (opts.noSchedule !== true) {
        clearTimeout(scheduleTimer);
        scheduleTimer = setTimeout(() => checkHealth(), nextDelay);
    }
}

let scheduleTimer = null;

// Autonomous adaptation when the health checker goes yellow / red.
// User asked: "you actually need to work to fix it when this comes up."
// Throttling alone is passive — we now ACTIVELY try to recover:
//
//   1. Fire a cache-busting refetch against every failing endpoint.
//      A 503 cached at the Cloudflare edge would otherwise serve the
//      bad response for 30s; ?cb=<ts> + cache:no-store forces a fresh
//      origin hit and a fresh cache entry.
//   2. Schedule a few escalating retries (4s, 12s, 30s) so we beat
//      the next regular health poll to recovery when possible.
//   3. Slow the markets-dashboard refresh to 30s — keeps us from
//      hammering the endpoint while it's already struggling.
//   4. Show a banner naming the failing check.
//
// When health flips back to OK, restore the 10s cadence, hide the
// banner, and cancel any pending retries.
let activeRecoveryTimers = [];

function applyDegradedAdaptations(health) {
    const isOk = health?.ok === true;
    if (!isOk && !degradedActionsApplied) {
        degradedActionsApplied = true;
        degradedSince = Date.now();
        // Slow the dashboard auto-refresh while degraded.
        try {
            if (root.marketsDashboardTimer) clearInterval(root.marketsDashboardTimer);
            if (typeof root.refreshMarketsDashboard === "function") {
                root.marketsDashboardTimer = setInterval(root.refreshMarketsDashboard, 30_000);
            }
        } catch { /* best-effort */ }
        showDegradedBanner();
        // Fire active recovery — don't wait passively for the next
        // health poll, go knock the bad endpoint into the cache.
        runActiveRecovery(health);
    } else if (isOk && degradedActionsApplied) {
        degradedActionsApplied = false;
        // Cancel any pending recovery retries that might still fire.
        activeRecoveryTimers.forEach(clearTimeout);
        activeRecoveryTimers = [];
        // Restore the normal 10s cadence.
        try {
            if (root.marketsDashboardTimer) clearInterval(root.marketsDashboardTimer);
            if (typeof root.refreshMarketsDashboard === "function") {
                root.marketsDashboardTimer = setInterval(root.refreshMarketsDashboard, 10_000);
            }
        } catch { /* best-effort */ }
        hideDegradedBanner();
        degradedSince = null;
    } else if (!isOk && degradedActionsApplied) {
        // Still degraded on a subsequent poll — kick another wave of
        // recovery attempts. checkHealth() schedules itself faster
        // (5s) while degraded, but the recovery wave does cache-bust
        // refetches the health probe wouldn't do on its own.
        runActiveRecovery(health);
    }
}

// Map of failing-check name → URL we can remediate from the browser.
// Upstream checks (mlb_stats, polymarket, kalshi) live on different
// origins and we have no way to kick their caches; the in-flight
// proxy retries inside the worker are the only recovery path for
// those. Our own endpoints we CAN cache-bust.
const RECOVERABLE_URLS = {
    our_markets: "/api/markets?scope=game_day&source=kalshi",
    our_games:   "/api/games/today",
};

// Walk the failed checks, fire a cache-busting refetch against each
// failing endpoint we own, then schedule two more attempts with
// backoff so the recovery is more than a single shot. Once a
// previously-failing endpoint returns 2xx, immediately re-poll
// health + refresh the markets dashboard so the user sees data
// again without waiting for the next regular tick.
function runActiveRecovery(health) {
    const failing = Object.keys(health?.checks || {})
        .filter((name) => health.checks[name].ok === false)
        .filter((name) => name in RECOVERABLE_URLS);
    if (!failing.length) return;
    const urls = failing.map((name) => RECOVERABLE_URLS[name]);

    const fireRound = async () => {
        const results = await Promise.allSettled(
            urls.map((u) => {
                // Add a cache-buster + force a fresh origin hit. The
                // Cloudflare edge would otherwise serve a stale 5xx
                // for the full cache TTL even after the origin is
                // healthy again. A 'cache: no-store' on the client
                // tells Cloudflare to revalidate.
                const sep = u.includes("?") ? "&" : "?";
                return fetch(`${u}${sep}cb=${Date.now()}`, {
                    cache: "no-store",
                    headers: { "cache-control": "no-cache" },
                });
            }),
        );
        // Did anything recover this round? If yes, kick a re-check
        // immediately AND nudge the markets dashboard to repopulate
        // from the now-good cache.
        const recovered = results.some(
            (r) => r.status === "fulfilled" && r.value.ok,
        );
        if (recovered) {
            try {
                if (typeof root.refreshMarketsDashboard === "function") {
                    root.refreshMarketsDashboard();
                }
            } catch { /* best-effort */ }
            // Re-poll health right away so the banner clears as
            // soon as possible.
            checkHealth({ noSchedule: true });
        }
    };

    // Three escalating rounds: now, +4s, +12s. Plus the next regular
    // 5s health poll, which gives ~4 attempts in the first 30 seconds.
    fireRound();
    activeRecoveryTimers.push(setTimeout(fireRound, 4_000));
    activeRecoveryTimers.push(setTimeout(fireRound, 12_000));
}

function showDegradedBanner() {
    let banner = document.querySelector(".health-degraded-banner");
    if (!banner) {
        banner = document.createElement("div");
        banner.className = "health-degraded-banner";
        document.body.appendChild(banner);
    }
    const failed = Object.entries(lastHealth?.checks || {})
        .filter(([_, c]) => !c.ok)
        .map(([n]) => n);
    banner.innerHTML = `
      <span class="hdb-dot"></span>
      <span class="hdb-text">
        Degraded: <strong>${failed.join(", ") || "system slow"}</strong>.
        Slowed auto-refresh to 30s while we recover.
      </span>
      <button class="hdb-dismiss" onclick="this.parentElement.remove()">×</button>
    `;
}

function hideDegradedBanner() {
    document.querySelector(".health-degraded-banner")?.remove();
}

function renderIndicator() {
    let host = document.querySelector(".health-indicator");
    if (!host) {
        host = document.createElement("div");
        host.className = "health-indicator";
        host.setAttribute("role", "status");
        host.setAttribute("aria-live", "polite");
        host.addEventListener("click", openHealthPanel);
        document.body.appendChild(host);
    }
    if (!lastHealth) {
        host.classList.remove("ok", "down", "degraded");
        host.classList.add("unknown");
        host.title = "Checking system health…";
        return;
    }
    const checks = lastHealth.checks || {};
    const names  = Object.keys(checks);
    const failed = names.filter((n) => checks[n].ok === false);
    let cls, tip;
    if (lastHealth.ok && failed.length === 0) {
        cls = "ok";
        tip = `All systems ok · checked ${timeAgo(lastHealth.timestamp)}`;
    } else if (failed.length >= names.length) {
        cls = "down";
        tip = `All systems down · ${failed.join(", ")}`;
    } else {
        cls = "degraded";
        tip = `Degraded · ${failed.join(", ")} failing`;
    }
    host.classList.remove("ok", "down", "degraded", "unknown");
    host.classList.add(cls);
    host.title = tip + " · click for detail";
}

function timeAgo(iso) {
    if (!iso) return "?";
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 5_000)  return "just now";
    if (ms < 60_000) return `${Math.round(ms/1000)}s ago`;
    if (ms < 3_600_000) return `${Math.round(ms/60_000)}m ago`;
    return `${Math.round(ms/3_600_000)}h ago`;
}

// Click-to-open panel: shows per-check status, latency, error
// message, and a "Recheck now" button.
function openHealthPanel() {
    const existing = document.querySelector(".health-panel-overlay");
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement("div");
    overlay.className = "health-panel-overlay";
    overlay.innerHTML = renderHealthPanelHtml();
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
    });
    const closeBtn = overlay.querySelector(".health-panel-close");
    if (closeBtn) closeBtn.addEventListener("click", () => overlay.remove());
    const recheckBtn = overlay.querySelector(".health-panel-recheck");
    if (recheckBtn) recheckBtn.addEventListener("click", async () => {
        recheckBtn.disabled = true;
        recheckBtn.textContent = "Checking…";
        await checkHealth({ noSchedule: true });
        overlay.innerHTML = renderHealthPanelHtml();
        // Re-attach close handlers since innerHTML wiped them
        overlay.querySelector(".health-panel-close").addEventListener("click", () => overlay.remove());
        overlay.querySelector(".health-panel-recheck").addEventListener("click", arguments.callee);
    });
}

function renderHealthPanelHtml() {
    const h = lastHealth;
    if (!h) {
        return `
          <div class="health-panel">
            <button class="health-panel-close" aria-label="Close">×</button>
            <h3>System health</h3>
            <p class="health-panel-empty">No health data yet — checking now.</p>
            <button class="health-panel-recheck">Recheck now</button>
          </div>
        `;
    }
    const checks = h.checks || {};
    const overall = h.ok
        ? `<span class="health-pill health-pill-ok">All systems ok</span>`
        : `<span class="health-pill health-pill-down">Degraded</span>`;
    const rows = Object.entries(checks).map(([name, c]) => `
      <tr class="${c.ok ? "row-ok" : "row-down"}">
        <td><code>${escapeHTMLAttr(name)}</code></td>
        <td>${c.ok ? "✓" : "✗"} ${c.status || ""}</td>
        <td>${c.latency_ms != null ? c.latency_ms + " ms" : "—"}</td>
        <td class="health-err">${c.error ? escapeHTMLAttr(c.error).slice(0, 80) : ""}</td>
      </tr>
    `).join("");
    return `
      <div class="health-panel">
        <button class="health-panel-close" aria-label="Close">×</button>
        <h3>System health ${overall}</h3>
        <p class="health-panel-sub">Last checked ${timeAgo(h.timestamp)}. Re-checks every ${lastHealth?.ok ? "30" : "5"}s.</p>
        <table class="health-table">
          <thead>
            <tr><th>Service</th><th>Status</th><th>Latency</th><th>Error</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <button class="health-panel-recheck">Recheck now</button>
      </div>
    `;
}

function escapeHTMLAttr(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
    }[c]));
}


// ── Bootstrap ───────────────────────────────────────────────────

// First check fires immediately on script load; subsequent checks are
// scheduled by checkHealth itself (faster cadence when degraded).
checkHealth();


// ── Public surface ──────────────────────────────────────────────

root.HealthMonitor = {
    checkNow: () => checkHealth({ noSchedule: true }),
    getStatus: () => lastHealth,
    openPanel: openHealthPanel,
};

})(typeof window !== "undefined" ? window : globalThis);
