// /api/game/{id}/plays
//
// Parsed play-by-play for the Gamecast view. Each entry is one plate
// appearance with the full pitch sequence — pitch type, velocity,
// per-pitch result, and the resolved outcome — plus the batter/pitcher
// matchup so the client can pair this with /api/matchup to show
// "predicted before the PA vs. what actually happened".
//
// Cached 10 seconds at the edge, same as /api/game/{id}.

const NON_PA_EVENT_TYPES = new Set([
    "caught_stealing_2b", "caught_stealing_3b", "caught_stealing_home",
    "pickoff_caught_stealing_2b", "pickoff_caught_stealing_3b",
    "pickoff_caught_stealing_home",
    "pickoff_1b", "pickoff_2b", "pickoff_3b",
    "stolen_base_2b", "stolen_base_3b", "stolen_base_home",
    "wild_pitch", "passed_ball",
    "balk", "defensive_indiff", "other_advance",
    "runner_double_play", "runner_placed",
    "game_advisory", "ejection",
]);

const OUTCOME_MAP = {
    "strikeout":                    "K",
    "strikeout_double_play":        "K",
    "strikeout_triple_play":        "K",
    "walk":                         "BB",
    "intent_walk":                  "BB",
    "hit_by_pitch":                 "HBP",
    "single":                       "1B",
    "double":                       "2B",
    "triple":                       "3B",
    "home_run":                     "HR",
    "field_out":                    "OUT",
    "force_out":                    "OUT",
    "grounded_into_double_play":    "OUT",
    "grounded_into_triple_play":    "OUT",
    "double_play":                  "OUT",
    "triple_play":                  "OUT",
    "sac_fly":                      "OUT",
    "sac_fly_double_play":          "OUT",
    "sac_bunt":                     "OUT",
    "sac_bunt_double_play":         "OUT",
    "fielders_choice_out":          "OUT",
    "field_error":                  "OTHER",
    "fielders_choice":              "OTHER",
    "catcher_interf":               "OTHER",
    "batter_interference":          "OTHER",
    "fan_interference":             "OTHER",
};

export async function onRequest(context) {
    const gameId = context.params?.id;
    if (!gameId || !/^\d+$/.test(gameId)) {
        return jsonError(400, "invalid game id");
    }
    const upstreamUrl =
        `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;

    let upstream;
    try {
        upstream = await fetch(upstreamUrl, {
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

    return new Response(JSON.stringify({
        game_pk: parseInt(gameId, 10),
        teams: parseTeams(data),
        plays: parsePlays(data),
        fetched_at: new Date().toISOString(),
    }), {
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

function parseTeams(data) {
    const t = data?.gameData?.teams || {};
    return {
        away: {
            id:   t.away?.id,
            name: t.away?.teamName || t.away?.name,
            abbr: t.away?.abbreviation,
        },
        home: {
            id:   t.home?.id,
            name: t.home?.teamName || t.home?.name,
            abbr: t.home?.abbreviation,
        },
    };
}

function parsePlays(data) {
    const allPlays = data?.liveData?.plays?.allPlays || [];
    const out = [];
    for (let i = 0; i < allPlays.length; i++) {
        const p = allPlays[i];
        const r = p.result || {};
        if (r.type !== "atBat") continue;
        // Skip PAs still in progress — they don't have a resolved
        // event yet, so there's nothing meaningful to compare the
        // model's prediction against.
        if (p.about?.isComplete === false) continue;
        const eventType = r.eventType || "";
        if (NON_PA_EVENT_TYPES.has(eventType)) continue;

        const matchup = p.matchup || {};
        const batter = matchup.batter || {};
        const pitcher = matchup.pitcher || {};
        if (!batter.id || !pitcher.id) continue;

        const about = p.about || {};
        const finalCount = p.count || {};
        const score = r.awayScore != null && r.homeScore != null
            ? { away: r.awayScore, home: r.homeScore }
            : null;

        out.push({
            play_index: i,
            inning: about.inning,
            half: about.isTopInning ? "top" : "bottom",
            outs_after: finalCount.outs ?? null,
            score_after: score,
            batter: {
                id:   batter.id,
                name: batter.fullName,
                hand: matchup.batSide?.code || "R",
            },
            pitcher: {
                id:   pitcher.id,
                name: pitcher.fullName,
                hand: matchup.pitchHand?.code || "R",
            },
            outcome:       OUTCOME_MAP[eventType] || null,
            outcome_event: r.event || eventType || "?",
            description:   r.description || "",
            pitches: parsePitches(p.playEvents || []),
        });
    }
    // Most recent first — the gamecast scrolls top-down through "what
    // just happened" before older PAs.
    return out.reverse();
}

function parsePitches(playEvents) {
    const out = [];
    for (const e of playEvents) {
        if (e.type !== "pitch") continue;
        const det = e.details || {};
        out.push({
            number:      e.pitchNumber || null,
            type:        det.type?.description || "Unknown",
            type_code:   det.type?.code || null,
            velo:        e.pitchData?.startSpeed != null
                            ? Math.round(e.pitchData.startSpeed * 10) / 10
                            : null,
            result:      det.call?.description || det.description || "?",
            result_code: det.call?.code || null,
            count_after: e.count
                ? { balls: e.count.balls, strikes: e.count.strikes }
                : null,
        });
    }
    return out;
}
