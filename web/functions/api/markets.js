// /api/markets
//
// Single-call dump of MLB prediction-market quotes across Polymarket,
// Kalshi, Manifold, and (when ODDS_API_KEY is set) The Odds API.
//
// Query params:
//   scope=game_day  — only tonight's lines (moneyline/spread/total/
//                     team_prop/player_prop with start_time in the
//                     next 48h). Futures and series excluded. Used by
//                     the sidebar Markets dashboard so the firehose
//                     view stays focused on game-day lines.
//   (no param)      — every market, used by team pages that filter
//                     client-side for that team's futures.
//
// Cache: 30s. Lines move on the order of seconds-to-minutes; 30s feels
// rapid without hammering upstreams.

import {
    listAllMlbMarkets,
    groupByQuestion,
} from "./_markets.js";

const CACHE_SECONDS = 30;
const GAME_DAY_TYPES   = new Set(["moneyline", "spread", "total", "team_prop", "player_prop"]);
const GAME_DAY_EXCLUDE = new Set(["future", "series"]);
const GAME_DAY_WINDOW_MS = 48 * 3600 * 1000;


export async function onRequest(context) {
    const env = context.env || {};
    const url = new URL(context.request.url);
    const scope = url.searchParams.get("scope");

    let markets;
    try {
        markets = await listAllMlbMarkets(env);
    } catch (e) {
        return new Response(
            JSON.stringify({ error: `markets fetch failed: ${e.message || e}` }),
            { status: 502, headers: { "content-type": "application/json" } },
        );
    }

    if (scope === "game_day") {
        markets = filterToGameDay(markets);
    }

    const grouped = groupByQuestion(markets);
    const sources = Array.from(new Set(markets.map((m) => m.source))).sort();
    const counts  = sources.reduce((acc, s) => {
        acc[s] = markets.filter((m) => m.source === s).length;
        return acc;
    }, {});

    return new Response(JSON.stringify({
        scope: scope || "all",
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

// Same logic as filterMarketsForGame, but with `now` instead of a
// specific game's start_time. Used for the dashboard's "tonight's
// slate" view.
function filterToGameDay(markets) {
    const now = Date.now();
    return markets.filter((m) => {
        if (GAME_DAY_EXCLUDE.has(m.question_type)) return false;
        if (!GAME_DAY_TYPES.has(m.question_type))   return false;
        if (m.start_time) {
            const dt = Math.abs(new Date(m.start_time).getTime() - now);
            if (dt > GAME_DAY_WINDOW_MS) return false;
        }
        return true;
    });
}
