// /api/edges
//
// Ranked list of player-prop edges across today's slate, where
// 'edge' = |our_model_probability - market_implied_probability|.
//
// Pipeline (server-side, no auth needed):
//   1. /api/games/today  → list of game_pks
//   2. For each game (parallel):
//        /api/game/{id}/markets       → Kalshi player_prop quotes
//        /api/game/{id}/model-props   → our tail probabilities
//   3. For every Kalshi player_prop that we have a model number for:
//        market_p_yes = outcomes[yes].probability
//        our_p_yes    = modelProps[mlbam][stat][threshold]
//        edge_pp      = (our_p - market_p) * 100  (positive = YES is mispriced)
//        side         = 'yes' or 'no' depending on sign
//   4. Sort by |edge_pp| descending, return all positive edges.
//
// Cached 60s — model probs only meaningfully shift between PAs and
// Kalshi prices move on a similar cadence.

const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";

export async function onRequest(context) {
    const origin = new URL(context.request.url).origin;

    // 1. Today's games — but only the ones where edges actually
    //    matter. Pregame and final games don't have meaningful
    //    in-game model adjustments; including them would just
    //    burn CPU on dead fan-outs. Caps the total to keep us
    //    inside Cloudflare Workers' per-request CPU budget.
    let games;
    try {
        const res = await fetch(`${origin}/api/games/today`);
        if (!res.ok) throw new Error(`games/today ${res.status}`);
        const data = await res.json();
        games = (data?.games || [])
            .filter((g) => g.game_pk)
            .filter((g) => g.status === "Live" || g.status === "In Progress")
            .slice(0, 10);   // hard cap — at 10 games × 2 fetches we
                              // fit comfortably under the 50ms CPU cap
    } catch (e) {
        return jsonError(502, `games fetch failed: ${e.message || e}`);
    }
    if (!games.length) {
        return jsonResponse({
            edges: [],
            counted_games: 0,
            note: "no live games right now",
            fetched_at: new Date().toISOString(),
        });
    }

    // 2. Per-game fetch fan-out.
    const perGame = await Promise.allSettled(games.map(async (g) => {
        const [marketsRes, modelRes] = await Promise.all([
            fetch(`${origin}/api/game/${g.game_pk}/markets`),
            fetch(`${origin}/api/game/${g.game_pk}/model-props`),
        ]);
        const markets    = marketsRes.ok ? await marketsRes.json() : null;
        const modelProps = modelRes.ok    ? await modelRes.json()    : null;
        return { game: g, markets, modelProps };
    }));

    // 3. For each game, extract every prop with both sides priced
    //    AND a matching model number. Compute edge per prop.
    const edges = [];
    for (const r of perGame) {
        if (r.status !== "fulfilled") continue;
        const { game, markets, modelProps } = r.value;
        if (!markets || !modelProps?.model_props) continue;
        const nameToMlbam = modelProps.name_to_mlbam || {};
        const modelData   = modelProps.model_props   || {};
        const kalshiPP = (markets.markets?.player_prop || [])
            .filter((m) => m.source === "kalshi");
        for (const m of kalshiPP) {
            const parsed = parsePropTitle(m.title || "");
            if (!parsed) continue;
            const mlbam = nameToMlbam[normName(parsed.player)];
            if (!mlbam) continue;
            const ladder = modelData[mlbam]?.[parsed.stat];
            if (!ladder) continue;
            const our_p_yes = ladder[parsed.threshold];
            if (typeof our_p_yes !== "number") continue;
            // Market YES probability — pulled from the outcomes
            // array shape produced by _markets.js. Falls back to
            // 1 - outcome[no].probability when only one side has
            // a quote.
            const yesOutcome = (m.outcomes || []).find(
                (o) => /^yes\b|^Yes\b/.test(o.name) || /:yes$/.test(o.id || "")
            );
            const noOutcome = (m.outcomes || []).find(
                (o) => /^no\b|^No\b/.test(o.name) || /:no$/.test(o.id || "")
            );
            const market_p_yes =
                (yesOutcome && typeof yesOutcome.probability === "number")
                    ? yesOutcome.probability
                    : (noOutcome && typeof noOutcome.probability === "number"
                        ? (1 - noOutcome.probability)
                        : null);
            if (market_p_yes == null) continue;
            const edge_yes = (our_p_yes - market_p_yes) * 100;
            const side = edge_yes >= 0 ? "yes" : "no";
            const edge_pp = Math.abs(edge_yes);
            const our_p_side    = side === "yes" ? our_p_yes : (1 - our_p_yes);
            const market_p_side = side === "yes" ? market_p_yes : (1 - market_p_yes);

            edges.push({
                rank:        0,                          // assigned after sort
                game_pk:     game.game_pk,
                matchup:     `${game.away}@${game.home}`,
                away_team:   game.away,
                home_team:   game.home,
                game_status: game.status,
                ticker:      m.raw_market_id || m.id || null,
                player:      parsed.player,
                player_id:   mlbam,
                stat:        parsed.stat,
                threshold:   parsed.threshold,
                side,
                our_p:       round4(our_p_side),
                market_p:    round4(market_p_side),
                edge_pp:     round2(edge_pp),
                our_yes:     round4(our_p_yes),
                market_yes:  round4(market_p_yes),
            });
        }
    }

    // 4. Sort by edge magnitude, assign ranks.
    edges.sort((a, b) => b.edge_pp - a.edge_pp);
    for (let i = 0; i < edges.length; i++) edges[i].rank = i + 1;

    return jsonResponse({
        edges,
        counted_games: games.length,
        counted_props: edges.length,
        fetched_at:    new Date().toISOString(),
    });
}


// ── Helpers (mirror the bot's parsePropTitle so any title shape
//    the bot accepts also shows up here) ────────────────────────

function parsePropTitle(title) {
    const m = String(title || "").trim().match(/^(.+?):\s*(\d+)\+\s+(.+?)\??$/);
    if (!m) return null;
    const player    = m[1].trim();
    const threshold = parseInt(m[2], 10);
    const statText  = m[3].toLowerCase().trim();
    let stat = null;
    if (/strikeouts?\b/.test(statText))             stat = "strikeouts";
    else if (/home runs?\b|\bhrs?\b/.test(statText)) stat = "home_runs";
    else if (/total bases?\b/.test(statText))        stat = "total_bases";
    else if (/hits?\b/.test(statText))               stat = "hits";
    if (!stat) return null;
    return { player, threshold, stat };
}

function normName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function round2(x) { return Math.round(x * 100) / 100; }
function round4(x) { return Math.round(x * 10000) / 10000; }

function jsonResponse(body, maxAge = 60) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            "content-type":  "application/json; charset=utf-8",
            "cache-control": `public, max-age=${maxAge}`,
        },
    });
}
function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}
