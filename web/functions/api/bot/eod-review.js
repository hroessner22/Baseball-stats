// /api/bot/eod-review
//
// End-of-day learning loop. The bot persists every SCORED decision
// (fire OR skip with reason) to localStorage; the user POSTs that
// log here along with their date-range. We pull the matching
// Kalshi settlements (when available — the client sends those
// too since the worker has no Kalshi auth) and produce:
//
//   1. Per-decision grade: WON / LOST / OPEN
//   2. Factor calibration: which factors correlated with wins,
//      which with losses, and which were inert.
//   3. Skip analysis: of the bets we DIDN'T take, which would
//      have won. If a particular skip-reason consistently misses
//      winners, that's a tuning signal.
//
// This is a thin compute endpoint — no persistence on the worker
// side. The client owns the decision log; we just crunch and
// return analysis. Lets us iterate the analysis without touching
// data.

export async function onRequest(context) {
    const req = context.request;
    if (req.method !== "POST") return jsonError(405, "POST only");
    let body;
    try { body = await req.json(); }
    catch { return jsonError(400, "invalid JSON"); }

    const decisions   = Array.isArray(body.decisions)   ? body.decisions   : [];
    const settlements = Array.isArray(body.settlements) ? body.settlements : [];
    if (!decisions.length) return jsonResponse({
        empty: true,
        msg:   "no decisions provided",
    });

    // Build ticker → settlement map.
    const settleByTicker = new Map();
    for (const s of settlements) {
        if (s.ticker) settleByTicker.set(s.ticker, s);
    }

    // Grade each decision.
    const graded = decisions.map((d) => grade(d, settleByTicker));

    // Roll up factor stats — for each factor, win-rate among fires
    // when the factor was positive vs negative vs absent.
    const factorRollup = rollupFactors(graded);
    // Skip analysis — among SKIP decisions, what would have happened?
    const skipAnalysis = analyzeSkips(graded);
    // Top-line: fired vs settled vs P&L.
    const summary = summarize(graded);

    return jsonResponse({
        date_range:    body.date_range || null,
        summary,
        factor_rollup: factorRollup,
        skip_analysis: skipAnalysis,
        graded,
    });
}

function grade(decision, settleByTicker) {
    const action = decision?.decision?.action;
    const ticker = decision?.decision?.ticker || decision?.meta?.ticker;
    if (!ticker) return { ...decision, grade: { state: "UNKNOWN" } };
    const settle = settleByTicker.get(ticker);
    if (!settle) {
        return { ...decision, grade: { state: action === "fire" ? "OPEN" : "UNSETTLED" } };
    }
    const yesCount = Number(settle.yes_count) || 0;
    const revenue  = Number(settle.revenue)   || 0;
    const won = settle.market_result === "yes" && yesCount > 0;
    if (action === "fire") {
        const cost = (decision.decision.contracts || 1) * (decision.decision.price_cents || 0);
        const pnl  = revenue - cost;
        return { ...decision, grade: { state: won ? "WON" : "LOST", pnl_cents: pnl } };
    }
    // SKIP decisions: the would-be outcome.
    return { ...decision, grade: { state: won ? "MISSED_WIN" : "AVOIDED_LOSS" } };
}

function rollupFactors(graded) {
    // For each factor name, count wins/losses when its adjustment
    // was positive vs negative. Inert factors (always 0) drop out.
    const fires = graded.filter((d) => d.decision?.action === "fire");
    const byFactor = {};
    for (const d of fires) {
        const state = d.grade?.state;
        if (state !== "WON" && state !== "LOST") continue;
        for (const f of d.factors || []) {
            if (!f.name || !f.present) continue;
            const dir = (f.adjust_pp > 0) ? "pos" : (f.adjust_pp < 0 ? "neg" : "zero");
            const bucket = `${f.name}:${dir}`;
            byFactor[bucket] = byFactor[bucket] || { name: f.name, dir, wins: 0, losses: 0 };
            if (state === "WON") byFactor[bucket].wins += 1;
            else byFactor[bucket].losses += 1;
        }
    }
    return Object.values(byFactor).map((b) => ({
        ...b,
        total:    b.wins + b.losses,
        win_rate: b.wins / Math.max(1, (b.wins + b.losses)),
    })).sort((a, b) => b.total - a.total);
}

function analyzeSkips(graded) {
    // Skip decisions grouped by reason — calculate would-be win rate.
    const skips = graded.filter((d) => d.decision?.action === "skip");
    const byReason = {};
    for (const s of skips) {
        const reason = s.decision?.reason || "unknown";
        byReason[reason] = byReason[reason] || { reason, missed_wins: 0, avoided_losses: 0, unsettled: 0 };
        if (s.grade?.state === "MISSED_WIN")     byReason[reason].missed_wins   += 1;
        else if (s.grade?.state === "AVOIDED_LOSS") byReason[reason].avoided_losses += 1;
        else                                     byReason[reason].unsettled    += 1;
    }
    return Object.values(byReason).map((r) => {
        const settled = r.missed_wins + r.avoided_losses;
        return {
            ...r,
            total: settled + r.unsettled,
            // Hit rate IF we had fired instead of skipping.
            would_be_win_rate: settled ? r.missed_wins / settled : null,
        };
    }).sort((a, b) => b.total - a.total);
}

function summarize(graded) {
    const fires    = graded.filter((d) => d.decision?.action === "fire");
    const settled  = fires.filter((d) => d.grade?.state === "WON" || d.grade?.state === "LOST");
    const wins     = settled.filter((d) => d.grade.state === "WON");
    const losses   = settled.filter((d) => d.grade.state === "LOST");
    const totalPnl = settled.reduce((s, d) => s + (d.grade.pnl_cents || 0), 0);
    return {
        decisions_total: graded.length,
        fires:           fires.length,
        fires_settled:   settled.length,
        fires_open:      fires.length - settled.length,
        wins:            wins.length,
        losses:          losses.length,
        win_rate:        settled.length ? wins.length / settled.length : null,
        net_pnl_cents:   totalPnl,
        net_pnl_dollars: totalPnl / 100,
        skips:           graded.length - fires.length,
    };
}


// ── Tiny utilities ───────────────────────────────────────────────

function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}
function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}
