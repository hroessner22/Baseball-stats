// /api/game/{id}
//
// Detailed live state for one game — current matchup (batter + pitcher),
// runners on base with names, count, outs, score, and win expectancy.
// Proxies the MLB Stats API live-feed endpoint and reshapes it into the
// minimal shape the Game view needs.

import { WE_TABLE } from "../games/_we_table.js";
import { WE_TABLE_V2 } from "../games/_we_table_v2.js";
import { DEMO_GAME } from "./_demo.js";

const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// PA-state win probability for the home team. Tries the new v2 table
// (15M-PA aggregation keyed by inning, half, outs, bases, home_lead)
// first; falls back to the half-level table if v2 has a hole.
function lookupWE(inning, half, outs, bases, homeLead) {
    const innC  = clip(inning, 1, 9);
    const leadC = clip(homeLead, -10, 10);
    const k2 = `${innC}|${half}|${outs}|${bases}|${leadC}`;
    if (WE_TABLE_V2[k2] !== undefined) return WE_TABLE_V2[k2];
    const prev = previousHalfState(innC, half);
    if (prev) {
        const k1 = `${Math.min(prev.inning, 9)}|${prev.half}|${homeLead}`;
        if (WE_TABLE[k1] !== undefined) return WE_TABLE[k1];
    }
    return null;
}

function previousHalfState(inning, half) {
    if (half === "top") {
        if (inning === 1) return null;
        return { inning: inning - 1, half: "bottom" };
    }
    return { inning, half: "top" };
}

export async function onRequest(context) {
    const gameId = context.params?.id;

    // Synthetic high-leverage scenario for testing the live-only UI
    // without waiting for a real game to roll around. Reachable at
    // #game/demo from the footer.
    if (gameId === "demo") {
        const g = { ...DEMO_GAME };
        const basesMask =
            (g.runners?.first  ? 1 : 0) |
            (g.runners?.second ? 2 : 0) |
            (g.runners?.third  ? 4 : 0);
        g.win_expectancy = lookupWE(
            g.inning, g.half, g.outs, basesMask,
            g.score.home - g.score.away
        );
        return new Response(JSON.stringify(g), {
            headers: {
                "content-type": "application/json",
                "cache-control": "no-store",
                "access-control-allow-origin": "*",
            },
        });
    }

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
            cf: { cacheTtl: 10, cacheEverything: true },
        });
    } catch (e) {
        return jsonError(502, `upstream fetch failed: ${e.message || e}`);
    }
    if (!upstream.ok) {
        return jsonError(502, `upstream HTTP ${upstream.status}`);
    }

    const data = await upstream.json();
    return new Response(JSON.stringify(buildGame(data)), {
        headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=10",
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

function buildGame(d) {
    const gameData = d.gameData || {};
    const liveData = d.liveData || {};
    const linescore = liveData.linescore || {};
    const currentPlay = liveData.plays?.currentPlay || {};
    const matchup = currentPlay.matchup || {};

    const status = gameData.status?.abstractGameState || "Unknown";
    const detail = gameData.status?.detailedState || "";

    const inning = linescore.currentInning ?? null;
    const half = inning ? (linescore.isTopInning ? "top" : "bottom") : null;
    const outs = linescore.outs ?? 0;
    const balls = linescore.balls ?? 0;
    const strikes = linescore.strikes ?? 0;

    const awayScore = linescore.teams?.away?.runs ?? 0;
    const homeScore = linescore.teams?.home?.runs ?? 0;

    const offense = linescore.offense || {};
    const runners = {
        first: offense.first?.fullName || null,
        second: offense.second?.fullName || null,
        third: offense.third?.fullName || null,
    };

    const batter = matchup.batter ? {
        id: matchup.batter.id,
        name: matchup.batter.fullName,
        bats: matchup.batSide?.code || null,
    } : null;
    const pitcher = matchup.pitcher ? {
        id: matchup.pitcher.id,
        name: matchup.pitcher.fullName,
        throws: matchup.pitchHand?.code || null,
    } : null;

    let winExp = null;
    if (status === "Live" && inning && half) {
        // PA-state lookup via the v2 table (15M-PA aggregation that
        // includes outs and bases). With this, "bottom 9th, bases
        // loaded, 1 out, home down 1" returns ~54% — what history
        // actually says — instead of the half-level table's 0%.
        const basesMask =
            (offense.first  ? 1 : 0) |
            (offense.second ? 2 : 0) |
            (offense.third  ? 4 : 0);
        winExp = lookupWE(inning, half, outs, basesMask, homeScore - awayScore);
        if (winExp === null && inning === 1 && half === "top") {
            winExp = 0.54;
        }
    } else if (status === "Final") {
        winExp = homeScore > awayScore ? 1.0 :
                 homeScore < awayScore ? 0.0 : 0.5;
    }

    return {
        game_pk: gameData.game?.pk,
        status,
        detail,
        teams: {
            away: teamFields(gameData.teams?.away),
            home: teamFields(gameData.teams?.home),
        },
        score: { away: awayScore, home: homeScore },
        inning, half, outs, balls, strikes,
        runners,
        batter, pitcher,
        win_expectancy: winExp,
        venue: gameData.venue?.name || null,
        start_time: gameData.datetime?.dateTime || null,
    };
}

function teamFields(t) {
    if (!t) return { id: null, name: "?", abbr: "?" };
    return {
        id: t.id,
        name: t.teamName || t.name || "?",
        abbr: t.abbreviation ||
              (t.teamName || t.name || "??").slice(0, 3).toUpperCase(),
    };
}
