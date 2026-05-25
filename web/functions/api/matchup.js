// /api/matchup?batter={mlbam}&pitcher={mlbam}[&balls=N&strikes=M]
//
// The Phase 3.2 endpoint — given two MLBAM player ids, returns a predicted
// outcome distribution for one plate appearance. Queries Supabase for the
// pre-aggregated rate tables (batter_rates, pitcher_rates, league_rates +
// the players id map) and combines them with the odds-ratio method
// (the JS port of src/engine/matchup.predict).
//
// Count-aware mode: if balls/strikes are in the URL (the in-game state),
// the engine swaps the all-count rate tables for the per-count ones
// (batter_rates_by_count / pitcher_rates_by_count, see PR #57) and
// regresses toward the LEAGUE PER-COUNT baseline instead of the
// all-count baseline. The same odds-ratio combination math is reused —
// only the input sample changes. This is the user-flagged
// "expectancy of a hit/out depends very much on the count" pass: Judge
// on 3-0 vs 0-2 returns completely different distributions now.

import { LEAGUE_RATES_BY_COUNT } from "./_league_rates_by_count.js";

const OUTCOMES = ["K", "BB", "HBP", "1B", "2B", "3B", "HR", "OUT", "OTHER"];
const REGRESSION_PA = 100;
// Per-count cells are inherently smaller (~12x split). Same 100-PA
// regression value as the all-count engine produces sensible shrinkage:
// a regular at ~150 PAs in a given count cell ends up ~60/40 blended
// with the league baseline; a sub at ~20 PAs ends up ~83% league.
const REGRESSION_PA_BY_COUNT = 100;
// Don't bother with count-aware lookup unless both players have at
// least this many PAs at the requested count — below this, the noise
// outweighs the signal we'd add over the all-count engine.
const MIN_COUNT_SAMPLE = 30;

export async function onRequest(context) {
    const env = context.env || {};
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return jsonError(500, "SUPABASE_URL / SUPABASE_ANON_KEY not configured");
    }

    const url = new URL(context.request.url);
    const batterId = url.searchParams.get("batter");
    const pitcherId = url.searchParams.get("pitcher");
    if (!isPositiveInt(batterId) || !isPositiveInt(pitcherId)) {
        return jsonError(400, "batter and pitcher MLBAM ids required");
    }

    // Optional in-game count. When both are present and valid, the
    // engine tries the per-count rates path first; falls back to the
    // all-count path silently when sample is thin on either side.
    const ballsParam   = url.searchParams.get("balls");
    const strikesParam = url.searchParams.get("strikes");
    let countState = null;
    if (ballsParam !== null && strikesParam !== null) {
        const b = parseInt(ballsParam, 10);
        const s = parseInt(strikesParam, 10);
        if (b >= 0 && b <= 3 && s >= 0 && s <= 2) {
            countState = { balls: b, strikes: s };
        }
    }

    try {
        const result = await buildMatchup(env, +batterId, +pitcherId, countState);
        // Tighter cache when the count is in play — the prediction
        // changes per pitch and the frontend polls every 5s. 60s on the
        // all-count path stays since that doesn't refresh per pitch.
        return jsonResponse(result, countState ? 5 : 60);
    } catch (e) {
        return jsonError(502, `${e.message || e}`);
    }
}

function isPositiveInt(s) {
    return s && /^\d+$/.test(s);
}

function jsonResponse(body, maxAge = 30) {
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

// ── Supabase REST helper ──────────────────────────────────────────────

async function sb(env, table, params) {
    const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
        headers: {
            "apikey": env.SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
        },
        cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase ${table} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

// ── Matchup ──────────────────────────────────────────────────────────

async function buildMatchup(env, batterMlbam, pitcherMlbam, countState = null) {
    // 1) Map the two MLBAM ids to retrosheet ids (+ names).
    const players = await sb(env, "players", {
        mlbam: `in.(${batterMlbam},${pitcherMlbam})`,
        select: "mlbam,retrosheet,name_first,name_last",
    });
    const batter = players.find((p) => p.mlbam === batterMlbam) || null;
    const pitcher = players.find((p) => p.mlbam === pitcherMlbam) || null;

    if (!batter?.retrosheet || !pitcher?.retrosheet) {
        return {
            available: false,
            reason: "player not in Chadwick map (modern era only)",
        };
    }

    // 2) Pitcher's throwing hand (from any of their rate rows).
    const handProbe = await sb(env, "pitcher_rates", {
        pitcher: `eq.${pitcher.retrosheet}`,
        select: "throws",
        limit: "1",
    });
    if (handProbe.length === 0) {
        return { available: false, reason: "no pitcher data" };
    }
    const throws = handProbe[0].throws;

    // 3) Batter rates vs that pitcher hand.
    const batterRows = await sb(env, "batter_rates", {
        batter: `eq.${batter.retrosheet}`,
        vs_hand: `eq.${throws}`,
        select: "bats,outcome,n",
    });
    if (batterRows.length === 0) {
        return { available: false, reason: "no batter data vs this pitcher hand" };
    }
    // For switch hitters this could span both — take the dominant.
    const bats = pickHand(batterRows.map((r) => r.bats));

    // 4) Pitcher rates vs that batter hand.
    const pitcherRows = await sb(env, "pitcher_rates", {
        pitcher: `eq.${pitcher.retrosheet}`,
        vs_hand: `eq.${bats}`,
        select: "outcome,n",
    });

    // 5) League baseline for the handedness matchup.
    const leagueRows = await sb(env, "league_rates", {
        bats: `eq.${bats}`,
        throws: `eq.${throws}`,
        select: "outcome,n",
    });

    const batterCounts = sumByOutcome(batterRows);
    const pitcherCounts = sumByOutcome(pitcherRows);
    const leagueCounts = sumByOutcome(leagueRows);

    // 6) Current-season events from the daily_pa log — append to batter and
    //    pitcher counts so predictions sharpen as the season's sample grows.
    //    League baseline isn't touched here: leagueRates in Supabase is the
    //    2020–2024 modern-era window, and one season's daily_pa delta is a
    //    few percent of that baseline. Worth folding in once calibration
    //    tracking tells us whether it helps; stays static for v0.1.
    const [batterCurrent, pitcherCurrent] = await Promise.all([
        sb(env, "daily_pa", {
            batter_mlbam: `eq.${batterMlbam}`,
            pitcher_hand: `eq.${throws}`,
            select: "outcome",
            limit: "5000",
        }),
        sb(env, "daily_pa", {
            pitcher_mlbam: `eq.${pitcherMlbam}`,
            batter_hand: `eq.${bats}`,
            select: "outcome",
            limit: "5000",
        }),
    ]);
    const batterCurrentCounts = countOutcomes(batterCurrent);
    const pitcherCurrentCounts = countOutcomes(pitcherCurrent);
    addCounts(batterCounts, batterCurrentCounts);
    addCounts(pitcherCounts, pitcherCurrentCounts);

    // All-count prediction — what we'd return if no count was passed.
    // Always computed because we use it as a fallback AND we ship it
    // alongside the count-aware prediction in the response so the
    // frontend can show "count-aware: X% K, all-count: Y% K" if it
    // wants. Today it just uses count-aware when present, but the data
    // is on the wire either way.
    const predictedAllCount = predict(batterCounts, pitcherCounts, leagueCounts);

    // Count-aware branch: only kicks in if the caller passed a valid
    // (balls, strikes) AND both players have enough Statcast-era PAs at
    // that count for the prediction to mean something. Below the
    // threshold we silently fall back to all-count — the user-facing
    // signal is `count_aware: true` so the UI can be transparent.
    let predicted = predictedAllCount;
    let countAware = false;
    let countSample = null;
    if (countState) {
        const [batterCountRows, pitcherCountRows] = await Promise.all([
            sb(env, "batter_rates_by_count", {
                batter_mlbam: `eq.${batterMlbam}`,
                vs_hand:      `eq.${throws}`,
                balls:        `eq.${countState.balls}`,
                strikes:      `eq.${countState.strikes}`,
                select:       "outcome,n",
            }),
            sb(env, "pitcher_rates_by_count", {
                pitcher_mlbam: `eq.${pitcherMlbam}`,
                vs_hand:       `eq.${bats}`,
                balls:         `eq.${countState.balls}`,
                strikes:       `eq.${countState.strikes}`,
                select:        "outcome,n",
            }),
        ]);
        const batterCountCounts  = sumByOutcome(batterCountRows);
        const pitcherCountCounts = sumByOutcome(pitcherCountRows);
        const bSample = total(batterCountCounts);
        const pSample = total(pitcherCountCounts);
        countSample = {
            batter_pa:   bSample,
            pitcher_bf:  pSample,
            balls:       countState.balls,
            strikes:     countState.strikes,
        };
        if (bSample >= MIN_COUNT_SAMPLE && pSample >= MIN_COUNT_SAMPLE) {
            // League per-count baseline — shipped as a precomputed JS
            // constant (~48 cells: 4 hand-pairs × 12 counts). Same role
            // as leagueCounts in the all-count path: the regression
            // target. Keyed by BOTH hands so platoon effects (R-vs-R
            // pitchers do well, L-vs-R is the platoon advantage) stay
            // in the baseline at every count.
            const leagueCountCounts = leagueByCountFor(
                bats, throws,
                countState.balls,
                countState.strikes,
            );
            predicted = predict(
                batterCountCounts,
                pitcherCountCounts,
                leagueCountCounts,
                REGRESSION_PA_BY_COUNT,
            );
            countAware = true;
        }
    }

    return {
        available: true,
        years: { start: 2020, end: 2024 },
        batter: {
            mlbam: batter.mlbam,
            retrosheet: batter.retrosheet,
            name: name(batter),
            bats,
        },
        pitcher: {
            mlbam: pitcher.mlbam,
            retrosheet: pitcher.retrosheet,
            name: name(pitcher),
            throws,
        },
        sample: {
            batter_pa:  total(batterCounts),
            pitcher_bf: total(pitcherCounts),
            // Visibility into how much of the sample came from the live
            // event log vs the frozen historical baseline.
            batter_pa_current_season:  batterCurrent.length,
            pitcher_bf_current_season: pitcherCurrent.length,
        },
        predicted,
        predicted_all_count: predictedAllCount,
        count_aware: countAware,
        count: countSample,
        batter_rates:  rates(batterCounts),
        pitcher_rates: rates(pitcherCounts),
        league:        rates(leagueCounts),
        // Raw current-season outcome distribution — what the batter and
        // pitcher have ACTUALLY done in the daily_pa window. Strictly
        // descriptive, not predictive; the matchup card renders it as a
        // "Recent form" line so users see the live sample, not just a
        // hidden sample-size pill.
        recent_form: {
            batter:  { pa: batterCurrent.length,  outcomes: batterCurrentCounts  },
            pitcher: { bf: pitcherCurrent.length, outcomes: pitcherCurrentCounts },
        },
    };
}

// Pull the league per-(bats, throws, balls, strikes) outcome counts
// from the precomputed LEAGUE_RATES_BY_COUNT constant. Used as the
// regression target inside predict() when the count-aware branch fires.
function leagueByCountFor(batterHand, pitcherHand, balls, strikes) {
    const key = `${batterHand}|${pitcherHand}|${balls}|${strikes}`;
    return LEAGUE_RATES_BY_COUNT[key] || {};
}

// Tally outcomes from a daily_pa row list (each row has just {outcome}).
function countOutcomes(rows) {
    const out = {};
    for (const r of rows) out[r.outcome] = (out[r.outcome] || 0) + 1;
    return out;
}

// In-place: a[k] += b[k] for every outcome.
function addCounts(a, b) {
    for (const o of Object.keys(b)) a[o] = (a[o] || 0) + b[o];
}

function name(p) {
    return `${p.name_first || ""} ${p.name_last || ""}`.trim();
}

function pickHand(hands) {
    const tally = {};
    for (const h of hands) tally[h] = (tally[h] || 0) + 1;
    return Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
}

function sumByOutcome(rows) {
    const out = {};
    for (const r of rows) out[r.outcome] = (out[r.outcome] || 0) + r.n;
    return out;
}

function total(counts) {
    return Object.values(counts).reduce((a, b) => a + b, 0);
}

function rates(counts) {
    const t = total(counts);
    const out = {};
    for (const o of OUTCOMES) out[o] = t > 0 ? (counts[o] || 0) / t : 0;
    return out;
}

// ── Odds-ratio prediction (the JS port of src/engine/matchup.predict) ─

function predict(batterC, pitcherC, leagueC, regressionPa = REGRESSION_PA) {
    const leagueRates = rates(leagueC);
    const regressed = (counts) => {
        const t = total(counts) + regressionPa;
        const out = {};
        for (const o of OUTCOMES) {
            out[o] = t > 0
                ? ((counts[o] || 0) + regressionPa * leagueRates[o]) / t
                : leagueRates[o];
        }
        return out;
    };
    const bat = regressed(batterC);
    const pit = regressed(pitcherC);

    const raw = {};
    let sum = 0;
    for (const o of OUTCOMES) {
        const lg = leagueRates[o];
        raw[o] = lg > 0 ? (bat[o] * pit[o]) / lg : 0;
        sum += raw[o];
    }
    if (sum <= 0) return leagueRates;
    const out = {};
    for (const o of OUTCOMES) out[o] = raw[o] / sum;
    return out;
}
