// /api/player/{mlbam}/tonight
//
// "What should we expect from this player in today's game?"
//
// Returns { available: false } when the player has no game today.
// When they do, returns the projected line — expected hits / HRs /
// walks / strikeouts based on the matchup engine (the same one that
// powers live game predictions) × the number of PAs they're likely
// to get (estimated from their lineup spot). Plus recent form (last
// 7 / 30 days), head-to-head career vs tonight's starter, and a
// hit streak indicator.
//
// This is the player-facing surface for everything we've built today:
// the engine outputs P(K), P(BB), ..., P(HR) per PA; multiply by
// expected PAs → expected_line. Same matchup math the WE chart
// already uses for forecasts.

const PA_ESTIMATE_BY_LINEUP_SPOT = {
    1: 4.6, 2: 4.5, 3: 4.4, 4: 4.3, 5: 4.2,
    6: 4.1, 7: 4.0, 8: 3.9, 9: 3.8,
};
const DEFAULT_EXPECTED_PAS = 4.2;


export async function onRequest(context) {
    const env = context.env || {};
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return jsonError(500, "supabase not configured");
    }

    const mlbam = parseInt(context.params?.mlbam, 10);
    if (!mlbam || mlbam < 1) {
        return jsonError(400, "invalid mlbam id");
    }

    const origin = new URL(context.request.url).origin;

    try {
        // 1. Get player bio (for team_id) and recent daily_pa rows in
        //    parallel — both feed downstream lookups.
        const [bio, dailyRows] = await Promise.all([
            fetchPlayerBio(mlbam),
            fetchPlayerDaily(env, mlbam),
        ]);

        if (!bio?.team_id) {
            return jsonResponse({
                player_mlbam: mlbam,
                available: false,
                reason: "no current team mapping for this player",
            }, 600);
        }

        // 2. Find today's game for this player's team.
        const todayET = currentDateET();
        const game = await findTeamGame(origin, todayET, bio.team_id);
        if (!game) {
            return jsonResponse({
                player_mlbam: mlbam,
                available: false,
                reason: "no game today for this player's team",
                team: { id: bio.team_id, name: bio.team_name },
                date: todayET,
            }, 300);
        }

        // 3. Pull the live feed to confirm player is in the lineup +
        //    identify the opposing pitcher.
        const lineupContext = await fetchLineupAndOpposingPitcher(
            game.game_pk, mlbam,
        );
        if (!lineupContext.inLineup) {
            return jsonResponse({
                player_mlbam: mlbam,
                available: false,
                reason: "player is not in tonight's lineup (bench / DTD / not playing)",
                game: gameSummary(game),
                date: todayET,
            }, 300);
        }

        // 4. Call our own matchup engine for the predicted outcome
        //    distribution per PA — same math the live game uses.
        let matchup = null;
        if (lineupContext.opposingPitcher?.id) {
            matchup = await fetchMatchup(
                origin, mlbam, lineupContext.opposingPitcher.id,
            );
        }

        // 5. Expected line = predicted per-PA distribution × estimated
        //    PA count from lineup spot.
        const expectedPas =
            PA_ESTIMATE_BY_LINEUP_SPOT[lineupContext.lineupSpot] ??
            DEFAULT_EXPECTED_PAS;
        const expectedLine = matchup?.available
            ? buildExpectedLine(matchup.predicted, expectedPas)
            : null;

        // 6. Recent form windows + head-to-head + streak — all derived
        //    from the same daily_pa rows we already fetched.
        const recentForm = computeRecentForm(dailyRows);
        const headToHead = lineupContext.opposingPitcher?.id
            ? computeHeadToHead(dailyRows, lineupContext.opposingPitcher.id)
            : null;
        const streaks = computeStreaks(dailyRows);

        return jsonResponse({
            player_mlbam: mlbam,
            available: true,
            date: todayET,
            game: gameSummary(game),
            lineup_spot: lineupContext.lineupSpot,
            opponent: lineupContext.opponent,
            opposing_pitcher: lineupContext.opposingPitcher,
            expected_pas: expectedPas,
            expected_line: expectedLine,
            recent_form: recentForm,
            head_to_head: headToHead,
            streaks,
        }, 60);
    } catch (e) {
        return jsonError(502, `${e.message || e}`);
    }
}


// ── data fetches ───────────────────────────────────────────────────

async function fetchPlayerBio(mlbam) {
    try {
        const res = await fetch(
            `https://statsapi.mlb.com/api/v1/people/${mlbam}?hydrate=currentTeam`,
            {
                headers: { "User-Agent": "DIAMOND:CONTEXT/0.1" },
                cf: { cacheTtl: 3600, cacheEverything: true },
            },
        );
        if (!res.ok) return null;
        const d = await res.json();
        const p = d.people?.[0];
        if (!p) return null;
        return {
            team_id:   p.currentTeam?.id ?? null,
            team_name: p.currentTeam?.name || null,
        };
    } catch {
        return null;
    }
}


async function fetchPlayerDaily(env, mlbam) {
    // Pull every daily_pa row for this player. Used for: recent form
    // windows, head-to-head vs tonight's starter, streak detection.
    // ~250 rows for a regular in 2026.
    const url = new URL(`${env.SUPABASE_URL}/rest/v1/daily_pa`);
    url.searchParams.set("batter_mlbam", `eq.${mlbam}`);
    url.searchParams.set("select", "game_pk,game_date,outcome,pitcher_mlbam");
    url.searchParams.set("order", "game_date.desc,pa_index.desc");
    url.searchParams.set("limit", "5000");
    const res = await fetch(url.toString(), {
        headers: {
            "apikey":        env.SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
        },
        cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return [];
    return res.json();
}


// Find today's game for the given team. Hits the MLB Stats API
// schedule endpoint directly (rather than our /api/games/today, which
// strips down to abbreviations) so we have full team.id matching.
async function findTeamGame(origin, date, teamId) {
    try {
        const res = await fetch(
            `https://statsapi.mlb.com/api/v1/schedule?date=${date}&sportId=1`,
            {
                headers: { "User-Agent": "DIAMOND:CONTEXT/0.1" },
                cf: { cacheTtl: 60, cacheEverything: true },
            },
        );
        if (!res.ok) return null;
        const data = await res.json();
        for (const day of data.dates || []) {
            for (const g of day.games || []) {
                const homeId = g.teams?.home?.team?.id;
                const awayId = g.teams?.away?.team?.id;
                if (homeId === teamId || awayId === teamId) {
                    const status = g.status?.abstractGameState || "Preview";
                    const isHome = homeId === teamId;
                    return {
                        game_pk: g.gamePk,
                        status,
                        start_time: g.gameDate,
                        is_home: isHome,
                        teams: {
                            home: {
                                id:   g.teams.home.team.id,
                                name: g.teams.home.team.name,
                                abbr: g.teams.home.team.abbreviation
                                      || g.teams.home.team.teamName
                                      || "",
                            },
                            away: {
                                id:   g.teams.away.team.id,
                                name: g.teams.away.team.name,
                                abbr: g.teams.away.team.abbreviation
                                      || g.teams.away.team.teamName
                                      || "",
                            },
                        },
                    };
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}


// Pull the boxscore to (a) confirm player is in the starting lineup,
// (b) find their lineup spot, (c) identify the current pitcher (live)
// or probable starter (pregame) of the opposing team.
async function fetchLineupAndOpposingPitcher(gamePk, mlbam) {
    try {
        const res = await fetch(
            `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`,
            {
                headers: { "User-Agent": "DIAMOND:CONTEXT/0.1" },
                cf: { cacheTtl: 60, cacheEverything: true },
            },
        );
        if (!res.ok) return { inLineup: false };
        const feed = await res.json();
        const teams = feed?.liveData?.boxscore?.teams || {};
        const gameData = feed?.gameData || {};

        const playerKey = `ID${mlbam}`;
        let side = null;
        if (teams.home?.players?.[playerKey]) side = "home";
        else if (teams.away?.players?.[playerKey]) side = "away";

        if (!side) {
            // Player might be on the roster but not in today's specific
            // boxscore — bench day, off injured-list, etc.
            return { inLineup: false };
        }

        const myTeam = teams[side];
        const oppSide = side === "home" ? "away" : "home";
        const oppTeam = teams[oppSide];

        // Lineup spot: first digit of MLB's 4-char battingOrder code
        // (e.g. "300" = 3rd in the order, "401" = 4th-slot bench PH).
        const orderCode = myTeam.players[playerKey]?.battingOrder;
        const lineupSpot = orderCode
            ? parseInt(String(orderCode).slice(0, -2), 10)
            : null;

        // Opposing pitcher: current pitcher if game is Live, probable
        // starter from gameData if pregame.
        const status = gameData.status?.abstractGameState || "Preview";
        let opposingPitcher = null;

        if (status === "Live") {
            // Try to get the active pitcher from the linescore.
            const offense = feed?.liveData?.linescore?.offense || {};
            const pitcherId = offense.pitcher?.id ||
                              feed?.liveData?.plays?.currentPlay?.matchup?.pitcher?.id;
            if (pitcherId) {
                const pp = oppTeam.players[`ID${pitcherId}`];
                opposingPitcher = {
                    id: pitcherId,
                    name: pp?.person?.fullName || `Pitcher ${pitcherId}`,
                    throws: pp?.pitchHand?.code || null,
                };
            }
        } else {
            // Probable pitcher for pregame games.
            const probable = gameData.probablePitchers?.[oppSide];
            if (probable?.id) {
                opposingPitcher = {
                    id: probable.id,
                    name: probable.fullName || `Pitcher ${probable.id}`,
                    throws: null,
                };
            }
        }

        return {
            inLineup: true,
            lineupSpot,
            opponent: {
                id: gameData.teams?.[oppSide]?.id,
                name: gameData.teams?.[oppSide]?.name,
                abbr: gameData.teams?.[oppSide]?.abbreviation,
            },
            opposingPitcher,
        };
    } catch {
        return { inLineup: false };
    }
}


async function fetchMatchup(origin, batterId, pitcherId) {
    try {
        const res = await fetch(
            `${origin}/api/matchup?batter=${batterId}&pitcher=${pitcherId}`,
        );
        if (!res.ok) return null;
        return res.json();
    } catch {
        return null;
    }
}


// ── derivations ────────────────────────────────────────────────────

// Expected per-game line = per-PA distribution × estimated PAs.
// Float values; UI rounds for display.
function buildExpectedLine(predicted, pas) {
    const hits = (predicted["1B"] || 0) + (predicted["2B"] || 0) +
                 (predicted["3B"] || 0) + (predicted["HR"] || 0);
    const onBase = hits + (predicted.BB || 0) + (predicted.HBP || 0);
    return {
        expected_pas: pas,
        h:   round2(hits         * pas),
        hr:  round2((predicted.HR || 0) * pas),
        bb:  round2((predicted.BB || 0) * pas),
        k:   round2((predicted.K  || 0) * pas),
        out: round2((predicted.OUT || 0) * pas),
        on_base: round2(onBase * pas),
        // Slash projection: per-PA rates aggregated to game-level.
        obp_proj: round3(onBase),
        // For SLG we need TB / AB. AB ≈ PA × (1 - P(BB) - P(HBP)).
        slg_proj: round3(slgFromPredicted(predicted)),
    };
}


function slgFromPredicted(p) {
    const ab_share = 1 - (p.BB || 0) - (p.HBP || 0);
    if (ab_share <= 0) return 0;
    const tb = (p["1B"] || 0) + 2 * (p["2B"] || 0) +
               3 * (p["3B"] || 0) + 4 * (p.HR || 0);
    return tb / ab_share;
}


function computeRecentForm(dailyRows) {
    if (!dailyRows || dailyRows.length === 0) return null;
    // Group PAs by game_pk and order the games newest-first, then take
    // the player's last 7 / 15 / 30 ACTUAL games. Calendar-day windows
    // were undercounting players who had off-days, IL stints, rainouts,
    // or platoon rest in the window — the directive says "last 30 games
    // played and not less", so we count games not days.
    const byGame = new Map();
    for (const r of dailyRows) {
        if (r.game_pk == null) continue;
        if (!byGame.has(r.game_pk)) {
            byGame.set(r.game_pk, { ts: Date.parse(r.game_date) || 0, rows: [] });
        }
        byGame.get(r.game_pk).rows.push(r);
    }
    const games = Array.from(byGame.entries())
        .map(([game_pk, v]) => ({ game_pk, ts: v.ts, rows: v.rows }))
        .sort((a, b) => b.ts - a.ts);

    const flatten = (n) => games.slice(0, n).flatMap((g) => g.rows);
    const w7  = flatten(7);
    const w15 = flatten(15);
    const w30 = flatten(30);

    return {
        // Field names kept stable for the UI — these are the LAST N
        // GAMES, not the last N days. Label copy on the UI side has
        // been updated to match ("L7 games", "L15 games", "L30 games").
        last_7_days:  windowStats(w7),
        last_15_days: windowStats(w15),
        last_30_days: windowStats(w30),
        // Diagnostic: actual counts achieved so the UI can warn when a
        // player hasn't played 30 games yet.
        actual_games: {
            l7:  Math.min(games.length, 7),
            l15: Math.min(games.length, 15),
            l30: Math.min(games.length, 30),
            total: games.length,
        },
    };
}


function windowStats(rows) {
    if (!rows.length) return { pa: 0 };
    const counts = { K:0, BB:0, HBP:0, "1B":0, "2B":0, "3B":0, HR:0, OUT:0, OTHER:0 };
    for (const r of rows) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    const pa = rows.length;
    const bb = counts.BB, hbp = counts.HBP, hr = counts.HR;
    const h = counts["1B"] + counts["2B"] + counts["3B"] + hr;
    const ab = pa - bb - hbp;
    const tb = counts["1B"] + 2*counts["2B"] + 3*counts["3B"] + 4*hr;
    const avg = ab > 0 ? h / ab : 0;
    const obp = pa > 0 ? (h + bb + hbp) / pa : 0;
    const slg = ab > 0 ? tb / ab : 0;
    return {
        pa, ab, h, hr, bb, k: counts.K,
        avg: fmtAvg(avg),
        obp: fmtAvg(obp),
        slg: fmtAvg(slg),
        ops: fmtAvg(obp + slg),
    };
}


function computeHeadToHead(dailyRows, opposingPitcherId) {
    const rows = dailyRows.filter((r) => r.pitcher_mlbam === opposingPitcherId);
    if (rows.length === 0) {
        return {
            pa: 0,
            sample_note: "no PAs vs this pitcher in 2025-26",
        };
    }
    const stats = windowStats(rows);
    return {
        ...stats,
        sample_note: rows.length < 10
            ? `tiny sample (${rows.length} PA) — read with caution`
            : `2025-26 only — historical pre-2025 not in daily log`,
    };
}


// Count consecutive games (from most recent backward) with ≥1 hit /
// ≥1 time on base. Walks game-by-game by grouping daily_pa rows
// per game_pk in date order.
function computeStreaks(dailyRows) {
    if (!dailyRows || dailyRows.length === 0) return { hit_streak: 0, on_base_streak: 0 };
    // Group by game (the rows come sorted desc by date already).
    const games = new Map();
    for (const r of dailyRows) {
        if (!games.has(r.game_pk)) games.set(r.game_pk, []);
        games.get(r.game_pk).push(r);
    }
    // Game order: most recent first. Walk until a game with 0 hits
    // (for hit streak) or 0 times-on-base (for on-base streak).
    const gameList = Array.from(games.entries())
        .sort((a, b) => {
            const da = a[1][0]?.game_date || "";
            const db = b[1][0]?.game_date || "";
            return db.localeCompare(da);
        });

    const hitOutcomes = new Set(["1B", "2B", "3B", "HR"]);
    const onBaseOutcomes = new Set(["1B", "2B", "3B", "HR", "BB", "HBP"]);

    let hitStreak = 0;
    for (const [, rs] of gameList) {
        const anyHit = rs.some((r) => hitOutcomes.has(r.outcome));
        if (anyHit) hitStreak += 1;
        else break;
    }
    let onBaseStreak = 0;
    for (const [, rs] of gameList) {
        const anyOnBase = rs.some((r) => onBaseOutcomes.has(r.outcome));
        if (anyOnBase) onBaseStreak += 1;
        else break;
    }
    return { hit_streak: hitStreak, on_base_streak: onBaseStreak };
}


function gameSummary(g) {
    return {
        game_pk: g.game_pk,
        status:  g.status,
        start_time: g.start_time,
        teams: g.teams,
    };
}


// Today's calendar date in ET — same convention as the rest of the
// ingest pipeline. UTC-5 is the simple year-round approximation; the
// off-by-one-hour from DST doesn't matter for calendar-day arithmetic.
function currentDateET() {
    const now = new Date(Date.now() - 5 * 3600 * 1000);
    return now.toISOString().slice(0, 10);
}


// ── formatting helpers ────────────────────────────────────────────

function round2(x) { return Math.round(x * 100) / 100; }
function round3(x) { return Math.round(x * 1000) / 1000; }

function fmtAvg(x) {
    if (!Number.isFinite(x) || x < 0) return ".000";
    if (x >= 1) return x.toFixed(3);
    return x.toFixed(3).slice(1);
}


// ── HTTP plumbing ─────────────────────────────────────────────────

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
