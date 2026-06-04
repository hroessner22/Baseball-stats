// ═════════════════════════════════════════════════════════════════
// CLIENT-SIDE KILL (rarely needed — prefer the server-side
// BUYS_KILLED in functions/api/kalshi/proxy.js because that one
// can't be bypassed by stale tabs running old code). Left here for
// emergencies where we need to disable scanning + cash-out on the
// browser side too.
// ═════════════════════════════════════════════════════════════════
const BOT_KILLED = false;

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
    // 2026-06-02: ceiling lowered to $0.10 after the NO-side prop
    // bug burned the bankroll. 2026-06-03: ceiling raised to $1.00
    // because $0.10 silently blocked ALL moneyline fires — Kalshi
    // ML contracts trade at 30-70¢ each, and floor(10/40)=0 contracts
    // meant 'contracts < 1' returned with no log entry on every
    // single ML opportunity. 2026-06-03 (later): ceiling raised to
    // $5.00 per user direction 'not real money, bump it up' —
    // practice bankroll is $100 by default so $5/fire = 20 fires
    // worth of room. NO-side props still disabled + sanity gates
    // still on. Per-fire spend is conviction-scaled — see
    // sizeContractsByConviction().
    unit_cents_min:        1,      // $0.01 minimum
    unit_cents_max:        500,    // $5.00 max spend per fire
    // The Pythag-baseline backtest cliff (49% at 1-2pp, 63% at
    // 2-3pp) was vs a dumb baseline. Kalshi isn't dumb. Live
    // experience (down 50% today at the 2pp default) shows the
    // 2pp signal does NOT survive an efficient market. Hard floor
    // raised to 4pp — keeps the bot above 'noise vs Kalshi.'
    // 2026-06-03: lowered floor 4 → 2pp per user direction 'edge
    // doesn't need to be massive because as long as we have one and
    // keep betting, we will win.' Volume + persistent edge > waiting
    // for blowout signals. Moneyline (WE) bets specifically are our
    // strongest signal (132-season Retrosheet validation); we should
    // fire on small but real edges.
    edge_pp_min:           2,
    edge_pp_max:           20,
    // User direction 2026-06-03: 'no more than 2 dollars lost.'
    // Daily loss limit lifted to $2. Open exposure also $2 so the
    // 50/50 split gives $1 to props + $1 to moneylines.
    daily_loss_cents_max:  200,    // $2 daily realized-loss limit
    open_exposure_max:     200,    // $2 total open positions
};

const DEFAULTS = {
    enabled:               false,
    unit_cents:            200,    // $2.00 max per fire — comfortable size for practice mode ($100 bankroll)
    // 2026-06-03 user direction: 'edge doesn't need to be massive
    // because as long as we have one and keep betting, we will win.'
    // Moneyline (WE) is our strongest signal — Retrosheet 132-season
    // validation. Volume of small-edge bets > waiting for blowout
    // signals. Lowered 5 → 3pp.
    edge_threshold_pp:     3,
    // 2026-06-03: lowered 7 → 5pp. Earlier the prop threshold was
    // padded high because the model was noisy (the Wenceel /
    // Gleyber pattern). Since then we've added: realistic-ceiling
    // gate, realistic-baseline gate, massive-disagreement guard,
    // payout-size guard, threshold-total fix, NO-side disabled.
    // A prop bet that survives ALL those gates AND has +5pp+ edge
    // is a real edge worth taking. NO bets still pay the +4pp
    // penalty → 9pp NO bar (still well above noise).
    player_prop_edge_threshold_pp: 5,
    // 2026-06-03: lowered 3 → 1 per user 'WIN EXPECTANCY IS OUR
    // FUCKING EDGE'. Early-inning WE swings ARE noisier (one HR
    // in the 1st moves WE 8pp), but blocking inning 1-2 entirely
    // means missing first-pitch through 2-out-of-2nd opportunities
    // — and the 3pp edge threshold + multi-factor gate already
    // filter out the noise. Scan everything; let the gates decide.
    min_inning_for_moneyline: 1,
    // Savant agreement is a SOFT confidence amplifier on
    // moneylines, not a hard gate. Disagreement is handled by the
    // multi-factor scoring framework's savant_alignment factor
    // (-1.5pp on adjusted edge). require_savant_agree forces a
    // strict hard gate for users who want it.
    require_savant_agree:       false,
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
    daily_loss_limit_cents: 200,   // $2 — per user 'no more than 2 dollars lost'
    open_exposure_max:     200,    // $2 total open ($1 props / $1 ML via 50/50)
    bet_player_props:      true,   // scan Kalshi player_prop markets too
    // TRUE-ADVANTAGE GATE — required factor agreement. New math (post
    // 2026-06-03) is fraction of factor weight that agrees with the
    // bet direction. 0.30 = at least 30% of factor weight pulls FOR
    // the bet. Lowered 0.40 → 0.30 per 'volume + persistent edge
    // wins' direction. Keeps the multi-factor sanity (factors must
    // mostly not disagree) without demanding unanimous confirmation.
    min_conviction:        0.30,
    // PRACTICE MODE — when true, every BUY decision the bot makes is
    // logged to a SEPARATE practice-fires localStorage bucket and
    // the actual Kalshi placeOrder call is SKIPPED. Lets the user
    // see what the bot would do (and how those positions would have
    // moved) without spending a cent. All sanity gates, scoring, and
    // caps still apply — practice mode shows the REAL behavior, just
    // with no money behind it.
    practice_mode:         false,
    // Virtual bankroll for practice mode. Bot deducts the trade cost
    // from this on every practice fire and refuses to fire when the
    // remaining bankroll can't cover the order. Live mark-to-market
    // adds the current value of open positions back when computing
    // total practice 'wealth'. Reset button in the Practice tab.
    practice_starting_bankroll_cents: 10000,   // $100 default
    // NO-SIDE PLAYER PROPS — re-enabled 2026-06-04. Disabled 2026-06-02
    // after the user lost the bankroll to NO bets that scored on
    // already-realized events (the bot computed an 'edge' before
    // checking the player's live stats). That structural bug is
    // now fixed: stat-check runs at the TOP of scanPlayerProps,
    // before orderbook fetch / edge math / scoring. Combined with
    // the payout-size guard (refuses ask > 60¢, blocking rare-event
    // NO traps at 90¢+), floor-ask guard (≤2¢), tail-probability
    // guard (our_p > 95%), and the +4pp NO penalty (NO needs 9pp
    // adjusted edge minimum), NO bets are now bounded to a rational
    // band: ask 3-60¢, our_p mid-range, high-conviction disagreement.
    bet_no_side_player_props: true,
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
    // CORRELATED-LADDER GATE — prop ladders (Cole over 6/7/8/9/10 K)
    // are perfectly correlated. Stacking fires across a ladder
    // sizes the same underlying bet Nx. BUT: a higher threshold
    // with HIGHER adjusted edge means more conviction — taking it
    // is justified because each subsequent threshold represents
    // a stronger model belief. So the gate isn't a hard cap, it's
    // an 'edge must keep climbing' rule. Each new fire in a (player,
    // stat, game) group must clear the previous max by this many
    // pp. Default 2pp — small enough to allow real conviction
    // climbs (5pp→7pp→10pp ok), big enough to block 5pp→5.1pp
    // micro-step stacking. Set to 0 to allow any subsequent fire
    // at >= the prior max edge.
    ladder_min_edge_increase_pp: 2,
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
    deadProps:  new Set(),     // tickers permanently skipped this session (our_p≈0, pitcher pulled, PA exhaustion)
    loggedDecisions: new Set(),// ticker:side:reason already logged to Edges this session — dedup
    playerStatLadder: new Map(),// "game_pk:player_id:stat" → { count, maxEdgePP } highest fire so far (correlated-ladder gate)
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
        // MIGRATION 2026-06-03: bump any persisted unit_cents below
        // $1 up to the new $2 default. The old $0.10 ceiling silently
        // blocked every ML fire (Kalshi ML contracts trade at 30-70¢
        // each). Anyone with old settings persisted would still be
        // stuck at the old value even after the code fix without
        // this nudge.
        if (typeof s.unit_cents === "number" && s.unit_cents < 100) {
            s.unit_cents = DEFAULTS.unit_cents;
        }
        // MIGRATION 2026-06-04: re-enable NO-side props for anyone
        // who had the 2026-06-02 disable persisted. The structural
        // stat-check-first bug fix means the original disaster
        // cause cannot repeat; user confirmed re-enable.
        if (s.bet_no_side_player_props === false) {
            s.bet_no_side_player_props = true;
        }
        _state.settings = clampSettings({ ...DEFAULTS, ...s });
        persistSettings();
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
        profit_take_cents:          clampInt(s.profit_take_cents, 5, 60),
        live_ev_take_pct:           clampFloat(s.live_ev_take_pct, 0.2, 0.95),
        daily_loss_limit_cents:     clampInt(s.daily_loss_limit_cents, 100, HARD_CAPS.daily_loss_cents_max),
        open_exposure_max:          clampInt(s.open_exposure_max, 200, HARD_CAPS.open_exposure_max),
        min_conviction:             clampFloat(s.min_conviction, 0, 1),
        moneyline_reserve_pct:      clampFloat(s.moneyline_reserve_pct, 0, 0.95),
        huge_edge_pp:               clampInt(s.huge_edge_pp, HARD_CAPS.edge_pp_min, HARD_CAPS.edge_pp_max),
        huge_edge_cap_pct:          clampFloat(s.huge_edge_cap_pct, 0.20, 0.95),
        bet_player_props:           s.bet_player_props !== false,
        bet_no_side_player_props:   s.bet_no_side_player_props === true,   // default OFF
        practice_mode:              s.practice_mode === true,               // default OFF (real-money)
        practice_starting_bankroll_cents: clampInt(s.practice_starting_bankroll_cents, 100, 1_000_00),
        ladder_min_edge_increase_pp: clampFloat(s.ladder_min_edge_increase_pp, 0, 10),
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

// Wrap BotScoring.logScoredDecision so repeated identical SKIPs
// don't flood the Edges screen. Same ticker + side + reason gets
// logged ONCE per session. Fires always pass through (no dedup).
// Without this, the same dead-prop SKIP was being logged on every
// 30s scan tick — six 'Luke Raley 1+ HR edge_below_threshold'
// entries in three minutes, etc.
function logScoredDecisionOnce(score, decision) {
    if (!score || !root.BotScoring || !root.BotScoring.logScoredDecision) return;
    const action = decision?.action || "unknown";
    if (action === "skip") {
        const ticker = score.meta?.ticker || "";
        const side   = decision.side || "yes";
        const reason = decision.reason || "unknown";
        const key    = `${ticker}:${side}:${reason}`;
        if (_state.loggedDecisions.has(key)) return;
        _state.loggedDecisions.add(key);
    }
    root.BotScoring.logScoredDecision(score, decision);
}


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
        // Open-exposure + balance + auth checks. ALL of these run
        // against REAL Kalshi state — useless in practice mode where
        // the virtual bankroll is the source of truth. Previously
        // the top-of-scan halted at 'Kalshi balance $0.00' on every
        // tick when a user testing in practice had $0 real cash,
        // so the scan never reached the per-game loop and nothing
        // was ever evaluated. Bypass entirely in practice mode;
        // the per-fire virtual bankroll check still gates spending.
        if (!_state.settings.practice_mode) {
            if (root.Kalshi && root.Kalshi.getPositions) {
                try {
                    const posResp = await root.Kalshi.getPositions();
                    _state.openPositions =
                        (posResp?.market_positions || [])
                            .filter((p) => (p.position || 0) !== 0);
                } catch { /* fall through with stale snapshot */ }
            }
            const exposureCents = computeOpenExposureCents();
            if (exposureCents >= _state.settings.open_exposure_max) {
                log("skip", `Open exposure $${(exposureCents/100).toFixed(2)} >= cap $${(_state.settings.open_exposure_max/100).toFixed(2)}; skipping this scan`);
                _state.lastScanAt = Date.now();
                return;
            }
            if (root.Kalshi && root.Kalshi.getBalance) {
                try {
                    const balanceCents = await root.Kalshi.getBalance();
                    if (balanceCents != null && balanceCents < 1) {
                        log("halt", `Kalshi balance $${(balanceCents/100).toFixed(2)} — nothing to bet with; skipping scan`);
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
                    root._botZeroBalScans = 0;
                } catch { /* fall through to per-fire check */ }
            }
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
        }
        // In practice mode the scan still needs Kalshi for orderbook
        // lookups (the per-game scanner calls Kalshi.getOrderbook for
        // each ticker). Auth itself isn't strictly required — markets
        // are public — but if Kalshi is broken we'll hit per-orderbook
        // failures downstream. Don't halt the scan over it.

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
    //    confidence amplifier). Win expectancy is our strongest
    //    edge — 132 seasons of Retrosheet validation.
    if (ourHome == null) {
        log("skip", `No WE for ${g.away}@${g.home} (game state too early or missing) — moneyline scan blocked`);
    } else {
        const gInning = parseInt(g.inning, 10) || 0;
        if (gInning < _state.settings.min_inning_for_moneyline) {
            log("skip", `Moneyline scan blocked — ${g.away}@${g.home} inning ${gInning} < min ${_state.settings.min_inning_for_moneyline}`);
        } else {
            const moneylines = (d.markets?.moneyline || []).filter((m) => m.source === "kalshi");
            if (moneylines.length === 0) {
                log("skip", `No Kalshi moneyline market for ${g.away}@${g.home}`);
            } else {
                log("bot", `Scanning ${moneylines.length} moneyline${moneylines.length === 1 ? "" : "s"} for ${g.away}@${g.home} (our WE: ${(ourHome*100).toFixed(1)}% home)`);
                for (const m of moneylines) {
                    await checkAndMaybeFire(g, m, ourHome, savantHome);
                }
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
        const propKey = m.raw_market_id || `${parsed.player}:${parsed.threshold}:${parsed.stat}`;

        // DEAD-PROP CACHE — once we've marked this ticker terminal
        // (pitcher pulled, batter PAs exhausted, our_p ≈ 0), skip
        // it silently for the rest of the session. Without this
        // the same useless prop ('Luke Raley 1+ HR' after his last
        // PA) re-scores every 30s scan and floods the Edges screen.
        if (_state.deadProps.has(propKey)) continue;

        const mlbam = nameToMlbam[normName(parsed.player)];
        if (!mlbam) continue;

        // PITCHER-NOT-ACTIVE guard — explicit skip when a K-prop's
        // player is not the current pitcher on either side. The
        // 'George Kirby has been pulled' case: Kalshi keeps the
        // market open until it settles, but the bot has no business
        // scoring it. Mark terminal so we never re-score it.
        if (parsed.stat === "strikeouts"
            && String(mlbam) !== String(homePitcher)
            && String(mlbam) !== String(awayPitcher)) {
            _state.deadProps.add(propKey);
            log("skip", `Pitcher not active — ${parsed.player} ${parsed.threshold}+ K: not currently on the mound — marked terminal for this session`);
            continue;
        }

        // ── STAT-CHECK FIRST. User direction (2026-06-04): 'you take
        //    under 6 ks because you see an edge but you dont check
        //    the stats first.' The 'Already crossed' guard used to
        //    run AFTER edge computation, deep in the sanity-gate
        //    block. By that point the bot had already 'seen' a
        //    juicy edge it shouldn't have considered. Move it to
        //    the very top — BEFORE orderbook fetch, BEFORE edge
        //    math, BEFORE scoring.
        //
        //    If pitcher has 6 Ks and threshold is 6+ → already-won
        //    YES (no upside), guaranteed-loss NO. If batter has 1 HR
        //    and threshold is 1+ → same. Either way the prop is
        //    settled from this player's perspective; the bot has
        //    no business pricing edge against the market here.
        const liveStatNow = liveStatForBet(modelProps, mlbam, parsed.stat);
        if (liveStatNow != null && liveStatNow >= parsed.threshold) {
            _state.deadProps.add(propKey);
            log("skip", `Threshold already crossed — ${parsed.player} has ${liveStatNow} ${parsed.stat} ≥ threshold ${parsed.threshold} — marked terminal (stat-check ran BEFORE edge math)`);
            continue;
        }

        const ladder = modelData[mlbam]?.[parsed.stat];
        if (!ladder) {
            // No projection available — likely a substitute or
            // bench player Kalshi listed. Mark terminal: re-checking
            // every 30s won't bring the ladder back.
            _state.deadProps.add(propKey);
            continue;
        }
        const our_p_yes = ladder[parsed.threshold];
        if (our_p_yes == null) {
            _state.deadProps.add(propKey);
            continue;
        }

        // DEAD-MODEL guard — our_p ≤ 1% means the model has given
        // up on this prop entirely (player out of PAs, threshold
        // unreachable from current state). Market will settle to
        // NO and the YES edge is a structural negative. Mark
        // terminal — re-scoring every scan adds nothing.
        if (our_p_yes <= 0.01) {
            _state.deadProps.add(propKey);
            log("skip", `Dead prop — ${parsed.player} ${parsed.threshold}+ ${parsed.stat}: our_p ${(our_p_yes*100).toFixed(2)}% — marked terminal for this session`);
            continue;
        }

        // ── GATE 0 — REALISTIC THRESHOLD ─────────────────────────────
        // Two-part check using the player's SEASON per-game rate:
        //
        // (a) HARD CEILING: threshold must not exceed 2× season rate.
        //     E.g. Randy Arozarena averages 0.9 hits/game, so 'realistic
        //     ceiling' = ceil(0.9 × 2) = 2. '3+ H' or '4+ H' for him
        //     gets skipped without even computing probability.
        //
        // (b) BASELINE FLOOR: if (a) passes, baseline P(threshold ≥ k)
        //     under Poisson must be ≥ 1%. Catches edge cases where the
        //     ceiling rule allows a marginal threshold (e.g. a player
        //     with 0.6 rate, threshold 2: ceiling allows it, but
        //     P(2+) ≈ 12% so it's fine; vs another at 0.5 rate where
        //     P(2+) ≈ 9% — also fine; rule mostly catches the
        //     ceiling cases).
        //
        // Both return null with small samples (<10 hitter games, <3
        // pitcher starts); when null, allow through.
        const realisticMax = realisticThresholdCeiling(modelProps, mlbam, parsed.stat);
        if (realisticMax != null && parsed.threshold > realisticMax) {
            log("skip", `Realistic-threshold guard — ${parsed.player} ${parsed.threshold}+ ${parsed.stat}: max realistic threshold is ${realisticMax} (he doesn't do this many)`);
            continue;
        }
        const baselineP = baselineProbForBet(modelProps, mlbam, parsed.stat, parsed.threshold);
        if (baselineP != null && baselineP < 0.01) {
            log("skip", `Realistic-threshold guard — ${parsed.player} ${parsed.threshold}+ ${parsed.stat}: season baseline ${(baselineP*100).toFixed(2)}% (he basically never does this)`);
            continue;
        }

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

        // SETTLED-PROP guard. When NO side has no ask in the book
        // AND YES edge is negative AND our_p is low (<10%), the
        // market is signaling 'this prop is over' — no one wants to
        // sell NO at any price. Our model agrees there's basically
        // no chance. Re-scoring it every scan adds nothing; mark
        // terminal. This is the 'Luke Raley 1+ HR after his last
        // PA' case — was logging an identical -5pp YES skip every
        // 30s and flooding the Edges screen.
        if (noAskCents == null && yes_edge_pp < 0 && our_p_yes < 0.10) {
            _state.deadProps.add(propKey);
            log("skip", `Settled prop — ${parsed.player} ${parsed.threshold}+ ${parsed.stat}: NO side empty, YES edge ${yes_edge_pp.toFixed(1)}pp, our_p ${(our_p_yes*100).toFixed(1)}% — marked terminal`);
            continue;
        }

        // ── MASSIVE-DISAGREEMENT GUARD ─────────────────────────────
        // If our_p and market_p disagree by more than 25pp in absolute
        // value on EITHER side, it's much more likely our model is
        // wrong than the market is mispriced. Pattern observed: 'Luis
        // Torrens 2+ H' showed model 9% vs market 99% — clearly an
        // already-realized event our threshold-crossed gate failed to
        // identify (probably MLBAM mismatch or pinch-hit subbed
        // batter not in lineup map).
        //
        // Trust the market. Skip these BEFORE scoring so they don't
        // clutter the Decisions log either.
        const yesAbs = yes_market_p != null ? Math.abs((our_p_yes - yes_market_p) * 100) : 0;
        const noAbs  = no_market_p  != null ? Math.abs((no_our_p   - no_market_p ) * 100) : 0;
        if (yesAbs > 25 || noAbs > 25) {
            log("skip", `Massive-disagreement guard — ${parsed.player} ${parsed.threshold}+ ${parsed.stat}: |our ${(our_p_yes*100).toFixed(1)}% − market ${((yes_market_p ?? 0)*100).toFixed(1)}%| = ${Math.max(yesAbs, noAbs).toFixed(1)}pp; likely model error not edge`);
            continue;
        }

        // Pick the side with the bigger edge. Threshold check is
        // applied AFTER the pick so the scoring/logging path knows
        // which side we were considering.
        const chooseNo = no_edge_pp > yes_edge_pp;
        // NO-SIDE KILL — when bet_no_side_player_props is off (the
        // default), refuse NO trades regardless of edge. Only fires
        // YES even when NO would have been the higher-edge side. If
        // YES has no edge either, the bet just doesn't happen.
        // Solves the 'every single attempted bet is NO' pattern.
        if (chooseNo && !_state.settings.bet_no_side_player_props) {
            log("skip", `NO disabled — ${parsed.player} ${parsed.threshold}+ ${parsed.stat}: NO edge ${no_edge_pp.toFixed(1)}pp ignored (bet_no_side_player_props=false)`);
            continue;
        }
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

        // 1b) PAYOUT-SIZE GUARD — refuse player-prop BUYs above 60¢.
        // User direction: 'for these bets like Raley, just make sure
        // the payout is large enough.' Above 60¢ ask the payout per
        // contract drops below 40¢ — even a 20pp edge yields small
        // expected profit and the loss side eats it on one bad call.
        // Better to pass on a marginally-positive bet at 70¢ ask and
        // wait for a wider-payout setup.
        //
        // Moneylines are NOT affected by this gate (lives in props
        // path only) — WE-driven moneyline bets are our strongest
        // signal, fire even on tight asks.
        if (askCents != null && askCents > 60) {
            log("skip", `Payout-size guard — ${parsed.player} ${parsed.threshold}+ ${parsed.stat} ${side.toUpperCase()} at ${askCents}¢: payout only ${100-askCents}¢ per contract, edge needs to be huge to justify`);
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
            _state.deadProps.add(propKey);
            log("skip", `Already crossed — ${parsed.player} has ${liveStat} ${parsed.stat} ≥ threshold ${parsed.threshold} — marked terminal for this session`);
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
                    _state.deadProps.add(propKey);
                    log("skip", `Pitcher-pulled guard — ${parsed.player} at ${pitchesThrown} pitches (p80+10 = ${limit}) — marked terminal for this session`);
                    continue;
                }
            }
        }

        // 6) PA-EXHAUSTION guard (hitter props). If there are <0.5
        //    turns remaining for the lineup, the batter is unlikely
        //    to get another PA. Mark terminal — the market settles
        //    quickly from here and re-checking adds nothing.
        if (parsed.stat !== "strikeouts") {
            const turnsLeft = modelProps?.game_state?.turns_remaining;
            if (typeof turnsLeft === "number" && turnsLeft < 0.5) {
                _state.deadProps.add(propKey);
                log("skip", `PA-exhaustion guard — ${parsed.player} ${parsed.threshold}+ ${parsed.stat}: only ${turnsLeft.toFixed(2)} turns left — marked terminal for this session`);
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
        //
        // NO-BIAS CORRECTION (2026-06-02). User direction: 'why are
        // you betting NO so much.' Rare-event prop markets (1+ HR,
        // 1+ hit at threshold 1) systematically price YES around
        // 10¢ / NO around 90¢, so a model that disagrees by 2pp
        // always lands on the NO side. NO bets pay 11¢ per contract
        // when they win and lose 89¢ when they lose — high variance,
        // tiny edge, and easily ruined by a single stale-model fire.
        // Require an EXTRA 4pp of edge for NO bets to compensate.
        const propThreshold = _state.settings.player_prop_edge_threshold_pp;
        const effectivePropThreshold = side === "no"
            ? propThreshold + 4
            : propThreshold;
        if (edgePP < effectivePropThreshold) {
            if (score) logScoredDecisionOnce(score, {
                action: "skip", reason: "edge_below_threshold",
                threshold_pp: effectivePropThreshold,
                no_bias_penalty_applied: side === "no",
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
                logScoredDecisionOnce(score, {
                    action: "skip", reason: "adjusted_edge_below_threshold",
                    threshold_pp: propThreshold, raw_edge_pp: edgePP, side,
                });
                continue;
            }
            if (conf < minConf) {
                logScoredDecisionOnce(score, {
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

        // CORRELATED-LADDER GATE — Cole over 6/7/8/9/10 K is one
        // outcome priced 5 ways. Allow stacked fires ONLY when each
        // new threshold's adjusted edge clears the prior fire's by
        // ladder_min_edge_increase_pp. Logic: climbing edge =
        // increasing conviction, so taking more correlated bets is
        // justified. Flat or falling edge = same conviction at a
        // worse risk profile, skip.
        const groupKey = `${g.game_pk}:${mlbam}:${parsed.stat}`;
        const groupState = _state.playerStatLadder.get(groupKey);
        const candidateEdge = Number(score?.edge_pp) || 0;
        if (groupState) {
            const requiredEdge = groupState.maxEdgePP + _state.settings.ladder_min_edge_increase_pp;
            if (candidateEdge < requiredEdge) {
                if (score) logScoredDecisionOnce(score, {
                    action: "skip", reason: "ladder_edge_did_not_climb",
                    player: parsed.player, stat: parsed.stat,
                    candidate_edge_pp: candidateEdge,
                    prior_max_edge_pp: groupState.maxEdgePP,
                    required_edge_pp: requiredEdge,
                    increase_required_pp: _state.settings.ladder_min_edge_increase_pp,
                    already_fired: groupState.count,
                    side,
                });
                log("skip", `Ladder gate — ${parsed.player} ${parsed.threshold}+ ${parsed.stat} ${side.toUpperCase()}: edge ${candidateEdge.toFixed(1)}pp didn't clear prior fire's ${groupState.maxEdgePP.toFixed(1)}pp + ${_state.settings.ladder_min_edge_increase_pp}pp climb requirement`);
                continue;
            }
        }

        const contracts = sizeContractsByConviction(askCents, score, _state.settings.unit_cents);
        if (contracts < 1) {
            if (score) logScoredDecisionOnce(score, {
                action: "skip", reason: "unit_too_small_for_market",
                ask_cents: askCents, unit_cents: _state.settings.unit_cents, side,
            });
            log("skip", `Prop ${parsed.player} ${parsed.threshold}+ ${parsed.stat} ${side.toUpperCase()}: ask ${askCents}¢ > unit cap ${_state.settings.unit_cents}¢`);
            continue;
        }
        const tradeCostCents = contracts * askCents;
        // HARD 50/50 SPLIT — applies in BOTH real mode and practice
        // mode. In real mode: cap = settings.open_exposure_max, split
        // is checked against Kalshi positions. In practice mode: cap
        // = practice_starting_bankroll_cents (scales the split to the
        // virtual bankroll), split checked against the practice fire
        // log. Same RULE, just keyed to the bankroll the bot is
        // actually spending from.
        const propsCapPct = 1 - _state.settings.moneyline_reserve_pct;
        const exposureBase = _state.settings.practice_mode
            ? _state.settings.practice_starting_bankroll_cents
            : _state.settings.open_exposure_max;
        const propsCapCents = Math.round(exposureBase * propsCapPct);
        const expSplit = _state.settings.practice_mode
            ? computePracticeExposureByKind()
            : computeOpenExposureByKindCents();
        const propsExposure = expSplit.player_prop + expSplit.unknown;
        if (propsExposure + tradeCostCents > propsCapCents) {
            if (score) logScoredDecisionOnce(score, {
                action: "skip", reason: "props_cap_hit",
                cap_cents:           propsCapCents,
                cap_pct:             propsCapPct,
                current_props_open:  propsExposure,
                side,
            });
            continue;
        }
        // Hard balance guard — refuse to even submit if Kalshi
        // balance can't cover it. PRACTICE MODE bypasses this; the
        // virtual bankroll check happens further down. Without
        // the bypass, a user testing in practice with $0 real
        // Kalshi balance got every prop fire silently skipped here.
        if (!_state.settings.practice_mode && !(await canAfford(tradeCostCents))) {
            log("skip", `Skip player_prop ${parsed.player} ${parsed.threshold}+ ${parsed.stat} [${side}]: balance below ${tradeCostCents}¢`);
            continue;
        }

        try {
            // PRACTICE MODE — log the would-have-been BUY and skip
            // the Kalshi call entirely. Same shape so all downstream
            // tools (P/L computation, history, edges-tab match) work
            // identically against the practice log.
            if (_state.settings.practice_mode) {
                // Bankroll check — refuse if virtual cash can't cover.
                const bankroll = computePracticeBankroll();
                if (bankroll.available_cents < tradeCostCents) {
                    log("skip", `[PRACTICE] bankroll exhausted: $${(bankroll.available_cents/100).toFixed(2)} available, ${tradeCostCents}¢ cost`);
                    continue;
                }
                // User approval mode: propose to the queue rather than
                // auto-firing. The bet is recorded as a fire ONLY after
                // the user clicks Approve in the Practice tab.
                recordPracticeFire({
                    kind:          "player_prop",
                    ticker, side, contracts,
                    price_cents:   askCents,
                    our_p, our_p_yes,
                    savant_p:      null,
                    market_p,
                    edge_pp:       edgePP,
                    game_pk:       g.game_pk,
                    matchup:       `${g.away}@${g.home}`,
                    player:        parsed.player,
                    stat:          parsed.stat,
                    threshold:     parsed.threshold,
                    placed_at:     new Date().toISOString(),
                    // FULL REASONING BUNDLE — captures every number the
                    // bot used to decide this trade. The Practice tab's
                    // expandable detail panel reads from here.
                    reasoning: {
                        // Raw edge math on both sides — so the user can
                        // see why this side was picked over the other.
                        yes_market_p:  Number(yes_market_p) || null,
                        no_market_p:   Number(no_market_p)  || null,
                        yes_edge_pp:   Number(yes_edge_pp)  || null,
                        no_edge_pp:    Number(no_edge_pp)   || null,
                        chosen_side:   side,
                        // Multi-factor score (the gate the bot used to
                        // confirm this was real edge, not noise).
                        score: score ? {
                            baseline_p:  score.baseline_p,
                            adjusted_p:  score.adjusted_p,
                            edge_pp:     score.edge_pp,
                            confidence:  score.confidence,
                            factors:     (score.factors || []).map((f) => ({
                                name:      f.name,
                                weight:    f.weight,
                                present:   f.present,
                                adjust_pp: f.adjust_pp,
                                value:     f.value,
                            })),
                        } : null,
                        // Player's live realized stat at fire time — proves
                        // the threshold wasn't already crossed.
                        live_stat: liveStat,
                        // Game state from model-props (turns_remaining etc).
                        game_state: modelProps.game_state || null,
                        // Sanity-gate audit — list of gates explicitly
                        // checked + passed in this scan.
                        gates_passed: [
                            "floor_ask",
                            "orderbook_coherence",
                            "tail_probability",
                            "threshold_not_crossed",
                            (parsed.stat === "strikeouts" ? "pitcher_not_pulled" : "pa_remaining"),
                        ],
                    },
                });
                _state.sessionBets.add(key);
                _state.playerStatLadder.set(groupKey, {
                    count: (groupState?.count || 0) + 1,
                    maxEdgePP: Math.max(groupState?.maxEdgePP || -Infinity, candidateEdge),
                });
                persistSessionBets();
                log("buy-practice", `[PRACTICE] auto-fired ${contracts}× ${parsed.player} ${(side === "no" ? "UNDER" : "OVER")} ${parsed.threshold} ${parsed.stat} @ ${askCents}¢`);
                toast(`Practice: ${parsed.player} ${parsed.threshold}+ ${parsed.stat} ${(side === "no" ? "UNDER" : "OVER")} @ ${askCents}¢`, "ok");
                await sleep(50);
                continue;
            }
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
            _state.playerStatLadder.set(groupKey, {
                count: (groupState?.count || 0) + 1,
                maxEdgePP: Math.max(groupState?.maxEdgePP || -Infinity, candidateEdge),
            });
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
            if (score) logScoredDecisionOnce(score, {
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

// Conviction-scaled sizing. Base 2 contracts (always willing to
// spend at least the ask × 2). Higher adjusted edge → more
// contracts to chase EV. Capped by unit_cents (≤$5 hard ceiling).
//
// Ladder:
//   <3pp adjusted edge → wouldn't fire anyway (filtered upstream)
//    3-5pp           → 2 contracts
//    5-8pp           → 4 contracts
//    8-12pp          → 6 contracts
//   12pp+            → 10 contracts (the 'huge edge' band)
//
// Returns 0 when even 1 contract exceeds the cap. Caller logs
// the skip — silent 'contracts < 1' returns were the bug that
// hid the old $0.10 unit blocking every ML fire.
function sizeContractsByConviction(askCents, score, unitCents) {
    if (!Number.isFinite(askCents) || askCents <= 0) return 0;
    if (askCents > unitCents) return 0;
    const adjEdge = Math.abs(Number(score && score.edge_pp) || 0);
    let contracts;
    if      (adjEdge >= 12) contracts = 10;
    else if (adjEdge >=  8) contracts =  6;
    else if (adjEdge >=  5) contracts =  4;
    else                     contracts =  2;
    while (contracts > 1 && contracts * askCents > unitCents) contracts--;
    return contracts;
}

async function checkAndMaybeFire(g, market, ourHome, savantHome) {
    // Identify which TEAM this Kalshi market is YES'ing on. The
    // ticker tail is the tricode (KXMLBGAME-...-DET, ...-TB, etc.).
    // Match against g.home / g.away to know if YES = home wins.
    const ticker = market.raw_market_id || "";
    const tail = ticker.split("-").slice(-1)[0]?.toUpperCase() || "";
    const isHomeSide = tail === g.home || tail === g.home?.toUpperCase();
    const isAwaySide = tail === g.away || tail === g.away?.toUpperCase();
    if (!isHomeSide && !isAwaySide) {
        log("skip", `Moneyline ${ticker}: ticker tail '${tail}' doesn't match ${g.away}/${g.home}`);
        return;
    }

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
    if (yesAskCents == null) {
        log("skip", `Moneyline ${tail} ${g.away}@${g.home}: no YES ask in orderbook (market thin/empty)`);
        return;
    }

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
        if (score) logScoredDecisionOnce(score, {
            action: "skip", reason: "savant_disagree_hard_gate",
        });
        return;
    }

    // SOFT-gate mode (default): Savant disagreement is handled by
    // the multi-factor scoring framework's savant_alignment factor
    // (-1.5pp on the adjusted edge). The old code ALSO raised the
    // raw-edge bar by savant_disagree_penalty_pp here, which double-
    // counted Savant — a Savant-disagree raw 6pp edge became 4.5pp
    // adjusted, failing the same 6pp gate. Net effect: Savant
    // disagreement cost ~4.5pp instead of 1.5pp, locking out the
    // WE-driven moneyline fires that ARE our strongest signal.
    // 2026-06-03 fix: single chokepoint — raw edge clears base
    // edge_threshold_pp, scoring framework handles Savant.
    const effectiveThreshold = _state.settings.edge_threshold_pp;
    if (edgePP < effectiveThreshold) {
        if (score) logScoredDecisionOnce(score, {
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
            logScoredDecisionOnce(score, {
                action: "skip", reason: "adjusted_edge_below_threshold",
                threshold_pp: effectiveThreshold, raw_edge_pp: edgePP,
            });
            return;
        }
        if (conf < minConf) {
            logScoredDecisionOnce(score, {
                action: "skip", reason: "confidence_below_min_conviction",
                min_conviction: minConf,
            });
            return;
        }
    }

    // Already bet this market+side this session?
    const key = `${ticker}:yes`;
    if (_state.sessionBets.has(key)) return;

    // Conviction-scaled sizing. Base 1 contract, +1 at 5pp adjusted
    // edge, +2 at 8pp — capped at unit_cents (=$1.00 hard ceiling).
    const contracts = sizeContractsByConviction(yesAskCents, score, _state.settings.unit_cents);
    if (contracts < 1) {
        if (score) logScoredDecisionOnce(score, {
            action: "skip", reason: "unit_too_small_for_market",
            ask_cents: yesAskCents, unit_cents: _state.settings.unit_cents,
        });
        log("skip", `Moneyline ${tail} ${g.away}@${g.home}: YES ask ${yesAskCents}¢ > unit cap ${_state.settings.unit_cents}¢`);
        return;
    }

    // HARD 50/50 SPLIT (moneyline side). Symmetric to props side
    // and to practice mode (see scanPlayerProps). Cap base is the
    // practice bankroll in practice mode, open_exposure_max in
    // real mode.
    const tradeCostCents = contracts * yesAskCents;
    const mlCapPct = _state.settings.moneyline_reserve_pct;
    const mlExposureBase = _state.settings.practice_mode
        ? _state.settings.practice_starting_bankroll_cents
        : _state.settings.open_exposure_max;
    const mlCapCents = Math.round(mlExposureBase * mlCapPct);
    const mlSplit = _state.settings.practice_mode
        ? computePracticeExposureByKind()
        : computeOpenExposureByKindCents();
    const mlExposure = mlSplit.moneyline + mlSplit.unknown;
    if (mlExposure + tradeCostCents > mlCapCents) {
        if (score) logScoredDecisionOnce(score, {
            action: "skip", reason: "moneyline_cap_hit",
            cap_cents:        mlCapCents,
            cap_pct:          mlCapPct,
            current_ml_open:  mlExposure,
        });
        return;
    }
    // Hard balance check — if Kalshi reports less cash than this
    // specific order would cost, skip silently. PRACTICE MODE
    // bypasses this; virtual bankroll check is below. Without the
    // bypass, every ML fire was getting blocked here when the user
    // was testing in practice with $0 real Kalshi balance.
    if (!_state.settings.practice_mode && !(await canAfford(tradeCostCents))) {
        log("skip", `Skip ${ticker}: balance below ${tradeCostCents}¢ trade cost`);
        return;
    }

    // FIRE.
    try {
        // PRACTICE MODE — log + skip the Kalshi call.
        if (_state.settings.practice_mode) {
            const bankroll = computePracticeBankroll();
            if (bankroll.available_cents < tradeCostCents) {
                log("skip", `[PRACTICE] bankroll exhausted: $${(bankroll.available_cents/100).toFixed(2)} available, ${tradeCostCents}¢ cost`);
                return;
            }
            recordPracticeFire({
                kind:          "moneyline",
                ticker,
                side:          "yes",
                contracts,
                price_cents:   yesAskCents,
                our_p, savant_p, market_p,
                edge_pp:       edgePP,
                savant_stance: savantStance,
                game_pk:       g.game_pk,
                matchup:       `${g.away}@${g.home}`,
                bet_team:      tail,
                placed_at:     new Date().toISOString(),
                reasoning: {
                    yes_market_p:  market_p,
                    yes_edge_pp:   edgePP,
                    chosen_side:   "yes",
                    score: score ? {
                        baseline_p:  score.baseline_p,
                        adjusted_p:  score.adjusted_p,
                        edge_pp:     score.edge_pp,
                        confidence:  score.confidence,
                        factors:     (score.factors || []).map((f) => ({
                            name:      f.name,
                            weight:    f.weight,
                            present:   f.present,
                            adjust_pp: f.adjust_pp,
                            value:     f.value,
                        })),
                    } : null,
                    savant_p,
                    savant_stance,
                    inning:        g.inning || null,
                    game_state:    g,
                    gates_passed:  ["edge_threshold", "min_inning"],
                },
            });
            _state.sessionBets.add(key);
            persistSessionBets();
            log("buy-practice", `[PRACTICE] auto-fired ${contracts}× ${tail} YES @ ${yesAskCents}¢ (edge ${edgePP.toFixed(1)}pp)`);
            toast(`Practice: ${tail} YES @ ${yesAskCents}¢`, "ok");
            return;
        }
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
        if (score) logScoredDecisionOnce(score, {
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

// ── Practice fires (paper-trading log) ────────────────────────────
// Same shape as fires, separate bucket. Practice mode writes here
// instead of calling Kalshi. Lets the user see what the bot would
// have done — and how those positions move — without spending money.
const LS_PRACTICE_FIRES = "diamond_context_bot_practice_fires";
const PRACTICE_FIRES_MAX = 500;
function recordPracticeFire(payload) {
    let arr;
    try { arr = JSON.parse(localStorage.getItem(LS_PRACTICE_FIRES) || "[]"); }
    catch { arr = []; }
    arr.unshift({ ...payload, practice: true });
    if (arr.length > PRACTICE_FIRES_MAX) arr.length = PRACTICE_FIRES_MAX;
    try { localStorage.setItem(LS_PRACTICE_FIRES, JSON.stringify(arr)); } catch {}
    // Live-refresh the drawer so the Practice tab updates the second
    // a fire lands instead of waiting for the next render cycle.
    refreshDrawerIfOpen();
}
function getPracticeFires() {
    try { return JSON.parse(localStorage.getItem(LS_PRACTICE_FIRES) || "[]"); }
    catch { return []; }
}
function clearPracticeFires() {
    try { localStorage.removeItem(LS_PRACTICE_FIRES); } catch {}
}

// ── Practice approval queue ───────────────────────────────────────
// In practice mode the bot doesn't auto-fire. Instead each candidate
// goes into a 'pending' queue. The user approves (→ becomes a
// practice fire) or declines (→ logged with an optional note so we
// can review later what they rejected and why).
const LS_PRACTICE_PENDING  = "diamond_context_bot_practice_pending";
const LS_PRACTICE_DECLINED = "diamond_context_bot_practice_declined";
const PRACTICE_PENDING_MAX = 100;
const PRACTICE_DECLINED_MAX = 500;

function getPracticePending() {
    try { return JSON.parse(localStorage.getItem(LS_PRACTICE_PENDING) || "[]"); }
    catch { return []; }
}
function getPracticeDeclined() {
    try { return JSON.parse(localStorage.getItem(LS_PRACTICE_DECLINED) || "[]"); }
    catch { return []; }
}
function clearPracticePending() {
    try { localStorage.removeItem(LS_PRACTICE_PENDING); } catch {}
}
function clearPracticeDeclined() {
    try { localStorage.removeItem(LS_PRACTICE_DECLINED); } catch {}
}

// Add a candidate to the pending queue. Dedupe by ticker+side so
// the same scan tick doesn't enqueue the same bet twice.
function proposePracticeBet(payload) {
    const arr = getPracticePending();
    const key = `${payload.ticker}:${payload.side}`;
    if (arr.some((p) => `${p.ticker}:${p.side}` === key)) return null;
    const note = {
        id: `pp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        proposed_at: new Date().toISOString(),
        status: "pending",
        ...payload,
    };
    arr.unshift(note);
    if (arr.length > PRACTICE_PENDING_MAX) arr.length = PRACTICE_PENDING_MAX;
    try { localStorage.setItem(LS_PRACTICE_PENDING, JSON.stringify(arr)); } catch {}
    return note.id;
}

// Approve a pending bet: move from pending → practice fires.
function approvePracticeBet(id) {
    const pending = getPracticePending();
    const idx = pending.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    const bet = pending[idx];
    // Reuse the existing practice fire path so all summary / Bets /
    // strip surfaces show it identically to an auto-fired bet.
    const { id: _drop, proposed_at, status, ...rest } = bet;
    recordPracticeFire({ ...rest, approved_at: new Date().toISOString() });
    pending.splice(idx, 1);
    try { localStorage.setItem(LS_PRACTICE_PENDING, JSON.stringify(pending)); } catch {}
    return true;
}

// Decline a pending bet with an optional user note ('tell the bot
// why you're saying no').
function declinePracticeBet(id, userNote) {
    const pending = getPracticePending();
    const idx = pending.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    const bet = pending[idx];
    pending.splice(idx, 1);
    try { localStorage.setItem(LS_PRACTICE_PENDING, JSON.stringify(pending)); } catch {}
    const declined = getPracticeDeclined();
    declined.unshift({
        ...bet,
        status: "declined",
        declined_at: new Date().toISOString(),
        user_note: userNote || null,
    });
    if (declined.length > PRACTICE_DECLINED_MAX) declined.length = PRACTICE_DECLINED_MAX;
    try { localStorage.setItem(LS_PRACTICE_DECLINED, JSON.stringify(declined)); } catch {}
    return true;
}

// Bankroll math for practice mode.
//   starting        — user-set initial virtual bank
//   total_cost      — sum of (contracts × price) across every practice fire
//   available       — starting − total_cost (what's left to spend)
//   We DON'T add back live mark-to-market for the available number
//   because in real money you don't get spent dollars back until the
//   position resolves. The Practice tab UI shows BOTH numbers:
//   available + total wealth (including open MTM).
function computePracticeBankroll() {
    // Real-money behavior: starting balance + realized P/L on settled
    // bets - cost locked up in still-open bets. A won bet returns its
    // cost AND adds profit; a lost bet is just gone; an open bet ties
    // up its cost but isn't yet realized.
    const starting = _state.settings.practice_starting_bankroll_cents;
    const fires = getPracticeFires();
    let openCost   = 0;
    let realizedPnl = 0;
    let settledWon  = 0;
    let settledLost = 0;
    for (const f of fires) {
        const cost = (f.contracts || 0) * (f.price_cents || 0);
        const settled = f.settled;
        if (settled) {
            realizedPnl += (settled.profit_cents || 0);
            if (settled.won) settledWon++; else settledLost++;
        } else {
            openCost += cost;
        }
    }
    const balance   = starting + realizedPnl;
    const available = Math.max(0, balance - openCost);
    return {
        starting_cents:    starting,
        total_cost_cents:  openCost,   // legacy alias — open-bet cost only
        realized_pnl_cents: realizedPnl,
        balance_cents:     balance,    // starting + realized
        available_cents:   available,  // balance - open cost
        settled_won:       settledWon,
        settled_lost:      settledLost,
    };
}

// Kind-split open exposure for practice fires — used so the same
// 50/50 split that constrains real-money fires also constrains
// practice fires, scaled to the practice bankroll. Only OPEN (un-
// settled) fires count against the cap; settled bets have already
// resolved and freed (or burned) their capital.
function computePracticeExposureByKind() {
    let moneyline = 0, player_prop = 0;
    for (const f of getPracticeFires()) {
        if (f.settled) continue;
        const cost = (f.contracts || 0) * (f.price_cents || 0);
        if (f.kind === "moneyline") moneyline += cost;
        else                         player_prop += cost;
    }
    return { moneyline, player_prop, unknown: 0 };
}

// Settle any pending practice fires whose games have finished.
// Mutates the practice-fires array in localStorage in place so the
// next computePracticeBankroll picks up realized P/L. Skipped fires
// (no boxscore, game not Final yet) stay open. Idempotent.
async function settleFinishedPracticeFires() {
    const fires = getPracticeFires();
    const pendingGamePks = [...new Set(
        fires
            .filter((f) => !f.settled && f.game_pk)
            .map((f) => f.game_pk)
    )];
    if (!pendingGamePks.length) return { newlySettled: 0 };
    const boxscoreMap = await fetchBoxscoreForGames(pendingGamePks);
    let newlySettled = 0;
    let mutated = false;
    for (const f of fires) {
        if (f.settled) continue;
        const box = boxscoreMap.get(f.game_pk);
        const result = settleFire(f, box);
        if (result && result.settled) {
            f.settled = {
                won:          result.won,
                profit_cents: result.profit_cents,
                settled_at:   new Date().toISOString(),
            };
            newlySettled++;
            mutated = true;
        }
    }
    if (mutated) {
        try { localStorage.setItem(LS_PRACTICE_FIRES, JSON.stringify(fires)); } catch {}
    }
    return { newlySettled };
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
            // DAILY-LOSS TRACKER. Was broken: the dailyLoss.cents
            // counter was only ever READ for the limit check, never
            // INCREMENTED. So the '$5 daily loss limit' never fired
            // no matter how much the bot lost. Increment on every
            // realized loss (profitPerContract * qty < 0) so the
            // limit can actually stop the bot.
            const realizedCents = profitPerContract * qty;
            if (realizedCents < 0) {
                _state.dailyLoss.cents += Math.abs(realizedCents);
                persistDailyLoss();
            }
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

// Was broken for NO positions — the previous 'if (qty <= 0)
// continue' skipped every NO holding because Kalshi reports
// those with NEGATIVE position values. Bot was firing NO bets
// almost exclusively (NO-bias on rare-event prop markets), so
// the exposure cap saw \$0 forever and let every trade through.
// THAT is how the 50% reserve became fictional.
function computeOpenExposureCents() {
    const split = computeOpenExposureByKindCents();
    return split.moneyline + split.player_prop + split.unknown;
}

// Kind-aware exposure split — needed for the HARD 50/50 cap.
// Returns { moneyline, player_prop, unknown } in cents. We match
// each Kalshi position to its fire record by ticker to identify
// the bet kind. Unknown bucket (manual bets or pre-bot positions)
// counts against BOTH caps so the user can't accidentally bypass
// the split by manually trading and then letting the bot fire on
// top — strict by design.
function computeOpenExposureByKindCents() {
    let moneyline = 0;
    let player_prop = 0;
    let unknown = 0;
    const fires = getFires();
    const fireByTicker = new Map();
    for (const f of fires) {
        if (f.ticker && !fireByTicker.has(f.ticker)) fireByTicker.set(f.ticker, f);
    }
    for (const p of _state.openPositions) {
        const qty = Math.abs(p.position || 0);
        if (qty === 0) continue;
        const entry = p.average_yes_price
                   ?? p.average_no_price
                   ?? p.average_cost_cents
                   ?? 0;
        const cost = qty * entry;
        const fire = fireByTicker.get(p.ticker);
        let kind = fire?.kind;
        if (!kind && p.ticker) {
            // Heuristic from Kalshi ticker shape:
            //   KXMLBGAME-... → moneyline
            //   KXMLB{HR|HIT|KS|TB}-... → player_prop
            if (/^KXMLBGAME/i.test(p.ticker))           kind = "moneyline";
            else if (/^KXMLB(HR|HIT|KS|TB)/i.test(p.ticker)) kind = "player_prop";
        }
        if (kind === "moneyline")      moneyline   += cost;
        else if (kind === "player_prop") player_prop += cost;
        else                            unknown     += cost;
    }
    return { moneyline, player_prop, unknown };
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
// Baseline probability of (stat ≥ threshold) for one game, using
// the player's season per-game rate as Poisson lambda. Returns null
// when we don't have season stats (early season, missing data, etc.) —
// caller treats null as "can't sanity-check, allow."
//
// User direction: 'It shouldn't be something a player has never done,
// or even something they haven't done in forever like hit 3 homers or
// a bum hits 2.'
function poissonAtLeast(threshold, lambda) {
    if (!(lambda > 0)) return 0;
    if (threshold <= 0) return 1;
    // P(X ≥ k) = 1 - sum_{i=0..k-1} e^-λ × λ^i / i!
    let cumP = 0;
    let term = Math.exp(-lambda);   // i=0 term
    cumP += term;
    for (let i = 1; i < threshold; i++) {
        term *= lambda / i;
        cumP += term;
    }
    return Math.max(0, 1 - cumP);
}

function baselineProbForBet(modelProps, playerMlbam, stat, threshold) {
    if (!modelProps?.lineups || !playerMlbam) return null;
    const want = String(playerMlbam);
    if (stat === "strikeouts") {
        for (const sk of ["home", "away"]) {
            const lp = modelProps.lineups[sk];
            if (!lp) continue;
            if (String(lp.pitcher_id) !== want) continue;
            const gs = lp.pitcher_season_gs || 0;
            const so = lp.pitcher_season_so || 0;
            if (gs < 3) return null;   // not enough sample
            const lambda = so / gs;     // K per start
            return poissonAtLeast(threshold, lambda);
        }
        return null;
    }
    // Hitter prop — find the batter, compute season per-game rate.
    for (const sk of ["home", "away"]) {
        const lp = modelProps.lineups[sk];
        if (!lp?.batters) continue;
        const b = lp.batters.find((x) => String(x.mlbam) === want);
        if (!b) continue;
        const g = b.season_games || 0;
        if (g < 10) return null;   // not enough sample
        let lambda;
        if (stat === "hits")        lambda = (b.season_hits || 0) / g;
        else if (stat === "home_runs")   lambda = (b.season_home_runs || 0) / g;
        else if (stat === "total_bases") {
            const tb = (b.season_hits || 0)
                     + (b.season_doubles || 0)
                     + 2 * (b.season_triples || 0)
                     + 3 * (b.season_home_runs || 0);
            lambda = tb / g;
        } else {
            return null;
        }
        return poissonAtLeast(threshold, lambda);
    }
    return null;
}

// "Realistic ceiling" for a prop: max threshold worth even
// CONSIDERING for this player. Defined as 2× the player's season
// per-game rate, rounded up. Anything beyond that is the 'Randy
// Arozarena 4+ H / Brett Baty 3+ H' pattern — the user said not to
// even bother considering these.
//
// Returns null when we can't compute (early season, missing data) —
// caller treats null as "can't decide, allow."
function realisticThresholdCeiling(modelProps, playerMlbam, stat) {
    if (!modelProps?.lineups || !playerMlbam) return null;
    const want = String(playerMlbam);
    if (stat === "strikeouts") {
        for (const sk of ["home", "away"]) {
            const lp = modelProps.lineups[sk];
            if (!lp) continue;
            if (String(lp.pitcher_id) !== want) continue;
            const gs = lp.pitcher_season_gs || 0;
            const so = lp.pitcher_season_so || 0;
            if (gs < 3) return null;
            return Math.max(1, Math.ceil((so / gs) * 2));
        }
        return null;
    }
    for (const sk of ["home", "away"]) {
        const lp = modelProps.lineups[sk];
        if (!lp?.batters) continue;
        const b = lp.batters.find((x) => String(x.mlbam) === want);
        if (!b) continue;
        const g = b.season_games || 0;
        if (g < 10) return null;
        let lambda = 0;
        if (stat === "hits")        lambda = (b.season_hits || 0) / g;
        else if (stat === "home_runs")   lambda = (b.season_home_runs || 0) / g;
        else if (stat === "total_bases") {
            const tb = (b.season_hits || 0)
                     + (b.season_doubles || 0)
                     + 2 * (b.season_triples || 0)
                     + 3 * (b.season_home_runs || 0);
            lambda = tb / g;
        } else {
            return null;
        }
        return Math.max(1, Math.ceil(lambda * 2));
    }
    return null;
}

// Settlement helpers for practice bets. Once a game ends, every
// practice fire on that game can be graded WON / LOST against the
// final boxscore. Uses /api/game/{pk}/boxscore directly — works
// for ANY date, not just today (previous impl checked /api/games/
// today which left yesterday's fires permanently unresolved).
//
// One boxscore call per unique game_pk; cached per render loop.
const _settlementCache = new Map();   // game_pk → { t, data }
const SETTLEMENT_TTL_MS = 5 * 60 * 1000;  // 5min: Finals don't change
async function fetchBoxscoreForGames(gamePks) {
    const out = new Map();
    const results = await Promise.allSettled(gamePks.map(async (pk) => {
        const cached = _settlementCache.get(pk);
        if (cached && Date.now() - cached.t < SETTLEMENT_TTL_MS) {
            return { pk, d: cached.data };
        }
        try {
            const res = await fetch(`/api/game/${pk}/boxscore`);
            if (!res.ok) return null;
            const d = await res.json();
            if (d.status === "Final") {
                _settlementCache.set(pk, { t: Date.now(), data: d });
            }
            return { pk, d };
        } catch { return null; }
    }));
    for (const r of results) {
        if (r.status === "fulfilled" && r.value?.d) out.set(r.value.pk, r.value.d);
    }
    return out;
}
function findPlayerLine(lines, mlbam, playerName) {
    if (!Array.isArray(lines)) return null;
    const want = String(mlbam || "");
    const target = normName(playerName || "");
    for (const ln of lines) {
        if (want && String(ln.mlbam) === want) return ln;
        if (target && normName(ln.name) === target) return ln;
    }
    return null;
}
function boxscoreStatForProp(boxscore, playerName, stat) {
    if (!boxscore) return null;
    if (stat === "strikeouts") {
        // Pitcher prop — check pitching lines on both sides.
        for (const side of ["home", "away"]) {
            const ln = findPlayerLine(boxscore.pitching?.[side], null, playerName);
            if (ln) return ln.K ?? 0;
        }
        return null;
    }
    // Hitter prop — check batting lines on both sides.
    for (const side of ["home", "away"]) {
        const ln = findPlayerLine(boxscore.batting?.[side], null, playerName);
        if (!ln) continue;
        if (stat === "hits")        return ln.H  ?? 0;
        if (stat === "home_runs")   return ln.HR ?? 0;
        if (stat === "total_bases") {
            return (ln.H || 0)
                 + (ln._2B || 0)
                 + 2 * (ln._3B || 0)
                 + 3 * (ln.HR || 0);
        }
    }
    return null;
}
// Returns { settled, won, profit_cents } or null when not yet
// graded. Profit is in cents: +contracts*(100-price) on a win,
// -contracts*price on a loss.
function settleFire(f, boxscore) {
    if (!boxscore || boxscore.status !== "Final") return null;
    const contracts  = f.contracts || 1;
    const price      = f.price_cents || 0;
    const profitWin  =  contracts * (100 - price);
    const profitLoss = -contracts * price;

    if (f.kind === "moneyline") {
        const totals  = boxscore.line_score?.totals || {};
        const homeRun = totals.home?.runs ?? 0;
        const awayRun = totals.away?.runs ?? 0;
        const homeWon = homeRun > awayRun;
        const awayWon = awayRun > homeRun;
        const betTeam  = String(f.bet_team || "").toUpperCase();
        const homeAbbr = String(boxscore.teams?.home?.abbr || "").toUpperCase();
        const awayAbbr = String(boxscore.teams?.away?.abbr || "").toUpperCase();
        const betHome  = betTeam === homeAbbr;
        const betAway  = betTeam === awayAbbr;
        if (!betHome && !betAway) return null;
        const yesWon = betHome ? homeWon : awayWon;
        const won = yesWon;
        return { settled: true, won, profit_cents: won ? profitWin : profitLoss };
    }
    if (f.kind === "player_prop") {
        const finalStat = boxscoreStatForProp(boxscore, f.player, f.stat);
        if (finalStat == null) return null;
        const yesWon = finalStat >= (f.threshold || 0);
        const won    = (f.side === "yes") ? yesWon : !yesWon;
        return { settled: true, won, profit_cents: won ? profitWin : profitLoss };
    }
    return null;
}

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
        // Fall back to all_player_stats — covers relievers whose
        // K stats live there.
        const all = modelProps.all_player_stats?.[want];
        if (all) return all.strikeouts ?? 0;
        return null;
    }

    // Hitter prop — first try the starting-lineup map, then fall
    // back to the all-players index. The fallback covers pinch
    // hitters / late subs not in the starting nine — the Luis
    // Torrens case where gate 4 missed because he wasn't a starter.
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
    // Fallback — all_player_stats covers every player who has
    // appeared, including subs.
    const all = modelProps.all_player_stats?.[want];
    if (all) {
        if (stat === "hits")        return all.hits        ?? 0;
        if (stat === "home_runs")   return all.home_runs   ?? 0;
        if (stat === "total_bases") {
            return (all.hits || 0)
                 + (all.doubles || 0)
                 + 2 * (all.triples || 0)
                 + 3 * (all.home_runs || 0);
        }
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

function openDrawer(initialTab = "performance") {
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
          <button class="bot-tab ${initialTab === "performance" ? "active" : ""}" data-tab="performance" role="tab">
            Results
          </button>
          <button class="bot-tab ${initialTab === "bets" ? "active" : ""}" data-tab="bets" role="tab">
            Bets <span class="bot-tab-count" data-bets-count>0</span>
          </button>
          <button class="bot-tab ${initialTab === "questions" ? "active" : ""}" data-tab="questions" role="tab">
            Questions <span class="bot-tab-count bot-tab-unread" data-questions-count>0</span>
          </button>
          <button class="bot-tab ${initialTab === "practice" ? "active" : ""}" data-tab="practice" role="tab">
            Practice <span class="bot-tab-count" data-practice-count>0</span>
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
        <div class="bot-tab-pane ${initialTab === "performance" ? "active" : ""}" data-pane="performance"></div>
        <div class="bot-tab-pane ${initialTab === "bets"        ? "active" : ""}" data-pane="bets"></div>
        <div class="bot-tab-pane ${initialTab === "questions"   ? "active" : ""}" data-pane="questions"></div>
        <div class="bot-tab-pane ${initialTab === "practice"    ? "active" : ""}" data-pane="practice"></div>
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
    // EMERGENCY BUTTON DELEGATION — kill-banner buttons live inside
    // the bot pane which gets re-rendered every 12s by the auto-
    // refresh. If a click lands on a button mid-rerender the direct
    // listener can be detached. Delegate from the overlay (stable
    // across rerenders) so clicks always fire.
    overlay.addEventListener("click", (e) => {
        const sellAllBtn = e.target.closest("[data-bot-emergency-sellall]");
        if (sellAllBtn) {
            e.preventDefault();
            handleEmergencySellAll(sellAllBtn);
            return;
        }
        const cancelAllBtn = e.target.closest("[data-bot-emergency-cancel]");
        if (cancelAllBtn) {
            e.preventDefault();
            handleEmergencyCancelAll(cancelAllBtn);
            return;
        }
    });
    const onKey = (e) => {
        if (e.key === "Escape") { closeDrawer(); document.removeEventListener("keydown", onKey); }
    };
    document.addEventListener("keydown", onKey);
}

async function handleEmergencySellAll(btn) {
    if (!confirm(
        "Sell EVERY held position at the current best bid for that side?\n\n" +
        "This is the nuclear-exit. Thin markets may pay you very little, but " +
        "you'll be flat. Existing resting orders are NOT touched — use the " +
        "other button for those."
    )) return;
    btn.disabled = true;
    btn.textContent = "Selling…";
    try {
        if (!root.Kalshi || !root.Kalshi.isConnected || !root.Kalshi.isConnected()) {
            toast("Kalshi not connected — can't sell", "err");
            btn.disabled = false;
            btn.textContent = "Sell ALL positions at market bid";
            return;
        }
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
                    ticker: p.ticker, side: heldSide, count: qty, price: bid, action: "sell",
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
}

async function handleEmergencyCancelAll(btn) {
    if (!confirm("Cancel EVERY resting order on Kalshi right now? Existing filled positions are NOT touched.")) return;
    btn.disabled = true;
    btn.textContent = "Cancelling…";
    try {
        if (!root.Kalshi || !root.Kalshi.isConnected || !root.Kalshi.isConnected()) {
            toast("Kalshi not connected — can't cancel", "err");
            btn.disabled = false;
            btn.textContent = "Cancel ALL resting orders";
            return;
        }
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
}

async function refreshDrawerContent() {
    const overlay = document.querySelector(".bot-drawer-overlay");
    if (!overlay) return;
    overlay.querySelector("[data-pane='bets']").innerHTML        = await renderOpenBetsPane();
    overlay.querySelector("[data-pane='questions']").innerHTML   = renderQuestionsPane();
    overlay.querySelector("[data-pane='practice']").innerHTML    = await renderPracticePane();
    overlay.querySelector("[data-pane='performance']").innerHTML = await renderPerformancePane();
    overlay.querySelector("[data-pane='history']").innerHTML     = await renderHistoryPane();
    overlay.querySelector("[data-pane='decisions']").innerHTML   = renderDecisionsPane();
    overlay.querySelector("[data-pane='bot']").innerHTML         = renderBotPane();
    bindBotPaneHandlers(overlay);
    bindBetsPaneHandlers(overlay);
    bindQuestionsPaneHandlers(overlay);
    bindPracticePaneHandlers(overlay);
    // Update count chips on the Bets + Questions + Practice + History + Decisions tabs.
    const betsCt = overlay.querySelector("[data-bets-count]");
    if (betsCt) {
        const count = _state.settings.practice_mode
            ? getPracticeFires().length
            : _state.openPositions.length;
        betsCt.textContent = String(count);
    }
    const qCt = overlay.querySelector("[data-questions-count]");
    if (qCt && root.BotNotifications) {
        const unread = root.BotNotifications.unreadCount();
        qCt.textContent = String(unread);
        qCt.classList.toggle("has-unread", unread > 0);
    }
    const practiceCt = overlay.querySelector("[data-practice-count]");
    if (practiceCt) {
        const pendingN = getPracticePending().length;
        const firesN   = getPracticeFires().length;
        practiceCt.textContent = pendingN > 0
            ? `${pendingN}!`   // show pending count with an alert tick
            : String(firesN);
        practiceCt.classList.toggle("has-unread", pendingN > 0);
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

// ── Practice pane (paper-trading mode) ────────────────────────────

async function renderPracticePane() {
    const fires = getPracticeFires();
    const settings = _state.settings;
    const modeBadge = settings.practice_mode
        ? `<span class="bot-practice-mode-on">PRACTICE MODE ON</span>`
        : `<span class="bot-practice-mode-off">Practice mode is OFF — flip toggle below to test without spending</span>`;
    const bankroll = computePracticeBankroll();
    const availPct = bankroll.starting_cents > 0
        ? (bankroll.available_cents / bankroll.starting_cents) * 100
        : 0;
    const bankrollBlock = `
      <div class="bot-practice-bankroll">
        <div class="bot-practice-bankroll-row">
          <span class="bot-practice-bankroll-label">Available virtual cash</span>
          <strong class="bot-practice-bankroll-amt">$${(bankroll.available_cents/100).toFixed(2)}</strong>
          <span class="bot-practice-bankroll-of">of $${(bankroll.starting_cents/100).toFixed(2)} starting</span>
        </div>
        <div class="bot-practice-bankroll-bar">
          <div class="bot-practice-bankroll-fill" style="width:${availPct.toFixed(1)}%"></div>
        </div>
        <div class="bot-practice-bankroll-actions">
          <label class="bot-practice-bankroll-input">
            Starting bankroll ($):
            <input type="number" min="1" max="1000" step="1"
                   value="${(bankroll.starting_cents/100).toFixed(0)}"
                   data-practice-starting>
          </label>
          <button class="bot-practice-reset" data-practice-reset>Reset practice log</button>
        </div>
      </div>
    `;
    const toggle = `
      <div class="bot-practice-head">
        ${modeBadge}
        <button class="bot-practice-toggle ${settings.practice_mode ? "is-on" : "is-off"}" data-practice-toggle>
          ${settings.practice_mode ? "Turn practice OFF (return to real money)" : "Turn practice ON"}
        </button>
      </div>
      ${bankrollBlock}
    `;

    // Pending approval queue — every bet the bot wants to take.
    // Rendered first because this is what the user needs to act on.
    const pending = getPracticePending();
    const pendingBlock = pending.length ? `
      <div class="bot-pending-section">
        <div class="bot-pending-head">
          <span>🔔 Pending approval — ${pending.length} bet${pending.length === 1 ? "" : "s"} waiting</span>
          <button class="bot-pending-clear" data-pending-clear-all>Decline all</button>
        </div>
        ${pending.map(renderPendingCard).join("")}
      </div>
    ` : "";

    if (!fires.length && !pending.length) {
        return `
          ${toggle}
          <div class="bot-empty">
            <p>No practice bets yet.</p>
            <p class="bot-empty-sub">
              Flip practice mode ON, turn the bot on, and every bet
              it auto-fires will land here. Live mark-to-market P/L
              is computed from the current market bid for each side.
              No money moves.
            </p>
          </div>
        `;
    }
    // If there are pending but no approved fires yet, return the
    // pending block without the bets-table section.
    if (!fires.length) {
        return `${toggle}${pendingBlock}`;
    }
    // Pull live bid for each ticker in parallel to compute simulated P/L.
    const tickers = [...new Set(fires.map((f) => f.ticker))];
    const bidMap = new Map();
    if (root.Kalshi && root.Kalshi.getOrderbook) {
        const results = await Promise.allSettled(tickers.map(async (t) => {
            const ob = await root.Kalshi.getOrderbook(t);
            return { t, ob };
        }));
        for (const r of results) {
            if (r.status === "fulfilled" && r.value.ob) {
                bidMap.set(r.value.t, r.value.ob);
            }
        }
    }
    let totalCost = 0, totalLive = 0, winCount = 0, lossCount = 0;
    const rows = fires.slice(0, 200).map((f, idx) => {
        const cost = (f.contracts || 1) * (f.price_cents || 0);
        const ob   = bidMap.get(f.ticker);
        const liveBid = ob
            ? (f.side === "no" ? orderbookNoBidCents(ob) : orderbookYesBidCents(ob))
            : null;
        let pnlCents = null, pnlClass = "", pnlText = "—";
        if (liveBid != null) {
            const liveVal = (f.contracts || 1) * liveBid;
            pnlCents = liveVal - cost;
            pnlClass = pnlCents >= 0 ? "bot-pl-pos" : "bot-pl-neg";
            pnlText  = `${pnlCents >= 0 ? "+" : ""}$${(pnlCents/100).toFixed(2)}`;
            totalCost += cost;
            totalLive += liveVal;
            if (pnlCents >= 0) winCount++; else lossCount++;
        }
        const label = escapeText(betLabel(f));
        const sideTag = f.side === "no" ? "NO" : "YES";
        const sideCls = f.side === "no" ? "bet-side-no" : "bet-side-yes";
        const when = formatNotifTime(f.placed_at);
        return `
          <details class="bot-practice-card">
            <summary class="bot-practice-summary-row">
              <span class="bot-practice-bet">${label}</span>
              <span class="${sideCls}">${sideTag}</span>
              <span class="bot-practice-size">${f.contracts}× @ ${f.price_cents}¢</span>
              <span class="bot-practice-cost">$${(cost/100).toFixed(2)}</span>
              <span class="bot-practice-livebid">${liveBid != null ? `${liveBid}¢ live` : "—"}</span>
              <span class="${pnlClass} bot-practice-pnl">${pnlText}</span>
              <span class="bot-practice-time">${when}</span>
            </summary>
            <div class="bot-practice-detail">
              ${renderPracticeReasoning(f)}
            </div>
          </details>
        `;
    }).join("");
    const totalPnl = totalLive - totalCost;
    const totalPnlCls = totalPnl >= 0 ? "bot-pl-pos" : "bot-pl-neg";
    const winRate = (winCount + lossCount) > 0
        ? Math.round(winCount / (winCount + lossCount) * 100)
        : 0;
    const summary = `
      <div class="bot-practice-summary">
        <div class="bot-practice-stat">
          <div class="bot-practice-stat-num">${fires.length}</div>
          <div class="bot-practice-stat-lbl">bets simulated</div>
        </div>
        <div class="bot-practice-stat">
          <div class="bot-practice-stat-num ${totalPnlCls}">${totalPnl >= 0 ? "+" : ""}$${(totalPnl/100).toFixed(2)}</div>
          <div class="bot-practice-stat-lbl">live mark-to-market P/L</div>
        </div>
        <div class="bot-practice-stat">
          <div class="bot-practice-stat-num">${winCount}-${lossCount}</div>
          <div class="bot-practice-stat-lbl">winning / losing now (${winRate}%)</div>
        </div>
      </div>
    `;
    return `
      ${toggle}
      ${pendingBlock}
      ${summary}
      <div class="bot-practice-list-head">
        <span>Approved bets — click any to expand the reasoning</span>
      </div>
      <div class="bot-practice-list">
        ${rows}
      </div>
    `;
}

// Render one pending-approval card — full reasoning + approve/decline.
function renderPendingCard(p) {
    const reasoningHTML = renderPracticeReasoning(p);
    const label = escapeText(betLabel(p));
    const sideTag = p.side === "no" ? "NO" : "YES";
    const sideCls = p.side === "no" ? "bet-side-no" : "bet-side-yes";
    const cost = (p.contracts || 1) * (p.price_cents || 0);
    const when = formatNotifTime(p.proposed_at);
    return `
      <div class="bot-pending-card" data-pending-id="${escapeText(p.id)}">
        <div class="bot-pending-head-row">
          <span class="bot-pending-label">${label}</span>
          <span class="${sideCls}">${sideTag}</span>
          <span class="bot-pending-size">${p.contracts}× @ ${p.price_cents}¢</span>
          <span class="bot-pending-cost">$${(cost/100).toFixed(2)}</span>
          <span class="bot-pending-ts">${when}</span>
        </div>
        <div class="bot-pending-reasoning">
          ${reasoningHTML}
        </div>
        <div class="bot-pending-actions">
          <button class="bot-pending-approve" data-pending-approve="${escapeText(p.id)}">✓ Approve</button>
          <button class="bot-pending-decline" data-pending-decline="${escapeText(p.id)}">✗ Decline</button>
        </div>
        <div class="bot-pending-note-row">
          <label class="bot-pending-note-label">Tell the bot why you're saying no (optional):</label>
          <input type="text" class="bot-pending-note-input"
                 data-pending-note="${escapeText(p.id)}"
                 placeholder="e.g. event already happened / model wrong on left-handed batters">
        </div>
      </div>
    `;
}

// Render the full reasoning panel for one practice fire — every
// number the bot used + the gates it passed. This is what answers
// the question 'why did the bot pick this bet'.
function renderPracticeReasoning(f) {
    const r = f.reasoning || {};
    const oursPct  = (f.our_p * 100).toFixed(1);
    const marketPct = (f.market_p * 100).toFixed(1);
    const rawEdge  = (f.edge_pp || 0).toFixed(1);
    const sideTag  = f.side === "no" ? "NO" : "YES";

    // EDGE MATH SECTION
    let edgeSection = `
      <div class="bot-reasoning-section">
        <div class="bot-reasoning-h">Edge math (raw)</div>
        <div class="bot-reasoning-rows">
          <div><span>Our model says</span><strong>${oursPct}% chance ${sideTag}</strong></div>
          <div><span>Market is paying</span><strong>${f.price_cents}¢ ${sideTag} (implies ${marketPct}%)</strong></div>
          <div><span>Raw edge</span><strong class="bot-pl-pos">+${rawEdge}pp</strong></div>
    `;
    if (r.yes_edge_pp != null && r.no_edge_pp != null && f.kind === "player_prop") {
        const chosen = r.chosen_side === "no" ? "NO" : "YES";
        const otherSide = r.chosen_side === "no" ? "YES" : "NO";
        const otherEdge = r.chosen_side === "no" ? r.yes_edge_pp : r.no_edge_pp;
        edgeSection += `
          <div><span>Other side (${otherSide})</span><strong>${otherEdge >= 0 ? "+" : ""}${otherEdge.toFixed(1)}pp</strong></div>
          <div><span>Bot picked</span><strong>${chosen} (bigger edge)</strong></div>
        `;
    }
    edgeSection += `
        </div>
      </div>
    `;

    // MULTI-FACTOR SCORE SECTION
    let scoreSection = "";
    if (r.score) {
        const adjPct = (r.score.adjusted_p * 100).toFixed(1);
        const adjEdge = (r.score.edge_pp || 0).toFixed(1);
        const conf = (r.score.confidence || 0).toFixed(2);
        const factorRows = (r.score.factors || []).map((fct) => {
            if (!fct.present) {
                return `<div class="bot-factor-row bot-factor-absent">
                  <span class="bot-factor-name">${escapeText(fct.name)}</span>
                  <span class="bot-factor-state">not present</span>
                </div>`;
            }
            const sign = (fct.adjust_pp || 0) >= 0 ? "+" : "";
            const cls  = (fct.adjust_pp || 0) >= 0 ? "bot-pl-pos" : "bot-pl-neg";
            const valStr = fct.value ? renderFactorValue(fct.name, fct.value) : "";
            return `
              <div class="bot-factor-row">
                <span class="bot-factor-name">${escapeText(fct.name)}</span>
                <span class="bot-factor-adjust ${cls}">${sign}${(fct.adjust_pp || 0).toFixed(1)}pp</span>
                <span class="bot-factor-weight">w=${(fct.weight || 0).toFixed(1)}</span>
                <span class="bot-factor-value">${valStr}</span>
              </div>
            `;
        }).join("");
        scoreSection = `
          <div class="bot-reasoning-section">
            <div class="bot-reasoning-h">Multi-factor score</div>
            <div class="bot-reasoning-rows">
              <div><span>Adjusted probability</span><strong>${adjPct}%</strong></div>
              <div><span>Adjusted edge</span><strong class="bot-pl-pos">+${adjEdge}pp</strong></div>
              <div><span>Confidence</span><strong>${conf} ${r.score.confidence >= 0.40 ? "✓ (≥ 0.40 min)" : "(below min)"}</strong></div>
            </div>
            <div class="bot-factor-list">
              ${factorRows}
            </div>
          </div>
        `;
    }

    // PLAYER / GAME STATE SECTION
    let stateSection = "";
    const bits = [];
    if (r.live_stat != null) {
        bits.push(`<div><span>Live ${f.stat} so far</span><strong>${r.live_stat} (threshold: ${f.threshold})</strong></div>`);
    }
    if (r.game_state) {
        const gs = r.game_state;
        if (gs.inning != null) bits.push(`<div><span>Inning</span><strong>${gs.inning}</strong></div>`);
        if (gs.turns_remaining != null) bits.push(`<div><span>Turns remaining</span><strong>${gs.turns_remaining.toFixed(2)}</strong></div>`);
    }
    if (r.savant_p != null) {
        bits.push(`<div><span>Savant says</span><strong>${(r.savant_p*100).toFixed(1)}% (${r.savant_stance || "no_data"})</strong></div>`);
    }
    if (bits.length) {
        stateSection = `
          <div class="bot-reasoning-section">
            <div class="bot-reasoning-h">Game / player state at fire</div>
            <div class="bot-reasoning-rows">${bits.join("")}</div>
          </div>
        `;
    }

    // GATES PASSED SECTION
    const gates = r.gates_passed || [];
    const gateSection = gates.length ? `
        <div class="bot-reasoning-section">
          <div class="bot-reasoning-h">Sanity gates passed</div>
          <div class="bot-gate-list">
            ${gates.map((g) => `<span class="bot-gate-chip">✓ ${escapeText(g.replace(/_/g, " "))}</span>`).join("")}
          </div>
        </div>
      ` : "";

    return edgeSection + scoreSection + stateSection + gateSection;
}

// Helper — render the factor value object as a compact hint.
function renderFactorValue(name, v) {
    if (!v) return "";
    if (name === "model_edge")           return `${(v.our_p*100).toFixed(1)}% vs ${(v.market_p*100).toFixed(1)}%`;
    if (name === "savant_alignment")     return v.aligned ? "agrees" : "disagrees";
    if (name === "pitch_count")          return `${v.pitches_thrown} pitches (p80=${v.p80 ?? "?"})`;
    if (name === "pa_remaining")         return `${(v.turns_remaining || 0).toFixed(2)} turns left`;
    if (name === "pitcher_recent_form")  return `K/9 ${v.k9?.toFixed(1) ?? "?"} (last 5 starts)`;
    if (name === "batter_recent_form")   return `BA ${v.ba?.toFixed(3) ?? "?"} (last 15g)`;
    if (name === "h2h")                  return `${v.hits || 0}/${v.pa || 0} lifetime`;
    return "";
}

function bindPracticePaneHandlers(overlay) {
    overlay.querySelector("[data-practice-toggle]")?.addEventListener("click", () => {
        _state.settings = clampSettings({
            ..._state.settings,
            practice_mode: !_state.settings.practice_mode,
        });
        persistSettings();
        toast(_state.settings.practice_mode
            ? "Practice mode ON — no real money will be spent"
            : "Practice mode OFF — bot is now back to real money", "ok");
        refreshDrawerContent();
    });
    overlay.querySelector("[data-practice-reset]")?.addEventListener("click", () => {
        if (!confirm("Clear the practice log and reset the virtual bankroll?")) return;
        clearPracticeFires();
        toast("Practice log + bankroll reset", "ok");
        refreshDrawerContent();
    });
    overlay.querySelector("[data-practice-starting]")?.addEventListener("change", (e) => {
        const dollars = parseFloat(e.target.value) || 0;
        const cents   = Math.round(dollars * 100);
        _state.settings = clampSettings({
            ..._state.settings,
            practice_starting_bankroll_cents: cents,
        });
        persistSettings();
        refreshDrawerContent();
    });
    // Active / History filter — flips the persisted choice and
    // re-renders. No async work needed, the filter is read at
    // render time.
    overlay.querySelectorAll("[data-practice-filter]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const v = btn.getAttribute("data-practice-filter");
            try { localStorage.setItem("diamond_context_practice_filter", v); } catch {}
            refreshDrawerContent();
        });
    });
    // Approval-queue handlers.
    overlay.querySelectorAll("[data-pending-approve]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const id = btn.dataset.pendingApprove;
            if (approvePracticeBet(id)) {
                toast("Bet approved — added to practice log", "ok");
                refreshDrawerContent();
            }
        });
    });
    overlay.querySelectorAll("[data-pending-decline]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const id = btn.dataset.pendingDecline;
            // Pull the note from the card's input box.
            const card = btn.closest(".bot-pending-card");
            const noteInp = card?.querySelector("[data-pending-note]");
            const note = noteInp?.value?.trim() || null;
            if (declinePracticeBet(id, note)) {
                toast(note ? "Declined with note" : "Declined", "ok");
                refreshDrawerContent();
            }
        });
    });
    overlay.querySelector("[data-pending-clear-all]")?.addEventListener("click", () => {
        if (!confirm("Decline ALL pending proposals?")) return;
        const pending = getPracticePending();
        for (const p of pending) {
            declinePracticeBet(p.id, "bulk decline");
        }
        toast("All pending bets declined", "ok");
        refreshDrawerContent();
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

async function renderPracticeBetsPane() {
    // Grade any finished games BEFORE reading the bankroll so the
    // banner reflects realized P/L like a real account.
    await settleFinishedPracticeFires();
    const fires = getPracticeFires();
    const bankroll = computePracticeBankroll();
    const realizedCls = bankroll.realized_pnl_cents >= 0 ? "bot-pl-pos" : "bot-pl-neg";
    const realizedTxt = `${bankroll.realized_pnl_cents >= 0 ? "+" : ""}$${(bankroll.realized_pnl_cents/100).toFixed(2)}`;
    const recordTxt   = `${bankroll.settled_won}–${bankroll.settled_lost}`;
    // Card-style banner: a tile per number. Easier to scan than a
    // single comma-separated sentence (user feedback 2026-06-04:
    // 'make these simpler to navigate'). The four cells are the
    // four numbers that matter — Balance, Available, Record,
    // Realized P/L. Started bankroll lives as a sublabel under
    // Balance since it's reference, not state.
    const banner = `
      <div class="bot-practice-summary">
        <div class="bot-practice-summary-tag">PRACTICE</div>
        <div class="bot-practice-stat">
          <div class="bot-practice-stat-label">Balance</div>
          <div class="bot-practice-stat-val">$${(bankroll.balance_cents/100).toFixed(2)}</div>
          <div class="bot-practice-stat-sub">started $${(bankroll.starting_cents/100).toFixed(2)}</div>
        </div>
        <div class="bot-practice-stat">
          <div class="bot-practice-stat-label">Available</div>
          <div class="bot-practice-stat-val">$${(bankroll.available_cents/100).toFixed(2)}</div>
          <div class="bot-practice-stat-sub">${fires.length} bet${fires.length === 1 ? "" : "s"} placed</div>
        </div>
        <div class="bot-practice-stat">
          <div class="bot-practice-stat-label">Record</div>
          <div class="bot-practice-stat-val">${recordTxt}</div>
          <div class="bot-practice-stat-sub">${bankroll.settled_won + bankroll.settled_lost} settled</div>
        </div>
        <div class="bot-practice-stat">
          <div class="bot-practice-stat-label">Realized P/L</div>
          <div class="bot-practice-stat-val ${realizedCls}">${realizedTxt}</div>
          <div class="bot-practice-stat-sub">on settled bets</div>
        </div>
      </div>
    `;
    if (!fires.length) {
        return `
          ${banner}
          <div class="bot-empty">
            <p>No practice bets yet.</p>
            <p class="bot-empty-sub">Turn the bot ON and the next signal that passes every gate will land here as a virtual buy.</p>
          </div>
        `;
    }
    // Pull live bid per ticker for mark-to-market on still-open bets.
    const tickers = [...new Set(fires.map((f) => f.ticker))];
    const obMap = new Map();
    if (root.Kalshi && root.Kalshi.getOrderbook) {
        const results = await Promise.allSettled(tickers.map(async (t) => {
            const ob = await root.Kalshi.getOrderbook(t);
            return { t, ob };
        }));
        for (const r of results) {
            if (r.status === "fulfilled" && r.value.ob) obMap.set(r.value.t, r.value.ob);
        }
    }
    // Active / History filter. Active = open (unsettled) + recent.
    // History = everything. Default is Active so the main view
    // isn't dominated by yesterday's settled bets. Persisted to
    // localStorage so the toggle survives reloads.
    const filter = localStorage.getItem("diamond_context_practice_filter") || "active";
    const activeFires = fires.filter((f) => !f.settled);
    const settledFires = fires.filter((f) => f.settled);
    const visibleFires = filter === "active" ? activeFires : fires;
    // Filter toggle pills above the bets list.
    const filterPills = `
      <div class="bot-filter-pills">
        <button class="bot-filter-pill ${filter === "active" ? "is-on" : ""}"
                data-practice-filter="active">Active <span class="bot-filter-pill-count">${activeFires.length}</span></button>
        <button class="bot-filter-pill ${filter === "history" ? "is-on" : ""}"
                data-practice-filter="history">History <span class="bot-filter-pill-count">${fires.length}</span></button>
      </div>
    `;
    // Settlement is already persisted onto each fire by the
    // settleFinishedPracticeFires() call at the top — just read it.
    let totalCost = 0, totalLive = 0;
    let settledWon = 0, settledLost = 0, settledNet = 0;
    const rows = visibleFires.slice(0, 100).map((f) => {
        const cost = (f.contracts || 1) * (f.price_cents || 0);
        const result = f.settled
            ? { settled: true, won: f.settled.won, profit_cents: f.settled.profit_cents }
            : null;

        let resultText = "—", resultCls = "", resultBadge = "";
        if (result?.settled) {
            const sign = result.won ? "+" : "";
            resultText = `${sign}$${(result.profit_cents/100).toFixed(2)}`;
            resultCls  = result.won ? "bot-pl-pos" : "bot-pl-neg";
            resultBadge = result.won
                ? `<span class="bot-result-badge bot-result-won">WON</span>`
                : `<span class="bot-result-badge bot-result-lost">LOST</span>`;
            settledNet += result.profit_cents;
            if (result.won) settledWon++; else settledLost++;
        } else {
            // Still open — fall back to live mark-to-market.
            const ob = obMap.get(f.ticker);
            const liveBid = ob
                ? (f.side === "no" ? orderbookNoBidCents(ob) : orderbookYesBidCents(ob))
                : null;
            if (liveBid != null) {
                const liveVal = (f.contracts || 1) * liveBid;
                const pnl = liveVal - cost;
                resultCls  = pnl >= 0 ? "bot-pl-pos" : "bot-pl-neg";
                resultText = `${pnl >= 0 ? "+" : ""}$${(pnl/100).toFixed(2)}`;
                totalCost += cost;
                totalLive += liveVal;
            }
        }
        const label = escapeText(betLabel(f));
        const sideTag = f.side === "no" ? "NO" : "YES";
        const sideCls = f.side === "no" ? "bet-side-no" : "bet-side-yes";
        const when    = formatNotifTime(f.placed_at);
        return `
          <div class="bot-recent-row">
            <span class="bot-recent-label">${label}</span>
            <span class="bot-recent-meta">
              <span class="${sideCls}">${sideTag}</span>
              $${(cost/100).toFixed(2)}
              ${resultBadge}
              <span class="${resultCls}">${resultText}</span>
              <span class="bot-recent-ts">${when}</span>
            </span>
          </div>
        `;
    }).join("");
    const openPnl = totalLive - totalCost;
    const openCls = openPnl >= 0 ? "bot-pl-pos" : "bot-pl-neg";
    const openTxt = `${openPnl >= 0 ? "+" : ""}$${(openPnl/100).toFixed(2)}`;
    const settledCls = settledNet >= 0 ? "bot-pl-pos" : "bot-pl-neg";
    const settledTxt = `${settledNet >= 0 ? "+" : ""}$${(settledNet/100).toFixed(2)}`;
    const settledLine = (settledWon + settledLost) > 0
        ? ` · settled ${settledWon}–${settledLost} <strong class="${settledCls}">${settledTxt}</strong>`
        : "";
    const headLabel = filter === "active"
        ? `Active bets · ${activeFires.length}`
        : `All bets · ${fires.length}`;
    const emptyState = visibleFires.length === 0 ? `
      <div class="bot-empty" style="border-top:1px solid var(--border-soft); padding:24px 16px">
        <p>${filter === "active" ? "No active bets right now." : "No bets logged yet."}</p>
        ${filter === "active" && settledFires.length > 0 ? `<p class="bot-empty-sub">Tap <strong>History</strong> to see ${settledFires.length} settled bet${settledFires.length === 1 ? "" : "s"}.</p>` : ""}
      </div>
    ` : "";
    return `
      ${banner}
      ${filterPills}
      <div class="bot-recent-section">
        <div class="bot-recent-head">
          ${headLabel}
          <span class="bot-recent-hint">open mark-to-market <strong class="${openCls}">${openTxt}</strong>${settledLine}</span>
        </div>
        ${emptyState || `<div class="bot-recent-list">${rows}</div>`}
      </div>
    `;
}

async function renderOpenBetsPane() {
    // PRACTICE MODE — show virtual practice fires instead of Kalshi
    // positions. User asked for practice bets to appear in the Bets
    // section too, not just the Practice tab. The Practice tab is
    // still the authoritative paper-trading view; this is a mirror
    // so a user toggling between tabs sees the same bets everywhere.
    if (_state.settings.practice_mode) {
        return await renderPracticeBetsPane();
    }
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
            : `Unit $${(s.unit_cents/100).toFixed(2)} · daily loss limit $${(s.daily_loss_limit_cents/100).toFixed(2)} · exposure cap $${(s.open_exposure_max/100).toFixed(2)}`}
        </p>
        <details class="bot-emergency-fold">
          <summary>Emergency actions</summary>
          <div class="bot-emergency-actions">
            <button class="bot-emergency-sellall" data-bot-emergency-sellall>Sell ALL positions at bid</button>
            <button class="bot-emergency-cancel" data-bot-emergency-cancel>Cancel ALL resting orders</button>
            <a class="bot-emergency-kalshi" href="https://kalshi.com/portfolio" target="_blank" rel="noopener">Open Kalshi →</a>
          </div>
        </details>
      </div>

      <details class="bot-section bot-settings" ${s.enabled ? "" : "open"}>
        <summary>Settings (hard caps cannot be exceeded)</summary>
        <div class="bot-settings-grid">
          <label>
            <span>Max spend per fire (¢)</span>
            <input type="number" min="${HARD_CAPS.unit_cents_min}" max="${HARD_CAPS.unit_cents_max}"
                   step="5" value="${s.unit_cents}" data-bot-setting="unit_cents">
            <small>$${(s.unit_cents/100).toFixed(2)} ceiling · 2 contracts base, 4 at 5pp adjusted edge, 6 at 8pp, 10 at 12pp+ · hard cap $${(HARD_CAPS.unit_cents_max/100).toFixed(2)}</small>
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
            <span>Ladder edge-climb requirement (pp)</span>
            <input type="number" min="0" max="10" step="0.5"
                   value="${s.ladder_min_edge_increase_pp}"
                   data-bot-setting-float="ladder_min_edge_increase_pp">
            <small>Correlated-ladder gate — each higher-threshold prop on the same player+stat must clear the prior fire's adjusted edge by N pp. Stops blind ladder-stacking but allows fires when conviction is genuinely climbing. 0 = allow any non-decreasing edge · 2 = small but meaningful climb required (default)</small>
          </label>
          <label class="bot-checkbox-label">
            <input type="checkbox" ${s.require_savant_agree ? "checked" : ""}
                   data-bot-setting-bool="require_savant_agree">
            <span>Strict mode: REQUIRE Savant to agree (hard gate) — off by default; Savant disagreement is handled by the scoring framework</span>
          </label>
          <label class="bot-checkbox-label">
            <input type="checkbox" ${s.bet_player_props ? "checked" : ""}
                   data-bot-setting-bool="bet_player_props">
            <span>Also bet player props (HR / Hits / Ks / TB) — no Savant signal applies</span>
          </label>
          <label class="bot-checkbox-label">
            <input type="checkbox" ${s.bet_no_side_player_props ? "checked" : ""}
                   data-bot-setting-bool="bet_no_side_player_props">
            <span>Allow NO-side player props (default OFF) — only re-enable after positive track record</span>
          </label>
        </div>
        <div class="bot-settings-recos">
          <button class="bot-reset-recos" data-bot-reset-recos>Apply recommended defaults</button>
          <small>Snaps every setting on this panel to the tuned values:
            <strong>$0.10 unit (hard cap)</strong> · <strong>3pp moneyline / 5pp prop YES</strong> /
            9pp prop NO · <strong>min inning 1</strong> · 50/50 reserve · <strong>0.30 conviction</strong> · 20¢ take ·
            55% EV-capture · <strong>$2 daily loss · $2 exposure ($1 props / $1 ML)</strong> · soft
            Savant +3pp · props on. Volume + persistent edge wins.</small>
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
    // New simple ON/OFF button. One click = toggle.
    const togBtn = overlay.querySelector("[data-bot-toggle-btn]");
    if (togBtn) togBtn.addEventListener("click", () => {
        if (_state.settings.enabled) {
            disable();
        } else {
            enable();
        }
        refreshDrawerContent();
    });
    // Legacy checkbox toggle — kept for any cached UI / muscle memory.
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
