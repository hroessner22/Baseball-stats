// /api/matchup?batter={mlbam}&pitcher={mlbam}
//
// The Phase 3.2 endpoint — given two MLBAM player ids, returns a predicted
// outcome distribution for one plate appearance. Queries Supabase for the
// pre-aggregated rate tables (batter_rates, pitcher_rates, league_rates +
// the players id map) and combines them with the odds-ratio method
// (the JS port of src/engine/matchup.predict).

const OUTCOMES = ["K", "BB", "HBP", "1B", "2B", "3B", "HR", "OUT", "OTHER"];
const REGRESSION_PA = 100;

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

    try {
        const result = await buildMatchup(env, +batterId, +pitcherId);
        return jsonResponse(result, 60);
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

async function buildMatchup(env, batterMlbam, pitcherMlbam) {
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

    const predicted = predict(batterCounts, pitcherCounts, leagueCounts);

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

function predict(batterC, pitcherC, leagueC) {
    const leagueRates = rates(leagueC);
    const regressed = (counts) => {
        const t = total(counts) + REGRESSION_PA;
        const out = {};
        for (const o of OUTCOMES) {
            out[o] = t > 0
                ? ((counts[o] || 0) + REGRESSION_PA * leagueRates[o]) / t
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
