// /api/markets
//
// Single-call dump of every MLB prediction-market quote we can see —
// across Polymarket, Kalshi, Manifold, and (when ODDS_API_KEY is set)
// The Odds API. Used by the Board and dashboard surfaces that need a
// firehose-style view of "what's bet on today."
//
// Per-game grouping happens on the client by walking `all` and using
// extractTeamsFromTitle on each row, or by calling the per-game
// endpoint at /api/game/{id}/markets which does the same thing
// server-side and adds our model's WE for comparison.
//
// Cache: 30s. Single shared response for all viewers; sportsbook lines
// move on the order of seconds-to-minutes, so 30s feels rapid without
// hammering upstream APIs.

import {
    listAllMlbMarkets,
    groupByQuestion,
} from "./_markets.js";

const CACHE_SECONDS = 30;


export async function onRequest(context) {
    const env = context.env || {};

    let markets;
    try {
        markets = await listAllMlbMarkets(env);
    } catch (e) {
        return new Response(
            JSON.stringify({ error: `markets fetch failed: ${e.message || e}` }),
            { status: 502, headers: { "content-type": "application/json" } },
        );
    }

    const grouped = groupByQuestion(markets);
    const sources = Array.from(new Set(markets.map((m) => m.source))).sort();
    const counts  = sources.reduce((acc, s) => {
        acc[s] = markets.filter((m) => m.source === s).length;
        return acc;
    }, {});

    return new Response(JSON.stringify({
        total: markets.length,
        sources,
        counts_by_source: counts,
        counts_by_question: Object.fromEntries(
            Object.entries(grouped).map(([k, v]) => [k, v.length]),
        ),
        markets: grouped,
        all: markets,
        fetched_at: new Date().toISOString(),
    }), {
        headers: {
            "content-type":  "application/json",
            "cache-control": `public, max-age=${CACHE_SECONDS}`,
            "access-control-allow-origin": "*",
        },
    });
}
