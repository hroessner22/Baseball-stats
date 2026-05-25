// /api/game/{id}/we-trace
//
// Win-expectancy trajectory over the course of one game. Per-PA points:
// one circle on the chart for every completed plate appearance, with
// the pre-PA situation (inning, outs, runners on, score, batter,
// pitcher) attached so the tooltip can say what was happening when the
// curve moved.
//
// Granularity: per plate appearance. Per-PITCH WE would be the next
// step up (each ball/strike nudges WE within a PA via count leverage);
// that needs the pitches↔at_bats join from docs/04-ROADMAP.md.
//
// The WE value on each point is the POST-PA win probability — i.e. the
// home team's empirical chance of winning given the state the next
// batter walks up to. The pre-PA situation in the payload is the state
// going INTO this PA. Reading a point's tooltip you see "Judge came up
// with 2 on, 1 out, NYY down 1" → the chart marker IS where WE landed
// after Judge's PA resolved.

import { WE_TABLE     } from "../../games/_we_table.js";
import { WE_TABLE_V2  } from "../../games/_we_table_v2.js";

const PRE_GAME_HOME_WP = 0.54; // MLB historical home-field advantage
const INNING_CLIP = [1, 9];
const LEAD_CLIP   = [-10, 10];

const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function previousHalfState(inning, half) {
    if (half === "top") {
        if (inning === 1) return null;
        return { inning: inning - 1, half: "bottom" };
    }
    return { inning, half: "top" };
}

// Per-PA WE lookup. Prefers the v2 table (which carries outs + bases +
// home_lead, the full PA-state space) and falls back to v1 (score-diff
// only, half-inning resolution) for states v2 doesn't cover.
function lookupWE(inning, half, outs, bases, homeLead, status) {
    const innC  = clip(inning, INNING_CLIP[0], INNING_CLIP[1]);
    const leadC = clip(homeLead, LEAD_CLIP[0], LEAD_CLIP[1]);
    const k2 = `${innC}|${half}|${outs}|${bases}|${leadC}`;
    if (WE_TABLE_V2[k2] !== undefined) return WE_TABLE_V2[k2];

    // v1 fallback — keyed by half-end state (inning, half, lead). The
    // "state going into the next half" approximation: use the previous
    // half-end's WE as a proxy when v2 doesn't have this exact mid-PA cell.
    const prev = previousHalfState(innC, half);
    if (prev) {
        const k1 = `${prev.inning}|${prev.half}|${leadC}`;
        if (WE_TABLE[k1] !== undefined) return WE_TABLE[k1];
    }
    const k1Direct = `${innC}|${half}|${leadC}`;
    if (WE_TABLE[k1Direct] !== undefined) return WE_TABLE[k1Direct];
    return null;
}

export async function onRequest(context) {
    const gameId = context.params?.id;

    if (gameId === "demo") {
        const { DEMO_TRACE_RAW } = await import("../_demo.js");
        // Demo carries only per-half summaries (it predates the per-PA
        // trace). Inflate each summary into a single "point" with no
        // runners / outs / batter info — same shape the per-PA path
        // emits below, but with the situational fields left null.
        const points = [
            { i: 0, inning: 0, half: "pre", outs: 0, bases: 0,
              away: 0, home: 0, we: PRE_GAME_HOME_WP,
              batter: null, batter_id: null,
              pitcher: null, pitcher_id: null,
              event: "Game start", description: "First pitch." },
        ];
        for (const [idx, e] of DEMO_TRACE_RAW.entries()) {
            const diff = e.home - e.away;
            const we = lookupWE(e.inning, e.half, 0, 0, diff, "Live");
            points.push({
                i: idx + 1,
                inning: e.inning, half: e.half,
                outs: 0, bases: 0,
                away: e.away, home: e.home,
                we,
                batter: null, batter_id: null,
                pitcher: null, pitcher_id: null,
                event: e.event,
                description: e.description,
            });
        }
        markBiggestSwing(points);
        return jsonResponse({
            game_pk: "demo",
            status: "Live",
            points,
            fetched_at: new Date().toISOString(),
        }, 0);
    }

    if (!gameId || !/^\d+$/.test(gameId)) {
        return jsonError(400, "invalid game id");
    }
    const url = `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;
    let upstream;
    try {
        upstream = await fetch(url, {
            headers: {
                "User-Agent": "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)",
            },
            cf: { cacheTtl: 30, cacheEverything: true },
        });
    } catch (e) {
        return jsonError(502, `upstream fetch failed: ${e.message || e}`);
    }
    if (!upstream.ok) return jsonError(502, `upstream HTTP ${upstream.status}`);

    const data = await upstream.json();
    const status = data?.gameData?.status?.abstractGameState || "Unknown";
    const allPlays = data?.liveData?.plays?.allPlays || [];

    const points = buildTrace(allPlays, status);

    return jsonResponse({
        game_pk: parseInt(gameId, 10),
        status,
        points,
        fetched_at: new Date().toISOString(),
    }, 30);
}

function buildTrace(allPlays, status) {
    // Pre-game seed: home-field advantage, no runners, no score.
    const points = [{
        i: 0,
        inning: 0, half: "pre",
        outs: 0, bases: 0,
        away: 0, home: 0,
        we: PRE_GAME_HOME_WP,
        batter: null, batter_id: null,
        pitcher: null, pitcher_id: null,
        event: "Game start",
        description: "First pitch.",
    }];

    // We carry score across PAs (the MLB feed gives post-PA scores on
    // each play). Outs and bases reset at the half-flip; we infer pre-PA
    // outs/bases from the play's own state (count.outs is the count
    // showing during the PA, which is the pre-PA outs; pre-PA runners
    // come from matchup.preOn{First,Second,Third}).
    let homeScore = 0;
    let awayScore = 0;
    let lastInning = null;
    let lastHalf   = null;

    for (const p of allPlays) {
        if (p.about?.isComplete === false) continue;
        if (p.result?.type !== "atBat") continue;  // skip pickoffs, mound visits, etc.

        const inning = p.about?.inning;
        if (!inning) continue;
        const half = p.about?.isTopInning ? "top" : "bottom";

        // Detect half-flip — purely for the rendering layer to potentially
        // hint (we don't draw anything different, but it's useful context).
        const flipped = (inning !== lastInning) || (half !== lastHalf);
        lastInning = inning; lastHalf = half;

        // Pre-PA state — what the batter walked into.
        const preOuts = p.count?.outs ?? 0;
        const preBases =
            ((p.matchup?.preOnFirst  ? 1 : 0)) |
            ((p.matchup?.preOnSecond ? 2 : 0)) |
            ((p.matchup?.preOnThird  ? 4 : 0));
        const preAway = awayScore;
        const preHome = homeScore;

        // Post-PA scores from the feed.
        const postAway = p.result?.awayScore ?? awayScore;
        const postHome = p.result?.homeScore ?? homeScore;
        awayScore = postAway;
        homeScore = postHome;

        // WE looked up at the POST-PA state — what the next batter
        // walks into. For a 3-out PA we'd want the state at the start of
        // the next half (0 outs, 0 bases, half flipped); rather than
        // compute that here, fall back to the v1 lookup which keys on
        // (inning, half, home_lead) — close enough for the half-end case.
        const postOuts =
            (typeof p.count?.outs === "number" && p.about?.hasOut)
                // p.count.outs at end of PA includes the out the PA created;
                // hasOut is true if THIS PA generated an out. MLB feed shape:
                // count.outs after the play. We use it as-is.
                ? p.count.outs
                : preOuts;
        const postBases =
            ((p.matchup?.postOnFirst  ? 1 : 0)) |
            ((p.matchup?.postOnSecond ? 2 : 0)) |
            ((p.matchup?.postOnThird  ? 4 : 0));

        let lookupOuts = postOuts;
        let lookupBases = postBases;
        let lookupHalf  = half;
        let lookupInn   = inning;
        if (postOuts >= 3) {
            // Half just ended — next state is start of next half, no
            // outs, no runners. v1 lookup handles this cleanly via the
            // previousHalfState fallback inside lookupWE.
            lookupOuts = 0;
            lookupBases = 0;
            if (half === "bottom") { lookupHalf = "top"; lookupInn = inning + 1; }
            else                   { lookupHalf = "bottom"; }
        }
        const we = lookupWE(
            lookupInn, lookupHalf, lookupOuts, lookupBases,
            postHome - postAway, status,
        );

        points.push({
            i: points.length,
            inning, half,
            outs: preOuts, bases: preBases,
            away: postAway, home: postHome,
            we,
            batter:    p.matchup?.batter?.fullName  || null,
            batter_id: p.matchup?.batter?.id        || null,
            pitcher:   p.matchup?.pitcher?.fullName || null,
            pitcher_id:p.matchup?.pitcher?.id       || null,
            event:       p.result?.event       || p.result?.eventType || null,
            description: p.result?.description || null,
            half_flipped: flipped || undefined,
        });
    }

    // For a Final game, force the last point to the certain outcome.
    if (status === "Final" && points.length > 1) {
        const last = points[points.length - 1];
        if (last.home > last.away) last.we = 1;
        else if (last.home < last.away) last.we = 0;
    }

    markBiggestSwing(points);
    return points;
}

function markBiggestSwing(points) {
    // Compute the per-PA WE delta on every point (post-PA WE minus the
    // previous post-PA WE — i.e. how much THIS PA moved the home win
    // probability). Used by the trace tooltip's small +/- chip so every
    // marker can show its individual impact, not just the biggest one.
    let biggestIdx = -1;
    let biggestAbsDelta = 0;
    for (let i = 1; i < points.length; i++) {
        const cur  = points[i].we;
        const prev = points[i - 1].we;
        if (cur == null || prev == null) continue;
        const d = cur - prev;
        points[i].we_delta = d;
        const ad = Math.abs(d);
        if (ad > biggestAbsDelta) { biggestAbsDelta = ad; biggestIdx = i; }
    }
    if (biggestIdx >= 0) {
        points[biggestIdx].biggest_swing = true;
    }
}

function jsonResponse(body, maxAge) {
    return new Response(JSON.stringify(body), {
        headers: {
            "content-type": "application/json",
            "cache-control": maxAge > 0
                ? `public, max-age=${maxAge}`
                : "no-store",
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
