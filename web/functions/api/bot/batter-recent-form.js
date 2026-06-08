// /api/bot/batter-recent-form?id={mlbam}&window={games}
//
// Aggregates the batter's recent form from MLB Stats API gameLog.
// Returns:
//
//   {
//     window_games: 15
//     games_found:  15
//     pa, ab, h, hr, k, bb
//     avg, obp, slg, ops, iso
//     k_pct, bb_pct
//     trend: 'hot' | 'cold' | 'steady'
//   }
//
// The bot's batter-recent-form factor uses this to bias hitter
// prop predictions: a batter on a 1.150 OPS heater the last 15
// games gets a +adjustment on their HR/TB/H props; a slumping
// .550 OPS guy gets a -adjustment.
//
// Cached 30min at the edge — yesterday's stats settle by then.

const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";

export async function onRequest(context) {
    const url = new URL(context.request.url);
    const id = parseInt(url.searchParams.get("id"), 10);
    const windowGames = Math.max(3, Math.min(30, parseInt(url.searchParams.get("window") || "15", 10)));
    if (!id) return jsonError(400, "id required");

    const season = new Date().getUTCFullYear();
    const splits = await fetchGameLog(id, season);
    if (!splits || !splits.length) {
        return jsonResponse({
            batter_mlbam: id,
            available: false,
            reason: "no gameLog this season",
        });
    }
    // gameLog comes oldest-first → reverse, slice to window.
    const recent = splits.slice().reverse().slice(0, windowGames);
    const agg    = aggregate(recent);

    // Trend: compare first half vs second half of the window.
    let trend = "steady";
    if (recent.length >= 6) {
        const mid = Math.floor(recent.length / 2);
        const recentHalf = aggregate(recent.slice(0, mid));
        const earlierHalf = aggregate(recent.slice(mid));
        if (recentHalf.ops != null && earlierHalf.ops != null) {
            const delta = recentHalf.ops - earlierHalf.ops;
            if (delta >= 0.150) trend = "hot";
            else if (delta <= -0.150) trend = "cold";
        }
    }

    return jsonResponse({
        batter_mlbam: id,
        season,
        available:    true,
        window_games: windowGames,
        games_found:  recent.length,
        ...agg,
        trend,
    });
}


async function fetchGameLog(pid, season) {
    const url = `https://statsapi.mlb.com/api/v1/people/${pid}` +
                `/stats?stats=gameLog&group=hitting&season=${season}`;
    try {
        const res = await fetch(url, {
            cf: { cacheTtl: 1800, cacheEverything: true },
            headers: { "User-Agent": UA, Accept: "application/json" },
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.stats?.[0]?.splits || null;
    } catch { return null; }
}

function aggregate(splits) {
    let pa=0, ab=0, h=0, hr=0, double=0, triple=0, k=0, bb=0, hbp=0;
    for (const s of splits) {
        const st = s.stat || {};
        pa     += parseInt(st.plateAppearances || 0, 10);
        ab     += parseInt(st.atBats            || 0, 10);
        h      += parseInt(st.hits              || 0, 10);
        hr     += parseInt(st.homeRuns          || 0, 10);
        double += parseInt(st.doubles           || 0, 10);
        triple += parseInt(st.triples           || 0, 10);
        k      += parseInt(st.strikeOuts        || 0, 10);
        bb     += parseInt(st.baseOnBalls       || 0, 10);
        hbp    += parseInt(st.hitByPitch        || 0, 10);
    }
    const single = Math.max(0, h - double - triple - hr);
    const tb = single + 2*double + 3*triple + 4*hr;
    return {
        pa, ab, h, hr,
        avg:    ab > 0 ? round3(h / ab)                              : null,
        obp:    pa > 0 ? round3((h + bb + hbp) / pa)                 : null,
        slg:    ab > 0 ? round3(tb / ab)                             : null,
        ops:    (ab > 0 && pa > 0)
                  ? round3((h + bb + hbp) / pa + tb / ab)
                  : null,
        iso:    ab > 0 ? round3((tb - h) / ab)                        : null,
        k_pct:  pa > 0 ? round3(k  / pa)                              : null,
        bb_pct: pa > 0 ? round3(bb / pa)                              : null,
    };
}


// ── Tiny utilities ───────────────────────────────────────────────

function round3(x) {
    if (!Number.isFinite(x)) return null;
    return Math.round(x * 1000) / 1000;
}
function jsonResponse(body, maxAge = 1800) {
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
