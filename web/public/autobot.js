// DIAMOND:CONTEXT auto-bet bot.
//
// One screen, one job: scan live MLB games every 30 s, find moneyline
// markets where our model's win probability AND Baseball Savant's WP
// both disagree with Kalshi by more than the edge threshold (in the
// SAME direction), and fire a small order on Kalshi to take the
// mispricing. Then, while we hold the position, watch the Kalshi
// mid-price — if it moves into our favor enough that selling now is
// more EV than waiting for settlement, sell to lock in the gain.
//
// Why two engines: our matchup engine is decent (Brier 0.69) but not
// perfect. Baseball Savant has its own WP model trained on the
// Statcast event log. Requiring BOTH to disagree with the market in
// the same direction filters out single-engine calibration errors —
// the single worst tail risk for an autobetter.
//
// Why moneyline only (for now): both engines produce game-level win
// probability. Neither produces calibrated spread / total / player-
// prop probabilities. The bot only fires where we have two-engine
// confirmation; anything else is single-engine and rides without a
// safety net.
//
// Safety rails baked in at the constant level (UI cannot bypass):
//   - $0.50 unit per fire (configurable 25¢ – $2)
//   - One bet per (ticker, side) per session — no piling on
//   - $5 daily realized-loss limit — bot pauses for the day
//   - $20 total open exposure ceiling — bot pauses until positions close
//   - Edge threshold floor: 3pp (UI can't go lower)
//   - Off by default; user flips the toggle to start each session
//
// Storage:
//   - localStorage: settings, session bet set, today's loss tally,
//     activity log (last 100 entries)
//   - All bot state survives page reloads but resets cleanly on
//     day boundaries (loss tally only)

(function (root) {
"use strict";


// ── Hard safety caps (UI cannot exceed these) ─────────────────────

const HARD_CAPS = {
    unit_cents_min:        25,     // $0.25 minimum
    unit_cents_max:        200,    // $2.00 maximum
    edge_pp_min:           3,      // never fire below 3pp edge
    edge_pp_max:           20,
    daily_loss_cents_max:  500,    // $5 daily realized-loss limit
    open_exposure_max:     2000,   // $20 total open positions
};

const DEFAULTS = {
    enabled:               false,
    unit_cents:            50,     // $0.50 per fire (user's spec)
    edge_threshold_pp:     5,      // fire when |edge| >= 5pp
    require_savant_agree:  true,   // both engines must agree direction
    profit_take_cents:     20,     // cash out at +20¢ on the contract
    daily_loss_limit_cents: 500,   // $5 default — tightened by HARD_CAPS
    open_exposure_max:     2000,   // $20 default
};

const SCAN_INTERVAL_MS    = 30_000;
const CASHOUT_INTERVAL_MS = 30_000;
const LOG_MAX_ENTRIES     = 100;

const LS_SETTINGS     = "diamond_context_bot_settings";
const LS_SESSION_BETS = "diamond_context_bot_session_bets";
const LS_DAILY_LOSS   = "diamond_context_bot_daily_loss";
const LS_LOG          = "diamond_context_bot_log";


// ── State ─────────────────────────────────────────────────────────

const _state = {
    settings: { ...DEFAULTS },
    sessionBets: new Set(),    // "ticker:side" strings we've already fired on
    dailyLoss: { date: todayUtcDate(), cents: 0 },
    openPositions: [],         // last Kalshi.getPositions() snapshot
    scanTimer: null,
    cashoutTimer: null,
    lastScanAt: null,
    isScanning: false,
};

function loadState() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}");
        _state.settings = clampSettings({ ...DEFAULTS, ...s });
    } catch { _state.settings = { ...DEFAULTS }; }
    try {
        const arr = JSON.parse(localStorage.getItem(LS_SESSION_BETS) || "[]");
        _state.sessionBets = new Set(arr);
    } catch { _state.sessionBets = new Set(); }
    try {
        const d = JSON.parse(localStorage.getItem(LS_DAILY_LOSS) || "{}");
        if (d.date === todayUtcDate()) _state.dailyLoss = d;
        else _state.dailyLoss = { date: todayUtcDate(), cents: 0 };
    } catch { _state.dailyLoss = { date: todayUtcDate(), cents: 0 }; }
}

function persistSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(_state.settings)); } catch {}
}
function persistSessionBets() {
    try {
        localStorage.setItem(LS_SESSION_BETS, JSON.stringify(Array.from(_state.sessionBets)));
    } catch {}
}
function persistDailyLoss() {
    try { localStorage.setItem(LS_DAILY_LOSS, JSON.stringify(_state.dailyLoss)); } catch {}
}

// Force every input through HARD_CAPS so the UI literally cannot
// configure a setting unsafer than the constants above. Single
// chokepoint applied on load + on every settings update.
function clampSettings(s) {
    return {
        enabled:               !!s.enabled,
        unit_cents:            clampInt(s.unit_cents, HARD_CAPS.unit_cents_min, HARD_CAPS.unit_cents_max),
        edge_threshold_pp:     clampInt(s.edge_threshold_pp, HARD_CAPS.edge_pp_min, HARD_CAPS.edge_pp_max),
        require_savant_agree:  s.require_savant_agree !== false,    // default true
        profit_take_cents:     clampInt(s.profit_take_cents, 5, 60),
        daily_loss_limit_cents: clampInt(s.daily_loss_limit_cents, 100, HARD_CAPS.daily_loss_cents_max),
        open_exposure_max:     clampInt(s.open_exposure_max, 200, HARD_CAPS.open_exposure_max),
    };
}
function clampInt(n, lo, hi) {
    const x = parseInt(n, 10);
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
}
function todayUtcDate() { return new Date().toISOString().slice(0, 10); }


// ── Activity log ──────────────────────────────────────────────────

function log(kind, message, meta = null) {
    let arr;
    try { arr = JSON.parse(localStorage.getItem(LS_LOG) || "[]"); }
    catch { arr = []; }
    arr.unshift({ ts: Date.now(), kind, message, meta });
    if (arr.length > LOG_MAX_ENTRIES) arr.length = LOG_MAX_ENTRIES;
    try { localStorage.setItem(LS_LOG, JSON.stringify(arr)); } catch {}
    // Live-refresh the drawer if it's open
    refreshDrawerIfOpen();
}
function getLog() {
    try { return JSON.parse(localStorage.getItem(LS_LOG) || "[]"); }
    catch { return []; }
}
function clearLog() {
    try { localStorage.removeItem(LS_LOG); } catch {}
    refreshDrawerIfOpen();
}


// ── Bot lifecycle ─────────────────────────────────────────────────

function enable() {
    if (!root.Kalshi || !root.Kalshi.isConnected || !root.Kalshi.isConnected()) {
        toast("Connect Kalshi first (top-right pill)", "err");
        return false;
    }
    _state.settings.enabled = true;
    persistSettings();
    log("bot", "Bot enabled");
    startTimers();
    runScan();      // fire one immediately so the user sees results
    runCashoutCheck();
    return true;
}

function disable() {
    _state.settings.enabled = false;
    persistSettings();
    stopTimers();
    log("bot", "Bot disabled");
}

function startTimers() {
    stopTimers();
    _state.scanTimer = setInterval(runScan, SCAN_INTERVAL_MS);
    _state.cashoutTimer = setInterval(runCashoutCheck, CASHOUT_INTERVAL_MS);
}
function stopTimers() {
    if (_state.scanTimer)    { clearInterval(_state.scanTimer);    _state.scanTimer = null; }
    if (_state.cashoutTimer) { clearInterval(_state.cashoutTimer); _state.cashoutTimer = null; }
}


// ── Scan loop ─────────────────────────────────────────────────────

async function runScan() {
    if (!_state.settings.enabled) return;
    if (_state.isScanning) return;
    _state.isScanning = true;
    try {
        // Daily loss check first — if we're at the cap, halt for today.
        if (_state.dailyLoss.date !== todayUtcDate()) {
            _state.dailyLoss = { date: todayUtcDate(), cents: 0 };
            persistDailyLoss();
        }
        if (_state.dailyLoss.cents >= _state.settings.daily_loss_limit_cents) {
            log("halt", `Daily loss limit hit ($${(_state.dailyLoss.cents/100).toFixed(2)}); bot will resume tomorrow`);
            disable();
            return;
        }
        // Open-exposure check.
        const exposureCents = computeOpenExposureCents();
        if (exposureCents >= _state.settings.open_exposure_max) {
            log("skip", `Open exposure $${(exposureCents/100).toFixed(2)} >= cap $${(_state.settings.open_exposure_max/100).toFixed(2)}; skipping this scan`);
            _state.lastScanAt = Date.now();
            return;
        }

        // 1) Live games
        const games = await fetchLiveGames();
        if (!games.length) {
            _state.lastScanAt = Date.now();
            return;
        }

        // 2) For each game, fetch markets + edges
        for (const g of games) {
            try {
                await scanOneGame(g);
            } catch (e) {
                log("err", `Scan failed for ${g.away}@${g.home}: ${e.message || e}`);
            }
        }
        _state.lastScanAt = Date.now();
    } finally {
        _state.isScanning = false;
    }
}

async function fetchLiveGames() {
    const res = await fetch("/api/games/today");
    if (!res.ok) throw new Error(`games HTTP ${res.status}`);
    const d = await res.json();
    return (d.games || []).filter((g) =>
        g.status === "Live" || g.status === "In Progress"
    );
}

async function scanOneGame(g) {
    const res = await fetch(`/api/game/${g.game_pk}/markets`);
    if (!res.ok) throw new Error(`markets HTTP ${res.status}`);
    const d = await res.json();

    const ourHome    = d.our_we_home;
    const savantHome = d.savant_we_home;
    if (ourHome == null) return;     // model didn't score this state

    // For each Kalshi moneyline market (one per team), figure out
    // which side YES represents, get its live price from the
    // orderbook, and check the edge.
    const moneylines = (d.markets?.moneyline || []).filter((m) => m.source === "kalshi");
    for (const m of moneylines) {
        await checkAndMaybeFire(g, m, ourHome, savantHome);
    }
}

async function checkAndMaybeFire(g, market, ourHome, savantHome) {
    // Identify which TEAM this Kalshi market is YES'ing on. The
    // ticker tail is the tricode (KXMLBGAME-...-DET, ...-TB, etc.).
    // Match against g.home / g.away to know if YES = home wins.
    const ticker = market.raw_market_id || "";
    const tail = ticker.split("-").slice(-1)[0]?.toUpperCase() || "";
    const isHomeSide = tail === g.home || tail === g.home?.toUpperCase();
    const isAwaySide = tail === g.away || tail === g.away?.toUpperCase();
    if (!isHomeSide && !isAwaySide) return;   // unknown side — skip

    // Probabilities for THIS side. our_p, savant_p, market_p.
    const our_p    = isHomeSide ? ourHome : (1 - ourHome);
    const savant_p = savantHome == null
        ? null
        : (isHomeSide ? savantHome : (1 - savantHome));

    // Get the live YES price for this market. Pull the orderbook
    // (cached by Kalshi.getOrderbook) — it gives us the best NO bid,
    // from which we derive the best YES ask.
    const ob = await root.Kalshi.getOrderbook(ticker);
    const yesAskCents = orderbookYesAskCents(ob);
    if (yesAskCents == null) return;          // no offers

    const market_p = yesAskCents / 100;
    const edgePP = (our_p - market_p) * 100;

    // Edge must be positive AND above the threshold (our model
    // thinks YES is too cheap → buy YES).
    if (edgePP < _state.settings.edge_threshold_pp) return;

    // Savant agreement gate.
    if (_state.settings.require_savant_agree) {
        if (savant_p == null) {
            return;     // pregame / no Savant data → don't fire
        }
        if (savant_p <= market_p) {
            return;     // Savant disagrees direction
        }
    }

    // Already bet this market+side this session?
    const key = `${ticker}:yes`;
    if (_state.sessionBets.has(key)) return;

    // Compute contract count. With $0.50 unit and ask at e.g. 25¢,
    // we'd buy 2 contracts. floor() means small leftover stays
    // unused; we never go over the unit even if the price is odd.
    const contracts = Math.floor(_state.settings.unit_cents / yesAskCents);
    if (contracts < 1) {
        return;   // unit too small to buy even 1 contract at this price
    }

    // Double-check exposure won't blow past the cap with this trade.
    const tradeCostCents = contracts * yesAskCents;
    if (computeOpenExposureCents() + tradeCostCents > _state.settings.open_exposure_max) {
        return;
    }

    // FIRE.
    try {
        const result = await root.Kalshi.placeOrder({
            ticker,
            side: "yes",
            count: contracts,
            price: yesAskCents,
            action: "buy",
        });
        _state.sessionBets.add(key);
        persistSessionBets();
        log("buy", `BUY ${contracts}× ${ticker} YES @ ${yesAskCents}¢` +
            ` (our ${(our_p*100).toFixed(1)}% / market ${(market_p*100).toFixed(1)}%` +
            (savant_p != null ? ` / savant ${(savant_p*100).toFixed(1)}%` : "") +
            `, edge ${edgePP.toFixed(1)}pp)`,
            { ticker, contracts, yesAskCents, our_p, savant_p, market_p, edgePP, order: result });
        toast(`Bot: bought ${contracts}× ${tail} YES @ ${yesAskCents}¢`, "ok");
    } catch (e) {
        log("err", `Order failed for ${ticker}: ${e.message || e}`);
    }
}


// ── Cash-out loop ─────────────────────────────────────────────────

async function runCashoutCheck() {
    if (!_state.settings.enabled) return;
    if (!root.Kalshi || !root.Kalshi.isConnected || !root.Kalshi.isConnected()) return;

    let positions;
    try {
        positions = await root.Kalshi.getPositions();
    } catch (e) {
        log("err", `Positions fetch failed: ${e.message || e}`);
        return;
    }
    const mps = positions?.market_positions || [];
    _state.openPositions = mps;
    refreshDrawerIfOpen();

    for (const p of mps) {
        const qty = (p.position || 0);
        if (qty === 0) continue;
        // Kalshi reports YES positions as positive quantity, NO as
        // negative. We only ever BUY YES so we only cash out positive
        // positions here.
        if (qty < 0) continue;
        // Use Kalshi's reported avg cost per contract (in cents) as
        // our entry price. fees_paid is excluded from market_value.
        const entryCents = p.average_yes_price ?? p.average_cost_cents ?? null;
        if (entryCents == null) continue;

        // Live YES price from the orderbook.
        let yesAskCents = null;
        try {
            const ob = await root.Kalshi.getOrderbook(p.ticker);
            yesAskCents = orderbookYesAskCents(ob);
        } catch { /* skip */ }
        if (yesAskCents == null) continue;

        // To SELL into the book we hit the best YES BID (someone
        // willing to buy YES from us). The bid is (100 - bestYesAsk_on_other_side)
        // which the orderbook gives us as the yes side's best bid.
        const yesBidCents = orderbookYesBidCents(await root.Kalshi.getOrderbook(p.ticker));
        if (yesBidCents == null) continue;
        const profitPerContract = yesBidCents - entryCents;

        if (profitPerContract < _state.settings.profit_take_cents) continue;
        // Already have a sell order resting?
        if (await hasOpenSellOrder(p.ticker)) continue;

        // SELL.
        try {
            const result = await root.Kalshi.placeOrder({
                ticker: p.ticker,
                side:   "yes",
                count:  qty,
                price:  yesBidCents,
                action: "sell",
            });
            log("sell", `SELL ${qty}× ${p.ticker} YES @ ${yesBidCents}¢` +
                ` (entry ${entryCents}¢, +${profitPerContract}¢/contract = $${((profitPerContract*qty)/100).toFixed(2)} profit)`,
                { ticker: p.ticker, qty, yesBidCents, entryCents, profitPerContract, order: result });
            toast(`Bot: sold ${qty}× ${p.ticker} +${profitPerContract}¢/contract`, "ok");
        } catch (e) {
            log("err", `Sell failed for ${p.ticker}: ${e.message || e}`);
        }
    }
}

async function hasOpenSellOrder(ticker) {
    try {
        const orders = await root.Kalshi.getOpenOrders();
        return (orders || []).some((o) =>
            o.ticker === ticker && o.action === "sell"
        );
    } catch { return false; }
}

function computeOpenExposureCents() {
    let cents = 0;
    for (const p of _state.openPositions) {
        const qty = (p.position || 0);
        if (qty <= 0) continue;
        const entry = p.average_yes_price ?? p.average_cost_cents ?? 0;
        cents += qty * entry;
    }
    return cents;
}


// ── Orderbook helpers ─────────────────────────────────────────────

// Normalized Kalshi orderbook: { yes: [[cents,qty]...], no: [[cents,qty]...] }
// The arrays are sorted ascending; the LAST entry is the best price
// on each side. Best YES ask = 100 - best NO bid (you take the NO
// side from the orderbook to BUY YES).
function orderbookYesAskCents(ob) {
    if (!ob) return null;
    const noBook = ob.no || [];
    if (!noBook.length) return null;
    const bestNoBid = noBook[noBook.length - 1];
    const noBidCents = Number(bestNoBid[0]);
    if (!Number.isFinite(noBidCents) || noBidCents < 1 || noBidCents > 99) return null;
    return 100 - noBidCents;
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


// ── UI: drawer with Open Bets + Bot tabs ──────────────────────────

let _drawerOpen = false;

function openDrawer(initialTab = "bets") {
    if (_drawerOpen) return;
    _drawerOpen = true;
    const overlay = document.createElement("div");
    overlay.className = "bot-drawer-overlay";
    overlay.innerHTML = drawerHtml(initialTab);
    document.body.appendChild(overlay);
    bindDrawer(overlay);
    refreshDrawerContent();
}

function closeDrawer() {
    document.querySelector(".bot-drawer-overlay")?.remove();
    _drawerOpen = false;
}

function refreshDrawerIfOpen() {
    if (_drawerOpen) refreshDrawerContent();
}

function drawerHtml(initialTab) {
    return `
      <div class="bot-drawer" role="dialog" aria-modal="true">
        <header class="bot-drawer-head">
          <h2>Bets &amp; Bot</h2>
          <button class="bot-drawer-close" aria-label="Close">×</button>
        </header>
        <nav class="bot-drawer-tabs" role="tablist">
          <button class="bot-tab ${initialTab === "bets" ? "active" : ""}" data-tab="bets" role="tab">
            Open Bets <span class="bot-tab-count" data-bets-count>0</span>
          </button>
          <button class="bot-tab ${initialTab === "bot" ? "active" : ""}" data-tab="bot" role="tab">
            Bot
          </button>
        </nav>
        <div class="bot-tab-pane ${initialTab === "bets" ? "active" : ""}" data-pane="bets"></div>
        <div class="bot-tab-pane ${initialTab === "bot" ? "active" : ""}" data-pane="bot"></div>
      </div>
    `;
}

function bindDrawer(overlay) {
    overlay.querySelector(".bot-drawer-close").addEventListener("click", closeDrawer);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeDrawer();
    });
    overlay.querySelectorAll("[data-tab]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const tab = btn.dataset.tab;
            overlay.querySelectorAll("[data-tab]").forEach((b) =>
                b.classList.toggle("active", b === btn));
            overlay.querySelectorAll("[data-pane]").forEach((p) =>
                p.classList.toggle("active", p.dataset.pane === tab));
        });
    });
    const onKey = (e) => {
        if (e.key === "Escape") { closeDrawer(); document.removeEventListener("keydown", onKey); }
    };
    document.addEventListener("keydown", onKey);
}

async function refreshDrawerContent() {
    const overlay = document.querySelector(".bot-drawer-overlay");
    if (!overlay) return;
    overlay.querySelector("[data-pane='bets']").innerHTML = await renderOpenBetsPane();
    overlay.querySelector("[data-pane='bot']").innerHTML = renderBotPane();
    bindBotPaneHandlers(overlay);
    bindBetsPaneHandlers(overlay);
    // Update count chip on the Bets tab.
    const ct = overlay.querySelector("[data-bets-count]");
    if (ct) ct.textContent = String(_state.openPositions.length);
}


// ── Open Bets pane ────────────────────────────────────────────────

async function renderOpenBetsPane() {
    if (!root.Kalshi || !root.Kalshi.isConnected || !root.Kalshi.isConnected()) {
        return `
          <div class="bot-empty">
            <p>Connect Kalshi to see open positions.</p>
          </div>
        `;
    }
    let positions, orders;
    try {
        [positions, orders] = await Promise.all([
            root.Kalshi.getPositions(),
            root.Kalshi.getOpenOrders(),
        ]);
    } catch (e) {
        return `<div class="bot-empty"><p>Couldn't load positions: ${escapeText(e.message || e)}</p></div>`;
    }
    const mps = (positions?.market_positions || []).filter((p) => (p.position || 0) !== 0);
    _state.openPositions = mps;

    const resting = (orders || []);

    if (!mps.length && !resting.length) {
        return `
          <div class="bot-empty">
            <p>No open positions or resting orders.</p>
            <p class="bot-empty-sub">Bets you place (manually or via the bot) show up here.</p>
          </div>
        `;
    }
    // Live YES prices in parallel so the P/L is fresh.
    const prices = await Promise.all(mps.map(async (p) => {
        try {
            const ob = await root.Kalshi.getOrderbook(p.ticker);
            return orderbookYesBidCents(ob);
        } catch { return null; }
    }));
    const posRows = mps.map((p, i) => {
        const qty = p.position;
        const entry = p.average_yes_price ?? p.average_cost_cents ?? 0;
        const live = prices[i];
        const pl = (live != null && qty > 0)
            ? ((live - entry) * qty / 100)
            : null;
        const plCls = pl == null ? "" : pl >= 0 ? "bot-pl-pos" : "bot-pl-neg";
        return `
          <tr>
            <td class="bot-ticker">${escapeText(p.ticker)}</td>
            <td>${qty}× YES</td>
            <td>${entry}¢</td>
            <td>${live != null ? `${live}¢` : "—"}</td>
            <td class="${plCls}">${pl != null ? `${pl >= 0 ? "+" : ""}$${pl.toFixed(2)}` : "—"}</td>
            <td>
              ${live != null && qty > 0
                ? `<button class="bot-exit-btn" data-exit="${escapeText(p.ticker)}:${qty}:${live}">Exit @ ${live}¢</button>`
                : ""}
            </td>
          </tr>
        `;
    }).join("");
    const orderRows = resting.map((o) => `
      <tr>
        <td class="bot-ticker">${escapeText(o.ticker)}</td>
        <td>${escapeText(o.action || "?")} ${escapeText(o.side || "?")}</td>
        <td>${o.yes_price ?? o.no_price ?? "?"}¢</td>
        <td>${o.remaining_count ?? o.count ?? "?"}</td>
        <td>
          <button class="bot-cancel-btn" data-cancel="${escapeText(o.order_id || "")}">Cancel</button>
        </td>
      </tr>
    `).join("");
    return `
      ${mps.length ? `
        <div class="bot-section">
          <h3>Positions</h3>
          <table class="bot-table">
            <thead><tr><th>Market</th><th>Side</th><th>Entry</th><th>Live</th><th>P/L</th><th></th></tr></thead>
            <tbody>${posRows}</tbody>
          </table>
        </div>
      ` : ""}
      ${resting.length ? `
        <div class="bot-section">
          <h3>Resting orders</h3>
          <table class="bot-table">
            <thead><tr><th>Market</th><th>Action</th><th>Price</th><th>Qty</th><th></th></tr></thead>
            <tbody>${orderRows}</tbody>
          </table>
        </div>
      ` : ""}
    `;
}

function bindBetsPaneHandlers(overlay) {
    overlay.querySelectorAll("[data-exit]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const [ticker, qtyStr, priceStr] = btn.getAttribute("data-exit").split(":");
            const qty = parseInt(qtyStr, 10);
            const price = parseInt(priceStr, 10);
            if (!confirm(`Exit ${qty}× ${ticker} YES at ${price}¢?`)) return;
            btn.disabled = true;
            btn.textContent = "Selling…";
            try {
                await root.Kalshi.placeOrder({
                    ticker, side: "yes", count: qty, price, action: "sell",
                });
                log("sell", `Manual sell: ${qty}× ${ticker} YES @ ${price}¢`);
                refreshDrawerContent();
            } catch (e) {
                btn.disabled = false;
                btn.textContent = `Exit @ ${price}¢`;
                toast(`Sell failed: ${e.message || e}`, "err");
            }
        });
    });
    overlay.querySelectorAll("[data-cancel]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const id = btn.getAttribute("data-cancel");
            if (!id) return;
            if (!confirm("Cancel this resting order?")) return;
            btn.disabled = true;
            btn.textContent = "Cancelling…";
            try {
                await root.Kalshi.cancelOrder(id);
                log("cancel", `Manual cancel: ${id}`);
                refreshDrawerContent();
            } catch (e) {
                btn.disabled = false;
                btn.textContent = "Cancel";
                toast(`Cancel failed: ${e.message || e}`, "err");
            }
        });
    });
}


// ── Bot pane (toggle + settings + log) ────────────────────────────

function renderBotPane() {
    const s = _state.settings;
    const lastScan = _state.lastScanAt
        ? `${Math.round((Date.now() - _state.lastScanAt)/1000)}s ago`
        : "never";
    const logEntries = getLog();
    return `
      <div class="bot-section">
        <div class="bot-toggle-row">
          <label class="bot-toggle">
            <input type="checkbox" ${s.enabled ? "checked" : ""} data-bot-toggle>
            <span class="bot-toggle-slider"></span>
            <span class="bot-toggle-label">${s.enabled ? "Bot is ON" : "Bot is OFF"}</span>
          </label>
          ${s.enabled
            ? `<button class="bot-kill" data-bot-kill>STOP NOW</button>`
            : ""}
        </div>
        <p class="bot-status-line">
          ${s.enabled
            ? `Scanning every ${SCAN_INTERVAL_MS/1000}s · last scan ${lastScan} · daily P/L: <strong>-$${(_state.dailyLoss.cents/100).toFixed(2)}</strong> / $${(s.daily_loss_limit_cents/100).toFixed(2)} cap`
            : `Turn ON to start scanning for edges. Bot fires moneyline bets when our model AND Baseball Savant disagree with Kalshi in the same direction by more than the threshold.`}
        </p>
      </div>

      <details class="bot-section bot-settings" ${s.enabled ? "" : "open"}>
        <summary>Settings (hard caps cannot be exceeded)</summary>
        <div class="bot-settings-grid">
          <label>
            <span>Unit per fire (¢)</span>
            <input type="number" min="${HARD_CAPS.unit_cents_min}" max="${HARD_CAPS.unit_cents_max}"
                   step="5" value="${s.unit_cents}" data-bot-setting="unit_cents">
            <small>$0.${String(s.unit_cents).padStart(2,"0")} per signal · cap $${(HARD_CAPS.unit_cents_max/100).toFixed(2)}</small>
          </label>
          <label>
            <span>Edge threshold (pp)</span>
            <input type="number" min="${HARD_CAPS.edge_pp_min}" max="${HARD_CAPS.edge_pp_max}"
                   step="1" value="${s.edge_threshold_pp}" data-bot-setting="edge_threshold_pp">
            <small>Fire when our model > market by N pp · min ${HARD_CAPS.edge_pp_min}</small>
          </label>
          <label>
            <span>Profit-take (¢)</span>
            <input type="number" min="5" max="60" step="5"
                   value="${s.profit_take_cents}" data-bot-setting="profit_take_cents">
            <small>Sell winners at +N¢ per contract</small>
          </label>
          <label>
            <span>Daily loss limit ($)</span>
            <input type="number" min="1" max="${HARD_CAPS.daily_loss_cents_max/100}" step="1"
                   value="${(s.daily_loss_limit_cents/100).toFixed(0)}"
                   data-bot-setting-dollar="daily_loss_limit_cents">
            <small>Bot pauses for the day at this realized loss · cap $${(HARD_CAPS.daily_loss_cents_max/100).toFixed(0)}</small>
          </label>
          <label>
            <span>Max open exposure ($)</span>
            <input type="number" min="2" max="${HARD_CAPS.open_exposure_max/100}" step="1"
                   value="${(s.open_exposure_max/100).toFixed(0)}"
                   data-bot-setting-dollar="open_exposure_max">
            <small>Total open positions cap · ceiling $${(HARD_CAPS.open_exposure_max/100).toFixed(0)}</small>
          </label>
          <label class="bot-checkbox-label">
            <input type="checkbox" ${s.require_savant_agree ? "checked" : ""}
                   data-bot-setting-bool="require_savant_agree">
            <span>Require Baseball Savant to agree direction</span>
          </label>
        </div>
        <p class="bot-settings-note">
          Only moneyline markets are scanned. The bot won't fire on player props or spreads —
          those don't have two-engine confirmation, so they ride without a safety net.
        </p>
      </details>

      <div class="bot-section">
        <div class="bot-log-head">
          <h3>Activity</h3>
          ${logEntries.length ? `<button class="bot-clear-log" data-bot-clear-log>Clear</button>` : ""}
        </div>
        <div class="bot-log">
          ${logEntries.length
            ? logEntries.map((e) => `
              <div class="bot-log-row bot-log-${e.kind}">
                <span class="bot-log-time">${timeStr(e.ts)}</span>
                <span class="bot-log-msg">${escapeText(e.message)}</span>
              </div>
            `).join("")
            : `<div class="bot-empty-sub">No activity yet.</div>`
          }
        </div>
      </div>
    `;
}

function bindBotPaneHandlers(overlay) {
    const tog = overlay.querySelector("[data-bot-toggle]");
    if (tog) tog.addEventListener("change", () => {
        if (tog.checked) {
            if (!enable()) tog.checked = false;
        } else {
            disable();
        }
        refreshDrawerContent();
    });
    overlay.querySelector("[data-bot-kill]")?.addEventListener("click", () => {
        disable();
        refreshDrawerContent();
    });
    overlay.querySelectorAll("[data-bot-setting]").forEach((inp) => {
        inp.addEventListener("change", () => {
            const k = inp.dataset.botSetting;
            const v = parseInt(inp.value, 10);
            _state.settings = clampSettings({ ..._state.settings, [k]: v });
            persistSettings();
            refreshDrawerContent();
        });
    });
    overlay.querySelectorAll("[data-bot-setting-dollar]").forEach((inp) => {
        inp.addEventListener("change", () => {
            const k = inp.dataset.botSettingDollar;
            const v = Math.round(parseFloat(inp.value) * 100);
            _state.settings = clampSettings({ ..._state.settings, [k]: v });
            persistSettings();
            refreshDrawerContent();
        });
    });
    overlay.querySelectorAll("[data-bot-setting-bool]").forEach((inp) => {
        inp.addEventListener("change", () => {
            const k = inp.dataset.botSettingBool;
            _state.settings = clampSettings({ ..._state.settings, [k]: inp.checked });
            persistSettings();
        });
    });
    overlay.querySelector("[data-bot-clear-log]")?.addEventListener("click", () => {
        if (confirm("Clear activity log?")) {
            clearLog();
            refreshDrawerContent();
        }
    });
}


// ── Floating launcher button ──────────────────────────────────────

function renderLauncher() {
    if (document.getElementById("bot-launcher")) return;
    const btn = document.createElement("button");
    btn.id = "bot-launcher";
    btn.className = "bot-launcher";
    btn.title = "Open bets & bot";
    btn.innerHTML = `
      <span class="bot-launcher-icon">🎯</span>
      <span class="bot-launcher-label">Bets</span>
      <span class="bot-launcher-dot" data-launcher-dot hidden></span>
    `;
    btn.addEventListener("click", () => openDrawer("bets"));
    document.body.appendChild(btn);
    refreshLauncherDot();
}
function refreshLauncherDot() {
    const dot = document.querySelector("[data-launcher-dot]");
    if (!dot) return;
    dot.hidden = !_state.settings.enabled;
}


// ── Utilities ─────────────────────────────────────────────────────

function escapeText(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
    }[c]));
}
function timeStr(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
}
function toast(msg, kind = "ok") {
    if (root.Kalshi?.toast) return root.Kalshi.toast(msg, kind);
    console.log(`[bot] ${msg}`);
}


// ── Bootstrap ─────────────────────────────────────────────────────

loadState();
// Render the launcher on DOMContentLoaded (or now if already past).
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        renderLauncher();
        if (_state.settings.enabled) {
            startTimers();
            log("bot", "Resumed (session persisted)");
        }
    });
} else {
    renderLauncher();
    if (_state.settings.enabled) {
        startTimers();
        log("bot", "Resumed (session persisted)");
    }
}


// ── Public surface ────────────────────────────────────────────────

root.AutoBot = {
    enable,
    disable,
    openDrawer,
    closeDrawer,
    getSettings: () => ({ ..._state.settings }),
    setSettings: (s) => {
        _state.settings = clampSettings({ ..._state.settings, ...s });
        persistSettings();
        return { ..._state.settings };
    },
    getLog,
    runScan,
    runCashoutCheck,
};

})(typeof window !== "undefined" ? window : globalThis);
