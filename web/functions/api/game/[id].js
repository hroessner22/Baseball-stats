// /api/game/{id}
//
// Detailed live state for one game — current matchup (batter + pitcher),
// runners on base with names, count, outs, score, and win expectancy.
// Proxies the MLB Stats API live-feed endpoint and reshapes it into the
// minimal shape the Game view needs.

import { WE_TABLE } from "../games/_we_table.js";
import { WE_TABLE_V2 } from "../games/_we_table_v2.js";
import { DEMO_GAME } from "./_demo.js";
import { fetchTeamStrength, teamStrengthAdjustment } from "../_team_strength.js";

const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// PA-state win probability for the home team. Tries the new v2 table
// (15M-PA aggregation keyed by inning, half, outs, bases, home_lead)
// first; falls back to the half-level table if v2 has a hole.
//
// For leads beyond ±10 (e.g. LAA 14, TB 3 → home_lead = -11), the
// raw lookup returns the lead-10 probability, which left a trailing
// team like Tampa Bay at ~5% in the bottom of the 9th despite
// needing 11 runs with 2 outs left. Dampen the trailing team's
// share by 0.25 per extra run beyond the clip — calibrated so a
// 12-run lead → trailing WP × 0.0625, a 15-run lead → essentially 0.
const DAMPEN_PER_RUN = 0.25;
const HARD_FLOOR_TRAILING = 0.0001;
function lookupWE(inning, half, outs, bases, homeLead) {
    const innC  = clip(inning, 1, 9);
    const leadC = clip(homeLead, -10, 10);
    const k2 = `${innC}|${half}|${outs}|${bases}|${leadC}`;
    let wpHome = WE_TABLE_V2[k2];
    // Fallback 1: V1 table at the previous half-state.
    if (wpHome === undefined) {
        const prev = previousHalfState(innC, half);
        if (prev) {
            const k1 = `${Math.min(prev.inning, 9)}|${prev.half}|${homeLead}`;
            wpHome = WE_TABLE[k1];
        }
    }
    // Fallback 2: V1 table at the CURRENT half (no previousHalf shift).
    if (wpHome === undefined) {
        const k1 = `${innC}|${half}|${leadC}`;
        wpHome = WE_TABLE[k1];
    }
    // Fallback 3 (2026-06-09): Bayesian smoothed estimate from lead +
    // inning progress. User direction: 'We have a great algorithm for
    // WE and youre not using it.' The bot's ML scan blocks when this
    // returns null. Returning a sensible estimate covers the rare
    // states the table misses, so ML can scan every live game.
    if (wpHome === undefined) {
        const inningProgress = innC + (half === "bottom" ? 0.5 : 0);
        const perRunWeight = 0.035 + 0.005 * inningProgress;
        let est = 0.5 + leadC * perRunWeight;
        const basesLift = bases > 0 ? 0.02 : 0;
        est = Math.max(0.02, Math.min(0.98, est + basesLift));
        wpHome = est;
    }
    const excess = Math.abs(homeLead) - 10;
    if (excess > 0) {
        const dampen = Math.pow(DAMPEN_PER_RUN, excess);
        if (homeLead > 10) {
            let awayWP = (1 - wpHome) * dampen;
            if (awayWP < HARD_FLOOR_TRAILING) awayWP = HARD_FLOOR_TRAILING;
            wpHome = 1 - awayWP;
        } else {
            wpHome = wpHome * dampen;
            if (wpHome < HARD_FLOOR_TRAILING) wpHome = HARD_FLOOR_TRAILING;
        }
    }
    return wpHome;
}

function previousHalfState(inning, half) {
    if (half === "top") {
        if (inning === 1) return null;
        return { inning: inning - 1, half: "bottom" };
    }
    return { inning, half: "top" };
}

export async function onRequest(context) {
    const gameId = context.params?.id;

    // Synthetic high-leverage scenario for testing the live-only UI
    // without waiting for a real game to roll around. Reachable at
    // #game/demo from the footer.
    if (gameId === "demo") {
        const g = { ...DEMO_GAME };
        const basesMask =
            (g.runners?.first  ? 1 : 0) |
            (g.runners?.second ? 2 : 0) |
            (g.runners?.third  ? 4 : 0);
        g.win_expectancy = lookupWE(
            g.inning, g.half, g.outs, basesMask,
            g.score.home - g.score.away
        );
        return new Response(JSON.stringify(g), {
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

    const url = `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;
    let upstream;
    try {
        upstream = await fetch(url, {
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
    // Compute team-strength adjustment in parallel with shaping the
    // game payload. Adjustment is added to every state-based WE
    // lookup so the headline (and the projected/forecast endpoints
    // that derive from it) reflect that not all teams are equally
    // capable. Empty/missing strength data falls back to no shift.
    const homeId = data?.gameData?.teams?.home?.id;
    const awayId = data?.gameData?.teams?.away?.id;
    const season = data?.gameData?.game?.season ||
                   new Date().getUTCFullYear();
    const [homeStr, awayStr] = await Promise.all([
        fetchTeamStrength(homeId, season),
        fetchTeamStrength(awayId, season),
    ]);
    const teamAdj = teamStrengthAdjustment(homeStr, awayStr);

    return new Response(JSON.stringify(buildGame(data, teamAdj)), {
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

function buildGame(d, teamAdj) {
    const gameData = d.gameData || {};
    const liveData = d.liveData || {};
    const linescore = liveData.linescore || {};
    const currentPlay = liveData.plays?.currentPlay || {};
    const matchup = currentPlay.matchup || {};

    const status = gameData.status?.abstractGameState || "Unknown";
    const detail = gameData.status?.detailedState || "";

    const inning = linescore.currentInning ?? null;
    const half = inning ? (linescore.isTopInning ? "top" : "bottom") : null;
    const outs = linescore.outs ?? 0;
    const balls = linescore.balls ?? 0;
    const strikes = linescore.strikes ?? 0;

    const awayScore = linescore.teams?.away?.runs ?? 0;
    const homeScore = linescore.teams?.home?.runs ?? 0;

    const offense = linescore.offense || {};
    const runners = {
        first: offense.first?.fullName || null,
        second: offense.second?.fullName || null,
        third: offense.third?.fullName || null,
    };

    const batter = matchup.batter ? {
        id: matchup.batter.id,
        name: matchup.batter.fullName,
        bats: matchup.batSide?.code || null,
    } : null;
    const pitcher = matchup.pitcher ? {
        id: matchup.pitcher.id,
        name: matchup.pitcher.fullName,
        throws: matchup.pitchHand?.code || null,
    } : null;

    let winExp = null;
    let stateWE = null;        // state-only (no team adjustment); kept
                               //   alongside so the UI can show both
    if (status === "Live" && inning && half) {
        // PA-state lookup via the v2 table (15M-PA aggregation that
        // includes outs and bases). With this, "bottom 9th, bases
        // loaded, 1 out, home down 1" returns ~54% — what history
        // actually says — instead of the half-level table's 0%.
        const basesMask =
            (offense.first  ? 1 : 0) |
            (offense.second ? 2 : 0) |
            (offense.third  ? 4 : 0);
        stateWE = lookupWE(inning, half, outs, basesMask, homeScore - awayScore);
        if (stateWE === null && inning === 1 && half === "top") {
            stateWE = 0.54;
        }
        // Apply team-strength adjustment: same delta (pregame_we - 0.54)
        // added to every state lookup in this game. Clipped to [0.01, 0.99]
        // so a team-quality megablob can't push WE outside the legal range.
        if (stateWE !== null && teamAdj?.delta_from_baseline != null) {
            winExp = Math.max(0.01, Math.min(0.99,
                stateWE + teamAdj.delta_from_baseline));
        } else {
            winExp = stateWE;
        }
    } else if (status === "Final") {
        winExp = homeScore > awayScore ? 1.0 :
                 homeScore < awayScore ? 0.0 : 0.5;
        stateWE = winExp;
    }

    // This-inning play-by-play strip — every completed PA in the
    // current half-inning, oldest first. Drives the "10TH SO FAR"
    // summary on the Live View so the user can see how the current
    // frame unfolded without leaving the main game pane.
    const allPlays = liveData.plays?.allPlays || [];
    const thisInningPlays = inning && half
        ? allPlays
            .filter((p) =>
                p.about?.isComplete &&
                p.about?.inning === inning &&
                (p.about?.isTopInning ? "top" : "bottom") === half
            )
            .map((p) => ({
                pa_index:    p.about?.atBatIndex ?? null,
                batter:      p.matchup?.batter?.fullName || null,
                batter_id:   p.matchup?.batter?.id || null,
                pitcher_id:  p.matchup?.pitcher?.id || null,
                event:       p.result?.event || null,
                eventType:   p.result?.eventType || null,
                description: p.result?.description || null,
                away_score:  p.result?.awayScore ?? 0,
                home_score:  p.result?.homeScore ?? 0,
                pitches: (p.playEvents || [])
                    .filter((e) => e.type === "pitch")
                    .map(shapePitchEvent),
            }))
        : [];

    // Pitch sequence for the IN-PROGRESS PA — same shape the Gamecast
    // uses for completed PAs.
    const currentPitches = (currentPlay.playEvents || [])
        .filter((e) => e.type === "pitch")
        .map(shapePitchEvent);

    return {
        game_pk: gameData.game?.pk,
        status,
        detail,
        teams: {
            away: teamFields(gameData.teams?.away),
            home: teamFields(gameData.teams?.home),
        },
        score: { away: awayScore, home: homeScore },
        inning, half, outs, balls, strikes,
        runners,
        batter, pitcher,
        current_pitches: currentPitches,
        // win_expectancy = state-based + team-strength adjustment.
        // state_we is the raw "average teams" empirical lookup, kept
        // alongside so the UI can show "AZ 53% (+3pp from team form)".
        win_expectancy: winExp,
        state_we: stateWE,
        team_adjustment: teamAdj ? {
            pregame_we:           teamAdj.pregame_we,
            delta_from_baseline:  teamAdj.delta_from_baseline,
            home: teamAdj.home ? compactTeamStrength(teamAdj.home) : null,
            away: teamAdj.away ? compactTeamStrength(teamAdj.away) : null,
        } : null,
        venue: gameData.venue?.name || null,
        venue_id: gameData.venue?.id ?? null,    // for stadium-specific field rendering
        start_time: gameData.datetime?.dateTime || null,
        this_inning: thisInningPlays,
    };
}

// Trim a team-strength object down to what the UI actually renders —
// drops a few derivation-only fields to keep the API response tight.
function compactTeamStrength(s) {
    return {
        season_w:        s.season_w,
        season_l:        s.season_l,
        season_pct:      s.season_pct,
        pyth_pct:        s.pyth_pct,
        run_differential:s.run_differential,
        l10:             s.l10,
        l15:             s.l15,
        l30:             s.l30,
        streak:          s.streak,
        combined_pct:    s.combined_pct,
    };
}

// Single source of truth for shaping a Statcast pitch event into the
// payload the frontend pitch row renders. Used by both current_pitches
// and the per-PA pitches array. Hit data is attached ONLY when the
// pitch was put in play — Statcast reports exit velocity, distance,
// and launch angle on those events; everything else gets null.
function shapePitchEvent(e) {
    const result_code = e.details?.call?.code || null;
    // 'X' = in play (out), 'D' = in play (run-scoring out / hit),
    // 'E' = in play (error). Statcast attaches hitData on all three.
    const isBip = result_code === "X" || result_code === "D" || result_code === "E";
    const hd = isBip ? (e.hitData || null) : null;
    return {
        number:      e.pitchNumber || null,
        type:        e.details?.type?.description || "Unknown",
        type_code:   e.details?.type?.code || null,
        velo:        e.pitchData?.startSpeed != null
            ? Math.round(e.pitchData.startSpeed * 10) / 10
            : null,
        result:      e.details?.call?.description || e.details?.description || "?",
        result_code,
        count_after: e.count
            ? { balls: e.count.balls, strikes: e.count.strikes }
            : null,
        // Statcast hit data — exit velo (mph), distance (ft), launch
        // angle (deg), trajectory ('fly_ball', 'ground_ball', etc).
        hit: hd ? {
            exit_velo:    hd.launchSpeed != null ? Math.round(hd.launchSpeed * 10) / 10 : null,
            distance:     hd.totalDistance != null ? Math.round(hd.totalDistance) : null,
            launch_angle: hd.launchAngle != null ? Math.round(hd.launchAngle) : null,
            trajectory:   hd.trajectory || null,
        } : null,
    };
}

function teamFields(t) {
    if (!t) return { id: null, name: "?", abbr: "?" };
    return {
        id: t.id,
        name: t.teamName || t.name || "?",
        abbr: t.abbreviation ||
              (t.teamName || t.name || "??").slice(0, 3).toUpperCase(),
    };
}
