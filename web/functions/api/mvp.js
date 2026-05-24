// /api/mvp
//
// MVP and Cy Young "race" view — top 5 candidates in each league, hitting
// and pitching, with the key headline stats per candidate. There's no
// official "MVP" stat in the MLB API, so we use OPS as the canonical
// batter signal and ERA as the canonical starting-pitcher signal, then
// hydrate each candidate's other headline stats (HR/RBI/AVG for batters,
// W-L/K/WHIP for pitchers).
//
// Four parallel calls to MLB Stats API /stats/leaders — one per
// (league × group) bucket — keep the latency tight. Cached 5 min.

const AL = 103;
const NL = 104;

const BATTER_HEADLINES = [
    ["onBasePlusSlugging", "OPS"],
    ["homeRuns",           "HR"],
    ["runsBattedIn",       "RBI"],
    ["battingAverage",     "AVG"],
];
const PITCHER_HEADLINES = [
    ["earnedRunAverage",   "ERA"],
    ["wins",               "W"],
    ["strikeouts",         "K"],
    ["walksAndHitsPerInningPitched", "WHIP"],
];

export async function onRequest(context) {
    const url = new URL(context.request.url);
    const season = url.searchParams.get("season") || String(currentSeason());

    try {
        const [alMvp, nlMvp, alCy, nlCy] = await Promise.all([
            fetchTopPlayers(AL, "hitting", BATTER_HEADLINES, season),
            fetchTopPlayers(NL, "hitting", BATTER_HEADLINES, season),
            fetchTopPlayers(AL, "pitching", PITCHER_HEADLINES, season),
            fetchTopPlayers(NL, "pitching", PITCHER_HEADLINES, season),
        ]);
        return new Response(JSON.stringify({
            season,
            races: [
                { id: "al-mvp", title: "AL MVP Race",       group: "hitting",  candidates: alMvp },
                { id: "nl-mvp", title: "NL MVP Race",       group: "hitting",  candidates: nlMvp },
                { id: "al-cy",  title: "AL Cy Young Race",  group: "pitching", candidates: alCy },
                { id: "nl-cy",  title: "NL Cy Young Race",  group: "pitching", candidates: nlCy },
            ],
            fetched_at: new Date().toISOString(),
        }), {
            headers: {
                "content-type": "application/json",
                "cache-control": "public, max-age=300",
                "access-control-allow-origin": "*",
            },
        });
    } catch (e) {
        return jsonError(502, `mvp fetch failed: ${e.message || e}`);
    }
}

// Pull the top 5 by the primary stat (first headline) plus the other
// headline stats for those same players. The trick: /stats/leaders only
// returns one stat per leader, so we fetch each headline separately and
// stitch by personId. Five parallel calls per league × group bucket.
async function fetchTopPlayers(leagueId, group, headlines, season) {
    const blocks = await Promise.all(
        headlines.map(([category]) =>
            fetchLeaderBlock({ category, leagueId, group, season, limit: 30 })
        )
    );
    if (blocks.length === 0) return [];
    const primary = blocks[0]; // primary = ranked by the first stat

    // Build a stat-by-id map for each non-primary headline so we can look
    // up the other stats per candidate.
    const lookups = blocks.slice(1).map((block) => {
        const m = new Map();
        for (const l of block) {
            if (l.person?.id) m.set(l.person.id, l.value);
        }
        return m;
    });

    const out = [];
    for (const l of primary.slice(0, 5)) {
        const pid = l.person?.id;
        const stats = [{ label: headlines[0][1], value: l.value }];
        headlines.slice(1).forEach(([, label], i) => {
            const v = lookups[i].get(pid);
            stats.push({ label, value: v ?? "—" });
        });
        out.push({
            rank: l.rank,
            person_id: pid,
            name: l.person?.fullName || "?",
            team: l.team?.abbreviation || null,
            stats,
        });
    }
    return out;
}

async function fetchLeaderBlock({ category, leagueId, group, season, limit }) {
    const url =
        `https://statsapi.mlb.com/api/v1/stats/leaders` +
        `?leaderCategories=${category}` +
        `&season=${season}&sportId=1` +
        `&leagueId=${leagueId}` +
        `&statGroup=${group}` +
        `&limit=${limit}` +
        `&hydrate=team`;
    const res = await fetch(url, {
        headers: {
            "User-Agent": "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)",
        },
        cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const blk = (d.leagueLeaders || [])[0];
    return blk ? blk.leaders || [] : [];
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
