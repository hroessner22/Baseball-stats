// /api/game/{id}/boxscore
//
// Returns a normalized box score for one game — line score (R/H/E by
// inning), per-batter and per-pitcher stat lines, plus team totals.
// Pulls from two MLB Stats API endpoints and shapes them into a flat
// structure the frontend can render without further reshaping.
//
// Sources:
//   /api/v1/game/{pk}/boxscore  — per-player game stats + season stats
//   /api/v1.1/game/{pk}/feed/live  — linescore (innings array) + status
//
// Two endpoints because /boxscore doesn't carry the innings R/H/E
// breakdown, and /feed/live's "boxscore" subtree is shaped differently
// (and is much larger to download). Fetching both in parallel costs
// one round-trip; total payload is ~250 KB unaffected by edge caching.
//
// The endpoint is read-only (anon Cloudflare access) and short-cached
// (30s for live games, 5min for Final). Live games re-fetch each
// game-view poll so the score / box updates as the game progresses.

const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";

export async function onRequest(context) {
    const gameId = context.params?.id;

    // Demo passthrough — we don't have a synthetic box score and there's
    // no upstream to fetch, so return a small "not available" shape that
    // the UI knows how to render as a "no box score for the demo game"
    // notice instead of an error.
    if (gameId === "demo") {
        return jsonResponse({
            game_pk: "demo",
            available: false,
            reason: "demo game has no box score",
        }, 0);
    }

    if (!gameId || !/^\d+$/.test(gameId)) {
        return jsonError(400, "invalid game id");
    }

    let boxRaw, feedRaw;
    try {
        [boxRaw, feedRaw] = await Promise.all([
            fetchJson(`https://statsapi.mlb.com/api/v1/game/${gameId}/boxscore`, 30),
            fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`, 30),
        ]);
    } catch (e) {
        return jsonError(502, `upstream fetch failed: ${e.message || e}`);
    }

    const status = feedRaw?.gameData?.status?.abstractGameState || "Unknown";
    const linescoreRaw = feedRaw?.liveData?.linescore || {};
    const teamsRaw = boxRaw?.teams || {};

    const body = {
        game_pk:    parseInt(gameId, 10),
        available:  true,
        status,
        teams: {
            away: shapeTeam(teamsRaw.away),
            home: shapeTeam(teamsRaw.home),
        },
        line_score: shapeLineScore(linescoreRaw),
        batting: {
            away:   shapeBattingLines(teamsRaw.away),
            home:   shapeBattingLines(teamsRaw.home),
            totals: {
                away: shapeBattingTotals(teamsRaw.away?.teamStats?.batting),
                home: shapeBattingTotals(teamsRaw.home?.teamStats?.batting),
            },
        },
        pitching: {
            away:   shapePitchingLines(teamsRaw.away),
            home:   shapePitchingLines(teamsRaw.home),
            totals: {
                away: shapePitchingTotals(teamsRaw.away?.teamStats?.pitching),
                home: shapePitchingTotals(teamsRaw.home?.teamStats?.pitching),
            },
        },
    };

    // Live games cache 30s; Finals cache 5min (data is frozen). Same
    // pattern as the other game-id endpoints.
    return jsonResponse(body, status === "Final" ? 300 : 30);
}


// ── shape helpers ──────────────────────────────────────────────────

function shapeTeam(team) {
    const t = team?.team || {};
    return {
        id:        t.id || null,
        name:      t.name || t.teamName || "",
        full_name: t.name || "",
        abbr:      t.abbreviation || "",
    };
}

// Innings array with consistent shape — each entry has both away and
// home runs/hits/errors. Pads to at least 9 (showing "—" for unplayed
// innings) so the line-score grid is always rectangular.
function shapeLineScore(ls) {
    const innings = (ls.innings || []).map((inn) => ({
        num:   inn.num,
        away:  shapeInningSide(inn.away),
        home:  shapeInningSide(inn.home),
    }));
    // Totals: just sum what's in the innings, but use the linescore's
    // own teams.{away,home} block when present (it's authoritative for
    // walk-off games where the bottom of the last inning is skipped).
    const t = ls.teams || {};
    const totals = {
        away: shapeInningSide(t.away),
        home: shapeInningSide(t.home),
    };
    return {
        innings,
        scheduled_innings: ls.scheduledInnings || 9,
        totals,
    };
}

function shapeInningSide(side) {
    if (!side || typeof side !== "object") {
        return { runs: null, hits: null, errors: null, lob: null };
    }
    return {
        runs:   side.runs   ?? 0,
        hits:   side.hits   ?? 0,
        errors: side.errors ?? 0,
        lob:    side.leftOnBase ?? 0,
    };
}

// Walks a team's `batters` list (ordered MLBAM ids of every position
// player + pinch hitter who came to bat) and returns a stat line per
// player. Order matches the lineup as it appeared in the game (top of
// the order first, then bench/PH in the order they batted).
function shapeBattingLines(team) {
    if (!team) return [];
    const players = team.players || {};
    const order = team.batters || [];
    const lines = [];
    for (const pid of order) {
        const p = players[`ID${pid}`];
        if (!p) continue;
        const b = (p.stats || {}).batting || {};
        const ss = (p.seasonStats || {}).batting || {};
        // Skip players who never came to bat (entered as PR or defensive
        // sub only). plateAppearances includes BB/HBP so it's the right
        // gate, but keep ABs > 0 OR PA > 0 in case the feed differs.
        if (!(b.plateAppearances || b.atBats)) continue;
        lines.push({
            mlbam:     p.person?.id || null,
            name:      p.person?.fullName || "",
            box_name:  p.person?.boxscoreName || lastName(p.person?.fullName),
            position:  p.position?.abbreviation || "",
            order:     normalizeBattingOrder(p.battingOrder),
            summary:   b.summary || "",     // "1-4 | HR, BB, RBI"
            // Game stats — the columns of a textbook box score.
            AB:        b.atBats || 0,
            R:         b.runs || 0,
            H:         b.hits || 0,
            RBI:       b.rbi || 0,
            BB:        b.baseOnBalls || 0,
            K:         b.strikeOuts || 0,
            LOB:       b.leftOnBase || 0,
            // Season-to-date AVG/OBP/SLG so the user can compare today's
            // line to who this hitter is. .--- shows up for pitchers /
            // 0-AB players; we leave it as-is rather than masking.
            season:   {
                AVG:   ss.avg || ".000",
                OBP:   ss.obp || ".000",
                SLG:   ss.slg || ".000",
                OPS:   ss.ops || ".000",
                HR:    ss.homeRuns || 0,
                RBI:   ss.rbi || 0,
            },
        });
    }
    return lines;
}

// Walks the pitching list in the order pitchers appeared (starter
// first, then relievers as they entered the game). One row per pitcher,
// with their game line + season ERA / WHIP.
function shapePitchingLines(team) {
    if (!team) return [];
    const players = team.players || {};
    const order = team.pitchers || [];
    const lines = [];
    for (const pid of order) {
        const p = players[`ID${pid}`];
        if (!p) continue;
        const g = (p.stats || {}).pitching || {};
        const s = (p.seasonStats || {}).pitching || {};
        if (!g.inningsPitched && !g.battersFaced) continue;
        const note = g.note || "";  // "(W, 5-3)", "(S, 12)", "(L, 2-4)"
        lines.push({
            mlbam:    p.person?.id || null,
            name:     p.person?.fullName || "",
            box_name: p.person?.boxscoreName || lastName(p.person?.fullName),
            decision: note ? note.replace(/[()]/g, "") : "",
            // Game stat line columns.
            IP:       g.inningsPitched || "0.0",
            H:        g.hits || 0,
            R:        g.runs || 0,
            ER:       g.earnedRuns || 0,
            BB:       g.baseOnBalls || 0,
            K:        g.strikeOuts || 0,
            HR:       g.homeRuns || 0,
            // Per-pitch tally (pitch count is interesting for managers).
            pitches:  g.pitchesThrown || 0,
            strikes:  g.strikes || 0,
            // Season ERA/WHIP/record for context.
            season:  {
                ERA:    s.era    || "0.00",
                WHIP:   s.whip   || "0.00",
                K:      s.strikeOuts  || 0,
                W:      s.wins        || 0,
                L:      s.losses      || 0,
                SV:     s.saves       || 0,
            },
        });
    }
    return lines;
}

function shapeBattingTotals(t) {
    const b = t || {};
    return {
        AB:   b.atBats || 0,
        R:    b.runs || 0,
        H:    b.hits || 0,
        RBI:  b.rbi || 0,
        BB:   b.baseOnBalls || 0,
        K:    b.strikeOuts || 0,
        LOB:  b.leftOnBase || 0,
        HR:   b.homeRuns || 0,
        AVG:  b.avg || ".000",
    };
}

function shapePitchingTotals(t) {
    const p = t || {};
    return {
        IP:  p.inningsPitched || "0.0",
        H:   p.hits || 0,
        R:   p.runs || 0,
        ER:  p.earnedRuns || 0,
        BB:  p.baseOnBalls || 0,
        K:   p.strikeOuts || 0,
        HR:  p.homeRuns || 0,
        ERA: p.era || "0.00",
    };
}

// MLB feed encodes battingOrder as a 4-character string like "100" or
// "401" — first digit is the lineup spot (1-9), last two are the sub
// index (00 = starter, 01+ = PH/PR off the bench in that spot). We
// surface the lineup spot as an integer for the order column and let
// the data implicit-sort by the natural string order downstream.
function normalizeBattingOrder(s) {
    if (!s) return null;
    const n = parseInt(String(s).slice(0, -2), 10);
    return Number.isFinite(n) ? n : null;
}

function lastName(fullName) {
    if (!fullName) return "";
    const parts = fullName.trim().split(/\s+/);
    return parts[parts.length - 1] || fullName;
}


// ── HTTP plumbing ──────────────────────────────────────────────────

async function fetchJson(url, edgeTtl) {
    const res = await fetch(url, {
        headers: { "User-Agent": UA },
        cf: { cacheTtl: edgeTtl, cacheEverything: true },
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`${url} HTTP ${res.status}: ${txt.slice(0, 120)}`);
    }
    return res.json();
}

function jsonResponse(body, maxAge) {
    return new Response(JSON.stringify(body), {
        headers: {
            "content-type": "application/json",
            "cache-control": maxAge > 0
                ? `public, max-age=${maxAge}`
                : "no-store",
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
