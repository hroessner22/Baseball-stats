// /api/game/{id}/plays
//
// Parsed play-by-play for the Gamecast view. Each entry is one plate
// appearance with the full pitch sequence — pitch type, velocity,
// per-pitch result, and the resolved outcome — plus the batter/pitcher
// matchup so the client can pair this with /api/matchup to show
// "predicted before the PA vs. what actually happened".
//
// We also compute the WE swing each PA produced — the home team's
// win-probability change from the state BEFORE the PA to the state
// AFTER it. Computed by walking allPlays in MLB-feed order and
// tracking (inning, half, outs, bases, score) through each event,
// then looking the before/after state up in WE_TABLE_V2. Surfaced on
// each Gamecast PA card as "+3.4pp HOU" / "-1.2pp HOU".
//
// Cached 10 seconds at the edge, same as /api/game/{id}.

import { WE_TABLE_V2 } from "../../games/_we_table_v2.js";
import { WE_TABLE }    from "../../games/_we_table.js";

const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function lookupWE(inning, half, outs, bases, homeLead) {
    if (inning == null || !half) return null;
    const innC  = clip(inning, 1, 9);
    const leadC = clip(homeLead, -10, 10);
    const k2 = `${innC}|${half}|${outs}|${bases}|${leadC}`;
    if (WE_TABLE_V2[k2] !== undefined) return WE_TABLE_V2[k2];
    // Half-level fallback — covers states the v2 table doesn't index.
    if (half === "top" && inning === 1 && outs === 0 && bases === 0) return 0.54;
    const k1 = `${innC}|${half}|${leadC}`;
    if (WE_TABLE[k1] !== undefined) return WE_TABLE[k1];
    return null;
}

// Compute the bases bitmask from a play's runners[] array's END
// positions — what's on base AFTER the play resolves. 1=1B, 2=2B, 4=3B.
function basesAfterFromRunners(runners) {
    let mask = 0;
    for (const r of runners || []) {
        const end = r.movement?.end;
        if (end === "1B") mask |= 1;
        if (end === "2B") mask |= 2;
        if (end === "3B") mask |= 4;
    }
    return mask;
}

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

    if (gameId === "demo") {
        const { DEMO_PLAYS, DEMO_GAME } = await import("../_demo.js");
        const plays = DEMO_PLAYS.slice().reverse().map((p) => ({
            play_index: p.pi,
            inning: p.inning,
            half: p.half,
            outs_after: null,
            score_after: { away: p.away, home: p.home },
            batter:  { id: 0, name: p.batter,  hand: "?" },
            pitcher: { id: 0, name: p.pitcher, hand: "?" },
            outcome: p.outcome,
            outcome_event: p.event,
            description: p.description,
            pitches: p.pitches,
        }));
        return new Response(JSON.stringify({
            game_pk: "demo",
            teams: DEMO_GAME.teams,
            plays,
            fetched_at: new Date().toISOString(),
        }), {
            headers: {
                "content-type": "application/json",
                "cache-control": "no-store",
                "access-control-allow-origin": "*",
            },
        });
    }

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

    // First pass: walk every event (PA and non-PA) in feed order,
    // tracking (inning, half, outs, bases, scores) so each play has a
    // state BEFORE and state AFTER. The non-PA events (stolen bases,
    // wild pitches, etc.) still mutate state and matter for the next
    // PA's WE lookup — we just don't emit them as rows.
    const states = new Array(allPlays.length);
    let s = { inning: 1, half: "top", outs: 0, bases: 0, away: 0, home: 0 };
    for (let i = 0; i < allPlays.length; i++) {
        const p = allPlays[i];
        const r = p.result || {};
        const about = p.about || {};
        const inning = about.inning ?? s.inning;
        const half = about.isTopInning ? "top" : "bottom";

        // New half-inning: outs reset, bases clear, inning/half flip.
        if (inning !== s.inning || half !== s.half) {
            s = { inning, half, outs: 0, bases: 0, away: s.away, home: s.home };
        }
        states[i] = { before: { ...s } };

        // Apply this event's effect.
        if (r.awayScore != null) s.away = r.awayScore;
        if (r.homeScore != null) s.home = r.homeScore;
        s.bases = basesAfterFromRunners(p.runners);
        if (p.count?.outs != null) s.outs = p.count.outs;
        states[i].after = { ...s };
    }

    const out = [];
    for (let i = 0; i < allPlays.length; i++) {
        const p = allPlays[i];
        const r = p.result || {};
        const eventType = r.eventType || "";
        const about = p.about || {};

        // BASERUNNING EVENTS — stolen bases, wild pitches, passed
        // balls, balks, pickoffs, advances on errors. Emit as a
        // thin event row between PA blocks so the user can see
        // how a runner got into scoring position outside the
        // batter's PA. User direction (2026-06-04): 'If someone
        // steals, you need to add that in here, or advances on a
        // wild pitch etc.'
        if (NON_PA_EVENT_TYPES.has(eventType)) {
            const sb = states[i].before;
            const sa = states[i].after;
            const weBefore = lookupWE(sb.inning, sb.half, sb.outs, sb.bases, sb.home - sb.away);
            const weAfter  = lookupWE(sa.inning, sa.half, sa.outs, sa.bases, sa.home - sa.away);
            const weDelta  = (weBefore != null && weAfter != null) ? (weAfter - weBefore) : null;
            const runner = (p.runners || []).find((rn) => rn.details?.runner);
            out.push({
                play_index: i,
                type: "baserunning",
                event_type: eventType,
                event_label: r.event || prettifyEventType(eventType),
                inning: about.inning,
                half: about.isTopInning ? "top" : "bottom",
                description: r.description || "",
                runner_name: runner?.details?.runner?.fullName || null,
                runner_id:   runner?.details?.runner?.id || null,
                score_after: r.awayScore != null && r.homeScore != null
                    ? { away: r.awayScore, home: r.homeScore }
                    : null,
                we_delta_home: weDelta,
            });
            continue;
        }

        if (r.type !== "atBat") continue;

        // Baserunning events (stolen bases, wild pitches, passed balls,
        // balks, pickoffs, advances) come through the MLB feed as "action"
        // playEvents INSIDE the at-bat, not as separate top-level plays — so
        // the top-level eventType check above never sees them. Walk the
        // at-bat's playEvents and emit each as a thin "just say what happened"
        // row. (Runs before the in-progress skip so a steal shows live.)
        for (const e of (p.playEvents || [])) {
            const det = e.details || {};
            const et = det.eventType || "";
            // Baserunning only — skip "game_advisory" (status changes / mound
            // visits) which also live as action playEvents but aren't plays.
            if (e.type === "action" && et !== "game_advisory"
                && NON_PA_EVENT_TYPES.has(et) && det.description) {
                out.push({
                    play_index:    i,
                    type:          "baserunning",
                    event_type:    et,
                    event_label:   r.event && et === r.eventType ? r.event : prettifyEventType(et),
                    inning:        about.inning,
                    half:          about.isTopInning ? "top" : "bottom",
                    description:   det.description,
                    runner_name:   null,
                    runner_id:     null,
                    score_after:   null,
                    we_delta_home: null,
                });
            }
        }

        // Skip PAs still in progress — they don't have a resolved
        // event yet, so there's nothing meaningful to compare the
        // model's prediction against.
        if (p.about?.isComplete === false) continue;

        const matchup = p.matchup || {};
        const batter = matchup.batter || {};
        const pitcher = matchup.pitcher || {};
        if (!batter.id || !pitcher.id) continue;

        const finalCount = p.count || {};
        const score = r.awayScore != null && r.homeScore != null
            ? { away: r.awayScore, home: r.homeScore }
            : null;

        // WE swing from BEFORE the PA to AFTER. Home-team perspective —
        // positive = home gained ground, negative = away gained ground.
        const sb = states[i].before;
        const sa = states[i].after;
        const weBefore = lookupWE(sb.inning, sb.half, sb.outs, sb.bases, sb.home - sb.away);
        const weAfter  = lookupWE(sa.inning, sa.half, sa.outs, sa.bases, sa.home - sa.away);
        const weDelta  = (weBefore != null && weAfter != null) ? (weAfter - weBefore) : null;

        out.push({
            play_index: i,
            type: "PA",
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
            pitches:       parsePitches(p.playEvents || []),
            // Home-team WE before/after the PA and the swing it
            // produced. Null when the state isn't covered by the WE
            // table (extra innings, etc.).
            we_home_before: weBefore,
            we_home_after:  weAfter,
            we_delta_home:  weDelta,
        });
    }
    // Most recent first — the gamecast scrolls top-down through "what
    // just happened" before older PAs.
    return out.reverse();
}

// Map raw eventType (snake_case) to a short user-facing label
// when MLB's result.event isn't already set. Covers the
// non-PA event types we surface in the gamecast.
function prettifyEventType(t) {
    switch (t) {
        case "stolen_base_2b":       return "Stolen Base (2B)";
        case "stolen_base_3b":       return "Stolen Base (3B)";
        case "stolen_base_home":     return "Stolen Base (Home)";
        case "caught_stealing_2b":   return "Caught Stealing (2B)";
        case "caught_stealing_3b":   return "Caught Stealing (3B)";
        case "caught_stealing_home": return "Caught Stealing (Home)";
        case "pickoff_caught_stealing_2b":   return "Pickoff/CS (2B)";
        case "pickoff_caught_stealing_3b":   return "Pickoff/CS (3B)";
        case "pickoff_caught_stealing_home": return "Pickoff/CS (Home)";
        case "pickoff_1b":           return "Pickoff (1B)";
        case "pickoff_2b":           return "Pickoff (2B)";
        case "pickoff_3b":           return "Pickoff (3B)";
        case "wild_pitch":           return "Wild Pitch";
        case "passed_ball":          return "Passed Ball";
        case "balk":                 return "Balk";
        case "defensive_indiff":     return "Defensive Indifference";
        case "other_advance":        return "Runner Advance";
        case "runner_double_play":   return "Runner Double Play";
        case "runner_placed":        return "Runner Placed";
        case "game_advisory":        return "Game Advisory";
        case "ejection":             return "Ejection";
        default: return String(t || "").replace(/_/g, " ");
    }
}

function parsePitches(playEvents) {
    const out = [];
    for (const e of playEvents) {
        if (e.type !== "pitch") continue;
        const det = e.details || {};
        const result_code = det.call?.code || null;
        // X / D / E = ball in play. Statcast attaches hitData on those.
        const isBip = result_code === "X" || result_code === "D" || result_code === "E";
        const hd = isBip ? (e.hitData || null) : null;
        out.push({
            number:      e.pitchNumber || null,
            type:        det.type?.description || "Unknown",
            type_code:   det.type?.code || null,
            velo:        e.pitchData?.startSpeed != null
                            ? Math.round(e.pitchData.startSpeed * 10) / 10
                            : null,
            result:      det.call?.description || det.description || "?",
            result_code,
            count_after: e.count
                ? { balls: e.count.balls, strikes: e.count.strikes }
                : null,
            // Pitch location for the strike-zone plot (matches game/[id].js).
            px:     e.pitchData?.coordinates?.pX != null ? Math.round(e.pitchData.coordinates.pX * 100) / 100 : null,
            pz:     e.pitchData?.coordinates?.pZ != null ? Math.round(e.pitchData.coordinates.pZ * 100) / 100 : null,
            sz_top: e.pitchData?.strikeZoneTop != null ? Math.round(e.pitchData.strikeZoneTop * 100) / 100 : null,
            sz_bot: e.pitchData?.strikeZoneBottom != null ? Math.round(e.pitchData.strikeZoneBottom * 100) / 100 : null,
            zone:   e.pitchData?.zone ?? null,
            // Statcast hit data — exit velo, distance, launch angle.
            // Matches the shape in shapePitchEvent() over in
            // game/[id].js so renderPitchRow() handles both.
            hit: hd ? {
                exit_velo:    hd.launchSpeed != null ? Math.round(hd.launchSpeed * 10) / 10 : null,
                distance:     hd.totalDistance != null ? Math.round(hd.totalDistance) : null,
                launch_angle: hd.launchAngle != null ? Math.round(hd.launchAngle) : null,
                trajectory:   hd.trajectory || null,
                coord_x:      hd.coordinates?.coordX ?? null,
                coord_y:      hd.coordinates?.coordY ?? null,
            } : null,
        });
    }
    return out;
}
