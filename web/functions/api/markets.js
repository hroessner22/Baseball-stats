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

const CACHE_SECONDS = 10;   // rapid updates per user feedback
const GAME_DAY_TYPES   = new Set(["moneyline", "spread", "total", "team_prop", "player_prop"]);
const GAME_DAY_EXCLUDE = new Set(["future", "series"]);
const GAME_DAY_WINDOW_MS = 48 * 3600 * 1000;


export async function onRequest(context) {
    const env = context.env || {};
    const url = new URL(context.request.url);
    const scope = url.searchParams.get("scope");

    let markets;
    let initialDiagnostics = null;
    try {
        markets = await listAllMlbMarkets(env);
        initialDiagnostics = markets._diagnostics || null;
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

    const debug = url.searchParams.get("debug");
    const diagnostics = initialDiagnostics;

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
        // Per-adapter outcome surface for ?debug=1 — silent failures
        // (Smarkets returning 0 etc.) become loud.
        ...(debug ? { _diagnostics: diagnostics } : {}),
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
// slate" view. Also dedupes by (team_pair × question × source) so
// the same team-pair moneyline doesn't appear 3x (doubleheaders,
// next-day series).
function filterToGameDay(markets) {
    const now = Date.now();
    const kept = markets.filter((m) => {
        if (GAME_DAY_EXCLUDE.has(m.question_type)) return false;
        if (!GAME_DAY_TYPES.has(m.question_type))   return false;
        if (m.start_time) {
            const dt = Math.abs(new Date(m.start_time).getTime() - now);
            if (dt > GAME_DAY_WINDOW_MS) return false;
        }
        return true;
    });
    return dedupeByGameKey(kept);
}

// Same idea as the SDK's per-game dedup, but here we anchor on each
// individual market's own start_time (the closest one to NOW wins per
// team-pair × question × source). Used for the dashboard firehose.
function dedupeByGameKey(markets) {
    const NON_DEDUPED = new Set(["player_prop", "team_prop"]);
    const now = Date.now();
    const byKey = new Map();
    const out = [];
    for (const m of markets) {
        if (NON_DEDUPED.has(m.question_type)) { out.push(m); continue; }
        const tri = [m.home_tricode, m.away_tricode].filter(Boolean).sort().join("v");
        if (!tri) { out.push(m); continue; }
        // Handicap in the key so spread / total ladders preserve each
        // line as its own row.
        const hKey = m.handicap != null ? `:${m.handicap}` : "";
        const key = `${tri}|${m.question_type}|${m.source}${hKey}`;
        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, m); continue; }
        const dNew = m.start_time
            ? Math.abs(new Date(m.start_time).getTime() - now) : Infinity;
        const dPrev = prev.start_time
            ? Math.abs(new Date(prev.start_time).getTime() - now) : Infinity;
        if (dNew < dPrev) { byKey.set(key, m); continue; }
        if (dNew === dPrev) {
            const newPriced  = (m.outcomes || []).filter((o) => o.probability != null).length;
            const prevPriced = (prev.outcomes || []).filter((o) => o.probability != null).length;
            if (newPriced > prevPriced) byKey.set(key, m);
        }
    }
    for (const m of byKey.values()) out.push(m);
    return out;
}
