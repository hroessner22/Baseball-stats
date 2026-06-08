// /api/backtest?date=YYYY-MM-DD&edge=5&unit=50
//
// Simulates how the autobot would have done on a given day's slate.
//
// What we can simulate accurately:
//   - The bot's TRIGGER rule (our pregame model vs a market baseline,
//     fire when edge exceeds the threshold).
//   - The bet settlement (we know the actual outcome).
//
// What we have to approximate:
//   - Kalshi's actual pregame ask. Their free API doesn't expose
//     historical orderbook snapshots, so we synthesize a "market
//     baseline" pregame price using the same team-strength inputs
//     a generic Vegas line would use: season win % + run differential
//     (Pythag) + home-field advantage. NO recent-form (L30/L10)
//     weighting — that's our model's signature contribution, and
//     it's exactly the diff we're trying to measure.
//
// In other words: the "edge" we compute here is the edge our recent-
// form weighting adds over a vanilla Pythag-baseline pregame line.
// That's the cleanest readable signal of "does our model's secret
// sauce add predictive value above what a market would already
// price in" — which is what an autobetter against Kalshi needs.
//
// Bet sizing matches the autobot's logic:
//   - contracts = floor(unit_cents / market_price_cents)
//   - settle: if our_side wins, profit per contract = (100 - market_price)
//             if our_side loses, loss per contract  = market_price
//
// Cash-out logic is NOT simulated in v0 (would need orderbook history).
// So this backtest is "to-settlement only" P/L — strictly worse than
// the live bot's expected P/L since the bot can also profit-take
// mid-game. Treat the reported P/L as a LOWER BOUND.

import {
    fetchTeamStrength,
    pregameHomeWE,
} from "./_team_strength.js";

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";

// Match the autobot's HARD_CAPS (same constants).
const HARD_CAPS = {
    unit_cents_min:    25,
    unit_cents_max:    200,
    edge_pp_min:       3,
    edge_pp_max:       20,
};

const HOME_FIELD_ADVANTAGE = 0.54;
const STRENGTH_SCALAR      = 0.20;
const ADJUSTMENT_CAP_PP    = 0.15;


export async function onRequest(context) {
    const env = context.env || {};
    const url = new URL(context.request.url);

    const date     = url.searchParams.get("date") || yesterdayUtcDate();
    // edge_pp_min relaxed to 1pp on the backtest endpoint only —
    // we need to see what the bot would do BELOW the live floor to
    // understand whether the floor is the right place.
    const edge     = clampInt(url.searchParams.get("edge"),  1, HARD_CAPS.edge_pp_max, 5);
    const unit     = clampInt(url.searchParams.get("unit"),  HARD_CAPS.unit_cents_min, HARD_CAPS.unit_cents_max, 50);
    // baseline: "pythag" (default, season-W%-based, what Vegas
    //           roughly does) or "naive" (50/50 + home-field only,
    //           "market knows nothing about the teams")
    const baseline = (url.searchParams.get("baseline") || "pythag").toLowerCase();
    const debug    = url.searchParams.get("debug") === "1";

    // 1) Schedule + final scores for the requested date.
    let games;
    try {
        games = await fetchSchedule(date);
    } catch (e) {
        return jsonError(502, `MLB schedule fetch failed: ${e.message || e}`);
    }
    const final = games.filter((g) => g.status === "Final" && g.away_score != null && g.home_score != null);
    if (!final.length) {
        return jsonResponse({
            date, edge_pp: edge, unit_cents: unit,
            games_total: games.length, games_final: 0,
            bets: [], summary: { bets_fired: 0, profit_cents: 0 },
            note: "No completed games on this date. Pick a different date.",
        });
    }

    // 2) For each completed game, snapshot both teams' strength
    //    AS OF the prior date so the team_strength reflects games
    //    BEFORE the one we're simulating (no information leakage).
    const priorDate = stepDate(date, -1);

    // 3) Walk every game, simulate the bot's fire rule, settle by
    //    the actual result.
    const bets = [];
    const skipped = [];
    let firedCount = 0;
    let profitCents = 0;
    let winCount = 0;

    // Fetch standings ONCE for the prior date (every team's data
    // comes out of the same response — fetchTeamStrength internally
    // hits /standings with the season; we re-use its plumbing).
    // The team_strength helper resolves teamId + season → strength
    // object via the /standings endpoint, which the MLB Stats API
    // does support a `date` query param on. _team_strength.js
    // currently uses the live season, so we call it inline and
    // re-derive a snapshot strength by passing the prior date.
    const season = new Date(date).getUTCFullYear();

    for (const g of final) {
        try {
            const [homeS, awayS] = await Promise.all([
                fetchTeamStrengthAsOf(g.home_id, season, priorDate),
                fetchTeamStrengthAsOf(g.away_id, season, priorDate),
            ]);
            if (!homeS || !awayS) {
                skipped.push({ game_pk: g.game_pk, reason: "missing team strength" });
                continue;
            }

            // OUR model's pregame home WP: uses L30/L10 weighting.
            const ourHome = pregameHomeWE(homeS, awayS);
            // MARKET BASELINE — two flavors:
            //   "pythag" (default): season W% only, mimics a vanilla
            //     Vegas line that ignores recent form.
            //   "naive": just home-field advantage (0.54), as if the
            //     market knew nothing about which teams were playing.
            //     Useful to see whether our model's TEAM STRENGTH
            //     signal beats a pure-coinflip-plus-home-field line.
            const baselineHome = baseline === "naive"
                ? HOME_FIELD_ADVANTAGE
                : pregameHomeWEBaseline(homeS, awayS);

            // Edge (signed): positive = our model is MORE bullish on
            // home than the baseline; negative = our model is more
            // bullish on away. We bet whichever side we're more
            // bullish on relative to baseline.
            const edgePP = (ourHome - baselineHome) * 100;
            if (Math.abs(edgePP) < edge) {
                skipped.push({ game_pk: g.game_pk, away: g.away, home: g.home,
                    reason: `edge ${edgePP.toFixed(1)}pp < threshold ${edge}pp`,
                    our_home: round3(ourHome), baseline_home: round3(baselineHome) });
                continue;
            }

            // Pick the side.
            const ourSideHome = edgePP > 0;
            const ourSide     = ourSideHome ? "home" : "away";
            const ourSideTri  = ourSideHome ? g.home : g.away;
            const ourSideId   = ourSideHome ? g.home_id : g.away_id;
            const ourSideWon  = (g.home_score > g.away_score) === ourSideHome;

            // Market price (cents) for the side we're betting.
            const marketPSide = ourSideHome ? baselineHome : (1 - baselineHome);
            const marketCents = Math.max(1, Math.min(99, Math.round(marketPSide * 100)));

            // Contracts under the unit cap. Skip if even 1 contract
            // would exceed the unit (e.g. unit 50¢, price 60¢ → 0).
            const contracts = Math.floor(unit / marketCents);
            if (contracts < 1) {
                skipped.push({ game_pk: g.game_pk, reason: `unit ${unit}¢ too small for ${marketCents}¢ price` });
                continue;
            }

            // Settle.
            const costCents     = contracts * marketCents;
            const payoutCents   = ourSideWon ? contracts * 100 : 0;
            const profitOnBet   = payoutCents - costCents;
            firedCount += 1;
            profitCents += profitOnBet;
            if (ourSideWon) winCount += 1;

            bets.push({
                game_pk: g.game_pk,
                date,
                matchup: `${g.away}@${g.home}`,
                final_score: `${g.away_score}-${g.home_score}`,
                bet_side: ourSide,
                bet_team: ourSideTri,
                our_p:     round3(ourSideHome ? ourHome : 1 - ourHome),
                market_p:  round3(marketPSide),
                edge_pp:   round1(edgePP),
                contracts,
                market_cents: marketCents,
                cost_cents:   costCents,
                won:          ourSideWon,
                profit_cents: profitOnBet,
            });
        } catch (e) {
            skipped.push({ game_pk: g.game_pk, reason: `error: ${e.message || e}` });
        }
    }

    return jsonResponse({
        date,
        edge_pp:   edge,
        unit_cents: unit,
        baseline,
        games_total: games.length,
        games_final: final.length,
        bets,
        summary: {
            bets_fired:    firedCount,
            wins:          winCount,
            losses:        firedCount - winCount,
            win_rate:      firedCount ? round3(winCount / firedCount) : null,
            total_cost_cents:   bets.reduce((s, b) => s + b.cost_cents, 0),
            total_profit_cents: profitCents,
            total_profit_dollars: round2(profitCents / 100),
            roi_pct: bets.length
                ? round1(100 * profitCents / Math.max(1, bets.reduce((s, b) => s + b.cost_cents, 0)))
                : null,
            average_edge_pp: bets.length
                ? round1(bets.reduce((s, b) => s + b.edge_pp, 0) / bets.length)
                : null,
        },
        ...(debug ? { skipped } : {}),
    });
}


// ── MLB schedule helper ─────────────────────────────────────────

async function fetchSchedule(date) {
    const url = `${MLB_BASE}/schedule?sportId=1&date=${date}&hydrate=linescore,team`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, cf: { cacheTtl: 60 } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const out = [];
    for (const day of data.dates || []) {
        for (const g of day.games || []) {
            out.push({
                game_pk: g.gamePk,
                status:  g.status?.abstractGameState,
                detail:  g.status?.detailedState,
                away:    g.teams?.away?.team?.abbreviation || g.teams?.away?.team?.teamCode,
                home:    g.teams?.home?.team?.abbreviation || g.teams?.home?.team?.teamCode,
                away_id: g.teams?.away?.team?.id,
                home_id: g.teams?.home?.team?.id,
                away_score: g.teams?.away?.score ?? null,
                home_score: g.teams?.home?.score ?? null,
            });
        }
    }
    return out;
}


// ── Team strength snapshot AS OF a date ─────────────────────────
//
// The shipped fetchTeamStrength uses live season standings, which
// would leak yesterday's games into "before yesterday" data. Re-do
// the minimal piece using /standings?date=YYYY-MM-DD so we get a
// proper as-of snapshot. Mirror the same combined_pct formula so
// the model output matches the live one.
async function fetchTeamStrengthAsOf(teamId, season, asOfDate) {
    if (!teamId) return null;
    try {
        const standings = await fetchStandingsAsOf(season, asOfDate);
        const tr = findTeamRecord(standings, teamId);
        if (!tr) return null;

        const season_w   = tr.wins ?? 0;
        const season_l   = tr.losses ?? 0;
        const season_pct = winPct(season_w, season_l);
        const rs = tr.runsScored ?? 0;
        const ra = tr.runsAllowed ?? 0;
        const pyth_pct = pythagoreanWinPct(rs, ra);

        const l10 = pickSplit(tr, "lastTen");

        // L30 from the team's schedule up to (but not including) asOfDate.
        const l30 = await computeL30AsOf(teamId, season, asOfDate);

        const combined_pct =
            0.25 * season_pct +
            0.25 * pyth_pct +
            0.30 * (l30?.pct ?? season_pct) +
            0.20 * (l10?.pct ?? season_pct);

        return {
            team_id:      teamId,
            season,
            season_w, season_l, season_pct,
            pyth_pct,
            l30, l10,
            combined_pct,
        };
    } catch {
        return null;
    }
}

async function fetchStandingsAsOf(season, date) {
    const url = `${MLB_BASE}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason&hydrate=team&date=${date}`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, cf: { cacheTtl: 300 } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
}

function findTeamRecord(standings, teamId) {
    for (const rec of (standings?.records || [])) {
        for (const t of (rec.teamRecords || [])) {
            if (t.team?.id === teamId) return t;
        }
    }
    return null;
}

function pickSplit(teamRecord, type) {
    const arr = teamRecord?.records?.splitRecords || [];
    const hit = arr.find((s) => s.type === type);
    if (!hit) return null;
    return { w: hit.wins, l: hit.losses, pct: winPct(hit.wins, hit.losses) };
}

async function computeL30AsOf(teamId, season, asOfDate) {
    // Pull the team's full schedule for the season, filter to
    // completed games BEFORE asOfDate, sort by date desc, take 30.
    const url = `${MLB_BASE}/schedule?sportId=1&season=${season}&teamId=${teamId}&hydrate=decisions`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, cf: { cacheTtl: 300 } });
    if (!res.ok) return null;
    const data = await res.json();
    const cutoff = new Date(asOfDate + "T00:00:00Z").getTime();
    const completed = [];
    for (const day of data.dates || []) {
        for (const g of day.games || []) {
            if (g.status?.abstractGameState !== "Final") continue;
            const t = new Date(g.gameDate).getTime();
            if (t >= cutoff) continue;
            const isHome  = g.teams?.home?.team?.id === teamId;
            const homeScr = g.teams?.home?.score ?? 0;
            const awayScr = g.teams?.away?.score ?? 0;
            const won = isHome ? homeScr > awayScr : awayScr > homeScr;
            completed.push({ t, won });
        }
    }
    completed.sort((a, b) => b.t - a.t);
    const last30 = completed.slice(0, 30);
    if (!last30.length) return null;
    const w = last30.filter((g) => g.won).length;
    return { w, l: last30.length - w, pct: winPct(w, last30.length - w) };
}


// ── Pregame WP helpers ──────────────────────────────────────────

// Same shape as pregameHomeWE but using ONLY season W% (no
// L30/L10 weighting). This is our "vanilla market baseline" — what
// a Vegas line would roughly price the game at if it ignored
// recent-form swings.
function pregameHomeWEBaseline(homeS, awayS) {
    if (!homeS || !awayS) return HOME_FIELD_ADVANTAGE;
    const delta = homeS.season_pct - awayS.season_pct;
    const raw   = HOME_FIELD_ADVANTAGE + delta * STRENGTH_SCALAR;
    const lo    = HOME_FIELD_ADVANTAGE - ADJUSTMENT_CAP_PP;
    const hi    = HOME_FIELD_ADVANTAGE + ADJUSTMENT_CAP_PP;
    return Math.max(lo, Math.min(hi, raw));
}


// ── Tiny utilities ──────────────────────────────────────────────

function winPct(w, l) {
    if (w + l === 0) return 0.500;
    return w / (w + l);
}
function pythagoreanWinPct(rs, ra) {
    if (rs <= 0 && ra <= 0) return 0.500;
    return (rs * rs) / (rs * rs + ra * ra);
}
function yesterdayUtcDate() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}
function stepDate(yyyyMmDd, deltaDays) {
    const d = new Date(yyyyMmDd + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().slice(0, 10);
}
function clampInt(raw, lo, hi, def) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(lo, Math.min(hi, n));
}
function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }
function round3(x) { return Math.round(x * 1000) / 1000; }

function jsonResponse(body, maxAge = 60) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            "content-type":  "application/json; charset=utf-8",
            "cache-control": `public, max-age=${maxAge}`,
        },
    });
}
function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}
