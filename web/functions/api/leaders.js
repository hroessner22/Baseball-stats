// /api/leaders
//
// Stat leaders across the league — top-5 in 6 hitting and 5 pitching
// categories. Two parallel calls to the MLB Stats API (one per stat
// group), each carrying multiple leader categories. Cached 5 minutes at
// the edge — leaders only move once per game.

const HITTING = [
    ["homeRuns",            "HR"],
    ["battingAverage",      "AVG"],
    ["runsBattedIn",        "RBI"],
    ["onBasePlusSlugging",  "OPS"],
    ["stolenBases",         "SB"],
    ["runs",                "R"],
    // Added to fill the leaders screen with real signal — every
    // category mapped to a standard MLB Stats API leaderCategory.
    ["onBasePercentage",    "OBP"],
    ["sluggingPercentage",  "SLG"],
    ["hits",                "H"],
    ["totalBases",          "TB"],
];

const PITCHING = [
    ["wins",                            "W"],
    ["earnedRunAverage",                "ERA"],
    ["strikeouts",                      "K"],
    ["saves",                           "SV"],
    ["walksAndHitsPerInningPitched",    "WHIP"],
    ["strikeoutsPer9Inn",               "K/9"],
    ["walksPer9Inn",                    "BB/9"],
    ["inningsPitched",                  "IP"],
    ["holds",                           "HLD"],
];

export async function onRequest(context) {
    const url = new URL(context.request.url);
    const season = url.searchParams.get("season") || String(currentSeason());
    // Top 5 per category. Top-10 made each card ~280px tall, which
    // pushed 4 card rows (2 hitting × 2 pitching) past the viewport
    // and required scrolling. Back to 5 — each card ~160-180px, the
    // full leaderboard fits in a 1080p viewport without scroll.
    const limit = url.searchParams.get("limit") || "5";

    try {
        const [hit, pit] = await Promise.all([
            fetchLeaders("hitting",  HITTING.map(([k]) => k), season, limit),
            fetchLeaders("pitching", PITCHING.map(([k]) => k), season, limit),
        ]);
        return new Response(JSON.stringify({
            season,
            hitting:  reshape(hit, HITTING,  limit),
            pitching: reshape(pit, PITCHING, limit),
            fetched_at: new Date().toISOString(),
        }), {
            headers: {
                "content-type": "application/json",
                "cache-control": "public, max-age=300",
                "access-control-allow-origin": "*",
            },
        });
    } catch (e) {
        return jsonError(502, `leaders fetch failed: ${e.message || e}`);
    }
}

async function fetchLeaders(group, categories, season, limit) {
    const url =
        `https://statsapi.mlb.com/api/v1/stats/leaders` +
        `?leaderCategories=${categories.join(",")}` +
        `&season=${season}&sportId=1` +
        `&statGroup=${group}&limit=${limit}` +
        `&hydrate=team`;
    const res = await fetch(url, {
        headers: {
            "User-Agent": "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)",
        },
        cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    return d.leagueLeaders || [];
}

function reshape(blocks, ordered, limit) {
    // The upstream returns categories in its own order; reproject into our
    // canonical order so the UI doesn't have to think about it.
    //
    // MLB's leaders API also returns ALL players tied at each rank — so a
    // top-5 HR card can land with 6 entries when there's a 3-way tie at
    // rank 4, or top-5 Wins with 10 entries when 5 starters tie at rank 5.
    // Hard-cap at the requested limit so the cards stay uniform across
    // categories (the Statcast endpoint already does this naturally).
    const cap = parseInt(limit, 10) || 5;
    const byKey = Object.fromEntries(
        blocks.map((b) => [b.leaderCategory, b])
    );
    return ordered.map(([key, label]) => {
        const b = byKey[key] || {};
        return {
            category: key,
            label,
            leaders: (b.leaders || []).slice(0, cap).map((l) => ({
                rank: l.rank,
                person_id: l.person?.id || null,
                name: l.person?.fullName || "?",
                team: l.team?.abbreviation || null,
                value: l.value,
            })),
        };
    });
}

function currentSeason() {
    return new Date().getUTCFullYear();
}

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}
