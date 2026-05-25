// /api/game/{id}/we-trace
//
// Win-expectancy trajectory over the course of one game. For every
// completed half-inning, we record the post-half state (home_score,
// away_score) and look up the corresponding WE from the same table
// the rest of the engine uses. Output is an ordered array of points
// the Game view renders as a simple SVG line chart.
//
// Granularity: half-inning. The same per-pitch WE that would give
// truly play-by-play resolution is a separate, bigger lift (the last
// unbuilt strategy-list item) — when it lands, this endpoint becomes
// per-PA without changing its consumer.

import { WE_TABLE } from "../../games/_we_table.js";

const PRE_GAME_HOME_WP = 0.54; // MLB historical home-field advantage

function previousHalfState(inning, half) {
    if (half === "top") {
        if (inning === 1) return null;
        return { inning: inning - 1, half: "bottom" };
    }
    return { inning, half: "top" };
}

export async function onRequest(context) {
    const gameId = context.params?.id;
    if (!gameId || !/^\d+$/.test(gameId)) {
        return jsonError(400, "invalid game id");
    }
    const url = `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;
    let upstream;
    try {
        upstream = await fetch(url, {
            headers: {
                "User-Agent": "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)",
            },
            cf: { cacheTtl: 30, cacheEverything: true },
        });
    } catch (e) {
        return jsonError(502, `upstream fetch failed: ${e.message || e}`);
    }
    if (!upstream.ok) return jsonError(502, `upstream HTTP ${upstream.status}`);

    const data = await upstream.json();
    const status = data?.gameData?.status?.abstractGameState || "Unknown";
    const allPlays = data?.liveData?.plays?.allPlays || [];

    const points = buildTrace(allPlays, status);

    return new Response(JSON.stringify({
        game_pk: parseInt(gameId, 10),
        status,
        points,
        fetched_at: new Date().toISOString(),
    }), {
        headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=30",
            "access-control-allow-origin": "*",
        },
    });
}

function buildTrace(allPlays, status) {
    // Walk plays; for each completed half-inning, keep the LAST play's
    // post-state score. That state's WE goes on the chart.
    const lastInHalf = new Map();
    for (const p of allPlays) {
        if (p.about?.isComplete === false) continue;
        const inning = p.about?.inning;
        if (!inning) continue;
        const half = p.about?.isTopInning ? "top" : "bottom";
        // Half-end key sorted as e.g. "01-top" so chronological iteration
        // walks 1-top → 1-bottom → 2-top → ...
        const sortKey = `${String(inning).padStart(2, "0")}-${half === "top" ? "0" : "1"}`;
        lastInHalf.set(sortKey, {
            inning,
            half,
            away: p.result?.awayScore ?? 0,
            home: p.result?.homeScore ?? 0,
        });
    }

    const points = [
        { inning: 0, half: "pre", away: 0, home: 0, we: PRE_GAME_HOME_WP },
    ];

    const sortedKeys = [...lastInHalf.keys()].sort();
    for (const k of sortedKeys) {
        const e = lastInHalf.get(k);
        const diff = e.home - e.away;
        const we = lookupWE(e.inning, e.half, diff, status);
        points.push({ inning: e.inning, half: e.half, away: e.away, home: e.home, we });
    }

    // For a Final game, force the last point to the certain outcome (0 or 1).
    // This matters when the game ended mid-half via walk-off — the WE_TABLE
    // entry can be slightly off, but the truth at game-end is binary.
    if (status === "Final" && points.length > 1) {
        const last = points[points.length - 1];
        if (last.home > last.away) last.we = 1;
        else if (last.home < last.away) last.we = 0;
    }

    return points;
}

function lookupWE(inning, half, diff, status) {
    // For LIVE games' most recent completed half, the half *just ended* so
    // the END-of-half table value is correct. (Different from the mid-half
    // case in the matchup endpoints, which use the previous half.)
    const directKey = `${Math.min(inning, 9)}|${half}|${diff}`;
    if (WE_TABLE[directKey] !== undefined) return WE_TABLE[directKey];

    // Fallback: previous half-end (rare — only when score diff is well
    // outside what we have data for, e.g. a 13-run blowout).
    const prev = previousHalfState(inning, half);
    if (prev) {
        const k = `${Math.min(prev.inning, 9)}|${prev.half}|${diff}`;
        if (WE_TABLE[k] !== undefined) return WE_TABLE[k];
    }
    // Last-resort: clip to ±1 (which we definitely have).
    const clipped = Math.max(-1, Math.min(1, diff));
    const fallbackKey = `${Math.min(inning, 9)}|${half}|${clipped}`;
    if (WE_TABLE[fallbackKey] !== undefined) {
        return diff > 0 ? Math.min(0.99, WE_TABLE[fallbackKey] + 0.2)
             : diff < 0 ? Math.max(0.01, WE_TABLE[fallbackKey] - 0.2)
             : WE_TABLE[fallbackKey];
    }
    return null;
}

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}
