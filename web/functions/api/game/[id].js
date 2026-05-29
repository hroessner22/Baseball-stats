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
function lookupWE(inning, half, outs, bases, homeLead) {
    const innC  = clip(inning, 1, 9);
    const leadC = clip(homeLead, -10, 10);
    const k2 = `${innC}|${half}|${outs}|${bases}|${leadC}`;
    if (WE_TABLE_V2[k2] !== undefined) return WE_TABLE_V2[k2];
    const prev = previousHalfState(innC, half);
    if (prev) {
        const k1 = `${Math.min(prev.inning, 9)}|${prev.half}|${homeLead}`;
        if (WE_TABLE[k1] !== undefined) return WE_TABLE[k1];
    }
    return null;
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
            }))
        : [];

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

function teamFields(t) {
    if (!t) return { id: null, name: "?", abbr: "?" };
    return {
        id: t.id,
        name: t.teamName || t.name || "?",
        abbr: t.abbreviation ||
              (t.teamName || t.name || "??").slice(0, 3).toUpperCase(),
    };
}
