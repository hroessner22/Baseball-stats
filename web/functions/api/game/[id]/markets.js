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
    let allMarkets;
    try {
        allMarkets = await listAllMlbMarkets(env);
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

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}
