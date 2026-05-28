// /api/game/{id}/markets
//
// Pull every prediction-market quote for this specific MLB game from
// every public source we wrap (Polymarket, Kalshi, Manifold, plus The
// Odds API when ODDS_API_KEY is configured). Group by question type
// (moneyline / spread / total / props), compute cross-source consensus,
// and surface alongside our model's WE so users can see where we agree
// or diverge from real money.
//
// Vendored from sports-oracle's @oracle/markets — see web/functions/api/
// _markets.js for the full SDK. Same unified Market shape that
// alexroessner's prediction-protocol consumes; this endpoint is our
// data-platform's read of the same surface.
//
// Cache: 20s. Sportsbook lines move quickly; user said update rapidly.

import {
    listAllMlbMarkets,
    filterMarketsForGame,
    groupByQuestion,
    consensusProbability,
    teamTricode,
} from "../../_markets.js";

const CACHE_SECONDS = 10;   // rapid updates per user feedback


export async function onRequest(context) {
    const env = context.env || {};
    const gameId = context.params?.id;

    if (gameId === "demo") {
        return jsonResponse({ game_pk: "demo", available: false,
            reason: "demo game has no real markets" }, 0);
    }
    if (!gameId || !/^\d+$/.test(gameId)) {
        return jsonError(400, "invalid game id");
    }

    // 1. Pull the game's team info + start time from our own API
    //    (which has it shaped from MLB feed).
    const origin = new URL(context.request.url).origin;
    let game;
    try {
        const res = await fetch(`${origin}/api/game/${gameId}`);
        if (!res.ok) throw new Error(`game HTTP ${res.status}`);
        game = await res.json();
    } catch (e) {
        return jsonError(502, `failed to load game: ${e.message || e}`);
    }

    const homeAbbr = game?.teams?.home?.abbr || game?.teams?.home?.name;
    const awayAbbr = game?.teams?.away?.abbr || game?.teams?.away?.name;
    if (!homeAbbr || !awayAbbr) {
        return jsonError(400, "couldn't resolve teams for this game");
    }

    // 2. Pull every MLB market across all sources (parallel inside
    //    the SDK), then filter to ones matching this game's teams.
    //    Also fetch MLB's official winProbability feed — Baseball
    //    Savant reads from the same source for the live-WE numbers it
    //    shows on its game pages, so we get "Savant's WE" by hitting
    //    /api/v1/game/{pk}/winProbability and reading the last entry's
    //    homeTeamWinProbability (returned as a percent number, 0-100).
    let allMarkets;
    let savantHomeWe = null;
    let savantSource = null;
    try {
        const [marketsRes, savantRes] = await Promise.allSettled([
            listAllMlbMarkets(env),
            // Pass game so the Savant fallback chain (pregame baseline →
            // state-based table) has the inputs when MLB hasn't populated
            // the winProbability endpoint yet.
            fetchSavantWe(gameId, game),
        ]);
        if (marketsRes.status === "fulfilled") {
            allMarkets = marketsRes.value;
        } else {
            throw marketsRes.reason;
        }
        if (savantRes.status === "fulfilled") {
            savantHomeWe = savantRes.value?.value;
            savantSource = savantRes.value?.source;
        }
    } catch (e) {
        return jsonError(502, `markets fetch failed: ${e.message || e}`);
    }
    const gameMarkets = filterMarketsForGame(
        allMarkets, homeAbbr, awayAbbr, game.start_time,
    );

    // 3. Group by question type so the dashboard can render sections.
    const grouped = groupByQuestion(gameMarkets);

    // 4. Compute cross-source consensus probability for the headline
    //    "home wins" question. Matches both moneyline-style outcomes
    //    AND yes/no markets where the question is about home winning.
    const homeWinConsensus = consensusProbability(
        grouped.moneyline,
        (outcome, market) => {
            const oName = (outcome.name || "").toLowerCase();
            return oName === homeAbbr.toLowerCase()
                || oName.includes((game.teams?.home?.name || "").toLowerCase());
        },
    );
    const awayWinConsensus = consensusProbability(
        grouped.moneyline,
        (outcome, market) => {
            const oName = (outcome.name || "").toLowerCase();
            return oName === awayAbbr.toLowerCase()
                || oName.includes((game.teams?.away?.name || "").toLowerCase());
        },
    );

    return jsonResponse({
        game_pk: parseInt(gameId, 10),
        available: true,
        teams: {
            home: { abbr: homeAbbr, tricode: teamTricode(homeAbbr) },
            away: { abbr: awayAbbr, tricode: teamTricode(awayAbbr) },
        },
        market_count: gameMarkets.length,
        sources_present: Array.from(new Set(gameMarkets.map((m) => m.source))).sort(),
        // Our model's headline WE (forwarded so the UI can show side-by-side).
        our_we_home: game.win_expectancy,
        // Consensus across all sources that quote the question.
        consensus: {
            home_win:  homeWinConsensus,
            away_win:  awayWinConsensus,
            edge_home: homeWinConsensus != null && game.win_expectancy != null
                ? game.win_expectancy - homeWinConsensus
                : null,
        },
        // Baseball Savant's live home win-probability. ALWAYS populated:
        //   mlb_official      = winProbability endpoint (Savant's source)
        //   pregame_baseline  = team-strength Pythagorean (pregame fallback)
        //   state_table       = our historical state-based WE (live fallback)
        // The UI uses savant_we_source to label which one is in play.
        savant_we_home:    savantHomeWe,
        savant_we_source:  savantSource,
        // Per-question-type buckets, each a list of Market rows.
        markets: grouped,
        // Flat array of all markets for clients that want their own grouping.
        all: gameMarkets,
        fetched_at: new Date().toISOString(),
    }, CACHE_SECONDS);
}


function jsonResponse(body, maxAge) {
    return new Response(JSON.stringify(body), {
        headers: {
            "content-type":  "application/json",
            "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
            "access-control-allow-origin": "*",
        },
    });
}

// Baseball Savant displays MLB's official winProbability on its game
// pages. The endpoint returns one entry per at-bat with
// homeTeamWinProbability + awayTeamWinProbability as percent numbers
// (0-100). We read the last entry (current state) and convert to a
// 0-1 float to match our home_win/away_win convention.
//
// FALLBACKS so every game ALWAYS has a Savant-style number:
//   1. winProbability endpoint (best — MLB official, what Savant shows)
//   2. game.team_adjustment.pregame_we (pregame estimate from team
//      strength + Pythagorean — defensible "Savant baseline" before
//      first pitch when MLB has no plays to compute from)
//   3. game.win_expectancy (our state-based table value — same kind of
//      historical lookup Savant uses, just from Retrosheet)
//
// Returns the resolved number plus the source so the UI can label it.
async function fetchSavantWe(gameId, gameDetail) {
    // 1. Try MLB's official winProbability endpoint.
    try {
        const url = `https://statsapi.mlb.com/api/v1/game/${gameId}/winProbability`;
        const res = await fetch(url, {
            headers: { "User-Agent": "DIAMOND:CONTEXT/0.1" },
            cf: { cacheTtl: 30, cacheEverything: true },
        });
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length) {
                const last = data[data.length - 1];
                const homePct = Number(last?.homeTeamWinProbability);
                if (Number.isFinite(homePct)) {
                    return { value: homePct / 100, source: "mlb_official" };
                }
            }
        }
    } catch { /* fall through to baselines */ }

    // 2. Pregame baseline from team strength (Pythagorean + season).
    const pregame = Number(gameDetail?.team_adjustment?.pregame_we);
    if (Number.isFinite(pregame) && (gameDetail?.status === "Preview" || gameDetail?.status === "Scheduled")) {
        return { value: pregame, source: "pregame_baseline" };
    }

    // 3. State-based fallback (our model's pre-adjustment value).
    const stateWe = Number(gameDetail?.win_expectancy);
    if (Number.isFinite(stateWe)) {
        return { value: stateWe, source: "state_table" };
    }
    return { value: null, source: null };
}

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}
