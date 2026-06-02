// bot-scoring.js
//
// Multi-factor scoring framework for bet decisions and cash-outs.
// Every fire / skip / sell decision routes through scoreBet() or
// scoreCashout() — both return a transparent breakdown of factors,
// their weights, and their probability adjustments. The full
// breakdown is logged to localStorage so we can review at end-of-
// day which factors mattered and which didn't.
//
// Each factor follows the same shape so we can add new ones (H2H,
// recent form, park factors, weather, etc.) without touching the
// orchestrator:
//
//   {
//     name:       'model_edge',     // identifier
//     weight:     1.0,              // confidence in this signal (0..1)
//     value:      { our_p, market_p, edge_pp },
//     adjust_pp:  +3.2,             // how much this factor moves
//                                   // our prob estimate (in pp)
//     present:    true              // whether the signal had data
//   }
//
// Total estimate = baseline (market price) + Σ adjust_pp.
// Confidence = Σ weight (capped at 1.0 — diminishing returns).
//
// This file is plain ES that loads alongside autobot.js. No bundler.

(function () {
"use strict";

const root = (typeof globalThis !== "undefined") ? globalThis : window;

const LS_DECISIONS = "diamond_context_bot_decisions";
const DECISIONS_MAX = 2000;

// ── Score a buying decision ──────────────────────────────────────
//
// opportunity = {
//   kind:        'moneyline' | 'player_prop',
//   game_pk:     number,
//   matchup:     'NYY@TB',
//   ticker:      string,
//   side:        'yes',
//
//   // BUYER vs market state
//   market_p:    number       // 0..1, market YES price
//   yes_ask_cents: number,
//
//   // Our base model
//   our_p:       number,      // 0..1, our model's belief
//   savant_p:    number | null,
//
//   // For player props
//   player:      string,
//   stat:        string,
//   threshold:   number,
//
//   // Live game state (provided by caller, all optional)
//   inning:      number,
//   game_state:  { turns_remaining, inning, half },
//   pitcher_info:{ pitchesThrown, profile },
// }
async function scoreBet(opportunity) {
    const factors = [];

    // F1 — model edge over market. The headline signal. Weight 1.0.
    factors.push(buildModelEdgeFactor(opportunity));

    // F2 — Savant cross-check (only on moneylines; props have no
    //      Savant equivalent).
    if (opportunity.kind === "moneyline") {
        factors.push(buildSavantFactor(opportunity));
    }

    // F3 — pitcher pitch-count proximity to personal p80. For
    //      pitcher-strikeout props the bet's upside collapses if
    //      the starter is about to be pulled.
    if (opportunity.kind === "player_prop" && opportunity.stat === "strikeouts") {
        factors.push(buildPitchCountFactor(opportunity));
    }

    // F4 — game-state PA-remaining. For hitter props, late innings
    //      mean fewer chances to hit the threshold.
    if (opportunity.kind === "player_prop" && opportunity.stat !== "strikeouts") {
        factors.push(buildPaRemainingFactor(opportunity));
    }

    // F5 — pitcher recent form. Async fetch from
    //      /api/bot/pitcher-recent-form. Used on K-props (K/9
    //      trend) and on moneylines for the starter's recent ERA.
    if ((opportunity.kind === "player_prop" && opportunity.stat === "strikeouts" && opportunity.pitcher_id)
        || (opportunity.kind === "moneyline" && opportunity.bet_team_starter_id)) {
        const pid = opportunity.pitcher_id || opportunity.bet_team_starter_id;
        factors.push(await buildPitcherRecentFormFactor(opportunity, pid));
    }

    // F6 — batter recent form. For hitter props the last 15 games'
    //      OPS shifts our prior up (hot streak) or down (slump).
    if (opportunity.kind === "player_prop"
        && opportunity.stat !== "strikeouts"
        && opportunity.batter_id) {
        factors.push(await buildBatterRecentFormFactor(opportunity));
    }

    // F7 — head-to-head career. Batter vs this pitcher specifically.
    //      Minimum 10 PAs to count; we prefer last-2-years window
    //      when available.
    if (opportunity.kind === "player_prop"
        && opportunity.stat !== "strikeouts"
        && opportunity.batter_id
        && opportunity.pitcher_id) {
        factors.push(await buildH2HFactor(opportunity));
    }

    // Combine. Baseline = market price (cents → 0..1). Each
    // factor adds its adjust_pp; final estimate is clamped 0..1.
    const baseline_p = opportunity.market_p;
    let adjusted_p = baseline_p;
    let confidence = 0;
    const breakdown = [];
    for (const f of factors) {
        if (!f || !f.present) {
            breakdown.push(f || { name: "missing", present: false });
            continue;
        }
        adjusted_p += (f.adjust_pp || 0) / 100;
        confidence += f.weight || 0;
        breakdown.push(f);
    }
    adjusted_p = Math.max(0, Math.min(1, adjusted_p));
    confidence = Math.min(1, confidence / 2);  // 2 factors of full weight = max confidence

    const edge_pp = (adjusted_p - baseline_p) * 100;

    return {
        baseline_p,
        adjusted_p,
        edge_pp,
        confidence,
        factors:   breakdown,
        // Decision is left to the caller — they know the thresholds.
        meta: {
            kind:       opportunity.kind,
            game_pk:    opportunity.game_pk,
            matchup:    opportunity.matchup,
            ticker:     opportunity.ticker,
            stat:       opportunity.stat,
            player:     opportunity.player,
            threshold:  opportunity.threshold,
            scored_at:  new Date().toISOString(),
        },
    };
}

// ── Factor builders ─────────────────────────────────────────────

// Our model's belief vs market. The headline edge.
function buildModelEdgeFactor(opp) {
    if (typeof opp.our_p !== "number" || typeof opp.market_p !== "number") {
        return { name: "model_edge", weight: 0, present: false };
    }
    const edge = (opp.our_p - opp.market_p) * 100;  // pp
    return {
        name:    "model_edge",
        weight:  1.0,
        value:   {
            our_p:    round4(opp.our_p),
            market_p: round4(opp.market_p),
            edge_pp:  round2(edge),
        },
        // Treat our model as the truth; the factor contribution
        // moves the baseline (market) the full distance to our_p.
        adjust_pp: edge,
        present:   true,
    };
}

// Savant — adds confidence when it agrees, subtracts when it
// disagrees. Caps the adjustment at ±2pp so it acts as a
// tiebreaker rather than overriding our primary signal.
function buildSavantFactor(opp) {
    if (typeof opp.savant_p !== "number" || typeof opp.market_p !== "number") {
        return { name: "savant_alignment", weight: 0, present: false };
    }
    const savantEdge = (opp.savant_p - opp.market_p) * 100;
    const ourEdge    = (opp.our_p    - opp.market_p) * 100;
    const sameSign   = Math.sign(savantEdge) === Math.sign(ourEdge);
    // ±2pp gentle nudge: agreement adds, disagreement subtracts.
    const adjust = sameSign ? +1.5 : -1.5;
    return {
        name:    "savant_alignment",
        weight:  0.5,
        value:   {
            savant_p:        round4(opp.savant_p),
            savant_edge_pp:  round2(savantEdge),
            aligned:         sameSign,
        },
        adjust_pp: adjust,
        present:   true,
    };
}

// Pitcher pitch-count proximity to personal p80. If the pitcher
// is past their personal pull point, the K-prop upside is dead.
// Negative adjustment scales with how far past p80 they are.
function buildPitchCountFactor(opp) {
    const info = opp.pitcher_info;
    if (!info || typeof info.pitchesThrown !== "number") {
        return { name: "pitch_count", weight: 0, present: false };
    }
    const pitches = info.pitchesThrown;
    const p80 = info.profile?.p80_pitches || 100;
    // Distance past p80 (negative = still has runway).
    const distance = pitches - p80;
    // -5pp at p80, -10pp at p80+10, +3pp if 20+ pitches under p80.
    let adjust;
    if      (distance >= 10)  adjust = -10;
    else if (distance >=  0)  adjust = -5;
    else if (distance >= -10) adjust = 0;
    else if (distance >= -20) adjust = +2;
    else                       adjust = +3;
    return {
        name:    "pitch_count",
        weight:  0.8,
        value:   {
            pitches_thrown: pitches,
            p80:            p80,
            distance:       distance,
            source:         info.profile ? "personal" : "league_default",
        },
        adjust_pp: adjust,
        present:   true,
    };
}

// Hitter prop game-state factor. Late innings with few PAs left
// = lower probability of accumulating more stats.
function buildPaRemainingFactor(opp) {
    const gs = opp.game_state;
    if (!gs || typeof gs.turns_remaining !== "number") {
        return { name: "pa_remaining", weight: 0, present: false };
    }
    const turns = gs.turns_remaining;
    // 3 turns = no adjust. <1 turn = strongly negative.
    let adjust;
    if      (turns >= 2.5) adjust = +1;
    else if (turns >= 1.5) adjust = 0;
    else if (turns >= 0.5) adjust = -4;
    else                    adjust = -10;
    return {
        name:    "pa_remaining",
        weight:  0.7,
        value:   {
            turns_remaining: round2(turns),
            inning:          gs.inning || null,
        },
        adjust_pp: adjust,
        present:   true,
    };
}


// Pitcher recent form — last 5 starts ERA/K9. Trend-aware.
// On K-props: high K/9 trend → positive adjustment (more Ks expected).
// On moneylines: improving ERA → negative adjustment for the pitcher's
// opponents (your bet on the OPPONENT team gets a haircut).
async function buildPitcherRecentFormFactor(opp, pid) {
    if (!pid) return { name: "pitcher_recent_form", weight: 0, present: false };
    let data;
    try {
        const res = await fetch(`/api/bot/pitcher-recent-form?id=${pid}&starts=5`);
        if (!res.ok) return { name: "pitcher_recent_form", weight: 0, present: false };
        data = await res.json();
    } catch { return { name: "pitcher_recent_form", weight: 0, present: false }; }
    if (!data?.available) return { name: "pitcher_recent_form", weight: 0, present: false };

    let adjust = 0;
    // K-prop adjustment: every +1.0 K/9 above ~9.0 is +1pp on the
    // prop's tail probability. Each 1.0 below is -1pp.
    if (opp.kind === "player_prop" && opp.stat === "strikeouts" && data.k9 != null) {
        adjust = (data.k9 - 9.0) * 1.0;
        if (data.trend === "improving") adjust += 1;
        if (data.trend === "declining") adjust -= 1;
    }
    // Moneyline adjustment: a starter with sub-3.00 ERA trend gets
    // a +pp for HIS side; bleeding 5.00+ gets -pp.
    if (opp.kind === "moneyline" && data.era != null) {
        if      (data.era < 2.50) adjust = +2;
        else if (data.era < 3.50) adjust = +1;
        else if (data.era > 5.00) adjust = -2;
        else if (data.era > 4.00) adjust = -1;
        // 'bet_team_starter_id' tells us whose pitcher this is —
        // if it's OUR team's pitcher, keep adjust as-is (boost our
        // side). If it's the opponent's pitcher, flip sign.
        if (opp.bet_team_starter_is_opponent) adjust = -adjust;
    }
    // Clamp ±5pp.
    adjust = Math.max(-5, Math.min(5, adjust));
    return {
        name:    "pitcher_recent_form",
        weight:  0.6,
        value:   {
            starts_found: data.starts_found,
            era:          data.era,
            k9:           data.k9,
            whip:         data.whip,
            trend:        data.trend,
        },
        adjust_pp: round2(adjust),
        present:   true,
    };
}

// Batter recent form — last 15 games' OPS / ISO. Hot bat → boost
// HR/TB/H props; cold → cut.
async function buildBatterRecentFormFactor(opp) {
    let data;
    try {
        const res = await fetch(`/api/bot/batter-recent-form?id=${opp.batter_id}&window=15`);
        if (!res.ok) return { name: "batter_recent_form", weight: 0, present: false };
        data = await res.json();
    } catch { return { name: "batter_recent_form", weight: 0, present: false }; }
    if (!data?.available || data.games_found < 5) return { name: "batter_recent_form", weight: 0, present: false };

    let adjust = 0;
    const ops = data.ops || 0;
    if      (ops >= 1.000) adjust = +3;
    else if (ops >= 0.850) adjust = +1.5;
    else if (ops >= 0.700) adjust = 0;
    else if (ops >= 0.550) adjust = -1.5;
    else                    adjust = -3;
    if (data.trend === "hot")  adjust += 1;
    if (data.trend === "cold") adjust -= 1;
    adjust = Math.max(-4, Math.min(4, adjust));

    return {
        name:    "batter_recent_form",
        weight:  0.6,
        value:   {
            games_found: data.games_found,
            ops:         data.ops,
            iso:         data.iso,
            k_pct:       data.k_pct,
            trend:       data.trend,
        },
        adjust_pp: round2(adjust),
        present:   true,
    };
}

// Head-to-head career stats (batter vs this pitcher specifically).
// Min 10 PAs to trust the sample. Prefer last-2-years window if
// available — career numbers can include data from when both
// players were different versions of themselves.
async function buildH2HFactor(opp) {
    let data;
    try {
        const res = await fetch(`/api/bot/h2h?batter=${opp.batter_id}&pitcher=${opp.pitcher_id}`);
        if (!res.ok) return { name: "h2h", weight: 0, present: false };
        data = await res.json();
    } catch { return { name: "h2h", weight: 0, present: false }; }
    if (!data?.available) return { name: "h2h", weight: 0, present: false };

    // Pick the window we trust.
    const window = data.recommended_window;
    if (window === "insufficient") return { name: "h2h", weight: 0, present: false };
    const stats = window === "last_2_years" ? data.last_2_years : data.career;
    if (!stats || stats.pa < 10) return { name: "h2h", weight: 0, present: false };

    let adjust = 0;
    const ops = stats.ops || ((stats.obp || 0) + (stats.slg || 0)) || 0;
    if      (ops >= 1.100) adjust = +3;
    else if (ops >= 0.900) adjust = +1.5;
    else if (ops >= 0.700) adjust = 0;
    else if (ops >= 0.500) adjust = -1.5;
    else                    adjust = -3;
    // K-prop check: if batter's H2H K-rate is way above his usual,
    // that's a sign this pitcher OWNS him on K's.
    if (opp.stat === "strikeouts" && stats.k_pct >= 0.35) adjust -= 2;

    // Confidence scales with sample size: 10 PA → 0.4 weight,
    // 30 PA → 0.8, 50+ → 1.0.
    const weight = Math.min(1.0, 0.4 + (stats.pa - 10) / 50 * 0.6);

    return {
        name:    "h2h",
        weight:  round2(weight),
        value:   {
            window,
            pa:    stats.pa,
            avg:   stats.avg,
            obp:   stats.obp,
            slg:   stats.slg,
            ops:   ops || null,
            k_pct: stats.k_pct,
        },
        adjust_pp: round2(adjust),
        present:   true,
    };
}


// ── Cash-out scoring ────────────────────────────────────────────
//
// Parallel framework for cash-out decisions. Each position is
// scored by its own set of factors; the result drives sell vs
// hold the same way scoreBet drives fire vs skip.
//
// position = {
//   ticker, contracts, entry_cents,
//   live_yes_bid_cents, live_yes_ask_cents,
//   placed_at_ts,
//
//   // From the original fire record
//   our_p_at_entry,
//   stat, threshold, player_id,
//   game_pk,
//
//   // Live signals (caller fetches)
//   live_p,                    // our updated model's belief
//   pitch_info,                // { pitchesThrown, profile }
//   game_state,                // { inning, turns_remaining }
// }
async function scoreCashout(position) {
    const factors = [];
    factors.push(buildRealizedProfitFactor(position));
    factors.push(buildModelEdgeRemainingFactor(position));
    factors.push(buildRemovalRiskFactor(position));
    factors.push(buildPaRemainingCashoutFactor(position));
    factors.push(buildTimeInPositionFactor(position));

    // Combine to a sell-score: 0..100. Higher = sell sooner.
    let score = 0;
    let confidence = 0;
    const breakdown = [];
    for (const f of factors) {
        if (!f || !f.present) { breakdown.push(f); continue; }
        score      += f.sell_score || 0;
        confidence += f.weight || 0;
        breakdown.push(f);
    }
    confidence = Math.min(1, confidence / 2.5);
    score = Math.max(0, Math.min(100, score));

    return {
        sell_score: round2(score),
        confidence: round2(confidence),
        factors:    breakdown,
        meta: {
            ticker:     position.ticker,
            scored_at:  new Date().toISOString(),
        },
    };
}

// Profit so far. Higher = more sell pressure (lock in).
function buildRealizedProfitFactor(p) {
    if (p.live_yes_bid_cents == null || p.entry_cents == null) {
        return { name: "realized_profit", weight: 0, present: false };
    }
    const perContract = p.live_yes_bid_cents - p.entry_cents;
    // 0¢ profit → 0 sell points. +5¢ → 10. +10¢ → 20. +15¢ → 35.
    // +20¢ → 50. Caps at 60.
    let sell = 0;
    if      (perContract >= 20) sell = 50 + Math.min(10, perContract - 20);
    else if (perContract >= 15) sell = 35 + (perContract - 15) * 3;
    else if (perContract >= 10) sell = 20 + (perContract - 10) * 3;
    else if (perContract >=  5) sell = 10 + (perContract -  5) * 2;
    else if (perContract >   0) sell = perContract * 2;
    else                         sell = 0;
    return {
        name:    "realized_profit",
        weight:  0.8,
        value:   { per_contract_cents: perContract },
        sell_score: sell,
        present:   true,
    };
}

// Model edge remaining. If live model fair is barely above market,
// little upside left → sell.
function buildModelEdgeRemainingFactor(p) {
    if (p.live_p == null || p.live_yes_bid_cents == null) {
        return { name: "model_edge_remaining", weight: 0, present: false };
    }
    const liveFairCents = p.live_p * 100;
    const remainingPp = liveFairCents - p.live_yes_bid_cents;
    // 0pp left → 30 sell points. Negative (we'd LOSE on continuation)
    // → up to 50. 5pp+ remaining → 0 sell points.
    let sell;
    if      (remainingPp <= 0)  sell = 50;
    else if (remainingPp <= 2)  sell = 30;
    else if (remainingPp <= 5)  sell = 15;
    else                         sell = 0;
    return {
        name:    "model_edge_remaining",
        weight:  0.7,
        value:   { live_fair_cents: round2(liveFairCents), remaining_pp: round2(remainingPp) },
        sell_score: sell,
        present:   true,
    };
}

// Pitcher removal risk — only matters for K-prop positions.
function buildRemovalRiskFactor(p) {
    if (p.stat !== "strikeouts" || !p.pitch_info?.pitchesThrown) {
        return { name: "removal_risk", weight: 0, present: false };
    }
    const pitches = p.pitch_info.pitchesThrown;
    const p80 = p.pitch_info.profile?.p80_pitches || 100;
    const distance = pitches - p80;
    let sell;
    if      (distance >= 10) sell = 40;
    else if (distance >=  0) sell = 25;
    else if (distance >= -10) sell = 10;
    else                       sell = 0;
    return {
        name:    "removal_risk",
        weight:  0.7,
        value:   { pitches_thrown: pitches, p80, distance },
        sell_score: sell,
        present:   true,
    };
}

// Remaining PAs for hitter props — late innings = high sell pressure.
function buildPaRemainingCashoutFactor(p) {
    if (p.stat === "strikeouts" || !p.game_state || typeof p.game_state.turns_remaining !== "number") {
        return { name: "pa_remaining_cashout", weight: 0, present: false };
    }
    const turns = p.game_state.turns_remaining;
    let sell;
    if      (turns < 0.3) sell = 40;
    else if (turns < 1.0) sell = 15;
    else if (turns < 2.0) sell = 5;
    else                   sell = 0;
    return {
        name:    "pa_remaining_cashout",
        weight:  0.6,
        value:   { turns_remaining: turns },
        sell_score: sell,
        present:   true,
    };
}

// Time in position — small opportunity-cost factor.
function buildTimeInPositionFactor(p) {
    if (!p.placed_at_ts) return { name: "time_in_position", weight: 0, present: false };
    const minutesHeld = (Date.now() - p.placed_at_ts) / 60000;
    // Held > 2hrs with modest profit → mild sell pressure to free
    // capital. Held < 30min → no rush.
    let sell = 0;
    if      (minutesHeld > 180) sell = 8;
    else if (minutesHeld > 120) sell = 5;
    else if (minutesHeld >  60) sell = 2;
    return {
        name:    "time_in_position",
        weight:  0.3,
        value:   { minutes_held: Math.round(minutesHeld) },
        sell_score: sell,
        present:   true,
    };
}


// ── Auto-tuning suggestor ───────────────────────────────────────
//
// Scans the EOD report's factor_rollup and recommends weight
// adjustments. Conservative: never auto-applies. Returns
// suggestions the user can review.
//
//   Input: factorRollup from /api/bot/eod-review
//          [{ name, dir, wins, losses, total, win_rate }, ...]
//   Output: [{ factor, current_weight, suggested_weight, reason,
//              sample_size }, ...]
//
// Heuristic:
//   - Need ≥ 30 settled bets per factor before suggesting.
//   - If win rate when factor was positive < 45% → reduce weight.
//   - If win rate when factor was positive > 65% → increase weight.
//   - Cap weight ±20% change per suggestion (gentle).
function suggestWeightAdjustments(factorRollup, currentWeights = {}) {
    const suggestions = [];
    const byName = {};
    for (const r of (factorRollup || [])) {
        if (r.dir !== "pos") continue;        // only score "positive direction" cells
        byName[r.name] = (byName[r.name] || { wins: 0, losses: 0 });
        byName[r.name].wins   += r.wins;
        byName[r.name].losses += r.losses;
    }
    for (const [name, agg] of Object.entries(byName)) {
        const total = agg.wins + agg.losses;
        if (total < 30) continue;             // not enough sample
        const winRate = agg.wins / total;
        const current = currentWeights[name] || 1.0;
        let suggested = current;
        let reason = null;
        if (winRate < 0.45) {
            suggested = Math.max(0.1, current * 0.85);
            reason = `Win rate ${(winRate*100).toFixed(0)}% over ${total} bets — reduce by 15%`;
        } else if (winRate > 0.65) {
            suggested = Math.min(2.0, current * 1.15);
            reason = `Win rate ${(winRate*100).toFixed(0)}% over ${total} bets — increase by 15%`;
        }
        if (reason) {
            suggestions.push({
                factor:           name,
                current_weight:   round2(current),
                suggested_weight: round2(suggested),
                reason,
                sample_size:      total,
                win_rate:         round2(winRate),
            });
        }
    }
    return suggestions;
}


// ── Decision log persistence ────────────────────────────────────

// Append a scored decision to localStorage. Captures the full
// factor breakdown PLUS what we decided (fire / skip + reason).
// Used by the EOD review to grade decisions against outcomes.
function logScoredDecision(score, decision) {
    let arr;
    try { arr = JSON.parse(localStorage.getItem(LS_DECISIONS) || "[]"); }
    catch { arr = []; }
    arr.unshift({
        ...score,
        decision: decision || { action: "unknown" },
    });
    if (arr.length > DECISIONS_MAX) arr.length = DECISIONS_MAX;
    try { localStorage.setItem(LS_DECISIONS, JSON.stringify(arr)); } catch {}
}

function getScoredDecisions(limit = 500) {
    try {
        const arr = JSON.parse(localStorage.getItem(LS_DECISIONS) || "[]");
        return Array.isArray(arr) ? arr.slice(0, limit) : [];
    } catch { return []; }
}

function clearScoredDecisions() {
    try { localStorage.removeItem(LS_DECISIONS); } catch {}
}


// ── Helpers ─────────────────────────────────────────────────────

function round2(x) { return Math.round(x * 100) / 100; }
function round4(x) { return Math.round(x * 10000) / 10000; }


// Expose globally so autobot.js can call without an import.
root.BotScoring = {
    scoreBet,
    scoreCashout,
    suggestWeightAdjustments,
    logScoredDecision,
    getScoredDecisions,
    clearScoredDecisions,
    LS_DECISIONS,
};

})();
