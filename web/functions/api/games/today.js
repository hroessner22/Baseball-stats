// /api/games/today
//
// Returns today's MLB schedule (from the MLB Stats API) with win expectancy
// added per game. Run on the Cloudflare Pages edge — the MLB upstream is
// rate-limited via the edge cache so even a hot Board hits it at most every
// few seconds.

import { WE_TABLE } from "./_we_table.js";

export async function onRequest(context) {
    const url = new URL(context.request.url);
    const date = url.searchParams.get("date") || todayInEastern();

    const upstreamUrl =
        `https://statsapi.mlb.com/api/v1/schedule` +
        `?date=${date}&sportId=1&hydrate=linescore`;

    let upstream;
    try {
        upstream = await fetch(upstreamUrl, {
            headers: {
                "User-Agent": "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)",
            },
            cf: { cacheTtl: 15, cacheEverything: true },
        });
    } catch (e) {
        return jsonError(502, `upstream fetch failed: ${e.message || e}`);
    }
    if (!upstream.ok) {
        return jsonError(502, `upstream HTTP ${upstream.status}`);
    }

    const data = await upstream.json();
    const games = [];
    for (const day of (data.dates || [])) {
        for (const game of (day.games || [])) {
            games.push(buildTile(game));
        }
    }

    return new Response(JSON.stringify({
        date,
        games,
        fetched_at: new Date().toISOString(),
    }), {
        headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=15",
            "access-control-allow-origin": "*",
        },
    });
}

function todayInEastern() {
    // MLB's day boundary is roughly midnight Eastern; align with that.
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const yyyy = parts.find((p) => p.type === "year").value;
    const mm = parts.find((p) => p.type === "month").value;
    const dd = parts.find((p) => p.type === "day").value;
    return `${yyyy}-${mm}-${dd}`;
}

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function buildTile(g) {
    const status = g.status?.abstractGameState || "Unknown";
    const detail = g.status?.detailedState || "";
    const ls = g.linescore || {};

    const away = abbrev(g.teams?.away);
    const home = abbrev(g.teams?.home);
    const awayScore = g.teams?.away?.score ?? 0;
    const homeScore = g.teams?.home?.score ?? 0;

    const inning = ls.currentInning ?? null;
    const half = inning ? (ls.isTopInning ? "top" : "bottom") : null;

    const off = ls.offense || {};
    const bases =
        (off.first ? 1 : 0) |
        (off.second ? 2 : 0) |
        (off.third ? 4 : 0);

    let winExp = null;
    if (status === "Live" && inning) {
        // Extra innings collapse to the 9th — a rough proxy until the matchup
        // engine takes over in Phase 3.2.
        const ksKey = `${Math.min(inning, 9)}|${half}|${homeScore - awayScore}`;
        if (WE_TABLE[ksKey] !== undefined) winExp = WE_TABLE[ksKey];
    } else if (status === "Final") {
        winExp = homeScore > awayScore ? 1.0 :
                 homeScore < awayScore ? 0.0 : 0.5;
    }

    return {
        game_pk: g.gamePk,
        status,
        detail,
        away, home,
        away_score: awayScore,
        home_score: homeScore,
        inning, half,
        outs: ls.outs ?? null,
        balls: ls.balls ?? null,
        strikes: ls.strikes ?? null,
        bases,
        win_expectancy: winExp,
        start_time: g.gameDate,
    };
}

// The MLB Stats API ``schedule`` endpoint doesn't include team
// abbreviations in its default response. Hardcode the 30-team map so the
// Board can render compact tiles without a second API call.
const TEAM_ABBR = {
    "Arizona Diamondbacks": "ARI",
    "Atlanta Braves": "ATL",
    "Baltimore Orioles": "BAL",
    "Boston Red Sox": "BOS",
    "Chicago Cubs": "CHC",
    "Chicago White Sox": "CHW",
    "Cincinnati Reds": "CIN",
    "Cleveland Guardians": "CLE",
    "Colorado Rockies": "COL",
    "Detroit Tigers": "DET",
    "Houston Astros": "HOU",
    "Kansas City Royals": "KC",
    "Los Angeles Angels": "LAA",
    "Los Angeles Dodgers": "LAD",
    "Miami Marlins": "MIA",
    "Milwaukee Brewers": "MIL",
    "Minnesota Twins": "MIN",
    "New York Mets": "NYM",
    "New York Yankees": "NYY",
    "Oakland Athletics": "OAK",
    "Athletics": "ATH",
    "Philadelphia Phillies": "PHI",
    "Pittsburgh Pirates": "PIT",
    "San Diego Padres": "SD",
    "San Francisco Giants": "SF",
    "Seattle Mariners": "SEA",
    "St. Louis Cardinals": "STL",
    "Tampa Bay Rays": "TB",
    "Texas Rangers": "TEX",
    "Toronto Blue Jays": "TOR",
    "Washington Nationals": "WSH",
};

function abbrev(side) {
    if (!side) return "?";
    const name = side.team?.name || "";
    return TEAM_ABBR[name] ||
           side.team?.abbreviation ||
           name.slice(0, 3).toUpperCase() ||
           "?";
}
