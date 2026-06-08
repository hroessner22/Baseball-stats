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

import { parkFactor } from "../../_park_factors.js";

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
    const allPlayers = buildAllPlayersIndex(feedRaw);
    if (!teams) {
        return jsonResponse({
            game_pk: parseInt(gameId, 10),
            available: false,
            reason: "no lineup posted yet (probables not announced)",
        }, 30);
    }

    // Pull the current game state so we can de-rate hitter PA
    // estimates as the game gets late. A batter due up in the 4th
    // can reasonably expect 2-3 more PAs; the same lineup spot in
    // the 8th probably gets one more if any.
    const linescore = feedRaw?.liveData?.linescore || {};
    const currentInning = parseInt(linescore.currentInning, 10) || 0;
    const inningHalf    = linescore.inningHalf || linescore.inningState || ""; // "Top" / "Bottom"
    const gameState = {
        inning: currentInning,
        half:   inningHalf,
        // The "natural" expected remaining lineup turns from THIS
        // point — anchored on the 8.5 innings = ~3 turns convention.
        // Each subsequent inning past 4 trims about 1/3 turn off.
        // Bottom of 9 (home leading) = 0.
        turns_remaining: estimateLineupTurnsRemaining(currentInning, inningHalf),
    };

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
        // Two estimates for remaining PAs — keep the smaller:
        //   1) Static: the season-average 4 PAs per batter minus
        //      what they've already taken (legacy default).
        //   2) Live game state: turns_remaining × 1 PA per turn
        //      capped at 9 lineup positions per turn. A batter due
        //      up in the 8th gets ~1 more if any; same spot in the
        //      4th gets 2-3.
        // The minimum of the two prevents overcounting in late
        // innings where the static formula thinks 4 PAs are still
        // coming but only 1 actually will.
        const staticRemaining = Math.max(
            0,
            PA_PER_STARTER_BATTER - (batter.pa_taken || 0),
        );
        const liveRemaining = Math.max(0, gameState.turns_remaining);
        const paRemaining = Math.min(staticRemaining, liveRemaining);
        if (paRemaining === 0) continue;
        // Convert per-PA rates to per-game tail probabilities. Each stat
        // is the binomial tail at the requested threshold.
        const pHR  = p.HR  || 0;
        const pHit = (p["1B"] || 0) + (p["2B"] || 0) + (p["3B"] || 0) + pHR;
        // ALREADY-REALIZED stats this game — subtract from the threshold
        // before computing the tail. Was a bug: tailMap(pHit, paRemaining,
        // [1,2,3,4]) computed P(at least N hits in REMAINING PAs), but the
        // prop threshold means TOTAL hits this game. So 'Julio Rodríguez
        // 2+ H' when he already has 1 hit should ask 'P(≥1 more hit in
        // remaining PAs)', not 'P(≥2 hits in remaining PAs)'. Old math
        // produced wildly low probabilities like 8% on bets the market
        // priced at 94%, generating massive phantom edges.
        const currentHits = batter.hits || 0;
        const currentHRs  = batter.home_runs || 0;
        const currentTB   = (batter.hits || 0)
                          + (batter.doubles || 0)
                          + 2 * (batter.triples || 0)
                          + 3 * (batter.home_runs || 0);
        // TB has a different domain (discrete sum, not Bernoulli). Compute
        // its distribution by walking the multinomial PA-by-PA over (1B,
        // 2B, 3B, HR, other) for the small PA counts we deal with here
        // (≤ 5 remaining), where exhaustive enumeration stays cheap.
        const tbDist = totalBasesDist(p, paRemaining);
        modelProps[batter.mlbam] = {
            home_runs:   tailMapTotal(pHR,  paRemaining, THRESHOLDS.home_runs,   currentHRs),
            hits:        tailMapTotal(pHit, paRemaining, THRESHOLDS.hits,        currentHits),
            total_bases: distTailMapTotal(tbDist,        THRESHOLDS.total_bases, currentTB),
            // Used by the renderer for sanity/debug; not displayed directly.
            _meta: {
                per_pa: {
                    HR:  round4(pHR),
                    hit: round4(pHit),
                },
                pa_remaining: paRemaining,
                pa_remaining_static: staticRemaining,
                pa_remaining_live:   round4(liveRemaining),
                pa_taken:     batter.pa_taken || 0,
            },
        };
    }

    // 3b) Pitcher strikeout projections — aggregate expected Ks across the
    //     opposing lineup, approximate tail as Poisson(λ = E[K]).
    //
    // Pull each starter's season pitch-count habit in parallel so the
    // pitch-count haircut can scale to the individual pitcher instead
    // of using a one-size global. The fetch is cached 24h at the
    // edge, so the same pitcher's profile costs at most one upstream
    // call per day across every game we render. Falls back to the
    // global ramp when a profile isn't returned.
    const season = new Date().getUTCFullYear();
    const profilesByPid = {};
    const profileTasks = [];
    for (const side of ["home", "away"]) {
        const pid = teams[side].pitcher_id;
        if (!pid) continue;
        profileTasks.push(
            fetchPitcherPitchProfile(pid, season).then((profile) => {
                profilesByPid[pid] = profile;
            }).catch(() => { profilesByPid[pid] = null; })
        );
    }
    await Promise.all(profileTasks);

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
        const pitchesThrown = teams[side].pitcher_pitches || 0;
        const baseRemaining = Math.max(
            0,
            PA_PER_STARTING_PITCHER - battersFaced,
        );
        // Pitch-count haircut, now per-pitcher when we have a profile.
        // Each starter has a personal hook point — Verlander gets pulled
        // around 100, Misiorowski around 85, an opener after 30. Using
        // a global 85/95/105 ramp punishes the workhorses and lets the
        // openers slip through.
        //
        // The profile gives us p80_pitches: the 80th percentile of
        // pitches per start this season. We anchor the haircut zones
        // around that:
        //   pitchesThrown < (p80 - 20):  no haircut
        //   p80 - 20 to p80 - 10:        0.75x (light caution)
        //   p80 - 10 to p80:             0.50x (50/50)
        //   p80 to p80 + 10:             0.20x (~80% removal)
        //   above p80 + 10:              0.05x (pull imminent)
        // Falls back to the league-wide 80/95/105 ramp when we don't
        // have a profile (rookies, pitchers with no starts yet).
        const profile = profilesByPid[pitcherId];
        let pitchCountFactor = 1.0;
        if (profile && profile.p80_pitches > 0) {
            const p80 = profile.p80_pitches;
            if      (pitchesThrown >= p80 + 10)  pitchCountFactor = 0.05;
            else if (pitchesThrown >= p80)       pitchCountFactor = 0.20;
            else if (pitchesThrown >= p80 - 10)  pitchCountFactor = 0.50;
            else if (pitchesThrown >= p80 - 20)  pitchCountFactor = 0.75;
        } else {
            if      (pitchesThrown >= 105)       pitchCountFactor = 0.05;
            else if (pitchesThrown >= 95)        pitchCountFactor = 0.20;
            else if (pitchesThrown >= 80)        pitchCountFactor = 0.50;
            else if (pitchesThrown >= 70)        pitchCountFactor = 0.75;
        }
        const totalPA = baseRemaining * pitchCountFactor;
        if (totalPA <= 0) continue;
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
                expected_k:           round4(lambda),
                batters_left:         round4(totalPA),
                batters_left_uncap:   baseRemaining,
                bf_so_far:            battersFaced,
                pitches_thrown:       pitchesThrown,
                pitch_count_factor:   pitchCountFactor,
                // Personal pitch-count habit (this-season avg/max/p80).
                // Bot's force-sell triggers can read this to set the
                // 'pull likely' threshold per pitcher instead of using
                // the global 85/95/105 ramp.
                pitch_profile:        profile || null,
            },
        };
    }

    // Stadium / park factors. The home team plays the home park; the
    // bot uses these multipliers to nudge prop probabilities (HR
    // boost at Coors / Citizens Bank, HR suppression at Oracle / Petco).
    const homeAbbr = teams.home?.team || null;
    const park = parkFactor(homeAbbr);

    return jsonResponse({
        game_pk: parseInt(gameId, 10),
        available: true,
        lineups: teams,
        game_state: gameState,
        model_props: modelProps,
        // Convenience lookup the frontend uses to map Kalshi market titles
        // ("Vinnie Pasquantino: 1+ home runs?") back to MLBAM ids without
        // a second roundtrip. Lowercase keys; trims punctuation/suffixes.
        name_to_mlbam: { ...allPlayers.name_index, ...buildNameLookup(teams) },
        // Live in-game stats for EVERY player who has appeared,
        // including pinch hitters / subs. The bot reads this as a
        // fallback when the starting-lineup map doesn't have the
        // player (the Luis Torrens case).
        all_player_stats: allPlayers.stats_by_id,
        // Park factors keyed to the home team's stadium. Bot adjusts
        // prop probabilities using these (HR-friendly bandbox vs
        // pitcher-friendly cavern).
        park_factors: { home_team: homeAbbr, ...park },
    }, 60);
}

// Rough "how many more lineup turns will this team get?" given the
// current inning + half. Each lineup turn ≈ 1 PA per slot. Anchored
// on the convention that a starter's 24 BF / 6 IP works out to ~2.6
// turns; from any midgame point, we back-compute remaining turns
// based on what's left of the regulation 8.5–9 innings.
//
// Top of N: away team has finished N-1 turns, batting now
// Bot of N: home team has finished N-1 turns, batting now (or just
// finished if 'Middle' / 'End')
function estimateLineupTurnsRemaining(inning, half) {
    if (!inning || inning < 1) return 3.0;         // pre-1st = full 3 turns
    if (inning >= 10) return 0.5;                  // extras — very rough
    const h = String(half || "").toLowerCase();
    // Rough mapping inning + half → remaining PAs per slot. Average
    // across home + away since most user-facing props are full-game.
    const tableTop = [3.0, 2.6, 2.2, 1.8, 1.4, 1.0, 0.7, 0.4, 0.1];
    const tableBot = [2.8, 2.4, 2.0, 1.6, 1.2, 0.8, 0.5, 0.2, 0.0];
    const idx = Math.max(0, Math.min(8, inning - 1));
    if (h.startsWith("top") || h.startsWith("mid")) return tableTop[idx];
    if (h.startsWith("bot") || h.startsWith("end")) return tableBot[idx];
    return tableTop[idx];   // unknown half — default to "top"
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

// Build a name→mlbam + per-mlbam live-stats map covering EVERY
// player who has appeared in the game, not just the starting lineup.
// Used by the bot's threshold-crossed gate so pinch hitters / late
// subs don't slip past the check just because they aren't in the
// starting nine. Returns { name_index, stats_by_id }.
//
// Example fix: 'Luis Torrens 2+ H' showed model 9% vs market 99%
// — Torrens was a pinch hitter or sub not in the starting lineup,
// so the gate-4 lookup returned null and the bot considered a bet
// on something that had already happened.
function buildAllPlayersIndex(feedRaw) {
    const box = feedRaw?.liveData?.boxscore || {};
    const teamsRaw = box.teams || {};
    const nameIndex = {};
    const statsById = {};
    for (const side of ["home", "away"]) {
        const players = teamsRaw[side]?.players || {};
        for (const key of Object.keys(players)) {
            const p = players[key];
            const id = p?.person?.id;
            const name = p?.person?.fullName;
            if (!id) continue;
            if (name) {
                nameIndex[normName(name)] = id;
                const surname = name.split(/\s+/).slice(-1)[0];
                if (surname) nameIndex[normName(surname)] = id;
            }
            const b = p.stats?.batting || {};
            const pitch = p.stats?.pitching || {};
            statsById[id] = {
                hits:        b.hits        || 0,
                doubles:     b.doubles     || 0,
                triples:     b.triples     || 0,
                home_runs:   b.homeRuns    || 0,
                strikeouts: pitch.strikeOuts || b.strikeOuts || 0,
                plate_appearances: b.plateAppearances || 0,
            };
        }
    }
    return { name_index: nameIndex, stats_by_id: statsById };
}

function shapeSide(side, probable) {
    if (!side) return { team: null, pitcher_id: null, batters: [] };
    const players = side.players || {};
    const orderIds = side.batters || [];
    const pitcherIds = side.pitchers || [];

    // CURRENT pitcher: MLB's `pitchers` array is chronological, with
    // the most recent pitcher at the END. pitchers[0] is the starter
    // even after they've been pulled — so before this fix, the bot
    // kept evaluating K-props on pitchers who were already in the
    // dugout (the 'George Kirby has been pulled' complaint). Take
    // the last entry, which is whoever is currently on the mound.
    // Falls back to probablePitcher for pregame.
    let pitcherId = pitcherIds[pitcherIds.length - 1] || probable?.id || null;
    let pitcherBf = 0;
    let pitcherPitches = 0;
    let pitcherSo = 0;
    let pitcherSeasonGS = 0;
    let pitcherSeasonSO = 0;
    let pitcherName = null;
    if (pitcherId) {
        const pRow = players[`ID${pitcherId}`];
        pitcherBf = pRow?.stats?.pitching?.battersFaced || 0;
        // Pitch count drives the remaining-BF estimate downstream —
        // a starter at 95 pitches in the 6th is one bad batter from
        // being pulled, regardless of how many BF the static
        // PA_PER_STARTING_PITCHER constant would predict.
        pitcherPitches = pRow?.stats?.pitching?.pitchesThrown || 0;
        // Strikeouts already recorded — the bot uses this to refuse
        // K-prop bets where the threshold has already been met
        // (e.g. 'over 5 K' when he already has 6).
        pitcherSo = pRow?.stats?.pitching?.strikeOuts || 0;
        // Season pitching for the realistic-threshold sanity check.
        const psp = (pRow?.seasonStats || {}).pitching || {};
        pitcherSeasonGS = Number(psp.gamesStarted) || 0;
        pitcherSeasonSO = Number(psp.strikeOuts)   || 0;
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
        // Season stats from p.seasonStats.batting — used by the bot
        // for the 'realistic threshold' sanity check (refuses bets on
        // thresholds the player almost never hits, like 'Baty 2+ HR').
        const ss = (p.seasonStats || {}).batting || {};
        batters.push({
            mlbam:    p.person?.id,
            name:     p.person?.fullName,
            order,
            pa_taken: b.plateAppearances || 0,
            hits:        b.hits        || 0,
            doubles:     b.doubles     || 0,
            triples:     b.triples     || 0,
            home_runs:   b.homeRuns    || 0,
            strikeouts:  b.strikeOuts  || 0,
            // Season per-game rates — let the bot compute baseline
            // probability of N+ via Poisson approximation.
            season_games:       Number(ss.gamesPlayed) || 0,
            season_hits:        Number(ss.hits)        || 0,
            season_home_runs:   Number(ss.homeRuns)    || 0,
            season_doubles:     Number(ss.doubles)     || 0,
            season_triples:     Number(ss.triples)     || 0,
            season_strikeouts:  Number(ss.strikeOuts)  || 0,
            // Season slash line for quality-of-hitter gates in the
            // bot (e.g. block 1+ hit NO bets on .250+ AVG hitters
            // since the market underprices their hit probability).
            season_avg:         parseFloat(ss.avg) || 0,
            season_obp:         parseFloat(ss.obp) || 0,
            season_slg:         parseFloat(ss.slg) || 0,
            season_ops:         parseFloat(ss.ops) || 0,
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
        team:           side.team?.abbreviation || side.team?.triCode || null,
        pitcher_id:     pitcherId,
        pitcher_name:   pitcherName,
        pitcher_bf:     pitcherBf,
        pitcher_pitches: pitcherPitches,
        pitcher_strikeouts: pitcherSo,
        pitcher_season_gs: pitcherSeasonGS,
        pitcher_season_so: pitcherSeasonSO,
        batters:        Array.from(byOrder.values()).sort((a, b) => a.order - b.order),
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

// Same as tailMap but subtracts already-realized count from each
// threshold. If the threshold has already been met (current >= k),
// probability is 1.0. Otherwise compute the binomial tail for the
// remaining needed in the remaining PAs.
function tailMapTotal(p, n, thresholds, current) {
    const out = {};
    for (const k of thresholds) {
        const need = k - (current || 0);
        if (need <= 0)              out[k] = 1.0;
        else if (need > n)          out[k] = 0.0;   // can't reach even with all PAs
        else                        out[k] = round4(binomTail(p, n, need));
    }
    return out;
}

// Total-bases version. Subtracts realized TB from each threshold
// then reads the dist tail at the reduced index.
function distTailMapTotal(dist, thresholds, current) {
    const out = {};
    for (const k of thresholds) {
        const need = k - (current || 0);
        if (need <= 0) { out[k] = 1.0; continue; }
        let acc = 0;
        for (const [v, prob] of dist) {
            if (v >= need) acc += prob;
        }
        out[k] = round4(acc);
    }
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


// ── Per-pitcher pitch-count profile ────────────────────────────────
// Pulls this-season game logs for a pitcher and surfaces summary
// stats: total starts, avg pitches per start, max pitches in any
// start, and the 80th percentile (the 'I usually go that long
// before getting pulled' marker the haircut uses).
//
// Cached 24h at the edge via cf.cacheTtl — Cloudflare Workers will
// only hit MLB once per pitcher per day no matter how many games
// reference them.
async function fetchPitcherPitchProfile(pitcherId, season) {
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}` +
                `/stats?stats=gameLog&group=pitching&season=${season}`;
    let data;
    try {
        data = await fetchJson(url, 86400);
    } catch { return null; }
    const splits = data?.stats?.[0]?.splits || [];
    // Filter to starts only (gamesStarted=1) — relievers' single-
    // outing pitch counts would skew downward and the cash-out
    // logic is about starter-pull tendency.
    const pitches = [];
    for (const s of splits) {
        const stat = s.stat || {};
        const isStart = (parseInt(stat.gamesStarted, 10) || 0) >= 1;
        if (!isStart) continue;
        const pc = parseInt(stat.pitchesThrown || stat.numberOfPitches || 0, 10);
        if (pc > 0) pitches.push(pc);
    }
    if (!pitches.length) return null;
    pitches.sort((a, b) => a - b);
    const sum = pitches.reduce((s, p) => s + p, 0);
    const p80Idx = Math.max(0, Math.min(pitches.length - 1, Math.floor(pitches.length * 0.8)));
    return {
        starts:      pitches.length,
        avg_pitches: Math.round(sum / pitches.length),
        max_pitches: pitches[pitches.length - 1],
        p80_pitches: pitches[p80Idx],
        // Median for sanity checks.
        med_pitches: pitches[Math.floor(pitches.length / 2)],
    };
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
