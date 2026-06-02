// ═════════════════════════════════════════════════════════════════
// GLOBAL KILL SWITCH — set true to disable ALL bot operations
// regardless of localStorage settings. Set 2026-06-02 in response
// to user 'TURN THE BOT OFF. PULL ALL BETS RIGHT NOW.'
//
// Effect when true:
//   - enable() refuses (forces persisted setting to false)
//   - runScan() / runCashoutCheck() bail before any work
//   - placeOrder is never invoked from the bot path
//   - Drawer surfaces a banner so the user can see the kill is on
//
// To re-enable bot trading: flip this constant to `false`, deploy,
// hard-refresh. Local settings are preserved through the kill.
// ═════════════════════════════════════════════════════════════════
const BOT_KILLED = true;

// DIAMOND:CONTEXT auto-bet bot.
//
// ═════════════════════════════════════════════════════════════════
// SYSTEM OVERVIEW (as of 2026-06)
// ═════════════════════════════════════════════════════════════════
// Every 30s the bot scans every live MLB game and decides whether
// to FIRE a bet on Kalshi. Every 30s it also scans every open
// position and decides whether to SELL. Both paths route through
// the same multi-factor scoring framework (bot-scoring.js) so we
// can review every decision after-the-fact.
//
// MARKETS THE BOT TRADES:
//   1. Moneyline (game outcome) — our WE model vs Kalshi
//   2. Player props (K, HR, hits, total bases) — our prop tail
//      probabilities (model-props endpoint) vs Kalshi YES/NO
//   3. (BOTH SIDES) For props, we consider YES (over) AND NO
//      (under) — whichever has the bigger edge wins.
//
// SCORING (see bot-scoring.js for full breakdown):
//   F1 model_edge        — our_p vs market (weight 1.0)
//   F2 savant_alignment  — Savant cross-check ±1.5pp (weight 0.5)
//   F3 pitch_count       — K-prop pitcher removal risk (weight 0.8)
//   F4 pa_remaining      — hitter-prop turns left (weight 0.7)
//   F5 pitcher_recent_form — last 5 starts (weight 0.6)
//   F6 batter_recent_form  — last 15 games (weight 0.6)
//   F7 h2h               — career batter-vs-pitcher (sample weighted)
//
// CASH-OUT TRIGGERS (any one fires the sell):
//   T1 ABS    — profit ≥ profit_take_cents (default 20¢)
//   T2 EV-CAPTURE — captured ≥ live_ev_take_pct of original edge (0.55)
//   T3 LIVE-EV — live model fair within 3¢ of market price
//   T4 PITCH-COUNT — pitcher past their personal p80 (K-props only)
//   T5 HITTER — late inning + threshold met / model cooled / no PAs left
//
// SAFETY RAILS (HARD_CAPS — UI cannot bypass):
//   - 4pp edge floor (UI can't go lower than 4pp)
//   - $5 daily realized-loss limit → bot pauses for the day
//   - $20 total open exposure ceiling → bot pauses until positions close
//   - Unit per fire 25¢ – $2 (default 50¢)
//   - One bet per (ticker, side) per session
//   - Off by default; user flips the toggle to start
//
// LEARNING LOOP:
//   - Every consideration (fire / skip / cash-out) is logged with
//     full factor breakdown to localStorage["diamond_context_bot_decisions"]
//   - End-of-day: drawer → Bot tab → "EOD review" pulls Kalshi
//     settlements + grades each decision, returning factor win rates,
//     skip analysis, and weight-tuning suggestions.
//   - Suggestions are SUGGESTIONS ONLY — never auto-applied.
//
// STORAGE:
//   - localStorage: settings, session bet set, daily loss tally,
//     activity log (last 100), bot fires (last 500), scored
//     decisions (last 2000)
//   - Bot state survives page reloads; loss tally resets at UTC day
//     boundary.

(function (root) {
"use strict";


// ── Hard safety caps (UI cannot exceed these) ─────────────────────

const HARD_CAPS = {
    unit_cents_min:        25,     // $0.25 minimum
    unit_cents_max:        200,    // $2.00 maximum
    // The Pythag-baseline backtest cliff (49% at 1-2pp, 63% at
    // 2-3pp) was vs a dumb baseline. Kalshi isn't dumb. Live
    // experience (down 50% today at the 2pp default) shows the
    // 2pp signal does NOT survive an efficient market. Hard floor
    // raised to 4pp — keeps the bot above 'noise vs Kalshi.'
    edge_pp_min:           4,
    edge_pp_max:           20,
    daily_loss_cents_max:  500,    // $5 daily realized-loss limit
    open_exposure_max:     2000,   // $20 total open positions
};

const DEFAULTS = {
    enabled:               false,
    unit_cents:            50,     // $0.50 per fire (user's spec)
    // 2pp default was vs a dumb Pythag baseline. Against Kalshi
    // (efficient market) 2pp lands in the noise zone, and the
    // user is down 50% today firing on those. Raised the default
    // to 5pp — meaningfully fewer fires, but each one carries
    // real conviction. The aggressive cash-out triggers below
    // (live-EV, pitch-count, hitter-prop) lock in wins quickly,
    // so we don't need a steady stream of small edges to be
    // profitable.
    edge_threshold_pp:     5,
    // SEPARATE threshold for player props — they don't have a
    // Savant cross-check and depend on per-PA modeling that
    // needs in-game data to settle. Higher bar (7pp) until we
    // build a track record on them.
    player_prop_edge_threshold_pp: 7,
    // Don't fire moneylines before this inning. Early-game WE
    // moves on tiny events (one HR in the 1st can swing 8pp)
    // and our model has the same volatility — most of our 'edge'
    // before the 3rd is regression to mean, not real signal.
    min_inning_for_moneyline: 3,
    // Savant agreement is a SOFT confidence amplifier on
    // moneylines, not a hard gate. Three states:
    //   - Savant agrees direction → fire at base edge_threshold_pp
    //   - Savant disagrees        → require base + savant_disagree_penalty_pp
    //   - Savant has no data      → fire at base
    require_savant_agree:       false,
    savant_disagree_penalty_pp: 3,
    // Cash-out at 20¢ absolute is the safety-net trigger — locks
    // any 20¢+ winner regardless of edge math. NOT the primary
    // exit mechanism; the smarter game-state triggers below
    // (live-EV, pitch-count, hitter-late-inning) do most of the
    // work.
    profit_take_cents:     20,
    // EV-capture sell — sell when we've captured this fraction of
    // the original edge. At 0.55, lock-in slightly exceeds
    // remaining expected edge under our model:
    //   entry 35¢, fair 50¢ (15¢ edge)
    //   cash out at 35 + 0.55×15 = 43.25¢ → lock 8.25¢
    //   remaining edge from 43.25¢ to fair 50¢ = 6.75¢
    //   8.25 > 6.75 → leans slightly toward sell in EV terms.
    // Lower than this (0.45) sells BEFORE crossing the EV
    // breakeven — locking certain gain less than the remaining
    // expected gain. That trades EV for variance reduction and
    // capital recycling, which is fine for a risk-averse trader
    // but it IS giving up theoretical EV. Default stays at 0.55
    // — backed by the math above, not by 'we feel like we should
    // sell sooner.'
    live_ev_take_pct:      0.55,
    daily_loss_limit_cents: 500,   // $5 default — tightened by HARD_CAPS
    open_exposure_max:     2000,   // $20 default
    bet_player_props:      true,   // scan Kalshi player_prop markets too
    // TRUE-ADVANTAGE GATE — required confidence from the multi-factor
    // scoring framework. score.confidence is normalized 0..1 (2 factors
    // of full weight = max). 0.40 ≈ model_edge + one more confirming
    // factor, which is what 'we have a real edge here' looks like in
    // practice. Set lower for more shots, higher for fewer/better.
    min_conviction:        0.40,
    // MONEYLINE BUDGET RESERVE — FRACTION of open_exposure_max
    // held back EXCLUSIVELY for moneyline (win-expectancy) fires.
    // Player-prop exposure caps at (1 - reserve) × open_exposure_max
    // so a WE signal can always trade even when prop opportunities
    // saturate the rest. WE path itself can use the FULL cap, so
    // a 50% reserve = 'props get up to half, WE can use everything'.
    //
    // Defaults to 0.50 per user direction: 'set it at 50% available
    // on player props and 50% on WE bets.'
    moneyline_reserve_pct: 0.50,
    // HUGE-EDGE OVERRIDE — when a player prop's factor-adjusted edge
    // clears huge_edge_pp, the props cap temporarily lifts from the
    // normal (1 - reserve) to huge_edge_cap_pct. Special-circumstance
    // budget for exceptional convictions only — the multi-factor gate
    // still requires min_conviction, so this kicks in when both edge
    // AND confidence are well above normal.
    huge_edge_pp:          12,     // adjusted edge ≥ 12pp = 'huge'
    huge_edge_cap_pct:     0.60,   // cap moves 50% → 60% on those
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
        enabled:                    !!s.enabled,
        unit_cents:                 clampInt(s.unit_cents, HARD_CAPS.unit_cents_min, HARD_CAPS.unit_cents_max),
        edge_threshold_pp:          clampInt(s.edge_threshold_pp, HARD_CAPS.edge_pp_min, HARD_CAPS.edge_pp_max),
        player_prop_edge_threshold_pp: clampInt(s.player_prop_edge_threshold_pp, HARD_CAPS.edge_pp_min, HARD_CAPS.edge_pp_max),
        min_inning_for_moneyline:   clampInt(s.min_inning_for_moneyline, 1, 8),
        require_savant_agree:       !!s.require_savant_agree,
        savant_disagree_penalty_pp: clampInt(s.savant_disagree_penalty_pp, 0, 10),
        profit_take_cents:          clampInt(s.profit_take_cents, 5, 60),
        live_ev_take_pct:           clampFloat(s.live_ev_take_pct, 0.2, 0.95),
        daily_loss_limit_cents:     clampInt(s.daily_loss_limit_cents, 100, HARD_CAPS.daily_loss_cents_max),
        open_exposure_max:          clampInt(s.open_exposure_max, 200, HARD_CAPS.open_exposure_max),
        min_conviction:             clampFloat(s.min_conviction, 0, 1),
        moneyline_reserve_pct:      clampFloat(s.moneyline_reserve_pct, 0, 0.95),
        huge_edge_pp:               clampInt(s.huge_edge_pp, HARD_CAPS.edge_pp_min, HARD_CAPS.edge_pp_max),
        huge_edge_cap_pct:          clampFloat(s.huge_edge_cap_pct, 0.20, 0.95),
        bet_player_props:           s.bet_player_props !== false,
    };
}
function clampFloat(n, lo, hi) {
    const x = parseFloat(n);
    if (!Number.isFinite(x)) return lo;
    return Math.min(hi, Math.max(lo, x));
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
    if (BOT_KILLED) {
        // Hard kill — force-persist OFF so a refresh / reload also
        // sees the disabled state. Toast loud so the user sees it.
        _state.settings.enabled = false;
        persistSettings();
        stopTimers();
        toast("Bot is globally killed — cannot enable", "err");
        log("bot", "Bot enable REFUSED — global kill switch is on");
        return false;
    }
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
    if (BOT_KILLED) return;             // global kill — never scan
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
            const lossDollars  = (_state.dailyLoss.cents / 100).toFixed(2);
            const limitDollars = (_state.settings.daily_loss_limit_cents / 100).toFixed(2);
            log("halt", `Daily loss limit hit ($${lossDollars}); bot will resume tomorrow`);
            // Notify — bot has stopped on its own; user should decide
            // whether to raise the limit, stop for the day, or accept.
            notify({
                level:      "warn",
                title:      "Daily loss limit reached — bot paused",
                body:       `Realized loss $${lossDollars} ≥ limit $${limitDollars}. ` +
                            `Bot stopped trading for today. Adjust the limit in Settings if you want it to resume.`,
                dedupe_key: `daily-loss-hit:${todayUtcDate()}`,
            });
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
        // Balance check — bail before even fetching games if Kalshi
        // says we can't afford a single contract. Avoids hammering
        // the rest of the stack with scans whose only outcome would
        // be a stream of "Order failed: insufficient funds" errors.
        // We compare to the smallest possible contract spend
        // (1¢ minimum on Kalshi); the per-fire balance check inside
        // checkAndMaybeFire enforces the actual ask + unit_cents.
        if (root.Kalshi && root.Kalshi.getBalance) {
            try {
                const balanceCents = await root.Kalshi.getBalance();
                if (balanceCents != null && balanceCents < 1) {
                    log("halt", `Kalshi balance $${(balanceCents/100).toFixed(2)} — nothing to bet with; skipping scan`);
                    // Track consecutive zero-balance scans — one is
                    // a flicker (settlement in flight), three is the
                    // user actually needs to deposit.
                    root._botZeroBalScans = (root._botZeroBalScans || 0) + 1;
                    if (root._botZeroBalScans >= 3) {
                        notify({
                            level:      "warn",
                            title:      "Kalshi balance below $0.01",
                            body:       "3 scans in a row hit a zero balance — nothing to bet with. " +
                                        "Deposit on Kalshi or lower the unit size to keep trading.",
                            dedupe_key: "balance-zero",
                            action: { label: "Open Kalshi", href: "https://kalshi.com/account/deposit" },
                        });
                    }
                    _state.lastScanAt = Date.now();
                    return;
                }
                // Reset streak on any positive balance.
                root._botZeroBalScans = 0;
            } catch { /* If balance fetch fails, fall through to per-fire check */ }
        }
        // Auth-loss check — if we were previously connected and now
        // aren't (token expired mid-session), surface it. Otherwise
        // the bot silently does nothing while every scan no-ops.
        if (root.Kalshi && root.Kalshi.isConnected && !root.Kalshi.isConnected()) {
            notify({
                level:      "error",
                title:      "Kalshi disconnected — reconnect to resume",
                body:       "Bot can't place or sell orders without an active Kalshi session. " +
                            "Click the Kalshi pill (top-right) to reconnect.",
                dedupe_key: "kalshi-disconnected",
            });
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
    // Pull markets (for moneyline + player_prop Kalshi quotes) and
    // model-props (player-level probabilities) in parallel.
    const [marketsRes, modelPropsRes] = await Promise.all([
        fetch(`/api/game/${g.game_pk}/markets`),
        _state.settings.bet_player_props
            ? fetch(`/api/game/${g.game_pk}/model-props`).catch(() => null)
            : Promise.resolve(null),
    ]);
    if (!marketsRes.ok) throw new Error(`markets HTTP ${marketsRes.status}`);
    const d = await marketsRes.json();

    const ourHome    = d.our_we_home;
    const savantHome = d.savant_we_home;

    // 1) Moneyline edges (our WE table vs Kalshi, with Savant as a
    //    confidence amplifier). Gated on inning ≥ min_inning_for_
    //    moneyline — early-game WE moves on tiny events, our edge
    //    there is mostly variance.
    if (ourHome != null) {
        const gInning = parseInt(g.inning, 10) || 0;
        if (gInning >= _state.settings.min_inning_for_moneyline) {
            const moneylines = (d.markets?.moneyline || []).filter((m) => m.source === "kalshi");
            for (const m of moneylines) {
                await checkAndMaybeFire(g, m, ourHome, savantHome);
            }
        }
    }

    // 2) Player-prop edges (our model-props endpoint vs Kalshi).
    //    Savant doesn't cover player props, so we run those through
    //    the same fire logic with savantStance = "no_data" (no
    //    threshold penalty applied).
    if (_state.settings.bet_player_props && modelPropsRes && modelPropsRes.ok) {
        try {
            const mp = await modelPropsRes.json();
            if (mp.available !== false) {
                await scanPlayerProps(g, d, mp);
            }
        } catch (e) {
            log("err", `Player-prop scan failed for ${g.away}@${g.home}: ${e.message || e}`);
        }
    }
}

// Player-prop scan: for each Kalshi player_prop market in the game,
// parse the title for (player name, threshold, stat), look up our
// model's probability from the model-props payload, and fire if the
// edge exceeds the base threshold. No Savant gate here — they don't
// publish player-level probabilities.
async function scanPlayerProps(g, marketsData, modelProps) {
    const kalshiPP = (marketsData.markets?.player_prop || []).filter((m) => m.source === "kalshi");
    if (!kalshiPP.length) return;

    const nameToMlbam = modelProps.name_to_mlbam || {};
    const modelData   = modelProps.model_props   || {};

    // Identify each side's starter for the pitcher_id used by the
    // recent-form factor. Lineups payload from model-props has both.
    const lineups = modelProps.lineups || {};
    const homePitcher = lineups.home?.pitcher_id || null;
    const awayPitcher = lineups.away?.pitcher_id || null;

    for (const m of kalshiPP) {
        // Parse "Vinnie Pasquantino: 1+ home runs?" into
        // (player, threshold, stat).
        const parsed = parsePropTitle(m.title || "");
        if (!parsed) continue;
        const mlbam = nameToMlbam[normName(parsed.player)];
        if (!mlbam) continue;
        const ladder = modelData[mlbam]?.[parsed.stat];
        if (!ladder) continue;
        const our_p_yes = ladder[parsed.threshold];
        if (our_p_yes == null) continue;

        // Live YES + NO ask for THIS Kalshi ticker. We can bet
        // EITHER side — whichever has the bigger edge wins.
        const idMatch = String(m.outcomes?.[0]?.id || "").match(/^(.*):(yes|no)$/i);
        const ticker = idMatch ? idMatch[1] : (m.raw_market_id || "");
        if (!ticker) continue;
        const ob = await root.Kalshi.getOrderbook(ticker);
        const yesAskCents = orderbookYesAskCents(ob);
        const noAskCents  = orderbookNoAskCents(ob);
        if (yesAskCents == null && noAskCents == null) continue;

        // Compute edge on BOTH sides — the YES side bets the over,
        // the NO side bets the under. our_p_no = 1 - our_p_yes.
        const yes_market_p = yesAskCents != null ? yesAskCents / 100 : null;
        const no_market_p  = noAskCents  != null ? noAskCents  / 100 : null;
        const yes_edge_pp  = (yes_market_p != null) ? (our_p_yes - yes_market_p) * 100 : -Infinity;
        const no_our_p     = 1 - our_p_yes;
        const no_edge_pp   = (no_market_p  != null) ? (no_our_p   - no_market_p)  * 100 : -Infinity;

        // Pick the side with the bigger edge. Threshold check is
        // applied AFTER the pick so the scoring/logging path knows
        // which side we were considering.
        const chooseNo = no_edge_pp > yes_edge_pp;
        const side          = chooseNo ? "no"          : "yes";
        const askCents      = chooseNo ? noAskCents    : yesAskCents;
        const market_p      = chooseNo ? no_market_p   : yes_market_p;
        const our_p         = chooseNo ? no_our_p      : our_p_yes;
        const edgePP        = chooseNo ? no_edge_pp    : yes_edge_pp;

        // ── SANITY GATES — refuse trades the orderbook can't actually
        // support, even if the math says enormous edge. These are the
        // 'Gleyber Torres under 1 HR at 1¢' class of fires: the listed
        // ask is at floor, our model says 92%, math says +91pp edge,
        // but the offer is either stale, fat-fingered, or 1 contract
        // deep behind a 90¢ wall. Real fills at those prices basically
        // never happen on liquid Kalshi markets, and when they do, we'd
        // be transacting against someone making a mistake — not actual
        // edge. Skip them entirely.

        // 1) Floor-ask guard. NO ask of 0-2¢ implies the market thinks
        //    YES is 98-100% likely. If our model agrees (our_p < 5%),
        //    edge is tiny → handled by edge threshold. If our model
        //    disagrees massively (e.g., our_p = 92%), the disagreement
        //    is the bug, not the opportunity. Same logic applies to
        //    YES asks at floor.
        if (askCents != null && askCents <= 2) {
            log("skip", `Floor-ask guard — ${parsed.player} ${parsed.threshold}+ ${parsed.stat} ${side.toUpperCase()} at ${askCents}¢: market priced at floor, model edge can't be trusted at the tail (raw edge ${edgePP.toFixed(1)}pp)`);
            continue;
        }

        // 2) Orderbook coherence — YES ask + NO ask should sum to
        //    around 100¢ on a real two-sided market. If the sum is
        //    well below 100, the book is broken/thin/stale and our
        //    edge math against either side is unreliable.
        if (yesAskCents != null && noAskCents != null) {
            const askSum = yesAskCents + noAskCents;
            if (askSum < 85 || askSum > 115) {
                log("skip", `Orderbook coherence — ${parsed.player} ${parsed.threshold}+ ${parsed.stat}: YES+NO asks = ${askSum}¢ (expected ~100); book is broken or thin`);
                continue;
            }
        }

        // 3) Tail-probability guard — when our model's belief on the
        //    side we'd take is > 95%, we're in the tail of the
        //    distribution where calibration is worst. Even if the
        //    market mispriced, the EV math (+99×1¢ - 1×0¢ → looks
        //    huge) overweights the upside that almost never fills.
        if (our_p > 0.95) {
            log("skip", `Tail-probability guard — ${parsed.player} ${parsed.threshold}+ ${parsed.stat} ${side.toUpperCase()}: our_p ${(our_p*100).toFixed(1)}% is past 95% calibration ceiling`);
            continue;
        }

        // 4) THRESHOLD-ALREADY-CROSSED guard. User flag: 'You took
        //    the Wenceel under right after he hit a homer.' Cause:
        //    market YES = ~99¢ post-event, market NO = ~1¢, our
        //    model's tail probability hasn't refreshed to reflect
        //    the realized HR, so it still says 92% NO. The "edge"
        //    is the model lagging the event, not actual mispricing.
        //
        //    Refuse to fire when the player's REALIZED stat already
        //    crosses (or meets) the threshold. For NO bets that's
        //    a guaranteed loss; for YES bets it's a guaranteed win
        //    with no upside left to pay for. Both cases, skip.
        const liveStat = liveStatForBet(modelProps, mlbam, parsed.stat);
        if (liveStat != null && liveStat >= parsed.threshold) {
            log("skip", `Already crossed — ${parsed.player} has ${liveStat} ${parsed.stat} ≥ threshold ${parsed.threshold}; ${side.toUpperCase()} ${side === "no" ? "can't win" : "already won, no upside"}`);
            continue;
        }

        // 5) PITCHER-PULLED guard (K-props only). Generalizes the
        //    Wenceel principle: if the K-prop market re-priced
        //    because the starter is out, our K-rate model is using
        //    a pitcher who isn't on the mound. Same 'odds great for
        //    a reason we don't see' failure mode.
        //
        //    Detection: starter's pitch count past p80 + 10 = pull
        //    imminent or already happened. Cross-checked against
        //    the live pitcher feed (getLivePitcherInfo). NO K bets
        //    are extra dangerous here — they look incredibly cheap
        //    because the over-N-K bet is essentially settled.
        if (parsed.stat === "strikeouts") {
            const pInfo = await getLivePitcherInfo(g.game_pk, parsed.player);
            if (pInfo) {
                const { pitchesThrown, profile } = pInfo;
                const p80     = profile?.p80_pitches || 95;
                const limit   = p80 + 10;
                if (pitchesThrown >= limit) {
                    log("skip", `Pitcher-pulled guard — ${parsed.player} at ${pitchesThrown} pitches (p80+10 = ${limit}); starter likely out, K model is stale`);
                    continue;
                }
            }
        }

        // 6) PA-EXHAUSTION guard (hitter props). If there are <0.5
        //    turns remaining for the lineup, the batter is unlikely
        //    to get another PA — the market knows this, prices
        //    accordingly, and our model still allocates expected
        //    contributions. Same family of failure.
        if (parsed.stat !== "strikeouts") {
            const turnsLeft = modelProps?.game_state?.turns_remaining;
            if (typeof turnsLeft === "number" && turnsLeft < 0.5) {
                log("skip", `PA-exhaustion guard — ${parsed.player} ${parsed.threshold}+ ${parsed.stat} ${side.toUpperCase()}: only ${turnsLeft.toFixed(2)} turns left, model can't move from here`);
                continue;
            }
        }

        // Determine opposing pitcher for hitter props (used by H2H
        // factor); the K-prop path already targets the SAME pitcher.
        let oppPitcherId = null;
        let pitcherId    = null;
        if (parsed.stat === "strikeouts") {
            pitcherId = mlbam;   // bet IS this pitcher
        } else {
            // Hitter prop — find which lineup the batter is on,
            // opposing pitcher is the OTHER side's starter.
            const onHome = (lineups.home?.batters || []).some((b) => String(b.mlbam) === String(mlbam));
            oppPitcherId = onHome ? awayPitcher : homePitcher;
        }

        // Build scored opportunity (multi-factor) before fire/skip
        // gates so every consideration is logged.
        const score = root.BotScoring ? await root.BotScoring.scoreBet({
            kind:          "player_prop",
            game_pk:       g.game_pk,
            matchup:       `${g.away}@${g.home}`,
            ticker,
            side,
            market_p,
            yes_ask_cents: askCents,
            our_p,
            savant_p:      null,
            player:        parsed.player,
            stat:          parsed.stat,
            threshold:     parsed.threshold,
            batter_id:     parsed.stat === "strikeouts" ? null : mlbam,
            pitcher_id:    pitcherId || oppPitcherId,
            game_state:    modelProps.game_state || null,
        }) : null;

        // No Savant signal for player props, no maturity track record
        // — use the SEPARATE prop threshold (default 7pp, higher than
        // the 5pp moneyline bar) until we've earned confidence.
        const propThreshold = _state.settings.player_prop_edge_threshold_pp;
        if (edgePP < propThreshold) {
            if (score) root.BotScoring.logScoredDecision(score, {
                action: "skip", reason: "edge_below_threshold",
                threshold_pp: propThreshold,
                side,
            });
            continue;
        }

        // TRUE-ADVANTAGE GATE (props) — same multi-factor gate the
        // moneyline path uses. Adjusted edge from scoreBet sums
        // model_edge + pitch_count (Ks) / pa_remaining (hitters) +
        // pitcher_recent_form + batter_recent_form + h2h. When all
        // those factors point the same direction as the model, the
        // adjusted edge is stronger than the raw 7pp; when they
        // disagree the bot would be guessing — refuse the trade.
        if (score) {
            const adjEdge = Number(score.edge_pp) || 0;
            const conf    = Number(score.confidence) || 0;
            const minConf = _state.settings.min_conviction;
            if (adjEdge < propThreshold) {
                root.BotScoring.logScoredDecision(score, {
                    action: "skip", reason: "adjusted_edge_below_threshold",
                    threshold_pp: propThreshold, raw_edge_pp: edgePP, side,
                });
                continue;
            }
            if (conf < minConf) {
                root.BotScoring.logScoredDecision(score, {
                    action: "skip", reason: "confidence_below_min_conviction",
                    min_conviction: minConf, side,
                });
                continue;
            }
        }

        // Session key includes the side so we don't re-fire after
        // a swing in market price + side flip on the same ticker.
        const key = `${ticker}:${side}`;
        if (_state.sessionBets.has(key)) continue;

        const contracts = Math.floor(_state.settings.unit_cents / askCents);
        if (contracts < 1) continue;
        const tradeCostCents = contracts * askCents;
        // MONEYLINE BUDGET RESERVE — player props cap at
        // (1 - reserve_pct) × open_exposure_max NORMALLY. HUGE-EDGE
        // OVERRIDE: when the factor-adjusted edge for this prop is
        // big enough (≥ huge_edge_pp, default 12pp), the cap lifts
        // to huge_edge_cap_pct (default 60%) so genuinely strong
        // signals aren't blocked just to protect the WE budget.
        //
        // Multi-factor gate above already required min_conviction +
        // adjusted edge ≥ 7pp, so a 12pp adjusted edge means several
        // factors are strongly confirming. Safe to push harder.
        //
        // Moneyline path has no reservation — it can still use the
        // full cap including the reserved half.
        const adjEdgePP    = score ? (Number(score.edge_pp) || edgePP) : edgePP;
        const isHugeEdge   = adjEdgePP >= _state.settings.huge_edge_pp;
        const propsCapPct  = isHugeEdge
            ? _state.settings.huge_edge_cap_pct
            : (1 - _state.settings.moneyline_reserve_pct);
        const propsCapCents = Math.round(_state.settings.open_exposure_max * propsCapPct);
        if (computeOpenExposureCents() + tradeCostCents > propsCapCents) {
            if (score) root.BotScoring.logScoredDecision(score, {
                action: "skip", reason: "moneyline_reserve_protected",
                cap_cents:     propsCapCents,
                cap_pct:       propsCapPct,
                is_huge_edge:  isHugeEdge,
                adjusted_edge_pp: adjEdgePP,
                side,
            });
            continue;
        }
        // Log when we INVOKE the huge-edge override so it shows up in
        // EOD review — special circumstance, want to see how often
        // it fires and whether those bets actually win.
        if (isHugeEdge) {
            log("buy", `HUGE EDGE override — ${parsed.player} ${parsed.threshold}+ ${parsed.stat} adj ${adjEdgePP.toFixed(1)}pp, props cap raised to ${(propsCapPct*100).toFixed(0)}%`);
        }
        // Same hard balance guard as moneyline path — refuse to even
        // submit the order if Kalshi balance can't cover it.
        if (!(await canAfford(tradeCostCents))) {
            log("skip", `Skip player_prop ${parsed.player} ${parsed.threshold}+ ${parsed.stat} [${side}]: balance below ${tradeCostCents}¢`);
            continue;
        }

        try {
            const result = await root.Kalshi.placeOrder({
                ticker, side, count: contracts, price: askCents, action: "buy",
            });
            // Invalidate balance cache so the NEXT canAfford check
            // in this same scan sees the post-trade balance, not
            // the pre-trade cached value. Was the root cause of the
            // 'insufficient balance' burst in the EOD log.
            if (root.Kalshi.invalidateBalanceCache) {
                root.Kalshi.invalidateBalanceCache();
            }
            // Any successful order resets the insufficient-funds streak.
            root._botInsufStreak = 0;
            _state.sessionBets.add(key);
            persistSessionBets();
            // Capture the FULL context for forward analysis.
            recordFiredBet({
                kind:          "player_prop",
                ticker,
                side,
                contracts,
                price_cents:   askCents,
                our_p,           // our probability of THIS side winning
                our_p_yes,       // the original YES-side model for reference
                savant_p:      null,
                market_p,
                edge_pp:       edgePP,
                game_pk:       g.game_pk,
                matchup:       `${g.away}@${g.home}`,
                player:        parsed.player,
                stat:          parsed.stat,
                threshold:     parsed.threshold,
                placed_at:     new Date().toISOString(),
                order_response: result,
            });
            if (score) root.BotScoring.logScoredDecision(score, {
                action: "fire", ticker, contracts, price_cents: askCents, side,
            });
            const dirLabel = side === "no" ? "UNDER" : "OVER";
            log("buy", `BUY ${contracts}× ${parsed.player} ${dirLabel} ${parsed.threshold}+ ${parsed.stat} ` +
                `@ ${askCents}¢ (our ${(our_p*100).toFixed(1)}% / market ${(market_p*100).toFixed(1)}%, edge ${edgePP.toFixed(1)}pp)`,
                { ticker, side, contracts, askCents, our_p, market_p, edgePP });
            toast(`Bot: ${parsed.player} ${dirLabel} ${parsed.threshold} ${parsed.stat} @ ${askCents}¢`, "ok");
            // Inter-fire pause — prevents burst-firing past Kalshi's
            // rate limit (EOD log showed 6 fires in 6 seconds
            // triggering 'too many requests' rejections).
            await sleep(800);
        } catch (e) {
            const msg = String(e?.message || e);
            log("err", `Player-prop order failed for ${ticker} [${side}]: ${msg}`);
            // Back off harder on rate-limit errors so subsequent
            // fires in the loop don't double down on a rejection.
            if (/too many requests|rate.?limit|429/i.test(msg)) {
                log("halt", "Kalshi rate limit hit — pausing 10s before next fire");
                await sleep(10000);
            } else if (/insufficient/i.test(msg)) {
                // Balance was actually low at order time despite
                // canAfford check — force-refresh cache so the next
                // iteration sees truth.
                if (root.Kalshi.invalidateBalanceCache) {
                    root.Kalshi.invalidateBalanceCache();
                }
                // Streak counter: 5 in a row = user needs to deposit
                // or lower unit size.
                root._botInsufStreak = (root._botInsufStreak || 0) + 1;
                if (root._botInsufStreak >= 5) {
                    notify({
                        level:      "warn",
                        title:      "Kalshi balance too low for new orders",
                        body:       `5 consecutive orders rejected for insufficient funds. ` +
                                    `Deposit on Kalshi or lower the unit size in Settings.`,
                        dedupe_key: "insufficient-funds",
                        action: { label: "Open Kalshi", href: "https://kalshi.com/account/deposit" },
                    });
                }
            }
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePropTitle(title) {
    const m = String(title || "").trim().match(/^(.+?):\s*(\d+)\+\s+(.+?)\??$/);
    if (!m) return null;
    const player    = m[1].trim();
    const threshold = parseInt(m[2], 10);
    const statText  = m[3].toLowerCase().trim();
    let stat = null;
    if (/strikeouts?\b/.test(statText))                  stat = "strikeouts";
    else if (/home runs?\b|\bhrs?\b/.test(statText))     stat = "home_runs";
    else if (/total bases?\b/.test(statText))            stat = "total_bases";
    else if (/hits?\b/.test(statText))                   stat = "hits";
    if (!stat) return null;
    return { player, threshold, stat };
}
function normName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

    // Savant stance — three states:
    //   "agree"     → Savant also thinks YES is mispriced too cheap
    //   "disagree"  → Savant thinks the market is right (or YES is overpriced)
    //   "no_data"   → no Savant WP for this state (pregame or PA gap)
    let savantStance = "no_data";
    if (savant_p != null) {
        savantStance = (savant_p > market_p) ? "agree" : "disagree";
    }

    // Build the scored decision early — used both to gate the
    // fire AND to log every considered opportunity (fired or not).
    const score = root.BotScoring ? await root.BotScoring.scoreBet({
        kind:          "moneyline",
        game_pk:       g.game_pk,
        matchup:       `${g.away}@${g.home}`,
        ticker,
        side:          "yes",
        market_p,
        yes_ask_cents: yesAskCents,
        our_p,
        savant_p,
        inning:        g.inning || null,
    }) : null;

    // HARD-gate mode (when the user explicitly enables
    // require_savant_agree): keep the original strict behavior.
    if (_state.settings.require_savant_agree && savantStance !== "agree") {
        if (score) root.BotScoring.logScoredDecision(score, {
            action: "skip", reason: "savant_disagree_hard_gate",
        });
        return;
    }

    // SOFT-gate mode (default): Savant raises the bar when it
    // disagrees. Our model needs MORE conviction to override.
    const effectiveThreshold = _state.settings.edge_threshold_pp + (
        savantStance === "disagree" ? _state.settings.savant_disagree_penalty_pp : 0
    );
    if (edgePP < effectiveThreshold) {
        if (score) root.BotScoring.logScoredDecision(score, {
            action: "skip", reason: "edge_below_threshold",
            threshold_pp: effectiveThreshold,
        });
        return;
    }

    // TRUE-ADVANTAGE GATE — the raw model edge cleared the bar, but
    // we ALSO require the multi-factor framework to confirm. score
    // sums up model_edge + savant + pitcher_recent_form (others
    // are prop-only). When factors agree, score.edge_pp >= raw
    // edge AND confidence climbs. When they disagree, the adjusted
    // edge shrinks toward zero and we want NO TRADE — disagreement
    // is the bot betting against itself.
    //
    // Two conditions both required:
    //   (a) adjusted edge after factor weighting still ≥ threshold
    //   (b) confidence ≥ min_conviction (default 0.40 = ~2 medium
    //       factors firing, or model_edge + one strong confirmation)
    if (score) {
        const adjEdge   = Number(score.edge_pp) || 0;
        const conf      = Number(score.confidence) || 0;
        const minConf   = _state.settings.min_conviction;
        if (adjEdge < effectiveThreshold) {
            root.BotScoring.logScoredDecision(score, {
                action: "skip", reason: "adjusted_edge_below_threshold",
                threshold_pp: effectiveThreshold, raw_edge_pp: edgePP,
            });
            return;
        }
        if (conf < minConf) {
            root.BotScoring.logScoredDecision(score, {
                action: "skip", reason: "confidence_below_min_conviction",
                min_conviction: minConf,
            });
            return;
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
    // Hard balance check — if Kalshi reports less cash than this
    // specific order would cost, skip silently. Without this we
    // generate a Kalshi "insufficient_funds" error per fire which
    // pollutes the log and burns rate limit.
    if (!(await canAfford(tradeCostCents))) {
        log("skip", `Skip ${ticker}: balance below ${tradeCostCents}¢ trade cost`);
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
        root._botInsufStreak = 0;
        _state.sessionBets.add(key);
        persistSessionBets();
        recordFiredBet({
            kind:        "moneyline",
            ticker,
            side:        "yes",
            contracts,
            price_cents: yesAskCents,
            our_p,
            savant_p,
            market_p,
            edge_pp:     edgePP,
            savant_stance: savantStance,
            game_pk:     g.game_pk,
            matchup:     `${g.away}@${g.home}`,
            bet_team:    tail,
            placed_at:   new Date().toISOString(),
            order_response: result,
        });
        if (score) root.BotScoring.logScoredDecision(score, {
            action:      "fire",
            ticker,
            contracts,
            price_cents: yesAskCents,
        });
        log("buy", `BUY ${contracts}× ${tail} YES @ ${yesAskCents}¢` +
            ` (our ${(our_p*100).toFixed(1)}% / market ${(market_p*100).toFixed(1)}%` +
            (savant_p != null ? ` / savant ${(savant_p*100).toFixed(1)}% [${savantStance}]` : " [no Savant data]") +
            `, edge ${edgePP.toFixed(1)}pp)`,
            { ticker, contracts, yesAskCents, our_p, savant_p, market_p, edgePP, savantStance, order: result });
        toast(`Bot: bought ${contracts}× ${tail} YES @ ${yesAskCents}¢`, "ok");
        // Invalidate balance cache + inter-fire pause to avoid
        // race-conditioning Kalshi's rate limit (same fix as
        // scanPlayerProps — see EOD log).
        if (root.Kalshi.invalidateBalanceCache) root.Kalshi.invalidateBalanceCache();
        await sleep(800);
    } catch (e) {
        const msg = String(e?.message || e);
        log("err", `Order failed for ${ticker}: ${msg}`);
        if (/too many requests|rate.?limit|429/i.test(msg)) {
            log("halt", "Kalshi rate limit hit — pausing 10s before next fire");
            await sleep(10000);
        } else if (/insufficient/i.test(msg)) {
            if (root.Kalshi.invalidateBalanceCache) root.Kalshi.invalidateBalanceCache();
            root._botInsufStreak = (root._botInsufStreak || 0) + 1;
            if (root._botInsufStreak >= 5) {
                notify({
                    level:      "warn",
                    title:      "Kalshi balance too low for new orders",
                    body:       `5 consecutive orders rejected for insufficient funds. ` +
                                `Deposit on Kalshi or lower the unit size in Settings.`,
                    dedupe_key: "insufficient-funds",
                    action: { label: "Open Kalshi", href: "https://kalshi.com/account/deposit" },
                });
            }
        }
    }
}

// Persistent record of every bet the bot fires. This is what we'll
// analyze next week to do a REAL backtest — the model probabilities,
// the market price at fire-time, the actual outcome. localStorage
// holds the last 500 fires; export-to-clipboard happens via the
// drawer's "Export fires (JSON)" button.
const LS_FIRES = "diamond_context_bot_fires";
const FIRES_MAX = 500;
function recordFiredBet(payload) {
    let arr;
    try { arr = JSON.parse(localStorage.getItem(LS_FIRES) || "[]"); }
    catch { arr = []; }
    arr.unshift(payload);
    if (arr.length > FIRES_MAX) arr.length = FIRES_MAX;
    try { localStorage.setItem(LS_FIRES, JSON.stringify(arr)); } catch {}
}
function getFires() {
    try { return JSON.parse(localStorage.getItem(LS_FIRES) || "[]"); }
    catch { return []; }
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

    // Build a ticker → fire lookup so we can correlate each open
    // position with the model probability that triggered the buy.
    // That's what makes the edge-capture cash-out possible: we need
    // our_p at entry to compute "captured 55% of edge yet?"
    const fires = getFires();
    const fireByTicker = new Map();
    for (const f of fires) {
        if (f.ticker && !fireByTicker.has(f.ticker)) fireByTicker.set(f.ticker, f);
    }

    for (const p of mps) {
        const rawQty = (p.position || 0);
        if (rawQty === 0) continue;
        // Kalshi reports YES positions as POSITIVE quantity and NO
        // positions as NEGATIVE. We now support both: positive qty
        // → we hold YES, sell into YES bid; negative qty → we hold
        // NO, sell into NO bid (= 100 - YES ask).
        const heldSide = rawQty > 0 ? "yes" : "no";
        const qty      = Math.abs(rawQty);
        // Use Kalshi's reported avg cost per contract (in cents) as
        // our entry price. fees_paid is excluded from market_value.
        const entryCents = p.average_yes_price ?? p.average_cost_cents ?? null;
        if (entryCents == null) continue;

        // Single orderbook fetch — was previously doing it TWICE
        // (once for ask, once for bid) which doubled latency on
        // every cash-out loop. One call, both extractions.
        let ob = null;
        try { ob = await root.Kalshi.getOrderbook(p.ticker); } catch { /* skip */ }
        if (!ob) continue;
        // Pull the bid for whichever side we hold — when we hold YES
        // we sell into YES bid, when we hold NO we sell into NO bid
        // (= 100 - YES ask). Same math from here forward; the only
        // change is which price we compare to entry.
        const liveBidCents = heldSide === "yes"
            ? orderbookYesBidCents(ob)
            : orderbookNoBidCents(ob);
        if (liveBidCents == null) continue;
        const profitPerContract = liveBidCents - entryCents;
        // Legacy local name kept so the rest of this function reads
        // unchanged — it points to the side-appropriate bid.
        const yesBidCents = liveBidCents;

        // Two independent cash-out triggers — whichever fires first
        // wins. Both have to be a net WIN (no stop-loss here; that's
        // the daily_loss_limit's job).
        //
        // 1) ABSOLUTE: live profit per contract >= profit_take_cents.
        //    Default 20¢ — a comfortable lock-in for any size bet.
        //
        // 2) EV-CAPTURE: we've captured live_ev_take_pct of the edge
        //    our model expected at fire time. Math:
        //      edge_to_fair = (our_p × 100) - entry_cents
        //      captured     = live_bid - entry_cents
        //      fraction     = captured / edge_to_fair
        //    Default 0.55 → "lock in once we're more than halfway to
        //    our model's fair value." This is the win the user asked
        //    for: when the market has moved in our favor and our
        //    capital is tied up earning slower than a fresh edge
        //    would, take the profit and let the next scan redeploy.
        const fire = fireByTicker.get(p.ticker);
        const ourPCents = (fire?.our_p != null) ? Math.round(fire.our_p * 100) : null;
        const edgeToFair = (ourPCents != null) ? (ourPCents - entryCents) : null;
        const captureFraction = (edgeToFair != null && edgeToFair > 0)
            ? (yesBidCents - entryCents) / edgeToFair
            : null;

        const hitAbsolute = profitPerContract >= _state.settings.profit_take_cents;
        const hitEvCapture = captureFraction != null
            && captureFraction >= _state.settings.live_ev_take_pct
            && profitPerContract > 0;

        // THIRD trigger — LIVE EV. The previous two use the model
        // probability at FIRE TIME (fire.our_p). That's stale once
        // the game has moved on: a "Chourio 5+ TB" bet that was a
        // 15% shot pregame might be 75% after he banks 3 TB by the
        // 5th inning. The market will have caught up too.
        //
        // For player props, refetch our live model probability for
        // the current state, and sell when the market price has
        // moved within `live_ev_take_cents` of that LIVE fair value.
        // No edge left → take the locked-in profit and free capital
        // for the next scan to redeploy.
        let hitLiveEv = false;
        let liveEvDetail = "";
        if (fire?.kind === "player_prop" && fire.game_pk && fire.player && fire.stat && fire.threshold) {
            // getLivePlayerPropPCents returns the YES-side tail
            // probability. For a NO holding, our side's fair value
            // is (100 - YES). Previous code compared YES-fair to
            // the NO-bid which fired premature sells on every NO
            // position. Side-aware now.
            const livePCentsYes = await getLivePlayerPropPCents(fire);
            const livePCents = livePCentsYes == null ? null
                             : (heldSide === "no" ? 100 - livePCentsYes : livePCentsYes);
            if (livePCents != null && profitPerContract > 0) {
                const liveEdgeRemaining = livePCents - yesBidCents;
                if (liveEdgeRemaining <= 3) {
                    hitLiveEv = true;
                    liveEvDetail = `live ${livePCents}¢ vs mkt ${yesBidCents}¢ (${heldSide.toUpperCase()}), only ${liveEdgeRemaining}¢ left`;
                }
            }
        }

        // FOURTH trigger — STARTER PITCH-COUNT FORCE SELL, now
        // pitcher-aware. The DeGrom-at-91 case: when the manager
        // is about to pull a starter, our 'X+ K' position drops
        // toward zero — sell before that happens.
        //
        // Each starter has a personal hook point; using a global
        // 85/95/105 ramp punishes workhorses (Verlander goes 110)
        // and lets quick hooks (Misiorowski rarely past 85) slip
        // through. The model-props endpoint now ships a per-pitcher
        // profile with p80_pitches (this-season 80th-percentile
        // pitch count per start). We anchor force-sell thresholds
        // around that personal number:
        //
        //   pitchesThrown >= p80 + 10:    pull imminent
        //   pitchesThrown >= p80:         50% removal
        //   pitchesThrown >= p80 - 10 + profit >= 10: lock in
        //
        // Falls back to global 85/95/105 when we don't have a
        // profile (rookies, no starts logged this season).
        let hitPitchCount = false;
        let pitchCountDetail = "";
        // NO-side K-props ('under N K') want the pitcher pulled
        // EARLY — that resolves YES under, making our NO worth ~100¢.
        // Selling on pitch-count would cash out before the upside
        // arrives. Skip this trigger for NO holdings; T1 / T2 will
        // still cover legitimate take-profits.
        if (fire?.kind === "player_prop"
            && fire.stat === "strikeouts"
            && heldSide === "yes"
            && fire.game_pk
            && fire.player
            && profitPerContract >= 5) {
            const pitchInfo = await getLivePitcherInfo(fire.game_pk, fire.player);
            if (pitchInfo) {
                const { pitchesThrown, profile } = pitchInfo;
                const p80 = profile?.p80_pitches;
                // Resolve thresholds — personal first, league fallback.
                const tImminent = p80 ? (p80 + 10) : 105;
                const tHalfPull = p80 ? p80         : 95;
                const tLockIn   = p80 ? (p80 - 10)  : 85;
                const tag = p80 ? `p80=${p80}` : "league";
                if (pitchesThrown >= tImminent) {
                    hitPitchCount = true;
                    pitchCountDetail = `${pitchesThrown} pitches (${tag}) — pull imminent`;
                } else if (pitchesThrown >= tHalfPull) {
                    hitPitchCount = true;
                    pitchCountDetail = `${pitchesThrown} pitches (${tag}) — removal ~50%`;
                } else if (pitchesThrown >= tLockIn && profitPerContract >= 10) {
                    hitPitchCount = true;
                    pitchCountDetail = `${pitchesThrown} pitches (${tag}), +${profitPerContract}¢ — lock in`;
                }
            }
        }

        // FIFTH trigger — HITTER PROP LATE-INNING + THRESHOLD-MET
        // FORCE SELL. For hitter props (HR, hits, total_bases), two
        // honest cash-out cases the user flagged:
        //
        //  a) Threshold already met. Our YES is essentially worth
        //     ~100¢ and just waiting for settle. If the market is
        //     paying 90+ for YES, sell — the remaining few cents
        //     of upside are pinned by fees and time risk (game
        //     could be suspended / postponed).
        //  b) Late inning with very few remaining PAs. The model
        //     has already re-priced via game_state.turns_remaining;
        //     if our live probability has dropped under our entry
        //     basis AND we still have profit (market hasn't fully
        //     caught up), lock in before it does.
        let hitHitterSell = false;
        let hitterSellDetail = "";
        if (fire?.kind === "player_prop"
            && (fire.stat === "home_runs" || fire.stat === "hits" || fire.stat === "total_bases")
            && fire.game_pk
            && fire.player
            && profitPerContract > 0) {
            // Side-aware fair value: livePCentsYes is the YES tail;
            // for NO holdings our side's fair is (100 - YES).
            // fire.our_p is ALREADY side-correct (set at entry).
            const livePCentsYes = await getLivePlayerPropPCents(fire);
            const livePCents = livePCentsYes == null ? null
                             : (heldSide === "no" ? 100 - livePCentsYes : livePCentsYes);
            const gameInfo   = await getLiveGameState(fire.game_pk);
            if (livePCents != null) {
                // Case a) live prob ≥ 90% AND market paying ≥ 88¢
                // for our side (lock in the cushion).
                if (livePCents >= 90 && yesBidCents >= 88) {
                    hitHitterSell = true;
                    hitterSellDetail = `live ${livePCents}¢ (${heldSide.toUpperCase()}) — threshold met, lock in`;
                }
                // Case b) live prob has dropped MORE than 10pp below
                // entry our_p AND we still have profit. The market
                // is reacting slower than the model — sell ahead.
                else if (fire.our_p != null) {
                    const ourPCentsEntry = Math.round(fire.our_p * 100);
                    if (livePCents <= ourPCentsEntry - 10) {
                        hitHitterSell = true;
                        hitterSellDetail = `live ${livePCents}¢ vs entry-fair ${ourPCentsEntry}¢ (${heldSide.toUpperCase()}) — model cooled, lock`;
                    }
                }
                // Case c) it's late (8th+) AND batter has no more
                // PAs expected. Cash any remaining cents.
                else if (gameInfo && gameInfo.inning >= 8 && gameInfo.turns_remaining < 0.3) {
                    hitHitterSell = true;
                    hitterSellDetail = `${gameInfo.inning}th, no more PAs — lock`;
                }
            }
        }

        if (!hitAbsolute && !hitEvCapture && !hitLiveEv && !hitPitchCount && !hitHitterSell) continue;
        // Compute the parallel score so EOD can analyze cash-out
        // timing alongside the imperative-trigger decisions. The
        // imperative triggers still drive the actual sells; this
        // is observation only.
        let cashoutScore = null;
        if (root.BotScoring && root.BotScoring.scoreCashout) {
            try {
                const livePCents = (fire && fire.kind === "player_prop")
                    ? await getLivePlayerPropPCents(fire) : null;
                const pitchInfo = (fire?.stat === "strikeouts")
                    ? await getLivePitcherInfo(fire.game_pk, fire.player) : null;
                const gameInfo = (fire?.kind === "player_prop")
                    ? await getLiveGameState(fire.game_pk) : null;
                cashoutScore = await root.BotScoring.scoreCashout({
                    ticker:             p.ticker,
                    contracts:          qty,
                    entry_cents:        entryCents,
                    live_yes_bid_cents: heldSide === "yes" ? yesBidCents : null,
                    live_yes_ask_cents: heldSide === "yes" ? null : (100 - yesBidCents),
                    placed_at_ts:       fire?.placed_at ? Date.parse(fire.placed_at) : null,
                    our_p_at_entry:     fire?.our_p,
                    stat:               fire?.stat,
                    threshold:          fire?.threshold,
                    player_id:          null,
                    game_pk:            fire?.game_pk,
                    live_p:             livePCents != null ? livePCents / 100 : null,
                    pitch_info:         pitchInfo,
                    game_state:         gameInfo,
                });
            } catch { /* observability only — never blocks sell */ }
        }

        // Already have a sell order resting?
        if (await hasOpenSellOrder(p.ticker)) continue;

        // SELL — pass `heldSide` so Kalshi sells the right
        // contracts (YES or NO).
        try {
            const result = await root.Kalshi.placeOrder({
                ticker: p.ticker,
                side:   heldSide,
                count:  qty,
                price:  yesBidCents,
                action: "sell",
            });
            const triggerParts = [];
            if (hitAbsolute)     triggerParts.push("+abs");
            if (hitEvCapture)    triggerParts.push(`+ev ${(captureFraction*100).toFixed(0)}%`);
            if (hitLiveEv)       triggerParts.push(`+live (${liveEvDetail})`);
            if (hitPitchCount)   triggerParts.push(`+pitch (${pitchCountDetail})`);
            if (hitHitterSell)   triggerParts.push(`+hit (${hitterSellDetail})`);
            const triggerTag = triggerParts.join(" / ");
            // Log the cash-out decision for EOD review — pairs with
            // the BUY scoreBet at fire time, so we can see whether
            // the imperative triggers fired earlier / later than
            // scoreCashout's sell_score would have suggested.
            if (cashoutScore && root.BotScoring.logScoredDecision) {
                root.BotScoring.logScoredDecision(cashoutScore, {
                    action:           "cashout",
                    ticker:           p.ticker,
                    side:             heldSide,
                    qty,
                    sell_price_cents: yesBidCents,
                    profit_cents:     profitPerContract * qty,
                    triggers:         triggerParts,
                });
            }
            log("sell", `SELL ${qty}× ${p.ticker} ${heldSide.toUpperCase()} @ ${yesBidCents}¢` +
                ` (entry ${entryCents}¢, +${profitPerContract}¢/contract = $${((profitPerContract*qty)/100).toFixed(2)} profit, trigger: ${triggerTag})`,
                { ticker: p.ticker, qty, yesBidCents, entryCents,
                  profitPerContract, captureFraction, order: result });
            toast(`Bot: sold ${qty}× ${p.ticker} +${profitPerContract}¢/contract (${triggerTag})`, "ok");
            // Successful sell — reset the per-ticker failure streak
            // so a future single hiccup doesn't immediately notify.
            if (root._botSellFails) root._botSellFails.delete(p.ticker);
        } catch (e) {
            const msg = String(e?.message || e);
            log("err", `Sell failed for ${p.ticker}: ${msg}`);
            // Track repeats — bot retries every 30s anyway, so a
            // single failure is transient. Notify after 3 in a row:
            // either the market is locked, the order is stuck, or
            // something Kalshi-side needs human action.
            const failMap = (root._botSellFails ||= new Map());
            const n       = (failMap.get(p.ticker) || 0) + 1;
            failMap.set(p.ticker, n);
            if (n >= 3) {
                notify({
                    level:      "error",
                    title:      `Stuck position — can't sell ${p.ticker}`,
                    body:       `${n} cash-out attempts rejected (${msg}). ` +
                                `Position: ${qty}× ${heldSide.toUpperCase()} ` +
                                `@ entry ${entryCents}¢, live bid ${yesBidCents}¢. ` +
                                `May need manual exit on Kalshi.`,
                    dedupe_key: `sell-stuck:${p.ticker}`,
                    action: {
                        label: "Open on Kalshi",
                        href:  `https://kalshi.com/markets/${encodeURIComponent(p.ticker)}`,
                    },
                });
            }
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

// Stop sending orders Kalshi will reject for insufficient funds.
// Reads cached balance (60s TTL inside kalshi.js) and compares to
// the trade cost. Treats unknown balance (fetch failure) as
// "trust but verify" — let the order go and surface Kalshi's error
// naturally rather than freezing the bot when Kalshi is degraded.
async function canAfford(costCents) {
    if (!root.Kalshi || !root.Kalshi.getBalance) return true;
    try {
        const balance = await root.Kalshi.getBalance();
        if (balance == null) return true;
        return balance >= costCents;
    } catch { return true; }
}

// Live model-props lookup for cash-out — same /api/game/{id}/model-props
// the bot uses to fire props, but called against a HELD position so we
// can compare our updated probability to the live market price.
// Result is the probability times 100 (cents-equivalent fair value),
// or null when we can't resolve the player's lineup id or the stat
// isn't supported. Cached per game_pk for 30s to avoid hammering.
const _livePropsCache = new Map();   // game_pk → { t, data }
const LIVE_PROPS_TTL_MS = 30000;

// Live pitcher info from the MLB Stats feed — used by the pitch-count
// force-sell trigger. Returns { pitchesThrown, battersFaced } for the
// given pitcher's name in the given game, or null if the player isn't
// the active pitcher on either side. Cached per game_pk for 30s
// alongside the model-props cache.
// Game state snapshot from the live model-props payload —
// inning, half, estimated turns_remaining. Used by hitter-prop
// cash-out triggers that need to know how many more PAs are
// realistically left for the team's lineup.
async function getLiveGameState(gamePk) {
    if (!gamePk) return null;
    let data = null;
    const cached = _livePropsCache.get(gamePk);
    if (cached && Date.now() - cached.t < LIVE_PROPS_TTL_MS) {
        data = cached.data;
    } else {
        try {
            const res = await fetch(`/api/game/${gamePk}/model-props`);
            if (!res.ok) return null;
            data = await res.json();
            _livePropsCache.set(gamePk, { t: Date.now(), data });
        } catch { return null; }
    }
    return data?.game_state || null;
}

// Read the player's REALIZED in-game stat for the bet's threshold.
// modelProps.lineups carries per-batter hits/HR/2B/3B/K and per-
// pitcher strikeouts. We translate the bet's `stat` field into the
// right field on the right entity (pitcher for strikeouts, batter
// for hits/HR/TB). Returns null when the player isn't found in
// either lineup (manual prop / pinch hitter / pregame).
function liveStatForBet(modelProps, playerMlbam, stat) {
    if (!modelProps?.lineups || !playerMlbam) return null;
    const want = String(playerMlbam);
    // Pitcher prop — strikeouts always belong to the bet's player
    // (the pitcher himself). Check both sides for safety.
    if (stat === "strikeouts") {
        for (const sk of ["home", "away"]) {
            const lp = modelProps.lineups[sk];
            if (!lp) continue;
            if (String(lp.pitcher_id) === want) {
                return lp.pitcher_strikeouts ?? 0;
            }
        }
        return null;
    }
    // Hitter prop — find the batter in either lineup, then read
    // the field. Total bases is computed from singles + 2×2B +
    // 3×3B + 4×HR using the standard identity
    //   TB = hits + 2B + 2*3B + 3*HR
    for (const sk of ["home", "away"]) {
        const lp = modelProps.lineups[sk];
        if (!lp?.batters) continue;
        const b = lp.batters.find((x) => String(x.mlbam) === want);
        if (!b) continue;
        if (stat === "hits")        return b.hits        ?? 0;
        if (stat === "home_runs")   return b.home_runs   ?? 0;
        if (stat === "total_bases") {
            return (b.hits || 0)
                 + (b.doubles || 0)
                 + 2 * (b.triples || 0)
                 + 3 * (b.home_runs || 0);
        }
        return null;
    }
    return null;
}

async function getLivePitcherInfo(gamePk, playerName) {
    if (!gamePk || !playerName) return null;
    // Reuses the model-props cache — the live pitch count + per-
    // pitcher profile both live there now.
    let data = null;
    const cached = _livePropsCache.get(gamePk);
    if (cached && Date.now() - cached.t < LIVE_PROPS_TTL_MS) {
        data = cached.data;
    } else {
        try {
            const res = await fetch(`/api/game/${gamePk}/model-props`);
            if (!res.ok) return null;
            data = await res.json();
            _livePropsCache.set(gamePk, { t: Date.now(), data });
        } catch { return null; }
    }
    if (!data?.lineups) return null;
    const target = normName(playerName);
    for (const sideKey of ["home", "away"]) {
        const side = data.lineups[sideKey];
        if (!side) continue;
        const name = side.pitcher_name;
        if (!name) continue;
        if (normName(name) !== target) continue;
        const pid = side.pitcher_id;
        const profile = pid && data.model_props?.[pid]?._meta?.pitch_profile || null;
        return {
            pitchesThrown: side.pitcher_pitches || 0,
            battersFaced:  side.pitcher_bf || 0,
            profile,
        };
    }
    return null;
}
async function getLivePlayerPropPCents(fire) {
    if (!fire || !fire.game_pk || !fire.player || !fire.stat || !fire.threshold) return null;
    let data = null;
    const cached = _livePropsCache.get(fire.game_pk);
    if (cached && Date.now() - cached.t < LIVE_PROPS_TTL_MS) {
        data = cached.data;
    } else {
        try {
            const res = await fetch(`/api/game/${fire.game_pk}/model-props`);
            if (!res.ok) return null;
            data = await res.json();
            _livePropsCache.set(fire.game_pk, { t: Date.now(), data });
        } catch { return null; }
    }
    if (!data?.model_props || !data?.name_to_mlbam) return null;
    const mlbam = data.name_to_mlbam[normName(fire.player)];
    if (!mlbam) return null;
    const stats = data.model_props[mlbam];
    if (!stats) return null;
    const tail = stats[fire.stat];
    if (!tail) return null;
    const p = tail[`${fire.threshold}+`];
    if (typeof p !== "number") return null;
    return Math.round(p * 100);
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
// NO ask = 100 - YES bid. To BUY a NO contract we hit whatever the
// best YES bid is (someone willing to sell YES = same as buying NO).
function orderbookNoAskCents(ob) {
    const yesBid = orderbookYesBidCents(ob);
    if (yesBid == null) return null;
    return 100 - yesBid;
}
// NO bid = 100 - YES ask. To SELL a NO position we hit the YES ask.
function orderbookNoBidCents(ob) {
    const yesAsk = orderbookYesAskCents(ob);
    if (yesAsk == null) return null;
    return 100 - yesAsk;
}


// ── UI: drawer with Open Bets + Bot tabs ──────────────────────────

let _drawerOpen = false;
let _drawerRefreshTimer = null;
// Auto-refresh every 12s while the drawer is open. Catches Kalshi's
// 1-3s eventual consistency lag after a fill AND catches positions
// the bot has cashed out in the background. 12s = faster than the
// bot's 30s scan, so users see fresh data even mid-cycle.
const DRAWER_AUTO_REFRESH_MS = 12_000;

function openDrawer(initialTab = "bets") {
    if (_drawerOpen) return;
    _drawerOpen = true;
    const overlay = document.createElement("div");
    overlay.className = "bot-drawer-overlay";
    overlay.innerHTML = drawerHtml(initialTab);
    document.body.appendChild(overlay);
    bindDrawer(overlay);
    refreshDrawerContent();
    // Periodic pull while open — without this, a placed bet won't
    // appear until the user re-clicks a tab.
    if (_drawerRefreshTimer) clearInterval(_drawerRefreshTimer);
    _drawerRefreshTimer = setInterval(() => {
        if (_drawerOpen) refreshDrawerContent();
    }, DRAWER_AUTO_REFRESH_MS);
}

function closeDrawer() {
    document.querySelector(".bot-drawer-overlay")?.remove();
    _drawerOpen = false;
    if (_drawerRefreshTimer) { clearInterval(_drawerRefreshTimer); _drawerRefreshTimer = null; }
}

function refreshDrawerIfOpen() {
    if (_drawerOpen) refreshDrawerContent();
}

function drawerHtml(initialTab) {
    return `
      <div class="bot-drawer" role="dialog" aria-modal="true">
        <header class="bot-drawer-head">
          <h2>Bot Console</h2>
          <button class="bot-drawer-close" aria-label="Close">×</button>
        </header>
        <nav class="bot-drawer-tabs" role="tablist">
          <button class="bot-tab ${initialTab === "bets" ? "active" : ""}" data-tab="bets" role="tab">
            Bets <span class="bot-tab-count" data-bets-count>0</span>
          </button>
          <button class="bot-tab ${initialTab === "questions" ? "active" : ""}" data-tab="questions" role="tab">
            Questions <span class="bot-tab-count bot-tab-unread" data-questions-count>0</span>
          </button>
          <button class="bot-tab ${initialTab === "performance" ? "active" : ""}" data-tab="performance" role="tab">
            Perf
          </button>
          <button class="bot-tab ${initialTab === "history" ? "active" : ""}" data-tab="history" role="tab">
            History <span class="bot-tab-count" data-history-count>0</span>
          </button>
          <button class="bot-tab ${initialTab === "decisions" ? "active" : ""}" data-tab="decisions" role="tab">
            Decisions <span class="bot-tab-count" data-decisions-count>0</span>
          </button>
          <button class="bot-tab ${initialTab === "bot" ? "active" : ""}" data-tab="bot" role="tab">
            Bot
          </button>
        </nav>
        <div class="bot-tab-pane ${initialTab === "bets"        ? "active" : ""}" data-pane="bets"></div>
        <div class="bot-tab-pane ${initialTab === "questions"   ? "active" : ""}" data-pane="questions"></div>
        <div class="bot-tab-pane ${initialTab === "performance" ? "active" : ""}" data-pane="performance"></div>
        <div class="bot-tab-pane ${initialTab === "history"     ? "active" : ""}" data-pane="history"></div>
        <div class="bot-tab-pane ${initialTab === "decisions"   ? "active" : ""}" data-pane="decisions"></div>
        <div class="bot-tab-pane ${initialTab === "bot"         ? "active" : ""}" data-pane="bot"></div>
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
    overlay.querySelector("[data-pane='bets']").innerHTML        = await renderOpenBetsPane();
    overlay.querySelector("[data-pane='questions']").innerHTML   = renderQuestionsPane();
    overlay.querySelector("[data-pane='performance']").innerHTML = await renderPerformancePane();
    overlay.querySelector("[data-pane='history']").innerHTML     = await renderHistoryPane();
    overlay.querySelector("[data-pane='decisions']").innerHTML   = renderDecisionsPane();
    overlay.querySelector("[data-pane='bot']").innerHTML         = renderBotPane();
    bindBotPaneHandlers(overlay);
    bindBetsPaneHandlers(overlay);
    bindQuestionsPaneHandlers(overlay);
    // Update count chips on the Bets + Questions + History + Decisions tabs.
    const betsCt = overlay.querySelector("[data-bets-count]");
    if (betsCt) betsCt.textContent = String(_state.openPositions.length);
    const qCt = overlay.querySelector("[data-questions-count]");
    if (qCt && root.BotNotifications) {
        const unread = root.BotNotifications.unreadCount();
        qCt.textContent = String(unread);
        qCt.classList.toggle("has-unread", unread > 0);
    }
    const histCt = overlay.querySelector("[data-history-count]");
    if (histCt) histCt.textContent = String(getFires().length);
    const decCt = overlay.querySelector("[data-decisions-count]");
    if (decCt && root.BotScoring) decCt.textContent = String(root.BotScoring.getScoredDecisions(2000).length);
}

function renderQuestionsPane() {
    if (!root.BotNotifications) {
        return `<div class="bot-empty">Notifications module not loaded.</div>`;
    }
    const items = root.BotNotifications.list(100);
    if (!items.length) {
        return `
          <div class="bot-empty bot-questions-empty">
            <p>Nothing needs your attention.</p>
            <p class="bot-help">The bot will surface a question here only when
              it hits something it can't fix on its own — a stuck position,
              auth loss, daily-loss-limit pause, or repeated insufficient-funds
              rejections.</p>
          </div>`;
    }
    const rows = items.map(renderNotifRow).join("");
    return `
      <div class="bot-questions-head">
        <button class="bot-notif-mark-all" data-mark-all-read>Mark all read</button>
        <button class="bot-notif-clear-all" data-clear-notifs>Clear all</button>
      </div>
      <div class="bot-notif-list">${rows}</div>
    `;
}

function renderNotifRow(n) {
    const when     = formatNotifTime(n.ts);
    const levelCls = `notif-${n.level || "warn"}`;
    const readCls  = n.acknowledged ? " is-read" : "";
    const countTag = (n.count && n.count > 1) ? ` <span class="bot-notif-count">×${n.count}</span>` : "";
    const actionA  = n.action && n.action.href
        ? `<a class="bot-notif-action" href="${escapeText(n.action.href)}" target="_blank" rel="noopener">${escapeText(n.action.label || "Open")}</a>`
        : "";
    const readBtn  = n.acknowledged
        ? ""
        : `<button class="bot-notif-mark" data-mark-read="${escapeText(n.id)}">Mark read</button>`;
    return `
      <div class="bot-notif ${levelCls}${readCls}">
        <div class="bot-notif-head">
          <span class="bot-notif-title">${escapeText(n.title)}${countTag}</span>
          <span class="bot-notif-ts">${when}</span>
        </div>
        <div class="bot-notif-body">${escapeText(n.body)}</div>
        <div class="bot-notif-actions">
          ${actionA}
          ${readBtn}
        </div>
      </div>
    `;
}

function formatNotifTime(iso) {
    const d   = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
        return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function bindQuestionsPaneHandlers(overlay) {
    overlay.querySelectorAll("[data-mark-read]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const id = btn.dataset.markRead;
            root.BotNotifications?.markRead(id);
            refreshDrawerContent();
        });
    });
    overlay.querySelector("[data-mark-all-read]")?.addEventListener("click", () => {
        root.BotNotifications?.markAllRead();
        refreshDrawerContent();
    });
    overlay.querySelector("[data-clear-notifs]")?.addEventListener("click", () => {
        if (confirm("Clear all questions?")) {
            root.BotNotifications?.clear();
            refreshDrawerContent();
        }
    });
}

// ── Decisions pane ────────────────────────────────────────────────
//
// Shows the bot's latest scored decisions with full factor
// breakdown — what it considered, what it decided, why. Lets the
// user audit the scoring framework in real time without waiting
// for EOD review.
function renderDecisionsPane() {
    if (!root.BotScoring) {
        return `<div class="bot-empty"><p>Scoring framework not loaded.</p></div>`;
    }
    const all = root.BotScoring.getScoredDecisions(100);
    if (!all.length) {
        return `
          <div class="bot-empty">
            <p>No decisions logged yet.</p>
            <p class="bot-empty-sub">Turn the bot on; every consideration (fire / skip / cash-out) gets logged here with the factor breakdown that produced it.</p>
          </div>
        `;
    }
    const rows = all.slice(0, 50).map((d) => {
        const action = d.decision?.action || "—";
        const actionCls = action === "fire"
            ? "bet-result-won"
            : action === "skip"
            ? "bet-state-placed"
            : "bet-state-resting";
        const ts = d.meta?.scored_at ? new Date(d.meta.scored_at) : null;
        const ago = ts ? formatTimeAgo(ts) : "—";
        let label;
        if (d.meta?.kind === "player_prop" && d.meta?.player) {
            label = `${d.meta.player} ${d.meta.threshold}+ ${shortStatLabel(d.meta.stat)}`;
        } else if (d.meta?.kind === "moneyline") {
            label = `${d.meta.matchup} ML`;
        } else if (d.meta?.ticker) {
            label = String(d.meta.ticker).slice(0, 30);
        } else {
            label = "—";
        }
        const side = d.decision?.side || "yes";
        const sideTag = side === "no"
            ? `<span class="bet-state bet-state-placed">NO</span>`
            : `<span class="bet-state bet-state-held">YES</span>`;
        const factorChips = (d.factors || [])
            .filter((f) => f && f.present)
            .map((f) => `
              <span class="bot-factor-chip ${(f.adjust_pp ?? 0) > 0 ? "is-pos" : (f.adjust_pp ?? 0) < 0 ? "is-neg" : ""}">
                ${escapeText(f.name)}: ${f.adjust_pp >= 0 ? "+" : ""}${(f.adjust_pp ?? 0).toFixed(1)}pp
              </span>
            `).join("");
        const reasonText = d.decision?.reason
            ? `<span class="bot-decision-reason">${escapeText(d.decision.reason)}</span>`
            : "";
        return `
          <tr>
            <td><span class="bet-state ${actionCls}">${action.toUpperCase()}</span></td>
            <td>${sideTag}</td>
            <td>${escapeText(label)}</td>
            <td>${d.adjusted_p != null ? (d.adjusted_p * 100).toFixed(1) + "%" : "—"}</td>
            <td>${d.edge_pp != null ? (d.edge_pp >= 0 ? "+" : "") + d.edge_pp.toFixed(1) + "pp" : "—"}</td>
            <td>${d.confidence != null ? (d.confidence * 100).toFixed(0) + "%" : "—"}</td>
            <td><div class="bot-factor-row">${factorChips}${reasonText}</div></td>
            <td class="bot-time-ago">${ago}</td>
          </tr>
        `;
    }).join("");
    // Summary numbers.
    const fires = all.filter((d) => d.decision?.action === "fire").length;
    const skips = all.filter((d) => d.decision?.action === "skip").length;
    const cashouts = all.filter((d) => d.decision?.action === "cashout").length;
    return `
      <div class="bot-status-banner">
        <span class="bot-status-row">
          <span class="bot-status-dot bot-status-ok"></span>
          ${all.length} decisions logged · ${fires} fires · ${skips} skips · ${cashouts} cash-outs
        </span>
      </div>
      <div class="bot-section">
        <h3>Latest 50 <span class="bot-section-sub">most recent first · factor chips show ± adjustment magnitude</span></h3>
        <table class="bot-table bot-table-history">
          <thead><tr>
            <th>Action</th><th>Side</th><th>Bet</th>
            <th>Adj P</th><th>Edge</th><th>Conf</th>
            <th>Factors</th><th>When</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
}


// ── Open Bets pane ────────────────────────────────────────────────

async function renderOpenBetsPane() {
    if (!root.Kalshi || !root.Kalshi.isConnected || !root.Kalshi.isConnected()) {
        return `
          <div class="bot-empty">
            <p>Connect Kalshi to see your active bets.</p>
          </div>
        `;
    }
    let positions, orders, fills, settlements;
    try {
        [positions, orders, fills, settlements] = await Promise.all([
            root.Kalshi.getPositions(),
            root.Kalshi.getOpenOrders(),
            // /portfolio/fills lists every trade execution Kalshi
            // has for the account, current AND historical. Pulled
            // here so the user sees what ACTUALLY happened on
            // Kalshi's side — not just net position state.
            root.Kalshi.getFills ? root.Kalshi.getFills() : Promise.resolve([]),
            // Settlements pulled here too — needed to compute the
            // 'live' fire set (anything still in flight = not
            // settled AND not cashed out). Without it, settled bets
            // appear orphaned in the Bets pane.
            root.Kalshi.getSettlements ? root.Kalshi.getSettlements() : Promise.resolve([]),
        ]);
    } catch (e) {
        return `<div class="bot-empty"><p>Couldn't load positions: ${escapeText(e.message || e)}</p></div>`;
    }
    const mps = (positions?.market_positions || []).filter((p) => (p.position || 0) !== 0);
    _state.openPositions = mps;

    const resting = (orders || []);
    const allFills = (fills || []);
    const fires   = getFires();

    // Sell-fill + settlement sets for resolution checks below.
    const sellTickers = new Set();
    for (const f of allFills) {
        if ((f.action || "").toLowerCase() === "sell" && f.ticker && Number(f.count) > 0) {
            sellTickers.add(f.ticker);
        }
    }
    const settleTickers = new Set((settlements || []).map((s) => s.ticker));
    const mpsTickers    = new Set(mps.map((p) => p.ticker));
    const restingTix    = new Set(resting.map((o) => o.ticker));

    // LIVE FIRES = our fires that aren't already shown as a Kalshi
    // position AND aren't resolved (no settlement, no cash-out).
    // These are the 'in flight per our log but Kalshi-side state is
    // ambiguous' bets — they should show in Bets, not in History,
    // until Kalshi catches up or the market settles.
    const liveFires = fires.filter((f) => {
        if (!f.ticker) return false;
        if (mpsTickers.has(f.ticker))     return false;   // shown as full position
        if (settleTickers.has(f.ticker))  return false;   // settled = History
        if (sellTickers.has(f.ticker))    return false;   // cashed out = History
        if (restingTix.has(f.ticker))     return false;   // shown as resting (below)
        return true;
    });

    // Build a map ticker → most-recent bet record so we can both tag
    // the row's source AND surface the edge / model probabilities
    // that triggered it. Records without a source field were written
    // before manual logging existed — treat those as bot fires.
    const fireByTicker = new Map();
    for (const f of fires) {
        if (!f.ticker) continue;
        if (!fireByTicker.has(f.ticker)) fireByTicker.set(f.ticker, f);
    }

    // Source helpers shared by all rendering paths below.
    const sourceOf = (rec) => (rec?.source === "manual" ? "user" : "bot");
    const sourceTag = (rec, extra = "") => {
        if (sourceOf(rec) === "user") {
            return `<span class="bet-src bet-src-user" title="Placed manually${extra ? " · " + extra : ""}">YOU</span>`;
        }
        return `<span class="bet-src bet-src-bot" title="Placed by bot${extra ? " · " + extra : ""}">BOT</span>`;
    };

    // Counts for the section subtitle.
    const botCount  = mps.filter((p) => sourceOf(fireByTicker.get(p.ticker)) === "bot").length;
    const userCount = mps.length - botCount;

    // Top-of-pane status banner — appears whether or not the user has
    // active positions. Surfaces what we know: connection state, the
    // raw position / order / fill counts from Kalshi (so a
    // "0 positions but I placed bets" case is visible as data, not
    // a missing UI), and how many bet records we have locally.
    const statusBanner = `
      <div class="bot-status-banner">
        <span class="bot-status-row">
          <span class="bot-status-dot bot-status-ok"></span>
          Kalshi: connected · ${mps.length} open, ${resting.length} resting, ${allFills.length} fills · ${fires.length} bets in local history
        </span>
      </div>
    `;

    // LIVE block — shown ALWAYS when liveFires is non-empty, even if
    // Kalshi reports positions of its own. These are bets we placed
    // that aren't yet resolved (no settlement, no sell-fill) and
    // aren't already shown as a Kalshi market_position.
    const liveBlock = liveFires.length
        ? `
            <div class="bot-recent-section">
              <div class="bot-recent-head">
                Live (per local log) — ${liveFires.length} bet${liveFires.length === 1 ? "" : "s"}
                <span class="bot-recent-hint">Kalshi-side state not yet visible · refreshes every 12s</span>
              </div>
              <div class="bot-recent-list">
                ${liveFires.slice(0, 30).map(renderRecentFireRow).join("")}
              </div>
            </div>
          `
        : "";

    if (!mps.length && !resting.length) {
        // No live Kalshi positions, no resting orders. Still might
        // have liveFires (bets we logged but Kalshi doesn't show in
        // positions yet) — render those above the empty state.
        const hasFills = allFills.length > 0;
        return `
          ${statusBanner}
          ${liveBlock}
          ${liveFires.length ? "" : `
            <div class="bot-empty">
              <p>No active bets right now.</p>
              <p class="bot-empty-sub">
                ${fires.length
                    ? `Past bets are in <strong>History</strong> — resolved bets only.`
                    : "Every bet — bot or manual — shows up here the moment it fills."}
              </p>
            </div>
          `}
          ${hasFills ? renderFillsSection(allFills) : ""}
        `;
    }
    // Live YES prices in parallel so the P/L is fresh.
    // Pull the side-appropriate live bid for each position — YES
    // positions sell into YES bid, NO positions into NO bid.
    const prices = await Promise.all(mps.map(async (p) => {
        try {
            const ob = await root.Kalshi.getOrderbook(p.ticker);
            const isNo = (p.position || 0) < 0;
            return isNo ? orderbookNoBidCents(ob) : orderbookYesBidCents(ob);
        } catch { return null; }
    }));
    const posRows = mps.map((p, i) => {
        const rawQty = p.position;
        const heldSide = rawQty > 0 ? "yes" : "no";
        const qty = Math.abs(rawQty);
        const entry = p.average_yes_price ?? p.average_cost_cents ?? 0;
        const live = prices[i];
        const pl = (live != null && qty > 0)
            ? ((live - entry) * qty / 100)
            : null;
        const plCls = pl == null ? "" : pl >= 0 ? "bot-pl-pos" : "bot-pl-neg";
        const fire  = fireByTicker.get(p.ticker);
        const extra = fire?.edge_pp != null ? `${fire.edge_pp.toFixed(1)}pp edge` : "";
        const sideLabel = heldSide === "no" ? "NO" : "YES";
        return `
          <tr>
            <td>${sourceTag(fire, extra)}</td>
            <td class="bot-ticker">${escapeText(p.ticker)}</td>
            <td>${qty}× ${sideLabel}</td>
            <td>${entry}¢</td>
            <td>${live != null ? `${live}¢` : "—"}</td>
            <td class="${plCls}">${pl != null ? `${pl >= 0 ? "+" : ""}$${pl.toFixed(2)}` : "—"}</td>
            <td>
              ${live != null && qty > 0
                ? `<button class="bot-exit-btn" data-exit="${escapeText(p.ticker)}:${heldSide}:${qty}:${live}">Exit @ ${live}¢</button>`
                : ""}
            </td>
          </tr>
        `;
    }).join("");
    const orderRows = resting.map((o) => {
        const fire = fireByTicker.get(o.ticker);
        return `
          <tr>
            <td>${sourceTag(fire)}</td>
            <td class="bot-ticker">${escapeText(o.ticker)}</td>
            <td>${escapeText(o.action || "?")} ${escapeText(o.side || "?")}</td>
            <td>${o.yes_price ?? o.no_price ?? "?"}¢</td>
            <td>${o.remaining_count ?? o.count ?? "?"}</td>
            <td>
              <button class="bot-cancel-btn" data-cancel="${escapeText(o.order_id || "")}">Cancel</button>
            </td>
          </tr>
        `;
    }).join("");
    const subtitle = mps.length
        ? `${mps.length} active · ${botCount} bot, ${userCount} manual`
        : "";

    return `
      ${statusBanner}
      ${mps.length ? `
        <div class="bot-section">
          <h3>Active positions ${subtitle ? `<span class="bot-section-sub">${subtitle}</span>` : ""}</h3>
          <table class="bot-table">
            <thead><tr><th>By</th><th>Market</th><th>Side</th><th>Entry</th><th>Live</th><th>P/L</th><th></th></tr></thead>
            <tbody>${posRows}</tbody>
          </table>
        </div>
      ` : ""}
      ${resting.length ? `
        <div class="bot-section">
          <h3>Resting orders</h3>
          <table class="bot-table">
            <thead><tr><th>By</th><th>Market</th><th>Action</th><th>Price</th><th>Qty</th><th></th></tr></thead>
            <tbody>${orderRows}</tbody>
          </table>
        </div>
      ` : ""}
      ${liveBlock}
      ${allFills.length ? renderFillsSection(allFills) : ""}
    `;
}

// Compact row for the "last 5 min" recent-fires strip. Just label
// + side + cost + time-ago — enough to confirm 'yes the bot fired
// this minute' without duplicating the full active-position card.
function renderRecentFireRow(f) {
    const label   = escapeText(betLabel(f));
    const side    = (f.side || "yes").toUpperCase();
    const sideCls = side === "NO" ? "bet-side-no" : "bet-side-yes";
    const cost    = ((f.contracts || 1) * (f.price_cents || 0) / 100).toFixed(2);
    const ago     = formatNotifTime(f.placed_at);
    return `
      <div class="bot-recent-row">
        <span class="bot-recent-label">${label}</span>
        <span class="bot-recent-meta">
          <span class="${sideCls}">${side}</span>
          $${cost}
          <span class="bot-recent-ts">${ago}</span>
        </span>
      </div>
    `;
}

// Render the Kalshi-fills section. Each fill is one actual trade
// execution — pair of buy + sell at the same ticker means the
// position is closed (net zero on positions endpoint but the
// trades are real). This section is what answers "did my orders
// actually go through" when /positions reports empty.
function renderFillsSection(fills) {
    if (!fills.length) return "";
    // Filter out junk entries — Kalshi's /portfolio/fills returns
    // every order attempt, including ones that filled 0 contracts
    // at no price. Those rows just showed '0× YES — 18h ago' over
    // and over. Only show fills that actually moved contracts at
    // a real price.
    const real = fills.filter((f) => {
        const count = Number(f.count) || 0;
        if (count <= 0) return false;
        const side = (f.side || "").toLowerCase();
        const price = (side === "yes") ? f.yes_price : f.no_price;
        if (price == null || price <= 0) return false;
        return true;
    });
    if (!real.length) return "";
    const rows = real.slice(0, 30).map((f) => {
        const t = f.ticker || "";
        const trimmed = t.length > 36 ? t.slice(0, 36) + "…" : t;
        const action = (f.action || "?").toLowerCase();
        const side   = (f.side || "?").toLowerCase();
        const actionCls = action === "sell" ? "bot-fill-sell" : "bot-fill-buy";
        const priceCents = (side === "yes") ? f.yes_price : f.no_price;
        const dt = f.created_time ? new Date(f.created_time) : null;
        const ago = dt ? formatTimeAgo(dt) : "—";
        return `
          <tr>
            <td><span class="bot-fill-action ${actionCls}">${action.toUpperCase()}</span></td>
            <td class="bot-ticker">${escapeText(trimmed)}</td>
            <td>${(f.count || 0)}× ${side.toUpperCase()}</td>
            <td>${priceCents}¢</td>
            <td class="bot-time-ago">${ago}</td>
          </tr>
        `;
    }).join("");
    return `
      <div class="bot-section">
        <h3>Kalshi fills <span class="bot-section-sub">last ${Math.min(real.length, 30)} executed trades — buys + sells from your account</span></h3>
        <table class="bot-table bot-table-history">
          <thead><tr><th>Action</th><th>Market</th><th>Side</th><th>Price</th><th>When</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
}

// Render the "recent activity" sub-table from the local fire log.
// State on each row is the BEST inference we can make from current
// Kalshi data; we never assert "closed" because we can't actually
// tell the difference between a settled position, a cashed-out
// position, and a silently-failed order. The states we DO emit:
//   HELD     — ticker is in current positions  (qty > 0)
//   RESTING  — ticker is in current open orders
//   PLACED   — neither; we only know we tried.  (default, neutral)
function renderRecentSection(fires, mps, resting, sourceTag, heading) {
    const activeTickers  = new Set(mps.map((p) => p.ticker));
    const restingTickers = new Set((resting || []).map((o) => o.ticker));
    // Show up to 50 — user explicitly asked to see ALL bets from
    // local history, not just the most recent 10. The full log is
    // capped at 500 entries by recordPlacedBet, and the much-deeper
    // History tab still shows up to 200 with settlement results.
    const rows = fires.slice(0, 50).map((f) => {
        let label;
        if (f.kind === "player_prop" && f.player) {
            const stat = shortStatLabel(f.stat);
            label = `${f.player} ${f.threshold}+ ${stat}`;
        } else if (f.bet_team && f.matchup) {
            label = `${f.bet_team} ML · ${f.matchup}`;
        } else {
            const t = f.ticker || "";
            label = t.length > 28 ? t.slice(0, 28) + "…" : t;
        }
        const placedAt = f.placed_at ? new Date(f.placed_at) : null;
        const ago      = placedAt ? formatTimeAgo(placedAt) : "—";
        let stateTag;
        if (activeTickers.has(f.ticker)) {
            stateTag = `<span class="bet-state bet-state-held">HELD</span>`;
        } else if (restingTickers.has(f.ticker)) {
            stateTag = `<span class="bet-state bet-state-resting">RESTING</span>`;
        } else {
            stateTag = `<span class="bet-state bet-state-placed">PLACED</span>`;
        }
        const edge = f.edge_pp != null ? `${f.edge_pp.toFixed(1)}pp edge` : "";
        return `
          <tr>
            <td>${sourceTag(f, edge)}</td>
            <td>${escapeText(label)}</td>
            <td>${f.contracts || 1}× @ ${f.price_cents}¢</td>
            <td>${stateTag}</td>
            <td class="bot-time-ago">${ago}</td>
          </tr>
        `;
    }).join("");
    return `
      <div class="bot-section">
        <h3>Recently placed <span class="bot-section-sub">${escapeText(heading)}</span></h3>
        <table class="bot-table bot-table-history">
          <thead><tr><th>By</th><th>Bet</th><th>Size</th><th>State</th><th>When</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
}

// ── Performance pane ──────────────────────────────────────────────
//
// 'How am I doing?' at a glance. Pulls the fire log + Kalshi
// settlements, computes per-day P/L, win rates broken out by stat
// type and edge band, and surfaces what the bot did well vs poorly.
// All client-side — no new endpoint, data already lives in
// localStorage + Kalshi.
async function renderPerformancePane() {
    const fires = getFires();
    if (!fires.length) {
        return `
          <div class="bot-empty">
            <p>No betting history yet.</p>
            <p class="bot-empty-sub">Turn the bot on; every fire shows up here and rolls into the performance numbers as Kalshi settles each market.</p>
          </div>
        `;
    }

    let settlements = [];
    let fills = [];
    let connected = false;
    if (root.Kalshi && root.Kalshi.isConnected && root.Kalshi.isConnected()) {
        connected = true;
        try {
            const got = await Promise.all([
                root.Kalshi.getSettlements ? root.Kalshi.getSettlements() : Promise.resolve([]),
                root.Kalshi.getFills       ? root.Kalshi.getFills()       : Promise.resolve([]),
            ]);
            settlements = got[0] || [];
            fills       = got[1] || [];
        } catch { /* fall through with empty */ }
    }
    const settleByTicker = new Map();
    for (const s of settlements) {
        if (s.ticker) settleByTicker.set(s.ticker, s);
    }
    // Build per-ticker sell-fill revenue. When the bot cashes out
    // before market settle, the settlement record shows yes_count=0
    // and revenue=0 (because we held nothing at settle time). The
    // ACTUAL revenue from that bet lives in the sell fills.
    // Settlement-based win/loss math missed every cashed-out winner.
    const sellRevenueByTicker = new Map();
    for (const f of fills) {
        if (!f.ticker || !(Number(f.count) > 0)) continue;
        const action = (f.action || "").toLowerCase();
        if (action !== "sell") continue;
        const side  = (f.side || "").toLowerCase();
        const price = (side === "yes") ? f.yes_price : f.no_price;
        if (!(price > 0)) continue;
        sellRevenueByTicker.set(
            f.ticker,
            (sellRevenueByTicker.get(f.ticker) || 0) + Number(f.count) * price
        );
    }

    // Per-fire P/L. Real revenue = settlement revenue + cash-out
    // proceeds. The bet is RESOLVED when we have either a
    // settlement record OR a sell fill (we got paid).
    const enriched = fires.map((f) => {
        const cost = (f.contracts || 1) * (f.price_cents || 0);
        const settle  = settleByTicker.get(f.ticker);
        const sellRev = sellRevenueByTicker.get(f.ticker) || 0;
        const settleRev = settle ? (Number(settle.revenue) || 0) : 0;
        const totalRev  = settleRev + sellRev;
        let pnl = null;
        let state = "open";
        if (settle || sellRev > 0) {
            pnl = totalRev - cost;
            // P/L sign is the truth — works for both settled wins
            // AND cash-out wins. Was previously checking yes_count
            // which goes to 0 the moment you sell, miscounting every
            // cash-out winner as a loss.
            state = pnl > 0 ? "won" : "lost";
        }
        return { ...f, cost, pnl, state };
    });

    const settled    = enriched.filter((f) => f.state !== "open");
    const wins       = settled.filter((f) => f.state === "won");
    const losses     = settled.filter((f) => f.state === "lost");
    const winRate    = settled.length ? wins.length / settled.length : 0;
    const totalPnl   = settled.reduce((s, f) => s + (f.pnl || 0), 0);
    const totalCost  = settled.reduce((s, f) => s + f.cost, 0);
    const roi        = totalCost > 0 ? totalPnl / totalCost : 0;

    // Per-day rollup (last 14 days, UTC).
    const dayPnl = new Map();   // YYYY-MM-DD → net cents
    for (const f of settled) {
        const day = (f.placed_at || "").slice(0, 10);
        if (!day) continue;
        dayPnl.set(day, (dayPnl.get(day) || 0) + (f.pnl || 0));
    }
    const todayKey = new Date().toISOString().slice(0, 10);
    const days = [];
    for (let i = 13; i >= 0; i--) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        const k = d.toISOString().slice(0, 10);
        days.push({ key: k, pnl: dayPnl.get(k) || 0, isToday: k === todayKey });
    }
    const todayPnl = dayPnl.get(todayKey) || 0;

    // Per-stat rollup.
    const byStat = {};
    for (const f of settled) {
        const stat = f.kind === "moneyline" ? "moneyline" : (f.stat || "—");
        if (!byStat[stat]) byStat[stat] = { wins: 0, losses: 0, pnl: 0 };
        if (f.state === "won")  byStat[stat].wins   += 1;
        if (f.state === "lost") byStat[stat].losses += 1;
        byStat[stat].pnl += (f.pnl || 0);
    }

    // Per-edge-band rollup.
    const bands = [
        { label: "2-5pp",   min: 2,  max: 5 },
        { label: "5-7pp",   min: 5,  max: 7 },
        { label: "7-10pp",  min: 7,  max: 10 },
        { label: "10pp+",   min: 10, max: 999 },
    ];
    const byBand = bands.map((b) => {
        const inBand = settled.filter((f) =>
            (f.edge_pp || 0) >= b.min && (f.edge_pp || 0) < b.max
        );
        return {
            ...b,
            count:  inBand.length,
            wins:   inBand.filter((f) => f.state === "won").length,
            losses: inBand.filter((f) => f.state === "lost").length,
            pnl:    inBand.reduce((s, f) => s + (f.pnl || 0), 0),
        };
    });

    // Per-source (bot vs manual) rollup.
    const bot    = settled.filter((f) => f.source !== "manual");
    const manual = settled.filter((f) => f.source === "manual");

    return `
      <div class="bot-status-banner">
        <span class="bot-status-row">
          <span class="bot-status-dot ${connected ? "bot-status-ok" : ""}"></span>
          ${connected ? "Kalshi connected" : "Kalshi NOT connected — settle counts may be stale"}
          · ${fires.length} bet${fires.length === 1 ? "" : "s"} placed, ${settled.length} settled
        </span>
      </div>

      <!-- HEADLINE STATS — what you'd glance at first thing -->
      <div class="bot-perf-headline">
        ${perfStatCard("Today P/L",
            (todayPnl >= 0 ? "+" : "") + "$" + (todayPnl/100).toFixed(2),
            todayPnl >= 0 ? "win" : "lose")}
        ${perfStatCard("All-time P/L",
            (totalPnl >= 0 ? "+" : "") + "$" + (totalPnl/100).toFixed(2),
            totalPnl >= 0 ? "win" : "lose")}
        ${perfStatCard("Win rate",
            settled.length ? (winRate * 100).toFixed(0) + "%" : "—",
            winRate >= 0.5 ? "win" : settled.length ? "lose" : "")}
        ${perfStatCard("ROI",
            settled.length ? (roi >= 0 ? "+" : "") + (roi * 100).toFixed(1) + "%" : "—",
            roi >= 0 ? "win" : "lose")}
        ${perfStatCard("Settled", `${wins.length}-${losses.length}`, "")}
        ${perfStatCard("Open", String(enriched.length - settled.length), "")}
      </div>

      <!-- 14-day P/L sparkline -->
      <div class="bot-section">
        <h3>Last 14 days <span class="bot-section-sub">net P/L per day</span></h3>
        ${perfSparkline(days)}
      </div>

      <!-- Win rate by stat type -->
      <div class="bot-section">
        <h3>By bet type <span class="bot-section-sub">win rate + net P/L per category</span></h3>
        <table class="bot-table bot-table-history">
          <thead><tr><th>Type</th><th>W-L</th><th>Win %</th><th>Net P/L</th><th>Sample</th></tr></thead>
          <tbody>
            ${Object.entries(byStat).sort((a,b) => (b[1].wins+b[1].losses)-(a[1].wins+a[1].losses)).map(([stat, agg]) => {
                const total = agg.wins + agg.losses;
                const wr = total ? agg.wins/total : 0;
                return `
                  <tr>
                    <td>${escapeText(shortStatLabel(stat))}</td>
                    <td>${agg.wins}-${agg.losses}</td>
                    <td>${total ? (wr*100).toFixed(0) + "%" : "—"}</td>
                    <td class="${agg.pnl >= 0 ? "bot-pl-pos" : "bot-pl-neg"}">${agg.pnl >= 0 ? "+" : ""}$${(agg.pnl/100).toFixed(2)}</td>
                    <td><div class="bot-perf-bar"><span style="width:${total ? wr*100 : 0}%; background:${wr >= 0.5 ? "var(--accent-win)" : "var(--accent-live)"};"></span></div></td>
                  </tr>
                `;
            }).join("") || `<tr><td colspan="5">No settled bets yet</td></tr>`}
          </tbody>
        </table>
      </div>

      <!-- Win rate by edge band -->
      <div class="bot-section">
        <h3>By edge magnitude <span class="bot-section-sub">conviction tier vs result</span></h3>
        <table class="bot-table bot-table-history">
          <thead><tr><th>Edge band</th><th>W-L</th><th>Win %</th><th>Net P/L</th><th>Sample</th></tr></thead>
          <tbody>
            ${byBand.map((b) => {
                const total = b.wins + b.losses;
                const wr = total ? b.wins/total : 0;
                return `
                  <tr>
                    <td>${b.label}</td>
                    <td>${b.wins}-${b.losses}</td>
                    <td>${total ? (wr*100).toFixed(0) + "%" : "—"}</td>
                    <td class="${b.pnl >= 0 ? "bot-pl-pos" : "bot-pl-neg"}">${b.pnl >= 0 ? "+" : ""}$${(b.pnl/100).toFixed(2)}</td>
                    <td><div class="bot-perf-bar"><span style="width:${total ? wr*100 : 0}%; background:${wr >= 0.5 ? "var(--accent-win)" : "var(--accent-live)"};"></span></div></td>
                  </tr>
                `;
            }).join("")}
          </tbody>
        </table>
      </div>

      ${bot.length || manual.length ? `
        <div class="bot-section">
          <h3>Bot vs manual <span class="bot-section-sub">which path is working</span></h3>
          <table class="bot-table bot-table-history">
            <thead><tr><th>Source</th><th>Settled</th><th>Win %</th><th>Net P/L</th></tr></thead>
            <tbody>
              ${[
                  { label: "BOT", arr: bot   },
                  { label: "YOU", arr: manual },
              ].filter(g => g.arr.length).map(g => {
                  const w = g.arr.filter(f => f.state === "won").length;
                  const l = g.arr.filter(f => f.state === "lost").length;
                  const pnl = g.arr.reduce((s, f) => s + (f.pnl || 0), 0);
                  const wr = (w + l) ? w / (w + l) : 0;
                  return `
                    <tr>
                      <td>${g.label === "BOT" ? `<span class="bet-src bet-src-bot">BOT</span>` : `<span class="bet-src bet-src-user">YOU</span>`}</td>
                      <td>${g.arr.length}</td>
                      <td>${(w + l) ? (wr*100).toFixed(0) + "%" : "—"}</td>
                      <td class="${pnl >= 0 ? "bot-pl-pos" : "bot-pl-neg"}">${pnl >= 0 ? "+" : ""}$${(pnl/100).toFixed(2)}</td>
                    </tr>
                  `;
              }).join("")}
            </tbody>
          </table>
        </div>
      ` : ""}
    `;
}

// Small reusable stat card.
function perfStatCard(label, value, tone) {
    const cls = tone === "win" ? "bot-perf-stat-win"
              : tone === "lose" ? "bot-perf-stat-lose"
              : "";
    return `
      <div class="bot-perf-stat ${cls}">
        <span class="bot-perf-stat-label">${escapeText(label)}</span>
        <span class="bot-perf-stat-value">${escapeText(value)}</span>
      </div>
    `;
}

// 14-day P/L sparkline — inline SVG, bar-style. Green bars for
// up days, red for down. Today gets a contrasting outline.
function perfSparkline(days) {
    const max = Math.max(1, ...days.map(d => Math.abs(d.pnl)));
    const w = 600;
    const h = 80;
    const barW = w / days.length;
    const midY = h / 2;
    const bars = days.map((d, i) => {
        const x = i * barW + 2;
        const barH = (Math.abs(d.pnl) / max) * (h * 0.45);
        const y = d.pnl >= 0 ? midY - barH : midY;
        const color = d.pnl > 0 ? "var(--accent-win)"
                    : d.pnl < 0 ? "var(--accent-live)"
                    : "var(--text-faint)";
        const ring = d.isToday ? `<rect x="${x - 1}" y="0" width="${barW - 2}" height="${h}" fill="none" stroke="var(--accent-action)" stroke-width="1" stroke-dasharray="2 2" rx="2"/>` : "";
        return `
          ${ring}
          <rect x="${x}" y="${y}" width="${Math.max(2, barW - 4)}" height="${Math.max(2, barH)}" fill="${color}" rx="1"/>
        `;
    }).join("");
    const labels = days.filter((_, i) => i === 0 || i === days.length - 1 || i === 6)
        .map((d, idx) => {
            const x = days.findIndex(x => x.key === d.key) * barW + barW/2;
            const label = d.isToday ? "today"
                        : new Date(d.key + "T00:00:00Z").toUTCString().slice(8, 11);
            return `<text x="${x}" y="${h - 4}" font-size="9" fill="var(--text-faint)" text-anchor="middle" font-family="ui-monospace, monospace">${label}</text>`;
        }).join("");
    return `
      <svg class="bot-perf-spark" viewBox="0 0 ${w} ${h + 14}" width="100%" preserveAspectRatio="none">
        <line x1="0" y1="${midY}" x2="${w}" y2="${midY}" stroke="var(--border)" stroke-width="1"/>
        ${bars}
        ${labels}
      </svg>
    `;
}


// Natural-language bet label, used everywhere a fire is rendered.
// Examples:
//   { side: 'yes', stat: 'total_bases', threshold: 2, player: 'A. Judge' }
//     → 'A. Judge over 2 total bases'
//   { side: 'no', stat: 'home_runs',  threshold: 1, player: 'J. Soto' }
//     → 'J. Soto under 1 home run'
//   { kind: 'moneyline', bet_team: 'NYY', matchup: 'NYY@TB' }
//     → 'NYY moneyline (NYY@TB)'
function betLabel(f) {
    if (f.kind === "player_prop" && f.player && f.stat) {
        const direction = (f.side || "yes") === "no" ? "under" : "over";
        const statText  = statFullName(f.stat, f.threshold);
        return `${f.player} ${direction} ${f.threshold} ${statText}`;
    }
    if (f.bet_team && f.matchup) {
        return `${f.bet_team} moneyline (${f.matchup})`;
    }
    if (f.ticker) {
        return f.ticker.length > 32 ? f.ticker.slice(0, 32) + "…" : f.ticker;
    }
    return "—";
}

// Pluralized full name of a stat key — used in betLabel above so
// the natural-language form reads like 'over 2 total bases'
// rather than 'over 2 total_bases'.
function statFullName(stat, threshold) {
    const plural = threshold !== 1;
    switch (stat) {
        case "home_runs":   return plural ? "home runs"   : "home run";
        case "hits":        return plural ? "hits"        : "hit";
        case "total_bases": return plural ? "total bases" : "total base";
        case "strikeouts":  return plural ? "strikeouts"  : "strikeout";
        default:            return String(stat || "");
    }
}

function shortStatLabel(s) {
    switch (s) {
        case "home_runs":   return "HR";
        case "total_bases": return "TB";
        case "hits":        return "H";
        case "strikeouts":  return "K";
        default:            return String(s || "").toUpperCase();
    }
}
function formatTimeAgo(d) {
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 60)        return `${sec}s ago`;
    if (sec < 3600)      return `${Math.round(sec/60)}m ago`;
    if (sec < 86400)     return `${Math.round(sec/3600)}h ago`;
    return `${Math.round(sec/86400)}d ago`;
}


// ── History pane (every bet ever placed + result) ─────────────────

async function renderHistoryPane() {
    if (!root.Kalshi || !root.Kalshi.isConnected || !root.Kalshi.isConnected()) {
        return `
          <div class="bot-empty">
            <p>Connect Kalshi to see history with realized results.</p>
            <p class="bot-empty-sub">Local fire log without Kalshi is still useful — re-render once you connect to see won/lost outcomes.</p>
          </div>
        `;
    }
    const fires = getFires();
    if (!fires.length) {
        return `
          <div class="bot-empty">
            <p>No betting history yet.</p>
            <p class="bot-empty-sub">Every bet you place — bot or manual — joins this log the moment it goes through.</p>
          </div>
        `;
    }
    // Pull positions + open orders + settlements + fills in parallel.
    // Each gives us a different lens on a fire's outcome:
    //   WON / LOST    → settled by Kalshi (revenue field tells final P/L)
    //   CASHED        → we sold the position via fills before settle
    //                   (P/L = sell fill price - buy fill price per ct)
    //   HELD          → ticker is in current positions
    //   RESTING       → ticker is in current open orders
    //   PLACED        → none of the above; the bet probably failed to
    //                   fill or is too old for Kalshi's settlement window
    let positions = null, orders = null, settlements = null, fills = null;
    try {
        [positions, orders, settlements, fills] = await Promise.all([
            root.Kalshi.getPositions(),
            root.Kalshi.getOpenOrders(),
            root.Kalshi.getSettlements ? root.Kalshi.getSettlements() : Promise.resolve([]),
            root.Kalshi.getFills       ? root.Kalshi.getFills()       : Promise.resolve([]),
        ]);
    } catch (e) {
        return `<div class="bot-empty"><p>Couldn't load Kalshi history: ${escapeText(e.message || e)}</p></div>`;
    }
    // Build ticker → [buy fill, sell fill] index. A SELL fill on a
    // ticker we BOUGHT means the bot cashed out — that's a realized
    // P/L the settlements endpoint doesn't see.
    //
    // Kalshi's action field has come back lowercase in testing but
    // we normalize defensively — the previous case-sensitive check
    // for 'sell' was routing some sells into the buy bucket and
    // making cash-outs invisible.
    const buyFillsByTicker = new Map();
    const sellFillsByTicker = new Map();
    for (const f of (fills || [])) {
        if (!f.ticker || !(Number(f.count) > 0)) continue;
        const side   = (f.side   || "").toLowerCase();
        const action = (f.action || "").toLowerCase();
        const price  = (side === "yes") ? f.yes_price : f.no_price;
        if (!(price > 0)) continue;
        const target = (action === "sell" ? sellFillsByTicker : buyFillsByTicker);
        if (!target.has(f.ticker)) target.set(f.ticker, []);
        target.get(f.ticker).push({ price, count: Number(f.count) });
    }
    // Sanity counts surfaced in the status banner — lets us see
    // whether we're actually receiving sell fills from Kalshi
    // when the user expects wins to be visible.
    let totalSellFills = 0;
    for (const arr of sellFillsByTicker.values()) totalSellFills += arr.length;
    let firesWithSellFills = 0;
    for (const f of fires) {
        if (sellFillsByTicker.has(f.ticker)) firesWithSellFills++;
    }
    let firesWithSettlement = 0;
    const settleTickers = new Set((settlements || []).map((s) => s.ticker));
    for (const f of fires) {
        if (settleTickers.has(f.ticker)) firesWithSettlement++;
    }
    const positionTickers = new Set(
        (positions?.market_positions || [])
            .filter((p) => (p.position || 0) !== 0)
            .map((p) => p.ticker)
    );
    const restingTickers = new Set((orders || []).map((o) => o.ticker));
    const settlementByTicker = new Map();
    for (const s of (settlements || [])) {
        if (!settlementByTicker.has(s.ticker)) settlementByTicker.set(s.ticker, s);
    }

    // Aggregate top-line stats — won/lost counts + total realized P/L.
    let wonCount = 0, lostCount = 0, totalRevenueCents = 0, totalCostCents = 0;
    for (const f of fires) {
        const s = settlementByTicker.get(f.ticker);
        if (!s) continue;
        const revenue = Number(s.revenue) || 0;        // cents
        const yesCount = Number(s.yes_count) || 0;
        const costForThisFire = (f.contracts || 1) * (f.price_cents || 0);
        // Kalshi reports a single settlement per ticker — credit the
        // first matching fire only so we don't double-count when the
        // bot placed multiple orders at the same ticker.
        totalRevenueCents += 0;   // tallied below per-row instead
        if (s.market_result === "yes" && yesCount > 0) wonCount++;
        else lostCount++;
    }

    // Helper that renders one fire row in the bet table — used
    // inside each day's section.
    const renderFireRow = (f) => {
        const label = betLabel(f);
        const placedAt = f.placed_at ? new Date(f.placed_at) : null;
        const timeOnly = placedAt
            ? `${String(placedAt.getHours()).padStart(2,"0")}:${String(placedAt.getMinutes()).padStart(2,"0")}`
            : "—";
        const cost     = (f.contracts || 1) * (f.price_cents || 0);
        const settle   = settlementByTicker.get(f.ticker);
        const sellFills = sellFillsByTicker.get(f.ticker) || [];

        let resultCell;
        // Real revenue = whatever Kalshi paid us at settle PLUS
        // any cash-out proceeds. Either or both can be present —
        // the previous code preferred settlement-only, which
        // returned 0 for any bet we'd already sold and miscounted
        // every cashed-out winner as a loss.
        const sellRev   = sellFills.reduce((s, x) => s + x.count * x.price, 0);
        const settleRev = settle ? (Number(settle.revenue) || 0) : 0;
        const totalRev  = settleRev + sellRev;
        if (settle || sellRev > 0) {
            const pnlCents   = totalRev - cost;
            const pnlDollars = pnlCents / 100;
            // Tag: SETTLED vs CASHED, based on which path produced
            // the revenue. WON/LOST is just P/L sign.
            const tag = sellRev > 0 && !settle ? "CASHED"
                      : sellRev > 0 ? "CLOSED"     // both — sold then market settled
                      : pnlCents >= 0 ? "WON" : "LOST";
            if (pnlCents >= 0) {
                resultCell = `<span class="bet-result bet-result-won">${tag} +$${pnlDollars.toFixed(2)}</span>`;
            } else {
                resultCell = `<span class="bet-result bet-result-lost">${tag} -$${Math.abs(pnlDollars).toFixed(2)}</span>`;
            }
        } else if (positionTickers.has(f.ticker)) {
            resultCell = `<span class="bet-state bet-state-held">HELD</span>`;
        } else if (restingTickers.has(f.ticker)) {
            resultCell = `<span class="bet-state bet-state-resting">RESTING</span>`;
        } else {
            resultCell = `<span class="bet-state bet-state-placed">PLACED</span>`;
        }

        const source = f.source === "manual"
            ? `<span class="bet-src bet-src-user" title="Placed manually">YOU</span>`
            : `<span class="bet-src bet-src-bot" title="Placed by bot${f.edge_pp != null ? ` · ${f.edge_pp.toFixed(1)}pp edge` : ""}">BOT</span>`;

        return `
          <tr>
            <td>${source}</td>
            <td>${escapeText(label)}</td>
            <td>${f.contracts || 1}× @ ${f.price_cents}¢</td>
            <td>$${(cost/100).toFixed(2)}</td>
            <td>${resultCell}</td>
            <td class="bot-time-ago">${timeOnly}</td>
          </tr>
        `;
    };

    // HISTORY = RESOLVED ONLY. A bet is resolved when EITHER:
    //   - Kalshi has a settlement record for the ticker, OR
    //   - We have at least one sell fill (cash-out).
    // Anything else — HELD, RESTING, PLACED, or "Kalshi lost track" —
    // belongs in the Bets pane, not here. Without this filter the
    // History tab showed in-flight bets as 'PLACED' rows, which the
    // user (correctly) called out as misclassified.
    const resolvedFires = fires.filter((f) => {
        const settle = settlementByTicker.get(f.ticker);
        const sellFills = sellFillsByTicker.get(f.ticker) || [];
        return !!settle || sellFills.length > 0;
    });

    // Group resolved fires by local calendar day (YYYY-MM-DD). Order
    // newest day first — within each day, newest bet first.
    const byDay = new Map();
    for (const f of resolvedFires.slice(0, 500)) {
        if (!f.placed_at) continue;
        const d = new Date(f.placed_at);
        const dayKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
        if (!byDay.has(dayKey)) byDay.set(dayKey, []);
        byDay.get(dayKey).push(f);
    }
    // Live count = total fires minus resolved. Show this in the
    // status banner so the user knows where the in-flight ones went.
    const liveCount = fires.length - resolvedFires.length;
    // Sort days descending and render each as its own section
    // with a day header showing the date + that day's W-L + net.
    const sortedDays = Array.from(byDay.keys()).sort().reverse();
    const todayKey = (() => {
        const t = new Date();
        return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`;
    })();
    const yesterdayKey = (() => {
        const y = new Date();
        y.setDate(y.getDate() - 1);
        return `${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,"0")}-${String(y.getDate()).padStart(2,"0")}`;
    })();

    const daySections = sortedDays.map((dayKey) => {
        const dayFires = byDay.get(dayKey);
        // Day-scoped aggregates — P/L sign as truth, revenue is
        // the sum of settlement + cash-out fills.
        let dayWins = 0, dayLosses = 0, dayPnl = 0;
        for (const f of dayFires) {
            const cost = (f.contracts || 1) * (f.price_cents || 0);
            const s = settlementByTicker.get(f.ticker);
            const sellFills = sellFillsByTicker.get(f.ticker) || [];
            const sellRev   = sellFills.reduce((sum, x) => sum + x.count * x.price, 0);
            const settleRev = s ? (Number(s.revenue) || 0) : 0;
            if (s || sellRev > 0) {
                const pnl = (settleRev + sellRev) - cost;
                dayPnl += pnl;
                if (pnl > 0) dayWins++; else dayLosses++;
            }
        }
        const daySettled = dayWins + dayLosses;
        const dayOpen    = dayFires.length - daySettled;
        const dayLabel = formatDayLabel(dayKey, todayKey, yesterdayKey);
        const pnlClass = dayPnl >= 0 ? "bot-pl-pos" : "bot-pl-neg";
        const pnlText  = `${dayPnl >= 0 ? "+" : ""}$${(dayPnl/100).toFixed(2)}`;

        const rowsHtml = dayFires.map(renderFireRow).join("");
        return `
          <div class="bot-section bot-history-day">
            <header class="bot-history-day-head">
              <div class="bot-history-day-title">
                <span class="bot-history-day-label">${escapeText(dayLabel)}</span>
                <span class="bot-history-day-meta">${dayFires.length} bet${dayFires.length === 1 ? "" : "s"}</span>
              </div>
              <div class="bot-history-day-summary">
                ${daySettled > 0
                  ? `<span class="bot-history-day-record">${dayWins}-${dayLosses}</span>
                     <span class="bot-history-day-pnl ${pnlClass}">${pnlText}</span>`
                  : `<span class="bot-history-day-meta">${dayOpen} still open</span>`
                }
              </div>
            </header>
            <table class="bot-table bot-table-history">
              <thead><tr><th>By</th><th>Bet</th><th>Size</th><th>Cost</th><th>Result</th><th>Time</th></tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        `;
    }).join("");

    // Top-line banner — P/L sign on combined revenue.
    let netCents = 0;
    let resolvedCount = 0;
    let resolvedWins  = 0;
    let resolvedLosses = 0;
    for (const f of fires) {
        const cost = (f.contracts || 1) * (f.price_cents || 0);
        const s = settlementByTicker.get(f.ticker);
        const sellFills = sellFillsByTicker.get(f.ticker) || [];
        const sellRev   = sellFills.reduce((sum, x) => sum + x.count * x.price, 0);
        const settleRev = s ? (Number(s.revenue) || 0) : 0;
        if (s || sellRev > 0) {
            resolvedCount++;
            const pnl = (settleRev + sellRev) - cost;
            netCents += pnl;
            if (pnl > 0) resolvedWins++; else resolvedLosses++;
        }
    }
    const winRate = resolvedCount ? (resolvedWins / resolvedCount) : null;
    const livePart = liveCount > 0
        ? ` · <span class="bot-history-live-hint">${liveCount} still live → <strong>Bets</strong> tab</span>`
        : "";
    const summary = resolvedCount > 0
        ? `${resolvedCount} resolved · ${resolvedWins}-${resolvedLosses} (${(winRate * 100).toFixed(0)}%) · Net <strong class="${netCents >= 0 ? "bot-pl-pos" : "bot-pl-neg"}">${netCents >= 0 ? "+" : ""}$${(netCents/100).toFixed(2)}</strong>${livePart}`
        : `${fires.length} placed · 0 resolved yet${livePart}`;

    // Empty resolved set → render banner + diag + a friendly empty
    // state instead of rows. Avoids showing nothing when ALL the
    // user's bets are in-flight.
    const noResolvedYet = resolvedCount === 0;

    return `
      <div class="bot-status-banner">
        <span class="bot-status-row">
          <span class="bot-status-dot bot-status-ok"></span>
          ${summary}
        </span>
      </div>
      <!-- Diagnostic line — exposes how many Kalshi records we
           pulled, and how many actually mapped onto our fires.
           If 'fires-matched: 0' we know the lookup is failing
           (ticker format mismatch / pagination / etc.) rather
           than 'the user didn't actually win.' -->
      <div class="bot-history-diag">
        Kalshi: ${(settlements || []).length} settlements, ${(fills || []).length} fills (${totalSellFills} sells) ·
        Mapped to our log: ${firesWithSettlement} settled, ${firesWithSellFills} cashed
      </div>
      ${noResolvedYet
        ? `<div class="bot-empty">
             <p>No resolved bets yet.</p>
             <p class="bot-empty-sub">
               History shows bets that have settled or cashed out.
               ${liveCount > 0 ? `Your ${liveCount} live bet${liveCount === 1 ? "" : "s"} ${liveCount === 1 ? "is" : "are"} in <strong>Bets</strong>.` : ""}
             </p>
           </div>`
        : daySections}
    `;
}

// Render a YYYY-MM-DD as 'Today', 'Yesterday', or a long-form date.
function formatDayLabel(key, todayKey, yesterdayKey) {
    if (key === todayKey)     return "Today";
    if (key === yesterdayKey) return "Yesterday";
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const day  = date.toLocaleDateString(undefined, { weekday: "long" });
    const mon  = date.toLocaleDateString(undefined, { month: "short" });
    return `${day}, ${mon} ${d}`;
}

function bindBetsPaneHandlers(overlay) {
    overlay.querySelectorAll("[data-exit]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            // Format ticker:side:qty:price (added side after we
            // started supporting NO positions).
            const parts = btn.getAttribute("data-exit").split(":");
            const ticker = parts[0];
            const side   = parts.length === 4 ? parts[1] : "yes";  // back-compat
            const qty    = parseInt(parts.length === 4 ? parts[2] : parts[1], 10);
            const price  = parseInt(parts.length === 4 ? parts[3] : parts[2], 10);
            const sideUp = side.toUpperCase();
            if (!confirm(`Exit ${qty}× ${ticker} ${sideUp} at ${price}¢?`)) return;
            btn.disabled = true;
            btn.textContent = "Selling…";
            try {
                await root.Kalshi.placeOrder({
                    ticker, side, count: qty, price, action: "sell",
                });
                log("sell", `Manual sell: ${qty}× ${ticker} ${sideUp} @ ${price}¢`);
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
    const killBanner = BOT_KILLED
        ? `
          <div class="bot-kill-banner">
            <div class="bot-kill-title">⚠️ BOT IS GLOBALLY KILLED</div>
            <div class="bot-kill-body">
              No new bets will be placed regardless of toggle state.
              Cash-out checks continue so existing positions can still
              lock in profit. Use the buttons below to flat the book
              if needed.
            </div>
            <div class="bot-kill-actions">
              <button class="bot-emergency-sellall" data-bot-emergency-sellall>
                Sell ALL positions at market bid
              </button>
              <button class="bot-emergency-cancel" data-bot-emergency-cancel>
                Cancel ALL resting orders
              </button>
              <a class="bot-emergency-kalshi"
                 href="https://kalshi.com/portfolio"
                 target="_blank" rel="noopener">
                Open Kalshi portfolio →
              </a>
            </div>
            <div class="bot-kill-warning">
              Sell-all uses live bid for each held side. Thin markets
              may show 0¢ bid — those positions can't auto-exit and
              need manual action on Kalshi.
            </div>
          </div>
        `
        : "";
    return `
      ${killBanner}
      <div class="bot-section">
        <div class="bot-toggle-row">
          <label class="bot-toggle">
            <input type="checkbox" ${s.enabled ? "checked" : ""} data-bot-toggle ${BOT_KILLED ? "disabled" : ""}>
            <span class="bot-toggle-slider"></span>
            <span class="bot-toggle-label">${BOT_KILLED ? "Bot is KILLED" : (s.enabled ? "Bot is ON" : "Bot is OFF")}</span>
          </label>
          ${s.enabled && !BOT_KILLED
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
            <span>Moneyline edge threshold (pp)</span>
            <input type="number" min="${HARD_CAPS.edge_pp_min}" max="${HARD_CAPS.edge_pp_max}"
                   step="1" value="${s.edge_threshold_pp}" data-bot-setting="edge_threshold_pp">
            <small>Fire moneyline when our WE > market by N pp · min ${HARD_CAPS.edge_pp_min}pp (down from 2 — Kalshi is efficient)</small>
          </label>
          <label>
            <span>Player-prop edge threshold (pp)</span>
            <input type="number" min="${HARD_CAPS.edge_pp_min}" max="${HARD_CAPS.edge_pp_max}"
                   step="1" value="${s.player_prop_edge_threshold_pp}" data-bot-setting="player_prop_edge_threshold_pp">
            <small>Higher bar for props (no Savant cross-check, no track record yet)</small>
          </label>
          <label>
            <span>Min inning for moneyline</span>
            <input type="number" min="1" max="8" step="1"
                   value="${s.min_inning_for_moneyline}" data-bot-setting="min_inning_for_moneyline">
            <small>Skip moneylines before this inning — early-game WE swings on tiny events</small>
          </label>
          <label>
            <span>Profit-take (¢)</span>
            <input type="number" min="5" max="60" step="5"
                   value="${s.profit_take_cents}" data-bot-setting="profit_take_cents">
            <small>Sell winners at +N¢ per contract</small>
          </label>
          <label>
            <span>EV-capture sell (% of edge)</span>
            <input type="number" min="20" max="95" step="5"
                   value="${Math.round(s.live_ev_take_pct * 100)}"
                   data-bot-setting-pct="live_ev_take_pct">
            <small>Also sell when market moves N% of the way to our model's fair value · frees capital to redeploy</small>
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
          <label>
            <span>Moneyline reserve (% of cap)</span>
            <input type="number" min="0" max="95" step="5"
                   value="${Math.round(s.moneyline_reserve_pct * 100)}"
                   data-bot-setting-pct="moneyline_reserve_pct">
            <small>= $${(s.open_exposure_max * s.moneyline_reserve_pct / 100).toFixed(2)} reserved for WE bets · player props cap at $${(s.open_exposure_max * (1 - s.moneyline_reserve_pct) / 100).toFixed(2)} open</small>
          </label>
          <label>
            <span>Huge-edge override at (pp)</span>
            <input type="number" min="${HARD_CAPS.edge_pp_min}" max="${HARD_CAPS.edge_pp_max}" step="1"
                   value="${s.huge_edge_pp}" data-bot-setting="huge_edge_pp">
            <small>Adjusted edge ≥ this lifts the props cap (special circumstance) — default 12pp ≈ '5pp more than the normal bar'</small>
          </label>
          <label>
            <span>Huge-edge props cap (% of cap)</span>
            <input type="number" min="20" max="95" step="5"
                   value="${Math.round(s.huge_edge_cap_pct * 100)}"
                   data-bot-setting-pct="huge_edge_cap_pct">
            <small>Props cap when huge edge fires · = $${(s.open_exposure_max * s.huge_edge_cap_pct / 100).toFixed(2)} max open on the exceptional bet</small>
          </label>
          <label>
            <span>Min conviction (0–1)</span>
            <input type="number" min="0" max="1" step="0.05"
                   value="${s.min_conviction.toFixed(2)}"
                   data-bot-setting-float="min_conviction">
            <small>Multi-factor confirmation required (0.40 ≈ model edge + one corroborating factor) · raise = fewer/better fires</small>
          </label>
          <label>
            <span>Savant disagrees → +N pp penalty</span>
            <input type="number" min="0" max="10" step="1"
                   value="${s.savant_disagree_penalty_pp}"
                   data-bot-setting="savant_disagree_penalty_pp">
            <small>When Savant disagrees direction, raise the required edge by N pp. Drop to 0 once we've outperformed Savant.</small>
          </label>
          <label class="bot-checkbox-label">
            <input type="checkbox" ${s.require_savant_agree ? "checked" : ""}
                   data-bot-setting-bool="require_savant_agree">
            <span>Strict mode: REQUIRE Savant to agree (hard gate)</span>
          </label>
          <label class="bot-checkbox-label">
            <input type="checkbox" ${s.bet_player_props ? "checked" : ""}
                   data-bot-setting-bool="bet_player_props">
            <span>Also bet player props (HR / Hits / Ks / TB) — no Savant signal applies</span>
          </label>
        </div>
        <div class="bot-settings-recos">
          <button class="bot-reset-recos" data-bot-reset-recos>Apply recommended defaults</button>
          <small>Snaps every setting on this panel to the tuned values discussed in this session:
            $0.50 unit · 5pp moneyline / 7pp prop · min inning 3 · 50/50 reserve · huge-edge 12pp → 60%
            cap · 0.40 conviction · 20¢ take · 55% EV-capture · $5 daily loss · $20 exposure · soft
            Savant +3pp · props on. Bot ON/OFF state is preserved.</small>
        </div>
        <p class="bot-settings-note">
          Moneyline uses Savant as a confidence amplifier (soft gate by default). Player props
          ride on our matchup-engine alone — Savant doesn't publish player-level probabilities.
          Every fire writes its full context to localStorage so we can backtest against actual
          outcomes after a few sessions.
        </p>
      </details>

      <div class="bot-section">
        <div class="bot-log-head">
          <h3>Activity</h3>
          <div class="bot-log-actions">
            <button class="bot-eod-review" data-bot-eod-review>EOD review</button>
            <button class="bot-copy-all" data-bot-copy-all
                    title="Copy fires + decisions + settings as ONE JSON — paste it in chat with Claude for analysis">
              Copy ALL → JSON
            </button>
            <button class="bot-export-fires" data-bot-export-fires>Export fires (${getFires().length})</button>
            <button class="bot-export-fires" data-bot-export-decisions>Export decisions (${root.BotScoring ? root.BotScoring.getScoredDecisions(2000).length : 0})</button>
            ${logEntries.length ? `<button class="bot-clear-log" data-bot-clear-log>Clear log</button>` : ""}
          </div>
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
    overlay.querySelectorAll("[data-bot-setting-pct]").forEach((inp) => {
        inp.addEventListener("change", () => {
            const k = inp.dataset.botSettingPct;
            const v = parseFloat(inp.value) / 100;
            _state.settings = clampSettings({ ..._state.settings, [k]: v });
            persistSettings();
            refreshDrawerContent();
        });
    });
    overlay.querySelectorAll("[data-bot-setting-float]").forEach((inp) => {
        inp.addEventListener("change", () => {
            const k = inp.dataset.botSettingFloat;
            const v = parseFloat(inp.value);
            _state.settings = clampSettings({ ..._state.settings, [k]: v });
            persistSettings();
            refreshDrawerContent();
        });
    });
    overlay.querySelector("[data-bot-emergency-sellall]")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        if (!confirm(
            "Sell EVERY held position at the current best bid for that side?\n\n" +
            "This is the nuclear-exit. Thin markets may pay you very little, but " +
            "you'll be flat. Existing resting orders are NOT touched — use the " +
            "other button for those."
        )) return;
        btn.disabled = true;
        btn.textContent = "Selling…";
        try {
            const data = await root.Kalshi.getPositions();
            const mps  = (data?.market_positions || []).filter((p) => (p.position || 0) !== 0);
            if (!mps.length) {
                toast("No held positions to sell", "ok");
                btn.disabled = false;
                btn.textContent = "Sell ALL positions at market bid";
                return;
            }
            let sold = 0, failed = 0, noBid = 0;
            for (const p of mps) {
                const heldSide = p.position > 0 ? "yes" : "no";
                const qty      = Math.abs(p.position);
                try {
                    const ob  = await root.Kalshi.getOrderbook(p.ticker);
                    const bid = heldSide === "yes"
                        ? orderbookYesBidCents(ob)
                        : orderbookNoBidCents(ob);
                    if (bid == null || bid < 1) {
                        log("err", `Sell-all skipped ${p.ticker} ${heldSide.toUpperCase()}: no bid`);
                        noBid++;
                        continue;
                    }
                    await root.Kalshi.placeOrder({
                        ticker: p.ticker,
                        side:   heldSide,
                        count:  qty,
                        price:  bid,
                        action: "sell",
                    });
                    log("sell", `Sell-all: ${qty}× ${p.ticker} ${heldSide.toUpperCase()} @ ${bid}¢`);
                    sold++;
                } catch (err) {
                    log("err", `Sell-all failed ${p.ticker}: ${err.message || err}`);
                    failed++;
                }
            }
            const msg = `Sold ${sold}/${mps.length}` + (noBid ? `, ${noBid} skipped (no bid)` : "") + (failed ? `, ${failed} failed` : "");
            toast(msg, sold === mps.length ? "ok" : "err");
            log("bot", `Emergency sell-all: ${msg}`);
            btn.disabled = false;
            btn.textContent = "Sell ALL positions at market bid";
            refreshDrawerContent();
        } catch (err) {
            btn.disabled = false;
            btn.textContent = "Sell ALL positions at market bid";
            toast(`Sell-all failed: ${err.message || err}`, "err");
        }
    });
    overlay.querySelector("[data-bot-emergency-cancel]")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        if (!confirm("Cancel EVERY resting order on Kalshi right now? Existing filled positions are NOT touched.")) return;
        btn.disabled = true;
        btn.textContent = "Cancelling…";
        try {
            const orders = await root.Kalshi.getOpenOrders();
            const cancellable = (orders || []).filter((o) => o.id);
            if (!cancellable.length) {
                toast("No resting orders to cancel", "ok");
                btn.disabled = false;
                btn.textContent = "Cancel ALL resting orders";
                return;
            }
            let ok = 0, fail = 0;
            for (const o of cancellable) {
                try { await root.Kalshi.cancelOrder(o.id); ok++; }
                catch { fail++; }
            }
            log("cancel", `Emergency cancel: ${ok} cancelled, ${fail} failed (out of ${cancellable.length})`);
            toast(`Cancelled ${ok}/${cancellable.length} resting orders`, ok === cancellable.length ? "ok" : "err");
            btn.disabled = false;
            btn.textContent = "Cancel ALL resting orders";
            refreshDrawerContent();
        } catch (err) {
            btn.disabled = false;
            btn.textContent = "Cancel ALL resting orders";
            toast(`Emergency cancel failed: ${err.message || err}`, "err");
        }
    });
    overlay.querySelector("[data-bot-reset-recos]")?.addEventListener("click", () => {
        if (!confirm("Reset every setting on this panel to recommended defaults? (Bot on/off state is preserved.)")) return;
        const wasEnabled = _state.settings.enabled;
        _state.settings = clampSettings({ ...DEFAULTS, enabled: wasEnabled });
        persistSettings();
        toast("Settings reset to recommended defaults", "ok");
        log("bot", "Settings reset to recommended defaults");
        refreshDrawerContent();
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
    overlay.querySelector("[data-bot-export-fires]")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        try {
            const fires = getFires();
            if (!fires.length) { flashBtn(btn, "No fires yet", "err"); toast("No fires recorded yet", "err"); return; }
            const blob = JSON.stringify(fires, null, 2);
            await navigator.clipboard.writeText(blob);
            flashBtn(btn, `✓ Copied ${fires.length} fires`, "ok");
            toast(`✓ Exported ${fires.length} fires — copied to clipboard, paste anywhere`, "ok");
        } catch (err) {
            console.error("[bot] export-fires failed", err);
            flashBtn(btn, "✗ Failed", "err");
            toast(`Copy failed: ${err?.message || err}`, "err");
        }
    });
    overlay.querySelector("[data-bot-eod-review]")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        try {
            flashBtn(btn, "Running…", "ok", 0);   // 0 = don't auto-restore
            await runEodReview();
            flashBtn(btn, "EOD review", "ok", 1);  // restore immediately
        } catch (err) {
            console.error("[bot] eod-review failed", err);
            flashBtn(btn, "✗ Failed", "err");
            toast(`EOD review failed: ${err?.message || err}`, "err");
        }
    });
    overlay.querySelector("[data-bot-export-decisions]")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        try {
            if (!root.BotScoring) { flashBtn(btn, "Scoring missing", "err"); toast("Scoring framework not loaded", "err"); return; }
            const decisions = root.BotScoring.getScoredDecisions(2000);
            if (!decisions.length) {
                flashBtn(btn, "0 decisions", "err");
                toast("No decisions logged yet (bot needs to run with fresh JS first)", "err");
                return;
            }
            const blob = JSON.stringify(decisions, null, 2);
            await navigator.clipboard.writeText(blob);
            flashBtn(btn, `✓ Copied ${decisions.length}`, "ok");
            toast(`✓ Exported ${decisions.length} decisions — copied to clipboard, paste anywhere`, "ok");
        } catch (err) {
            console.error("[bot] export-decisions failed", err);
            flashBtn(btn, "✗ Failed", "err");
            toast(`Copy failed: ${err?.message || err}`, "err");
        }
    });
    overlay.querySelector("[data-bot-copy-all]")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        // CRITICAL: clipboard.writeText() in most browsers requires
        // the user-gesture context still be active. Any `await` on
        // a fetch BEFORE the clipboard write breaks that chain and
        // the write silently rejects. So we gather all SYNC data
        // first, write clipboard immediately, then optionally
        // top-up settlements after.
        try {
            const fires     = getFires();
            const decisions = root.BotScoring ? root.BotScoring.getScoredDecisions(2000) : [];
            const logRows   = getLog();
            const bundle = {
                generated_at: new Date().toISOString(),
                url:          location.href,
                settings:     _state.settings,
                counts: {
                    fires:     fires.length,
                    decisions: decisions.length,
                    log_rows:  logRows.length,
                },
                fires,
                decisions,
                activity_log: logRows.slice(0, 200),
                diagnostics: {
                    scoring_loaded:   !!root.BotScoring,
                    kalshi_connected: !!(root.Kalshi && root.Kalshi.isConnected && root.Kalshi.isConnected()),
                    user_agent:       navigator.userAgent,
                },
            };
            const blob = JSON.stringify(bundle, null, 2);
            await navigator.clipboard.writeText(blob);
            flashBtn(btn, `✓ Copied ${fires.length} fires + ${decisions.length} decisions`, "ok");
            toast(`✓ Copied to clipboard — ${fires.length} fires, ${decisions.length} decisions, ${logRows.length} log rows. Paste in chat.`, "ok");
        } catch (err) {
            const msg = err?.message || String(err);
            console.error("[bot] copy-all failed", err);
            flashBtn(btn, "✗ Failed", "err");
            toast(`Copy failed: ${msg}. Open console for details.`, "err");
        }
    });
}

// End-of-day review — gathers every SCORED decision (fire + skip)
// from the client log, pulls today's Kalshi settlements, POSTs both
// to /api/bot/eod-review, then renders the analysis. The report is
// what makes the user's directive 'no bet should be a loss — we
// either make money or learn' actually possible.
async function runEodReview() {
    if (!root.BotScoring) { toast("Scoring framework not loaded", "err"); return; }
    const decisions = root.BotScoring.getScoredDecisions(2000);
    if (!decisions.length) {
        toast("No scored decisions yet — let the bot run first", "ok");
        return;
    }
    let settlements = [];
    try {
        if (root.Kalshi && root.Kalshi.getSettlements) {
            settlements = await root.Kalshi.getSettlements();
        }
    } catch { /* fall through with empty list */ }
    toast(`Reviewing ${decisions.length} decisions, ${settlements.length} settlements…`, "ok");
    let report = null;
    try {
        const res = await fetch("/api/bot/eod-review", {
            method:  "POST",
            headers: { "content-type": "application/json" },
            body:    JSON.stringify({ decisions, settlements }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        report = await res.json();
    } catch (e) {
        toast(`Review failed: ${e.message || e}`, "err");
        return;
    }
    showEodReportModal(report);
}

function showEodReportModal(report) {
    const old = document.querySelector(".bot-eod-modal");
    if (old) old.remove();
    const m = document.createElement("div");
    m.className = "bot-eod-modal";
    const s = report.summary || {};
    const factorRows = (report.factor_rollup || [])
        .map((r) => `
          <tr>
            <td>${escapeText(r.name)}</td>
            <td>${escapeText(r.dir)}</td>
            <td>${r.wins}-${r.losses}</td>
            <td>${(r.win_rate * 100).toFixed(0)}%</td>
          </tr>
        `).join("");
    const skipRows = (report.skip_analysis || [])
        .map((r) => `
          <tr>
            <td>${escapeText(r.reason)}</td>
            <td>${r.missed_wins}</td>
            <td>${r.avoided_losses}</td>
            <td>${r.unsettled}</td>
            <td>${r.would_be_win_rate != null ? (r.would_be_win_rate * 100).toFixed(0) + "%" : "—"}</td>
          </tr>
        `).join("");
    const suggestionRows = (report.suggestions || []).length
        ? report.suggestions.map((s) => `
          <tr>
            <td>${escapeText(s.factor)}</td>
            <td>${escapeText(s.action)}</td>
            <td>${s.sample_size}</td>
            <td>${(s.win_rate*100).toFixed(0)}%</td>
            <td>${escapeText(s.reason)}</td>
          </tr>
        `).join("")
        : `<tr><td colspan="5">No tuning suggestions yet (need ≥30 settled bets per factor)</td></tr>`;
    m.innerHTML = `
      <div class="bot-eod-content">
        <header>
          <h3>End-of-Day Review</h3>
          <button class="bot-eod-close" aria-label="Close">×</button>
        </header>
        <section class="bot-eod-summary">
          <div><strong>${s.fires || 0}</strong> fires</div>
          <div><strong>${s.wins || 0}-${s.losses || 0}</strong> settled</div>
          <div>Win rate: <strong>${s.win_rate != null ? (s.win_rate * 100).toFixed(0) + "%" : "—"}</strong></div>
          <div>Net P/L: <strong class="${s.net_pnl_cents >= 0 ? "bot-pl-pos" : "bot-pl-neg"}">${s.net_pnl_cents >= 0 ? "+" : ""}$${(s.net_pnl_dollars || 0).toFixed(2)}</strong></div>
          <div>${s.skips || 0} skips considered</div>
        </section>
        <h4>Factor calibration <span class="bot-section-sub">which signals predicted wins</span></h4>
        <table class="bot-table">
          <thead><tr><th>Factor</th><th>Dir</th><th>W-L</th><th>Win rate</th></tr></thead>
          <tbody>${factorRows || `<tr><td colspan="4">No settled fires yet</td></tr>`}</tbody>
        </table>
        <h4>Skip analysis <span class="bot-section-sub">would-be outcomes by reason</span></h4>
        <table class="bot-table">
          <thead><tr><th>Reason</th><th>Missed wins</th><th>Avoided losses</th><th>Unsettled</th><th>Would-be win rate</th></tr></thead>
          <tbody>${skipRows || `<tr><td colspan="5">No skips with settled would-be outcomes yet</td></tr>`}</tbody>
        </table>
        <h4>Auto-tuning suggestions <span class="bot-section-sub">factor weights to nudge based on observed performance</span></h4>
        <table class="bot-table">
          <thead><tr><th>Factor</th><th>Action</th><th>Sample</th><th>Win rate</th><th>Reason</th></tr></thead>
          <tbody>${suggestionRows}</tbody>
        </table>
      </div>
    `;
    document.body.appendChild(m);
    m.querySelector(".bot-eod-close")?.addEventListener("click", () => m.remove());
    m.addEventListener("click", (e) => { if (e.target === m) m.remove(); });
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
      <span class="bot-launcher-label">Active Bets</span>
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
// Flash the button label as inline confirmation feedback. Even
// if the toast layer fails for some reason (z-index, ad blocker,
// browser quirk), the user sees the button itself change.
//   flashBtn(btn, "✓ Copied 33 fires", "ok")
//   flashBtn(btn, "✗ Failed", "err")
//   flashBtn(btn, "Running…", "ok", 0) — don't auto-restore
function flashBtn(btn, message, kind = "ok", durationSec = 2.5) {
    if (!btn) return;
    if (!btn._origLabel) btn._origLabel = btn.textContent;
    btn.textContent = message;
    btn.classList.add(kind === "ok" ? "btn-flash-ok" : "btn-flash-err");
    if (durationSec === 1) {
        // Restore immediately (used as a "reset to original label").
        btn.classList.remove("btn-flash-ok", "btn-flash-err");
        btn.textContent = btn._origLabel;
        return;
    }
    if (durationSec <= 0) return;   // 0 = keep flashed indefinitely
    if (btn._flashTimer) clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => {
        btn.classList.remove("btn-flash-ok", "btn-flash-err");
        btn.textContent = btn._origLabel;
    }, durationSec * 1000);
}

// notify() — single chokepoint for "this needs human attention."
// Writes to the persistent notification log AND surfaces a toast
// so the user sees it even if the drawer is closed. Routine fail
// modes the bot self-recovers from never reach here.
function notify(args) {
    if (!args || !args.title) return;
    root.BotNotifications?.push(args);
    const kind = (args.level === "error" || args.level === "warn") ? "err" : "ok";
    toast(`⚠️ ${args.title}`, kind);
}

function toast(msg, kind = "ok") {
    // Try Kalshi's toast surface first (older sites expose it);
    // otherwise render our own DOM-backed toast. The previous
    // implementation silently fell back to console.log, so every
    // 'Bot: bought X', 'Copied N fires to clipboard', etc. was
    // invisible to the user — the source of 'these buttons aren't
    // doing anything' in image 126.
    if (typeof root.Kalshi?.toast === "function") {
        return root.Kalshi.toast(msg, kind);
    }
    console.log(`[bot] ${msg}`);
    let host = document.querySelector(".bot-toasts");
    if (!host) {
        host = document.createElement("div");
        host.className = "bot-toasts";
        document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = `bot-toast bot-toast-${kind}`;
    el.textContent = msg;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("bot-toast-show"));
    setTimeout(() => {
        el.classList.remove("bot-toast-show");
        setTimeout(() => el.remove(), 220);
    }, 4200);
}


// ── Bootstrap ─────────────────────────────────────────────────────

loadState();

// Auto-refresh the drawer when a new notification fires so the
// Questions badge updates in real time without the user reopening.
window.addEventListener("bot-notification-change", () => {
    const overlay = document.querySelector(".bot-drawer-overlay");
    if (!overlay) return;
    // Only update what's cheap to touch: the badge + the pane
    // (avoid a full refreshDrawerContent which re-pulls Kalshi).
    const qCt = overlay.querySelector("[data-questions-count]");
    if (qCt && root.BotNotifications) {
        const unread = root.BotNotifications.unreadCount();
        qCt.textContent = String(unread);
        qCt.classList.toggle("has-unread", unread > 0);
    }
    const pane = overlay.querySelector("[data-pane='questions']");
    if (pane && pane.classList.contains("active")) {
        pane.innerHTML = renderQuestionsPane();
        bindQuestionsPaneHandlers(overlay);
    }
});

// HARD KILL at load. If BOT_KILLED is on, ANY localStorage value
// that says enabled=true gets forced back to false on every refresh.
// Prevents 'bot keeps placing bets even after I stopped' for users
// who closed the tab without explicitly disabling.
if (BOT_KILLED && _state.settings.enabled) {
    _state.settings.enabled = false;
    persistSettings();
}

// Render the launcher on DOMContentLoaded (or now if already past).
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        renderLauncher();
        if (_state.settings.enabled && !BOT_KILLED) {
            startTimers();
            log("bot", "Resumed (session persisted)");
        }
    });
} else {
    renderLauncher();
    if (_state.settings.enabled && !BOT_KILLED) {
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
