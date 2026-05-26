// /api/game/{id}/we-forward
//
// Bullpen-aware forward WE projection — what's the end-of-game win
// expectancy IF the manager runs the bullpen the way they usually do
// (starter pulled when pitch count + inning thresholds hit, setup man
// in 7th/8th, closer in 9th), and IF future matchups go according to
// the count-aware matchup engine?
//
// Nobody public ships this — FanGraphs/BR/MLB show "WE in current
// state assuming a league-average team." We project forward using THIS
// team's actual lineup, THIS team's actual bullpen, and THE actual
// per-(batter, pitcher) matchup distributions from our engine. See the
// research note in docs/04-ROADMAP.md — this is the academic-frontier
// "player-identity WE" applied forward in time.
//
// Pipeline:
//   1. Read current state from /api/game/{id}
//   2. Pull lineups + bullpens + pitcher usage from MLB feed
//   3. Build a pitcher sequence (current → predicted relievers)
//   4. Precompute matchup outcome distributions for every unique
//      (batter, pitcher) pair we'll need
//   5. Walk forward PA by PA: pick pitcher, pick batter, sample
//      outcome from distribution, advance state, record WE
//   6. Return projected EOG WE + the pitcher sequence used
//
// v1 caveats:
//   - Greedy state walk (most likely outcome each PA) — single path,
//     not Monte Carlo. Tomorrow's v2 swaps in N=100 sample averaging.
//   - Manager pull rule is league-average heuristic (pitch count > 95
//     OR inning ≥ 7 AND score within 3); no per-manager learning yet.
//   - Closer / setup identification uses bullpen list order, not
//     usage history (closer is typically last in MLB roster ordering).

import { WE_TABLE     } from "../../games/_we_table.js";
import { WE_TABLE_V2  } from "../../games/_we_table_v2.js";

const OUTCOMES = ["K", "BB", "HBP", "1B", "2B", "3B", "HR", "OUT", "OTHER"];
const HALF_FLIP = { top: "bottom", bottom: "top" };

const INNING_CLIP = [1, 9];
const LEAD_CLIP   = [-10, 10];
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const popcount = (n) => ((n>>0)&1) + ((n>>1)&1) + ((n>>2)&1);

// Manager pull rules — v1 is league average. Refine per-manager later.
const STARTER_PITCH_LIMIT = 95;   // ~ 6-7 IP for a starter going well
const LATE_INNING_FROM    = 7;    // 7th+ flips to bullpen if game is close
const CLOSE_GAME_MARGIN   = 3;    // within ±3 runs counts as "save situation"

const MAX_SIMULATION_PAS = 60;    // per-run safety: extras eventually terminate
const N_SIMULATIONS      = 25;    // Monte Carlo path count — balances accuracy
                                  // vs Worker compute budget. Each path samples
                                  // outcomes from the matchup distribution.


export async function onRequest(context) {
    const gameId = context.params?.id;

    if (gameId === "demo") {
        return jsonResponse({
            game_pk: "demo",
            available: false,
            reason: "demo game forecast not synthesized (no real lineup / bullpen)",
        }, 0);
    }
    if (!gameId || !/^\d+$/.test(gameId)) {
        return jsonError(400, "invalid game id");
    }

    const origin = new URL(context.request.url).origin;

    // 1. Current game state — shape we control via /api/game/{id}.
    let game;
    try {
        const res = await fetch(`${origin}/api/game/${gameId}`);
        if (!res.ok) throw new Error(`game HTTP ${res.status}`);
        game = await res.json();
    } catch (e) {
        return jsonError(502, `failed to load game: ${e.message || e}`);
    }
    if (game.status !== "Live" || !game.batter?.id || !game.pitcher?.id) {
        return jsonResponse({
            game_pk: parseInt(gameId, 10),
            available: false,
            reason: "no live PA in progress",
            current_we: game.win_expectancy ?? null,
        }, 30);
    }

    // 2. Lineups + bullpens + pitcher usage from the MLB live feed.
    let feed;
    try {
        const res = await fetch(
            `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`,
            {
                headers: { "User-Agent": "DIAMOND:CONTEXT/0.1" },
                cf: { cacheTtl: 30, cacheEverything: true },
            },
        );
        if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
        feed = await res.json();
    } catch (e) {
        return jsonError(502, `failed to load feed: ${e.message || e}`);
    }

    const boxscoreTeams = feed?.liveData?.boxscore?.teams || {};
    const battingSide  = game.half === "bottom" ? "home" : "away";
    const pitchingSide = battingSide === "home" ? "away" : "home";

    const battingLineup = extractLineup(boxscoreTeams[battingSide]);
    const pitchingLineup = extractLineup(boxscoreTeams[pitchingSide]);
    const pitcherSequence = buildPitcherSequence(
        boxscoreTeams[pitchingSide],
        game.pitcher.id,
        game.inning,
    );

    if (battingLineup.length < 9 || pitcherSequence.length === 0) {
        return jsonResponse({
            game_pk: parseInt(gameId, 10),
            available: false,
            reason: "incomplete lineup / bullpen data",
            current_we: game.win_expectancy ?? null,
        }, 30);
    }

    // 3. Precompute matchup distributions in parallel — every unique
    // (batter, pitcher) pair we might hit during the rest of the game.
    // ~9 batters × ~3 pitchers = ~27 fetches, each Cloudflare-cached.
    const matchupCache = await precomputeMatchups(
        origin, battingLineup, pitchingLineup, pitcherSequence,
    );

    // 4. Walk forward.
    const currentState = {
        inning:        game.inning,
        half:          game.half,
        outs:          game.outs ?? 0,
        bases:
            ((game.runners?.first  ? 1 : 0)) |
            ((game.runners?.second ? 2 : 0)) |
            ((game.runners?.third  ? 4 : 0)),
        home_lead:     (game.score?.home ?? 0) - (game.score?.away ?? 0),
        batting_team:  battingSide,
        pitching_team: pitchingSide,
    };

    // We need to know where in the lineup we are. Find the current
    // batter in the lineup; if not there (PH not in starting 9, etc.),
    // fall back to slot 0.
    const startBatterIdx = Math.max(
        0,
        battingLineup.findIndex((b) => b.mlbam === game.batter.id),
    );

    // Run N Monte Carlo paths through the rest of the game, each
    // sampling outcomes from the matchup distribution. Forecast WE is
    // the share of paths that resolve to a home win. Single representative
    // path (the one whose path-end WE is the median) drives the display
    // sequence so the UI has something coherent to render.
    const paths = [];
    for (let i = 0; i < N_SIMULATIONS; i++) {
        paths.push(simulateForward({
            state:           currentState,
            lineupBatting:   battingLineup,
            lineupPitching:  pitchingLineup,
            batterIdx:       startBatterIdx,
            pitcherSequence,
            matchupCache,
        }));
    }
    const wins = paths.filter((p) => p.finalWE >= 0.5).length;
    const rawForecastWE = wins / N_SIMULATIONS;

    // Team-strength shift carried from /api/game/{id}. Player-level
    // recency (PR #70) is already captured per-PA inside the simulation
    // via the matchup engine, but TEAM-level effects (bullpen depth,
    // manager, clutch, whatever the strength differential captures
    // beyond individual stats) aren't. Apply as a post-hoc shift —
    // the simulation samples enough paths that the win rate is a
    // reasonable estimate, and the team-strength delta is a constant
    // that bumps the final number by the same amount it bumped the
    // headline state WE.
    const teamDelta = game.team_adjustment?.delta_from_baseline || 0;
    const forecastWE = Math.max(0.01, Math.min(0.99, rawForecastWE + teamDelta));

    // Median path for display — the one with WE closest to the average
    // is the "typical" simulated future to show in the UI.
    paths.sort((a, b) => a.finalWE - b.finalWE);
    const median = paths[Math.floor(N_SIMULATIONS / 2)];

    return jsonResponse({
        game_pk:           parseInt(gameId, 10),
        available:         true,
        current_we:        game.win_expectancy ?? null,
        forecast_we:       forecastWE,
        forecast_we_raw:   rawForecastWE,
        team_delta:        teamDelta,
        n_simulations:     N_SIMULATIONS,
        pitcher_sequence:  median.pitcherSummary,
        sequence:          median.sequence,
        n_pas_simulated:   median.sequence.length,
        terminated_reason: median.terminatedReason,
    }, 5);
}


// ── lineup / bullpen extraction ────────────────────────────────────

function extractLineup(teamBox) {
    if (!teamBox) return [];
    const players = teamBox.players || {};
    const order = teamBox.battingOrder || [];
    const lineup = [];
    for (const pid of order.slice(0, 9)) {  // 9 starters; PH/PR/subs handled by usage
        const p = players[`ID${pid}`];
        if (!p) continue;
        lineup.push({
            mlbam: p.person?.id || null,
            name:  p.person?.fullName || "",
            bats:  p.batSide?.code || p.person?.batSide?.code || null,
            position: p.position?.abbreviation || "",
        });
    }
    return lineup;
}

// Build the pitcher sequence — who's pitching when. v1 is rules-based:
//   current starter:  continues until pitch count > STARTER_PITCH_LIMIT
//                     OR we're in inning ≥ LATE_INNING_FROM and not blowout
//   first reliever:   first available bullpen arm, pitches 1 inning
//   second reliever:  next bullpen arm, pitches 1 inning
//   closer:           last bullpen arm (typical MLB roster ordering puts
//                     the closer at the end), pitches 9th
function buildPitcherSequence(pitchingTeamBox, currentPitcherMlbam, currentInning) {
    if (!pitchingTeamBox) return [];
    const players = pitchingTeamBox.players || {};
    const bullpenIds = pitchingTeamBox.bullpen || [];
    const usedIds    = pitchingTeamBox.pitchers || [];

    const namedById = (id) => {
        const p = players[`ID${id}`];
        if (!p) return null;
        const g = (p.stats || {}).pitching || {};
        return {
            mlbam:    id,
            name:     p.person?.fullName || "",
            throws:   p.pitchHand?.code || null,
            pitches_thrown:   g.pitchesThrown || 0,
            innings_pitched:  g.inningsPitched || "0.0",
            role:     null,  // assigned below
        };
    };

    const currentPitcher = namedById(currentPitcherMlbam);
    if (!currentPitcher) return [];

    // Bullpen arms NOT already used today. Used pitchers usually won't
    // re-enter a game; exclude them from the future sequence.
    const usedSet = new Set(usedIds.map(String));
    const availableBullpen = bullpenIds
        .filter((id) => !usedSet.has(String(id)))
        .map(namedById)
        .filter(Boolean);

    // Conventional MLB roster ordering — the closer is at the END of
    // the bullpen list (it's how teams list 9th-inning specialists).
    // Pull him to a separate slot so we use him last.
    let closer = null;
    if (availableBullpen.length > 0) {
        closer = availableBullpen.pop();
        closer.role = "closer";
    }

    const sequence = [{ ...currentPitcher, role: "current_starter" }];

    // Estimate the inning when the starter gets pulled — earliest of:
    //   pitch count crossing 95 (assume ~15 pitches/inning going forward)
    //   inning ≥ 7
    const pitchesRemaining = Math.max(0, STARTER_PITCH_LIMIT - currentPitcher.pitches_thrown);
    const inningsLeftInStarter = Math.min(
        Math.floor(pitchesRemaining / 15),
        Math.max(0, LATE_INNING_FROM - currentInning),
    );
    sequence[0].estimated_innings_left = inningsLeftInStarter;

    // Fill 7th/8th with the first 1-2 bullpen arms, then closer in 9th.
    let inningPtr = currentInning + inningsLeftInStarter;
    for (const r of availableBullpen.slice(0, 2)) {
        if (inningPtr > 8) break;
        sequence.push({ ...r, role: `inning_${inningPtr}` });
        inningPtr += 1;
    }
    if (closer) {
        sequence.push({ ...closer, role: "closer" });
    }

    return sequence;
}


// ── matchup precompute ────────────────────────────────────────────

async function precomputeMatchups(origin, batting, pitching, sequence) {
    const cache = new Map();
    // Every (batter, pitcher) pair we might evaluate. ~9 × ~3 = ~27.
    const pairs = [];
    for (const b of batting) {
        for (const p of sequence) {
            pairs.push({ batter: b.mlbam, pitcher: p.mlbam });
        }
    }
    // Also include the other team's lineup × the current batting
    // team's pitcher when we flip half-innings. We'll skip for v1 —
    // the projection focuses on the half-inning in progress + the
    // remaining game from this team's PoV. If the half flips, the
    // opposing team would have its own matchup data needed; for v1
    // we use the league-average outcome (matchup with available = false).

    const results = await Promise.all(pairs.map(async (pair) => {
        try {
            const res = await fetch(
                `${origin}/api/matchup?batter=${pair.batter}&pitcher=${pair.pitcher}`,
                { cf: { cacheTtl: 60, cacheEverything: true } },
            );
            if (!res.ok) return [pair, null];
            const m = await res.json();
            if (!m.available) return [pair, null];
            return [pair, m.predicted];
        } catch {
            return [pair, null];
        }
    }));
    for (const [pair, dist] of results) {
        cache.set(`${pair.batter}-${pair.pitcher}`, dist);
    }
    return cache;
}


// ── state simulation ──────────────────────────────────────────────

function simulateForward({
    state, lineupBatting, lineupPitching,
    batterIdx, pitcherSequence, matchupCache,
}) {
    const sequence = [];
    let curState = { ...state };
    let curBatterIdx = batterIdx;
    let curPitcherIdx = 0;  // pointer into pitcherSequence
    let paInInning = 0;
    let pitcherPaCount = 0;
    let terminatedReason = "reached_end_of_game";

    for (let pa = 0; pa < MAX_SIMULATION_PAS; pa++) {
        // Terminal? (walk-off / mercy / top-9+ closed)
        const term = terminalWE(curState);
        if (term !== null) { break; }

        // If the batting team flips (half changed since we set up), we
        // skip per-PA matchup math for v1 because we don't have the
        // opposing pitcher's matchup against our team's lineup pre-
        // computed. Fall back to "average team in this state" via the
        // empirical WE table.
        const sameTeamBatting = curState.batting_team === state.batting_team;

        const pitcher = pickPitcher(pitcherSequence, curPitcherIdx, curState.inning);
        const batter  = lineupBatting[curBatterIdx % 9];

        let dist = null;
        if (sameTeamBatting && pitcher && batter) {
            dist = matchupCache.get(`${batter.mlbam}-${pitcher.mlbam}`);
        }

        let outcome;
        if (dist) {
            // Sample from the matchup distribution. With N=25 paths the
            // sampled-outcomes average converges close to the true
            // expectation while still being cheap.
            outcome = sampleOutcome(dist);
        } else {
            // No matchup distribution — sample from a league-flavored
            // baseline so the simulation makes forward progress instead
            // of grinding out endless OUTs. League roughly: K 23%, BB
            // 9%, 1B 13%, 2B 4%, HR 3%, OUT 45%, OTHER 3%.
            outcome = sampleOutcome({
                K: 0.23, BB: 0.09, HBP: 0.01, "1B": 0.13, "2B": 0.04,
                "3B": 0.005, HR: 0.03, OUT: 0.45, OTHER: 0.03,
            });
        }

        const post = postPAState(curState, outcome);

        sequence.push({
            pa_index:    pa,
            inning:      curState.inning,
            half:        curState.half,
            outs_before: curState.outs,
            bases_before:curState.bases,
            home_lead_before: curState.home_lead,
            batter:      batter?.name || null,
            batter_id:   batter?.mlbam || null,
            pitcher:     pitcher?.name || null,
            pitcher_id:  pitcher?.mlbam || null,
            outcome,
            we_after:    post.terminal !== undefined
                ? post.terminal
                : lookupWE(post.inning, post.half, post.outs, post.bases, post.home_lead),
        });

        // Did the half flip during this PA? If yes, swap batting/pitching
        // teams and reset paInInning. The pitcher sequence we built only
        // covers the team we modeled — when the half flips, we keep the
        // same pitcher slot (i.e. "your starter keeps pitching when your
        // team is in the field too" — yes, this is silly but for v1 it's
        // a simplification).
        if (post.half !== curState.half) {
            // Half flipped — switch teams. Lineup pointer for the new
            // batting team would be a new index; we don't track the
            // opposing lineup, so just continue with the same batterIdx
            // for now. This is the v1 simplification.
            paInInning = 0;
            curPitcherIdx = advancePitcher(
                pitcherSequence, curPitcherIdx,
                post.inning, curState.inning,
            );
            pitcherPaCount = 0;
        } else {
            paInInning += 1;
            pitcherPaCount += 1;
        }

        // Pitcher change mid-half on pitch-count threshold (rule-based).
        if (pitcherPaCount * 4 > 15 && curPitcherIdx < pitcherSequence.length - 1) {
            // Rough: 4 pitches per PA on average; if the current pitcher
            // has likely thrown 15+ pitches since taking over (≥4 PAs),
            // and we have a reliever queued, swap.
            if (pitcher?.role === "current_starter" &&
                (pitcherSequence[0].pitches_thrown + pitcherPaCount * 4) > STARTER_PITCH_LIMIT) {
                curPitcherIdx += 1;
                pitcherPaCount = 0;
            }
        }

        curState = post;
        curBatterIdx += 1;

        if (pa === MAX_SIMULATION_PAS - 1) {
            terminatedReason = "max_pas_reached";
        }
    }

    // Final WE for this Monte Carlo path:
    //   - If we exited the loop because the game terminated (walk-off,
    //     mercy out, top-9+ closeout), terminalWE returns 1.0 / 0.0.
    //   - Otherwise we hit MAX_SIMULATION_PAS — fall back to the last
    //     simulated PA's WE, which reflects the score margin we got to.
    const terminalCheck = terminalWE(curState);
    const lastSim = sequence[sequence.length - 1];
    const finalWE = terminalCheck !== null
        ? terminalCheck
        : (lastSim?.we_after ?? 0.5);

    // Per-pitcher rollup for the UI: how many PAs each pitcher saw,
    // and the WE at the moment they left the game.
    const pitcherSummary = pitcherSequence.map((p) => {
        const pas = sequence.filter((s) => s.pitcher_id === p.mlbam);
        return {
            mlbam:        p.mlbam,
            name:         p.name,
            role:         p.role,
            pa_count:     pas.length,
            we_at_exit:   pas.length ? pas[pas.length - 1].we_after : null,
        };
    });

    return { sequence, finalWE, pitcherSummary, terminatedReason };
}

function pickPitcher(sequence, idx, inning) {
    // Bound the index — if we've blown past the sequence (extras with
    // no more arms), keep the last pitcher in the rotation.
    return sequence[Math.min(idx, sequence.length - 1)] || null;
}

function advancePitcher(sequence, idx, newInning, oldInning) {
    // Simple rule: each inning advance moves us forward in the bullpen
    // sequence, capped at the closer.
    if (newInning > oldInning) {
        return Math.min(idx + 1, sequence.length - 1);
    }
    return idx;
}

// Sample an outcome from a probability distribution. Uses cumulative
// probability + a uniform random draw — standard categorical sampler.
function sampleOutcome(distribution) {
    const total = OUTCOMES.reduce((s, o) => s + (distribution[o] ?? 0), 0);
    if (total <= 0) return "OUT";
    let r = Math.random() * total;
    for (const o of OUTCOMES) {
        r -= (distribution[o] ?? 0);
        if (r <= 0) return o;
    }
    return OUTCOMES[OUTCOMES.length - 1];
}


// ── state transition + WE lookups ─────────────────────────────────

// Returns 1.0, 0.0, or null. 1.0 = home wins, 0.0 = away wins, null = game ongoing.
function terminalWE(state) {
    // Walk-off: home took the lead in the bottom of the 9th+.
    if (state.inning >= 9 && state.half === "bottom" && state.home_lead > 0) {
        return 1.0;
    }
    // Mercy / 3rd-out close-out scenarios are evaluated inside postPAState's
    // out-counting logic; if we ever sit in a 3-out state with score
    // diff, the game has ended.
    if (state.outs >= 3 && state.inning >= 9) {
        if (state.half === "bottom" && state.home_lead < 0) return 0.0;
        if (state.half === "top"    && state.home_lead > 0) return 1.0;
    }
    return null;
}

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
            outsChange = 1;
            break;
        case "BB":
        case "HBP":
            new_bases = 1;
            if (on1) {
                new_bases |= 2;
                if (on2) {
                    new_bases |= 4;
                    if (on3) runs = 1;
                }
            }
            if (!on1) {
                if (on2) new_bases |= 2;
                if (on3) new_bases |= 4;
            }
            break;
        case "1B":
            new_bases = 1;
            if (on1) new_bases |= 2;
            if (on2) runs += 1;
            if (on3) runs += 1;
            break;
        case "2B":
            new_bases = 2;
            if (on1) new_bases |= 4;
            if (on2) runs += 1;
            if (on3) runs += 1;
            break;
        case "3B":
            new_bases = 4;
            runs += popcount(bases);
            break;
        case "HR":
            new_bases = 0;
            runs += popcount(bases) + 1;
            break;
    }

    if (batting_team === "home") home_lead += runs;
    else                         home_lead -= runs;

    if (inning >= 9 && half === "bottom" && home_lead > 0) {
        return {
            inning, half, outs: outs + outsChange, bases: new_bases,
            home_lead, batting_team, terminal: 1.0,
        };
    }

    outs += outsChange;
    if (outs >= 3) {
        if (inning >= 9 && half === "bottom" && home_lead < 0) {
            return {
                inning, half, outs: 3, bases: new_bases,
                home_lead, batting_team, terminal: 0.0,
            };
        }
        if (inning >= 9 && half === "top" && home_lead > 0) {
            return {
                inning, half, outs: 3, bases: new_bases,
                home_lead, batting_team, terminal: 1.0,
            };
        }
        // Normal half-flip. Since MLB's 2020 rule change, the 10th+
        // inning starts with a runner on 2nd (the "ghost runner" /
        // "Manfred man") — set bases = 2 when flipping into extras so
        // the forward simulation reads from the right state.
        if (half === "bottom") inning += 1;
        half = HALF_FLIP[half];
        outs = 0;
        new_bases = inning >= 10 ? 2 : 0;
        batting_team = batting_team === "home" ? "away" : "home";
    }

    return { inning, half, outs, bases: new_bases, home_lead, batting_team };
}

function lookupWE(inning, half, outs, bases, homeLead) {
    const innC  = clip(inning, 1, 9);
    const leadC = clip(homeLead, LEAD_CLIP[0], LEAD_CLIP[1]);
    const k2 = `${innC}|${half}|${outs}|${bases}|${leadC}`;
    if (WE_TABLE_V2[k2] !== undefined) return WE_TABLE_V2[k2];
    const k1 = `${innC}|${half}|${leadC}`;
    if (WE_TABLE[k1] !== undefined) return WE_TABLE[k1];
    return null;
}


// ── HTTP plumbing ──────────────────────────────────────────────────

function jsonResponse(body, maxAge) {
    return new Response(JSON.stringify(body), {
        headers: {
            "content-type":  "application/json",
            "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
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
