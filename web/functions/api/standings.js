// /api/standings
//
// Returns today's MLB standings — the 6 divisions, each with its teams
// sorted by current division rank. Proxies the MLB Stats API standings
// endpoint and reshapes it into the minimal shape the Board view needs.
// Cached 5 minutes at the edge — standings only move once per game.

export async function onRequest(context) {
    const url = new URL(context.request.url);
    const season = url.searchParams.get("season") || String(currentSeason());
    const date = url.searchParams.get("date"); // optional override

    const apiUrl =
        `https://statsapi.mlb.com/api/v1/standings` +
        `?leagueId=103,104&season=${season}` +
        (date ? `&date=${date}` : "");

    let upstream;
    try {
        upstream = await fetch(apiUrl, {
            headers: {
                "User-Agent": "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)",
            },
            cf: { cacheTtl: 300, cacheEverything: true },
        });
    } catch (e) {
        return jsonError(502, `upstream fetch failed: ${e.message || e}`);
    }
    if (!upstream.ok) return jsonError(502, `upstream HTTP ${upstream.status}`);

    const data = await upstream.json();
    const divisions = (data.records || []).map(buildDivision);

    return new Response(JSON.stringify({
        season,
        date: date || null,
        divisions,
        fetched_at: new Date().toISOString(),
    }), {
        headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=300",
            "access-control-allow-origin": "*",
        },
    });
}

function currentSeason() {
    // MLB season is well-aligned with the calendar year — March through October.
    // For November + December we'd want last season, but for the live MVP we
    // can assume in-season.
    return new Date().getUTCFullYear();
}

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function buildDivision(rec) {
    const id = rec.division?.id;
    return {
        id,
        name: DIVISION_NAMES[id] || `Division ${id}`,
        league: DIVISION_LEAGUE[id] || "?",
        teams: (rec.teamRecords || []).map(buildTeam),
    };
}

function buildTeam(t) {
    const name = t.team?.name || "?";
    const splits = t.records?.splitRecords || [];
    const last10 = splits.find((s) => s.type === "lastTen");
    const home = splits.find((s) => s.type === "home");
    const away = splits.find((s) => s.type === "away");
    return {
        team_id: t.team?.id,
        team: TEAM_ABBR[name] || name.slice(0, 3).toUpperCase(),
        name,
        wins: t.wins,
        losses: t.losses,
        pct: t.winningPercentage,
        gb: t.gamesBack || "-",
        streak: t.streak?.streakCode || "-",
        last10: last10 ? `${last10.wins}-${last10.losses}` : "-",
        home:  home  ? `${home.wins}-${home.losses}`  : "-",
        away:  away  ? `${away.wins}-${away.losses}`  : "-",
        run_diff: (t.runsScored ?? 0) - (t.runsAllowed ?? 0),
        div_rank: parseInt(t.divisionRank, 10) || null,
    };
}

const DIVISION_NAMES = {
    200: "AL West",
    201: "AL East",
    202: "AL Central",
    203: "NL West",
    204: "NL East",
    205: "NL Central",
};

const DIVISION_LEAGUE = {
    200: "AL", 201: "AL", 202: "AL",
    203: "NL", 204: "NL", 205: "NL",
};

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
    // Short forms the upstream sometimes returns
    "Rays": "TB", "Yankees": "NYY", "Red Sox": "BOS", "Blue Jays": "TOR",
    "Orioles": "BAL", "Guardians": "CLE", "White Sox": "CHW", "Tigers": "DET",
    "Twins": "MIN", "Royals": "KC", "Astros": "HOU", "Mariners": "SEA",
    "Rangers": "TEX", "Angels": "LAA", "Braves": "ATL", "Phillies": "PHI",
    "Mets": "NYM", "Marlins": "MIA", "Nationals": "WSH", "Brewers": "MIL",
    "Cardinals": "STL", "Cubs": "CHC", "Reds": "CIN", "Pirates": "PIT",
    "Dodgers": "LAD", "Padres": "SD", "Giants": "SF", "Diamondbacks": "ARI",
    "Rockies": "COL",
};
