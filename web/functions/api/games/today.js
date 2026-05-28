// /api/games/today
//
// Returns today's MLB schedule (from the MLB Stats API) with win expectancy
// added per game. Run on the Cloudflare Pages edge — the MLB upstream is
// rate-limited via the edge cache so even a hot Board hits it at most every
// few seconds.

import { WE_TABLE } from "./_we_table.js";
import { WE_TABLE_V2 } from "./_we_table_v2.js";

// Clip helpers — keep WE state inside the indexed range of v2.
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Pre-PA win probability for the home team. Tries the new state-keyed
// table (inning, half, outs, bases, home_lead) first; falls back to the
// half-level table (using the previous half's end as an approximation
// of "WP at start of current half") if the v2 cell is missing.
function lookupWE(inning, half, outs, bases, homeLead) {
    const innC  = clip(inning, 1, 9);
    const leadC = clip(homeLead, -10, 10);
    const k2 = `${innC}|${half}|${outs}|${bases}|${leadC}`;
    if (WE_TABLE_V2[k2] !== undefined) return WE_TABLE_V2[k2];
    // Fallback path (rare — only when v2 has a hole the smoothing
    // couldn't fill). Use the half-level table at the start of the
    // current half, same approximation as before v2 landed.
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
    const url = new URL(context.request.url);
    const date = url.searchParams.get("date") || todayInEastern();

    const upstreamUrl =
        `https://statsapi.mlb.com/api/v1/schedule` +
        `?date=${date}&sportId=1&hydrate=linescore,probablePitcher,decisions`;

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

    // Pre-pass: collect every probable pitcher ID across the slate so we can
    // resolve handedness in a single batch fetch (the schedule hydrate doesn't
    // include pitchHand).
    const probableIds = new Set();
    for (const day of (data.dates || [])) {
        for (const game of (day.games || [])) {
            const a = game.teams?.away?.probablePitcher?.id;
            const h = game.teams?.home?.probablePitcher?.id;
            if (a) probableIds.add(a);
            if (h) probableIds.add(h);
        }
    }
    const handBy = await fetchHandedness([...probableIds]);

    const games = [];
    for (const day of (data.dates || [])) {
        for (const game of (day.games || [])) {
            games.push(buildTile(game, handBy));
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

async function fetchHandedness(ids) {
    const out = {};
    if (ids.length === 0) return out;
    const url =
        `https://statsapi.mlb.com/api/v1/people` +
        `?personIds=${ids.join(",")}`;
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)",
            },
            cf: { cacheTtl: 300, cacheEverything: true },
        });
        if (!res.ok) return out;
        const j = await res.json();
        for (const p of (j.people || [])) {
            out[p.id] = p.pitchHand?.code || null;
        }
    } catch {
        // missing handedness is degraded but tolerable — tile just omits the LHP/RHP tag.
    }
    return out;
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

function buildTile(g, handBy) {
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
        // PA-state lookup using the new (inning, half, outs, bases,
        // home_lead) table aggregated from 15M historical PAs. Honest
        // at the per-PA level — fixes the "100% bottom 9th down 1"
        // class of bugs the half-level table produced.
        const outsN  = ls.outs ?? 0;
        const basesN = bases;
        winExp = lookupWE(inning, half, outsN, basesN, homeScore - awayScore);
        if (winExp === null && inning === 1 && half === "top") {
            // Pre-game start state — baseline home-field advantage.
            winExp = 0.54;
        }
    } else if (status === "Final") {
        winExp = homeScore > awayScore ? 1.0 :
                 homeScore < awayScore ? 0.0 : 0.5;
    }

    // Probable pitchers (pregame). Handedness is resolved from the batch
    // /people fetch above; absence is fine — we just drop the LHP/RHP tag.
    let probables = null;
    if (status === "Preview") {
        const ap = g.teams?.away?.probablePitcher;
        const hp = g.teams?.home?.probablePitcher;
        if (ap || hp) {
            probables = {
                away: ap ? { id: ap.id, name: ap.fullName, throws: handBy[ap.id] || null } : null,
                home: hp ? { id: hp.id, name: hp.fullName, throws: handBy[hp.id] || null } : null,
            };
        }
    }

    // Decisions (final). Winning + losing pitcher are always present once a
    // game is final; the save is only present on save-eligible wins.
    let decisions = null;
    if (status === "Final" && g.decisions) {
        decisions = {
            // Names AND ids — UI attaches a headshot to each pitcher.
            winner:    g.decisions.winner?.fullName || null,
            winner_id: g.decisions.winner?.id      || null,
            loser:     g.decisions.loser?.fullName  || null,
            loser_id:  g.decisions.loser?.id       || null,
            save:      g.decisions.save?.fullName   || null,
            save_id:   g.decisions.save?.id        || null,
        };
    }

    // Records ride straight off the schedule response. Standings position
    // isn't here — would need a separate /standings call — so we surface the
    // raw W-L only.
    const recAway = g.teams?.away?.leagueRecord;
    const recHome = g.teams?.home?.leagueRecord;
    const record = (recAway || recHome) ? {
        away: recAway ? `${recAway.wins}-${recAway.losses}` : null,
        home: recHome ? `${recHome.wins}-${recHome.losses}` : null,
    } : null;

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
        probables,
        decisions,
        record,
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
