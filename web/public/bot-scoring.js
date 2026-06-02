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
    logScoredDecision,
    getScoredDecisions,
    clearScoredDecisions,
    LS_DECISIONS,
};

})();
