// /api/bot/pitcher-recent-form?id={mlbam}&starts={N}
//
// Aggregates the pitcher's last N starts from MLB Stats API
// gameLog. Returns:
//
//   {
//     starts_window: 5,
//     starts_found:  5,
//     era,        // weighted avg ERA across the window
//     whip,       // weighted avg
//     k9,         // K per 9
//     bb9,        // BB per 9
//     opp_avg,    // opponent batting average
//     swstr_pct,  // swinging-strike % if available
//     trend: 'improving' | 'declining' | 'steady'
//   }
//
// The bot's pitcher-recent-form factor uses these to bias the
// model edge: a pitcher whose K/9 has spiked the last 5 starts
// gets a positive K-prop adjustment; one whose ERA is bleeding
// gets a negative WE adjustment when betting his side.
//
// Cached 1h at the edge — gameLog only changes after a start.

const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";

export async function onRequest(context) {
    const url = new URL(context.request.url);
    const id = parseInt(url.searchParams.get("id"), 10);
    const starts = Math.max(1, Math.min(15, parseInt(url.searchParams.get("starts") || "5", 10)));
    if (!id) return jsonError(400, "id required");

    const season = new Date().getUTCFullYear();
    const gameLog = await fetchGameLog(id, season);
    if (!gameLog || !gameLog.length) {
        return jsonResponse({
            pitcher_mlbam: id,
            available: false,
            reason: "no gameLog available for season",
        });
    }
    // Filter to starts only (gamesStarted >= 1) and take the most
    // recent N — gameLog comes oldest-first, reverse it.
    const startsOnly = gameLog
        .filter((g) => parseInt(g.stat?.gamesStarted || 0, 10) >= 1)
        .reverse()
        .slice(0, starts);
    if (!startsOnly.length) {
        return jsonResponse({
            pitcher_mlbam: id,
            available: false,
            reason: "no starts logged this season yet",
        });
    }
    const agg = aggregate(startsOnly);
    // Trend: compare first half of the window vs second half.
    const trend = (startsOnly.length >= 4)
        ? computeTrend(startsOnly)
        : "steady";

    return jsonResponse({
        pitcher_mlbam: id,
        season,
        available:     true,
        starts_window: starts,
        starts_found:  startsOnly.length,
        ...agg,
        trend,
    });
}


async function fetchGameLog(pid, season) {
    const url = `https://statsapi.mlb.com/api/v1/people/${pid}` +
                `/stats?stats=gameLog&group=pitching&season=${season}`;
    try {
        const res = await fetch(url, {
            cf: { cacheTtl: 3600, cacheEverything: true },
            headers: { "User-Agent": UA, Accept: "application/json" },
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.stats?.[0]?.splits || null;
    } catch { return null; }
}

function aggregate(splits) {
    let ip = 0, er = 0, h = 0, bb = 0, k = 0, ab = 0, batters = 0, pitches = 0;
    for (const s of splits) {
        const st = s.stat || {};
        ip       += parseIp(st.inningsPitched);
        er       += parseInt(st.earnedRuns || 0, 10);
        h        += parseInt(st.hits || 0, 10);
        bb       += parseInt(st.baseOnBalls || 0, 10);
        k        += parseInt(st.strikeOuts || 0, 10);
        ab       += parseInt(st.atBats || 0, 10);
        batters  += parseInt(st.battersFaced || 0, 10);
        pitches  += parseInt(st.pitchesThrown || st.numberOfPitches || 0, 10);
    }
    return {
        era:           ip > 0 ? round2((er / ip) * 9)       : null,
        whip:          ip > 0 ? round2((h + bb) / ip)        : null,
        k9:            ip > 0 ? round2((k / ip) * 9)         : null,
        bb9:           ip > 0 ? round2((bb / ip) * 9)        : null,
        opp_avg:       ab > 0 ? round3(h / ab)               : null,
        k_pct:         batters > 0 ? round3(k / batters)     : null,
        bb_pct:        batters > 0 ? round3(bb / batters)    : null,
        // MLB Stats API doesn't surface swinging-strike % in
        // gameLog — would need Savant for that. Left null so the
        // factor builder downgrades that signal cleanly.
        swstr_pct:     null,
        avg_pitches:   splits.length > 0 ? Math.round(pitches / splits.length) : null,
    };
}

function computeTrend(splits) {
    // Split window in half. If ERA in the later half is materially
    // lower than the earlier half → improving. Higher → declining.
    const mid = Math.floor(splits.length / 2);
    const recent = aggregate(splits.slice(0, mid));      // most recent (we reversed earlier)
    const earlier = aggregate(splits.slice(mid));
    if (recent.era == null || earlier.era == null) return "steady";
    const delta = recent.era - earlier.era;
    if (delta <= -0.75) return "improving";
    if (delta >= +0.75) return "declining";
    return "steady";
}


// ── Tiny utilities ───────────────────────────────────────────────

function parseIp(str) {
    // MLB's IP format: '6.1' = 6⅓ IP, '6.2' = 6⅔ IP.
    if (!str) return 0;
    const s = String(str);
    const m = s.match(/^(\d+)(?:\.(\d))?$/);
    if (!m) return 0;
    const whole = parseInt(m[1], 10);
    const frac  = m[2] === "1" ? 1/3 : (m[2] === "2" ? 2/3 : 0);
    return whole + frac;
}
function round2(x) {
    if (!Number.isFinite(x)) return null;
    return Math.round(x * 100) / 100;
}
function round3(x) {
    if (!Number.isFinite(x)) return null;
    return Math.round(x * 1000) / 1000;
}
function jsonResponse(body, maxAge = 3600) {
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
