// /api/game/{id}
//
// Detailed live state for one game — current matchup (batter + pitcher),
// runners on base with names, count, outs, score, and win expectancy.
// Proxies the MLB Stats API live-feed endpoint and reshapes it into the
// minimal shape the Game view needs.

import { WE_TABLE } from "../games/_we_table.js";

// The half-inning that just completed before the current mid-half play.
// The WE table is keyed by end-of-half states; the previous half's end
// is the right approximation of "WP at start of current half".
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
        // Our WE table is keyed by END-OF-HALF-INNING state. During mid-
        // half play, the right lookup is the END of the PREVIOUS half —
        // that's the WP at the START of the current half. Looking up
        // the CURRENT half mid-PA returns the "if this half ended now"
        // probability, which collapses to 0 (or 1) when the half-end
        // score would already decide the game (e.g. bottom 9th down 1).
        const prev = previousHalfState(inning, half);
        if (prev) {
            const key = `${Math.min(prev.inning, 9)}|${prev.half}|${homeScore - awayScore}`;
            if (WE_TABLE[key] !== undefined) winExp = WE_TABLE[key];
        } else {
            // Top of 1st — baseline home-field advantage.
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
