// /api/game/{id}/we-projected
//
// "What's the WE going to look like AFTER this PA, given who's on the
// mound vs. who's at the plate?" — the last unbuilt piece of the
// per-pitch WE chunk (the pitcher-quality blend).
//
// For each of the 9 outcome buckets (K, BB, HBP, 1B, 2B, 3B, HR, OUT,
// OTHER), we compute the next game state and look up its WE in the v2
// table. The weighted sum (using the matchup engine's predicted
// distribution) is the expected post-PA win probability. The
// difference from the current-state WE is the leverage of the PA.
//
// Useful as both:
//   - a "projected WE after this PA" indicator (where the curve is
//     headed if the matchup unfolds as predicted)
//   - a leverage number ("this PA can swing the game ±X%")

import { WE_TABLE_V2 } from "../../games/_we_table_v2.js";

const OUTCOMES = ["K", "BB", "HBP", "1B", "2B", "3B", "HR", "OUT", "OTHER"];
const HALF_FLIP = { top: "bottom", bottom: "top" };

const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const popcount = (n) =>
    ((n >> 0) & 1) + ((n >> 1) & 1) + ((n >> 2) & 1);

function lookupWE(inning, half, outs, bases, homeLead) {
    const innC  = clip(inning, 1, 9);
    const leadC = clip(homeLead, -10, 10);
    const k = `${innC}|${half}|${outs}|${bases}|${leadC}`;
    if (WE_TABLE_V2[k] !== undefined) return WE_TABLE_V2[k];
    return null;
}

// Map (current state, outcome) → next state. Approximations are honest
// about being approximations; the alternative is per-outcome runner-
// advancement tables we don't have. For singles/doubles we move every
// runner the conventional N bases.
function postPAState(state, outcome) {
    let { inning, half, outs, bases, home_lead, batting_team } = state;
    const on1 = (bases & 1) !== 0;
    const on2 = (bases & 2) !== 0;
    const on3 = (bases & 4) !== 0;
    let runs = 0;
    let new_bases = bases;
    let outsChange = 0;

    switch (outcome) {
        case "K":
        case "OUT":
        case "OTHER":
            // Treat "OUT" and "OTHER" as +1 out, runners hold. OTHER
            // covers reach-on-error / fielder's choice / interference —
            // not worth modeling base advancement for the small probability.
            // (Note: sac flies aren't separately modeled either, which
            // under-counts runs scored on OUTs with a runner on 3rd and
            // <2 outs. Real-world impact is small but worth knowing.)
            outsChange = 1;
            break;

        case "BB":
        case "HBP":
            // Force play. Walk the chain only if 1st is occupied.
            new_bases = 1; // batter to 1st
            if (on1) {
                new_bases |= 2;          // 1st → 2nd
                if (on2) {
                    new_bases |= 4;      // 2nd → 3rd
                    if (on3) runs = 1;   // 3rd → home (bases were loaded)
                }
            }
            // Runners not forced just stay put.
            if (!on1) {
                if (on2) new_bases |= 2;
                if (on3) new_bases |= 4;
            }
            break;

        case "1B":
            // Singles in real baseball score the runner from 3rd always
            // and the runner from 2nd about 60% of the time — the
            // textbook "every runner advances one base" rule was too
            // conservative and made walk-off scenarios under-project the
            // WE swing. Compromise: 3rd and 2nd both score, 1st takes
            // 2nd. (Slight over-projection on infield singles; closer
            // to truth than the strict-1-base rule.)
            new_bases = 1;             // batter to 1st
            if (on1) new_bases |= 2;   // 1st → 2nd
            if (on2) runs += 1;        // 2nd → home
            if (on3) runs += 1;        // 3rd → home
            break;

        case "2B":
            // Batter to 2nd; runners advance two bases.
            new_bases = 2;
            if (on1) new_bases |= 4;   // 1st → 3rd
            if (on2) runs += 1;        // 2nd → home
            if (on3) runs += 1;        // 3rd → home
            break;

        case "3B":
            // Batter to 3rd; all runners score.
            new_bases = 4;
            runs += popcount(bases);
            break;

        case "HR":
            new_bases = 0;
            runs += popcount(bases) + 1;
            break;
    }

    // Apply the run delta to the home_lead first so walk-off checks
    // see the post-PA score.
    if (batting_team === "home") home_lead += runs;
    else                         home_lead -= runs;

    // Walk-off: home took the lead in the bottom of the 9th or later.
    // The game ends as soon as the run scores; no need to apply outs or
    // advance state. WE collapses to a certain 1.0.
    if (inning >= 9 && half === "bottom" && home_lead > 0) {
        return {
            inning, half, outs: outs + outsChange, bases: new_bases,
            home_lead, batting_team, terminal: 1.0,
        };
    }

    // Apply outs and roll the inning if the PA closed the half.
    outs += outsChange;
    if (outs >= 3) {
        // Bottom-of-late-inning 3rd out with home still trailing →
        // home loses. Game over. WE = 0.
        if (inning >= 9 && half === "bottom" && home_lead < 0) {
            return {
                inning, half, outs: 3, bases: new_bases,
                home_lead, batting_team, terminal: 0.0,
            };
        }
        // Top-of-late-inning 3rd out with home already leading → home
        // doesn't need to bat; game over with home as winner. WE = 1.
        if (inning >= 9 && half === "top" && home_lead > 0) {
            return {
                inning, half, outs: 3, bases: new_bases,
                home_lead, batting_team, terminal: 1.0,
            };
        }
        // Otherwise: normal half-flip / inning advance. Since MLB's
        // 2020 rule change, the 10th+ inning starts with a runner on
        // 2nd (the "ghost runner" / "Manfred man") — set bases = 2
        // when flipping into extras so projections from this state
        // forward read the correct WE.
        if (half === "bottom") inning += 1;
        half = HALF_FLIP[half];
        outs = 0;
        new_bases = inning >= 10 ? 2 : 0;
    }

    return { inning, half, outs, bases: new_bases, home_lead, batting_team };
}

export async function onRequest(context) {
    const env = context.env || {};
    const gameId = context.params?.id;
    // Allow "demo" through alongside numeric MLBAM game_pks so the
    // synthetic scenario gets the same matchup-blended projection.
    if (!gameId || (gameId !== "demo" && !/^\d+$/.test(gameId))) {
        return jsonError(400, "invalid game id");
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return jsonError(500, "supabase not configured");
    }

    // Pull current state from our own /api/game/{id} (already shapes
    // exactly what we need + applies our WE lookup).
    const origin = new URL(context.request.url).origin;
    let game;
    try {
        const res = await fetch(`${origin}/api/game/${gameId}`);
        if (!res.ok) throw new Error(`game HTTP ${res.status}`);
        game = await res.json();
    } catch (e) {
        return jsonError(502, `failed to load game: ${e.message || e}`);
    }

    if (game.status !== "Live" || !game.batter?.id || !game.pitcher?.id) {
        // Pre-game / final / between batters — projection is meaningless.
        return jsonResponse({
            game_pk: parseInt(gameId, 10),
            available: false,
            reason: "no live PA in progress",
            current_we: game.win_expectancy ?? null,
        }, 30);
    }

    // Get the predicted outcome distribution from the matchup engine.
    // Pass the live count so the matchup engine returns count-aware
    // rates when sample allows (PR #58 — batter on 3-0 vs 0-2 returns
    // very different distributions). Since projected WE = sum_o
    // predicted[o] × post_PA_WE(state, o), the projection becomes
    // count-aware automatically — same math, count-shifted weights.
    let matchup;
    try {
        const countQuery = (game.balls != null && game.strikes != null)
            ? `&balls=${game.balls}&strikes=${game.strikes}`
            : "";
        const res = await fetch(
            `${origin}/api/matchup?batter=${game.batter.id}&pitcher=${game.pitcher.id}${countQuery}`
        );
        if (!res.ok) throw new Error(`matchup HTTP ${res.status}`);
        matchup = await res.json();
    } catch (e) {
        return jsonError(502, `failed to load matchup: ${e.message || e}`);
    }
    if (!matchup.available) {
        return jsonResponse({
            game_pk: parseInt(gameId, 10),
            available: false,
            reason: matchup.reason || "matchup unavailable",
            current_we: game.win_expectancy ?? null,
        }, 30);
    }

    const currentState = {
        inning:    game.inning,
        half:      game.half,
        outs:      game.outs ?? 0,
        bases:
            ((game.runners?.first  ? 1 : 0)) |
            ((game.runners?.second ? 2 : 0)) |
            ((game.runners?.third  ? 4 : 0)),
        home_lead: (game.score?.home ?? 0) - (game.score?.away ?? 0),
        batting_team: game.half === "bottom" ? "home" : "away",
    };

    // Team-strength adjustment carried over from /api/game/{id} so
    // the projected WE shifts by the same delta as the headline WE.
    // Without this, the projected number would silently drift back
    // toward the "average teams" baseline even when the headline says
    // "AZ +3pp from team form."
    const teamDelta = game.team_adjustment?.delta_from_baseline || 0;
    const applyDelta = (we) =>
        we === null ? null : Math.max(0.01, Math.min(0.99, we + teamDelta));

    // For each outcome, compute the post-PA state and its WE. Walk-off
    // and game-end states get their WE from the terminal flag (1.0 or
    // 0.0) rather than the lookup table — those states don't exist in
    // at_bats data (the game ended, no more PAs are recorded) so the
    // table would return null and the projection would silently drop
    // walk-off outcomes from the weighted sum.
    const perOutcome = {};
    let projected = 0;
    let weightSum = 0;
    for (const o of OUTCOMES) {
        const p = matchup.predicted?.[o] ?? 0;
        if (p === 0) continue;
        const post = postPAState(currentState, o);
        // Terminal (game-ending) outcomes don't get the team adjustment
        // because the game is over — there's no "what's home's chance
        // from here" to shift, just 1.0 / 0.0 for the final result.
        const we = post.terminal !== undefined
            ? post.terminal
            : applyDelta(lookupWE(post.inning, post.half, post.outs, post.bases, post.home_lead));
        if (we === null) continue;
        perOutcome[o] = { probability: p, post_we: we };
        projected += p * we;
        weightSum += p;
    }
    if (weightSum > 0) projected /= weightSum;

    const currentWE = game.win_expectancy ?? null;
    const leverage = currentWE !== null
        ? Math.abs(projected - currentWE)
        : null;

    // Best- and worst-case post-PA WE for the home team (helps the UI
    // show a "WE could land between X and Y after this PA" range).
    const entries = Object.entries(perOutcome);
    let bestHome = currentWE, worstHome = currentWE;
    let bestOutcome = null, worstOutcome = null;
    for (const [o, { post_we }] of entries) {
        if (bestHome  === null || post_we > bestHome)  { bestHome  = post_we; bestOutcome  = o; }
        if (worstHome === null || post_we < worstHome) { worstHome = post_we; worstOutcome = o; }
    }

    // When the matchup engine ran in count-aware mode, the projection
    // is per-pitch (refreshes every count change) rather than per-PA.
    // Drop the cache TTL so the frontend's 5s game poll always reaches
    // a fresh response for the live count.
    const countAware = matchup.count_aware === true;
    const cacheSeconds = gameId === "demo" ? 0 : (countAware ? 3 : 10);

    return jsonResponse({
        game_pk: gameId === "demo" ? "demo" : parseInt(gameId, 10),
        available: true,
        current_we: currentWE,
        projected_we: projected,
        leverage,
        best:  bestOutcome  ? { outcome: bestOutcome,  we: bestHome  } : null,
        worst: worstOutcome ? { outcome: worstOutcome, we: worstHome } : null,
        per_outcome: perOutcome,
        matchup_sample: matchup.sample,
        // Surface the count-aware mode so the UI can label the projection
        // as per-pitch (vs per-PA). When false, the projection still uses
        // the all-count matchup engine (e.g. between batters, or when
        // sample is below MIN_COUNT_SAMPLE on either side).
        count_aware: countAware,
        count: matchup.count || null,
    }, cacheSeconds);
}

function jsonResponse(body, maxAge) {
    return new Response(JSON.stringify(body), {
        headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${maxAge}`,
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
