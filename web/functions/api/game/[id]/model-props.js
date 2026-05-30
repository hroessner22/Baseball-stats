// /api/game/{id}/model-props
//
// Returns our matchup-engine projection for every player prop a sportsbook
// would price on this game — keyed by MLBAM id, broken down by stat
// (home_runs / hits / total_bases for batters; strikeouts for pitchers) and
// threshold (1+, 2+, …). The frontend lays these next to the live Kalshi
// quote so the user can see where our model and the market disagree.
//
// Pipeline:
//   1. MLB Stats API live-feed → lineup, batting order, PAs taken so far,
//      probable / current starting pitcher per side.
//   2. Fan out to /api/matchup?batter=X&pitcher=Y for every hitter-vs-
//      opposing-pitcher pair (Promise.allSettled — one slow lookup
//      shouldn't blank the rest).
//   3. Convert each per-PA distribution to a per-game tail probability
//      via the binomial formula. For pitcher strikeouts, sum the expected
//      Ks across the opposing lineup and approximate the tail with a
//      Poisson — close enough at K-counts in the 4-10 range and avoids
//      a full convolution.
//
// Cached 60 s — these projections only meaningfully change between PAs.
// Per-card model display tolerates "no quote" gracefully so the rare
// upstream failure stays invisible.

const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";

// Heuristics for "PAs you still expect this player to get in the game."
// The book lines we're pricing are full-game props (recorded at game end),
// so we need a forward-looking estimate. These are rough but live across
// the whole season, so calibration is the right knob to tune them — not
// per-game guessing.
const PA_PER_STARTER_BATTER = 4;       // top-of-order gets 5, bottom 3-4
const PA_PER_STARTING_PITCHER = 24;    // ~5.5 IP × ~3.6 BF/inning typical starter
// Threshold sets we score per stat — covers everything Kalshi currently
// lists for MLB and stays cheap to compute (binomial tail at small N).
const THRESHOLDS = {
    home_runs:   [1, 2, 3],
    hits:        [1, 2, 3, 4],
    total_bases: [1, 2, 3, 4, 5],
    strikeouts:  [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};


export async function onRequest(context) {
    const gameId = context.params?.id;
    if (!gameId || !/^\d+$/.test(gameId)) {
        return jsonError(400, "invalid game id");
    }

    // 1) MLB live feed — lineup + pitcher per side + PAs taken so far.
    let feedRaw;
    try {
        feedRaw = await fetchJson(
            `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`,
            30,
        );
    } catch (e) {
        return jsonError(502, `live feed fetch failed: ${e.message || e}`);
    }

    const teams = extractLineups(feedRaw);
    if (!teams) {
        return jsonResponse({
            game_pk: parseInt(gameId, 10),
            available: false,
            reason: "no lineup posted yet (probables not announced)",
        }, 30);
    }

    // 2) Fan out matchup calls. For each batter on each side, one call vs
    //    the opposing pitcher. Promise.allSettled so one 5xx doesn't kill
    //    every other player's projection.
    const origin = new URL(context.request.url).origin;
    const tasks = [];
    for (const side of ["home", "away"]) {
        const opp = side === "home" ? "away" : "home";
        const oppPitcherId = teams[opp].pitcher_id;
        if (!oppPitcherId) continue;
        for (const b of teams[side].batters) {
            tasks.push(
                fetchMatchup(origin, b.mlbam, oppPitcherId).then((m) => ({
                    side,
                    batter: b,
                    pitcher_id: oppPitcherId,
                    matchup: m,
                })),
            );
        }
    }
    const settled = await Promise.allSettled(tasks);

    // 3a) Batter prop projections — HR / Hits / Total Bases per player.
    const modelProps = {};
    for (const r of settled) {
        if (r.status !== "fulfilled") continue;
        const { batter, matchup } = r.value;
        if (!matchup || !matchup.available || !matchup.predicted) continue;
        const p = matchup.predicted;
        const paRemaining = Math.max(
            0,
            PA_PER_STARTER_BATTER - (batter.pa_taken || 0),
        );
        if (paRemaining === 0) continue;
        // Convert per-PA rates to per-game tail probabilities. Each stat
        // is the binomial tail at the requested threshold.
        const pHR  = p.HR  || 0;
        const pHit = (p["1B"] || 0) + (p["2B"] || 0) + (p["3B"] || 0) + pHR;
        // TB has a different domain (discrete sum, not Bernoulli). Compute
        // its distribution by walking the multinomial PA-by-PA over (1B,
        // 2B, 3B, HR, other) for the small PA counts we deal with here
        // (≤ 5 remaining), where exhaustive enumeration stays cheap.
        const tbDist = totalBasesDist(p, paRemaining);
        modelProps[batter.mlbam] = {
            home_runs:   tailMap(pHR,  paRemaining, THRESHOLDS.home_runs),
            hits:        tailMap(pHit, paRemaining, THRESHOLDS.hits),
            total_bases: distTailMap(tbDist, THRESHOLDS.total_bases),
            // Used by the renderer for sanity/debug; not displayed directly.
            _meta: {
                per_pa: {
                    HR:  round4(pHR),
                    hit: round4(pHit),
                },
                pa_remaining: paRemaining,
                pa_taken:     batter.pa_taken || 0,
            },
        };
    }

    // 3b) Pitcher strikeout projections — aggregate expected Ks across the
    //     opposing lineup, approximate tail as Poisson(λ = E[K]).
    for (const side of ["home", "away"]) {
        const opp = side === "home" ? "away" : "home";
        const pitcherId = teams[side].pitcher_id;
        if (!pitcherId) continue;
        let expectedK = 0;
        let oppBatterCount = 0;
        // PAs the pitcher has already worked on this batter set live in
        // the feed under `boxscore.teams[X].players[ID{pitcher}].stats.
        // pitching.battersFaced`. Pulled below.
        const battersFaced = teams[side].pitcher_bf || 0;
        const totalPA = Math.max(
            0,
            PA_PER_STARTING_PITCHER - battersFaced,
        );
        if (totalPA === 0) continue;
        // Spread the remaining PAs evenly across the opposing lineup.
        // A starter naturally cycles the lineup ~3x — uniform allocation
        // is the right zero-information prior across all 9 spots.
        for (const r of settled) {
            if (r.status !== "fulfilled") continue;
            const { side: bSide, batter, pitcher_id, matchup } = r.value;
            if (bSide !== opp) continue;
            if (String(pitcher_id) !== String(pitcherId)) continue;
            if (!matchup?.available || !matchup.predicted) continue;
            expectedK += matchup.predicted.K || 0;
            oppBatterCount += 1;
        }
        if (oppBatterCount === 0) continue;
        const meanKPerPA = expectedK / oppBatterCount;
        const lambda = meanKPerPA * totalPA;
        modelProps[pitcherId] = {
            ...(modelProps[pitcherId] || {}),
            strikeouts: poissonTailMap(lambda, THRESHOLDS.strikeouts),
            _meta: {
                ...(modelProps[pitcherId]?._meta || {}),
                expected_k:   round4(lambda),
                batters_left: totalPA,
                bf_so_far:    battersFaced,
            },
        };
    }

    return jsonResponse({
        game_pk: parseInt(gameId, 10),
        available: true,
        lineups: teams,
        model_props: modelProps,
        // Convenience lookup the frontend uses to map Kalshi market titles
        // ("Vinnie Pasquantino: 1+ home runs?") back to MLBAM ids without
        // a second roundtrip. Lowercase keys; trims punctuation/suffixes.
        name_to_mlbam: buildNameLookup(teams),
    }, 60);
}


// ── Lineup extraction ──────────────────────────────────────────────

function extractLineups(feedRaw) {
    const box = feedRaw?.liveData?.boxscore || {};
    const teamsRaw = box.teams || {};
    const probables = feedRaw?.gameData?.probablePitchers || {};
    const out = { home: shapeSide(teamsRaw.home, probables.home), away: shapeSide(teamsRaw.away, probables.away) };
    if (!out.home.pitcher_id && !out.away.pitcher_id) return null;
    if (out.home.batters.length === 0 && out.away.batters.length === 0) return null;
    return out;
}

function shapeSide(side, probable) {
    if (!side) return { team: null, pitcher_id: null, batters: [] };
    const players = side.players || {};
    const orderIds = side.batters || [];
    const pitcherIds = side.pitchers || [];

    // Starting pitcher: prefer the currently-pitching one (front of
    // `pitchers`), fall back to `probablePitcher` for pregame.
    let pitcherId = pitcherIds[0] || probable?.id || null;
    let pitcherBf = 0;
    let pitcherName = null;
    if (pitcherId) {
        const pRow = players[`ID${pitcherId}`];
        pitcherBf = pRow?.stats?.pitching?.battersFaced || 0;
        pitcherName = pRow?.person?.fullName || probable?.fullName || null;
    } else if (probable?.fullName) {
        pitcherName = probable.fullName;
    }

    const batters = [];
    const seen = new Set();
    for (const pid of orderIds) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        const p = players[`ID${pid}`];
        if (!p) continue;
        const b = p.stats?.batting || {};
        const order = parseBattingOrder(p.battingOrder);
        // Skip pinch hitters / defensive subs who haven't been assigned a
        // top-of-the-order slot (they show up with battingOrder 9xx after
        // entering). For pre-game where stats are zero we keep everyone
        // whose battingOrder is 100-900 (the starting nine).
        if (!order) continue;
        batters.push({
            mlbam:    p.person?.id,
            name:     p.person?.fullName,
            order,
            pa_taken: b.plateAppearances || 0,
        });
    }
    // Keep just one player per lineup spot — the starter. Pinch hitters
    // would otherwise inflate the model with extra PAs we won't credit
    // to anyone. battingOrder=NN0 is the starter, NN1+ are subs.
    const byOrder = new Map();
    for (const b of batters) {
        const existing = byOrder.get(b.order);
        if (!existing || existing.pa_taken < b.pa_taken) {
            byOrder.set(b.order, b);
        }
    }
    return {
        team:         side.team?.abbreviation || side.team?.triCode || null,
        pitcher_id:   pitcherId,
        pitcher_name: pitcherName,
        pitcher_bf:   pitcherBf,
        batters:      Array.from(byOrder.values()).sort((a, b) => a.order - b.order),
    };
}

// MLB's battingOrder is a 3-character string: "101" = leadoff hitter,
// first sub-slot. We want just the lineup spot (1..9).
function parseBattingOrder(bo) {
    if (!bo) return null;
    const n = parseInt(String(bo).charAt(0), 10);
    if (!Number.isFinite(n) || n < 1 || n > 9) return null;
    return n;
}


// ── Matchup-engine bridge ──────────────────────────────────────────

async function fetchMatchup(origin, batterMlbam, pitcherMlbam) {
    if (!batterMlbam || !pitcherMlbam) return null;
    try {
        const url = `${origin}/api/matchup?batter=${batterMlbam}&pitcher=${pitcherMlbam}`;
        const res = await fetch(url, {
            cf: { cacheTtl: 60 },
            headers: { "User-Agent": UA },
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}


// ── Tail-probability helpers ───────────────────────────────────────

// Binomial tail: P(X >= k) where X ~ Binomial(n, p).
function binomTail(p, n, k) {
    if (n === 0)         return k <= 0 ? 1 : 0;
    if (k <= 0)          return 1;
    if (k > n)           return 0;
    if (p <= 0)          return 0;
    if (p >= 1)          return 1;
    // P(X < k) = sum_{i=0..k-1} C(n,i) p^i (1-p)^(n-i)
    let cdfBelow = 0;
    let logCoef = 0;  // log C(n,0) = 0
    for (let i = 0; i < k; i++) {
        if (i > 0) {
            logCoef += Math.log(n - i + 1) - Math.log(i);
        }
        const logP = logCoef + i * Math.log(p) + (n - i) * Math.log1p(-p);
        cdfBelow += Math.exp(logP);
    }
    return Math.max(0, Math.min(1, 1 - cdfBelow));
}

function tailMap(p, n, thresholds) {
    const out = {};
    for (const k of thresholds) out[k] = round4(binomTail(p, n, k));
    return out;
}

// Total-bases distribution — multinomial enumeration over per-PA buckets.
// For PA counts up to 5 this is ~6^5 = 7,776 cells max, evaluated once
// per batter. The closed-form alternative (generating-function or Poisson
// approximation) is messier and not noticeably faster at these sizes.
function totalBasesDist(p, n) {
    const buckets = [
        { tb: 0, prob: 1 - ((p["1B"]||0) + (p["2B"]||0) + (p["3B"]||0) + (p.HR||0)) },
        { tb: 1, prob: p["1B"] || 0 },
        { tb: 2, prob: p["2B"] || 0 },
        { tb: 3, prob: p["3B"] || 0 },
        { tb: 4, prob: p.HR   || 0 },
    ];
    // dist[k] = P(total bases == k) after r PAs.
    let dist = new Map([[0, 1]]);
    for (let r = 0; r < n; r++) {
        const next = new Map();
        for (const [k, kp] of dist) {
            for (const b of buckets) {
                if (b.prob <= 0) continue;
                const nk = k + b.tb;
                next.set(nk, (next.get(nk) || 0) + kp * b.prob);
            }
        }
        dist = next;
    }
    return dist;
}

function distTailMap(dist, thresholds) {
    // Cumulative sum from the top, so each tail value is P(X >= k).
    const keys = Array.from(dist.keys()).sort((a, b) => b - a);
    let cum = 0;
    const cdfAbove = new Map();   // k → P(X >= k)
    for (const k of keys) {
        cum += dist.get(k);
        cdfAbove.set(k, cum);
    }
    const out = {};
    for (const k of thresholds) {
        // P(X >= k) = sum_{i >= k} dist[i]
        let s = 0;
        for (const [i, pi] of dist) if (i >= k) s += pi;
        out[k] = round4(s);
    }
    return out;
}

// Poisson tail: P(X >= k) where X ~ Poisson(λ). Used for pitcher Ks
// across the lineup. Independence isn't strictly true (PAs share
// batters) but the approximation holds well at λ in the 4–10 range
// we live in for MLB starters.
function poissonTail(lambda, k) {
    if (lambda <= 0) return k <= 0 ? 1 : 0;
    if (k <= 0)      return 1;
    let cdfBelow = 0;
    let term = Math.exp(-lambda);     // P(X = 0)
    cdfBelow += term;
    for (let i = 1; i < k; i++) {
        term = term * lambda / i;
        cdfBelow += term;
    }
    return Math.max(0, Math.min(1, 1 - cdfBelow));
}

function poissonTailMap(lambda, thresholds) {
    const out = {};
    for (const k of thresholds) out[k] = round4(poissonTail(lambda, k));
    return out;
}


// ── Name → MLBAM lookup ────────────────────────────────────────────

function buildNameLookup(teams) {
    const out = {};
    for (const side of ["home", "away"]) {
        for (const b of teams[side].batters) {
            if (!b.name || !b.mlbam) continue;
            out[normName(b.name)] = b.mlbam;
            // Also index by surname-only ("Pasquantino" → mlbam) for
            // Kalshi titles that abbreviate the first name. Last-name
            // collisions get the last writer; downstream is best-effort.
            const surname = b.name.split(/\s+/).slice(-1)[0];
            if (surname) out[normName(surname)] = b.mlbam;
        }
        const pid = teams[side].pitcher_id;
        const pname = teams[side].pitcher_name;
        if (pid && pname) {
            out[normName(pname)] = pid;
            const surname = pname.split(/\s+/).slice(-1)[0];
            if (surname) out[normName(surname)] = pid;
        }
    }
    return out;
}

function normName(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}


// ── Tiny utilities ─────────────────────────────────────────────────

async function fetchJson(url, cacheTtl = 30) {
    const res = await fetch(url, {
        cf: { cacheTtl },
        headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    return await res.json();
}

function round4(x) {
    if (!Number.isFinite(x)) return null;
    return Math.round(x * 10000) / 10000;
}

function jsonResponse(body, maxAge = 60) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": `public, max-age=${maxAge}`,
        },
    });
}

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}
