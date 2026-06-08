// /api/bot/h2h?batter={mlbam}&pitcher={mlbam}
//
// Career batter-vs-pitcher head-to-head via MLB Stats API's
// vsPlayer stat type. Returns:
//
//   {
//     pa, ab, h, hr, k, bb, hbp, avg, obp, slg, ops
//     career_pa:    total career PAs in matchup
//     last_2_years: same stats restricted to last 2 seasons,
//                   when available — recency window for the
//                   H2H factor (per our 10-PA minimum default)
//   }
//
// MLB exposes vsPlayer at:
//   /api/v1/people/{batter}/stats?stats=vsPlayer&
//     group=hitting&opposingPlayerId={pitcher}&sportId=1
//
// Career across all seasons by default; we add &season=YYYY for
// the recent-2-year window separately and merge client-side.
//
// Cached 24h at the edge — career H2H rarely shifts intra-day.

const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";

export async function onRequest(context) {
    const url = new URL(context.request.url);
    const batter  = parseInt(url.searchParams.get("batter"),  10);
    const pitcher = parseInt(url.searchParams.get("pitcher"), 10);
    if (!batter || !pitcher) return jsonError(400, "batter and pitcher required");

    const thisYear = new Date().getUTCFullYear();
    const lastYear = thisYear - 1;

    // Pull career and last-2-years in parallel. MLB Stats API needs
    // a season parameter or it defaults to current year only —
    // vsPlayerTotal is the all-time variant.
    const [career, recent1, recent2] = await Promise.all([
        fetchVsPlayer(batter, pitcher, null),
        fetchVsPlayer(batter, pitcher, thisYear),
        fetchVsPlayer(batter, pitcher, lastYear),
    ]);

    const last2Years = sumStats([recent1, recent2].filter(Boolean));

    if (!career || career.pa === 0) {
        return jsonResponse({
            batter, pitcher,
            available: false,
            reason:    "no career H2H data",
        });
    }

    return jsonResponse({
        batter,
        pitcher,
        available:     true,
        career,
        last_2_years:  last2Years,
        // Convenience: which window to use, given the 10-PA bot
        // default minimum.
        recommended_window: (last2Years && last2Years.pa >= 10)
            ? "last_2_years"
            : (career.pa >= 10 ? "career" : "insufficient"),
    });
}


async function fetchVsPlayer(batter, pitcher, season) {
    const params = new URLSearchParams({
        stats:             season ? "vsPlayer" : "vsPlayerTotal",
        group:             "hitting",
        opposingPlayerId:  String(pitcher),
        sportId:           "1",
    });
    if (season) params.set("season", String(season));
    const url = `https://statsapi.mlb.com/api/v1/people/${batter}/stats?${params}`;
    try {
        const res = await fetch(url, {
            cf: { cacheTtl: 86400, cacheEverything: true },
            headers: { "User-Agent": UA, Accept: "application/json" },
        });
        if (!res.ok) return null;
        const data = await res.json();
        const split = data?.stats?.[0]?.splits?.[0];
        if (!split) return zeroStats();
        return summarize(split.stat);
    } catch { return null; }
}

function summarize(st) {
    if (!st) return zeroStats();
    const pa = parseInt(st.plateAppearances || 0, 10);
    const ab = parseInt(st.atBats           || 0, 10);
    const h  = parseInt(st.hits             || 0, 10);
    const hr = parseInt(st.homeRuns         || 0, 10);
    const k  = parseInt(st.strikeOuts       || 0, 10);
    const bb = parseInt(st.baseOnBalls      || 0, 10);
    const hbp= parseInt(st.hitByPitch       || 0, 10);
    return {
        pa, ab, h, hr, k, bb, hbp,
        avg:  ab > 0 ? round3(h / ab)                                          : null,
        obp:  pa > 0 ? round3((h + bb + hbp) / pa)                             : null,
        slg:  ab > 0 ? round3(parseFloat(st.slg || (h / ab) || 0))             : null,
        ops:  parseFloat(st.ops || 0) || null,
        k_pct:  pa > 0 ? round3(k  / pa) : null,
        bb_pct: pa > 0 ? round3(bb / pa) : null,
    };
}

function sumStats(arr) {
    if (!arr.length) return null;
    const total = zeroStats();
    for (const s of arr) {
        if (!s) continue;
        total.pa  += s.pa  || 0;
        total.ab  += s.ab  || 0;
        total.h   += s.h   || 0;
        total.hr  += s.hr  || 0;
        total.k   += s.k   || 0;
        total.bb  += s.bb  || 0;
        total.hbp += s.hbp || 0;
    }
    total.avg    = total.ab > 0 ? round3(total.h / total.ab)                          : null;
    total.obp    = total.pa > 0 ? round3((total.h + total.bb + total.hbp) / total.pa) : null;
    total.k_pct  = total.pa > 0 ? round3(total.k  / total.pa) : null;
    total.bb_pct = total.pa > 0 ? round3(total.bb / total.pa) : null;
    return total;
}

function zeroStats() {
    return { pa:0, ab:0, h:0, hr:0, k:0, bb:0, hbp:0, avg:null, obp:null, slg:null, ops:null, k_pct:null, bb_pct:null };
}
function round3(x) {
    if (!Number.isFinite(x)) return null;
    return Math.round(x * 1000) / 1000;
}
function jsonResponse(body, maxAge = 86400) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            "content-type":  "application/json; charset=utf-8",
            "cache-control": `public, max-age=${maxAge}`,
        },
    });
}
function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}
