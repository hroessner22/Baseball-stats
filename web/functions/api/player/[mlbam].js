// /api/player/{mlbam}
//
// Player profile data — what we know about one batter or pitcher
// across the four engines:
//
//  * players table        — name + MLBAM/retrosheet identity
//  * batter_rates table   — Retrosheet 2020–2024 outcome rates by hand-faced
//  * pitcher_rates table  — same shape but for pitchers
//  * daily_pa event log   — every PA since the daily cron started writing
//                           (plus whatever historical seasons the backfill
//                           workflow has caught up — 2025+ as of 2026-05)
//
// "Career" bars combine the Retrosheet rates with every daily_pa row
// from a year that ISN'T the current season — so once 2025 is backfilled
// the bars naturally cover 2020 through last year, with 2026 broken out
// in the "THIS SEASON" callout.
//
// Returns null for the batter or pitcher section if the player has no
// data in that role — a position player gets a `batter` section and
// pitcher=null, a starter gets `pitcher` and batter=null, two-way players
// (Ohtani-types) get both populated.

const OUTCOMES = ["K", "BB", "HBP", "1B", "2B", "3B", "HR", "OUT", "OTHER"];
const RETROSHEET_START_YEAR = 2020;
const RETROSHEET_END_YEAR   = 2024;

export async function onRequest(context) {
    const env = context.env || {};
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return jsonError(500, "SUPABASE_URL / SUPABASE_ANON_KEY not configured");
    }

    const mlbam = parseInt(context.params?.mlbam, 10);
    if (!mlbam || mlbam < 1) {
        return jsonError(400, "invalid mlbam id");
    }

    try {
        // 1. Player identity. The Chadwick map (2020–2024 modern era)
        //    is the source of truth — fall back to MLB Stats API if
        //    the player isn't there (modern callups, etc.).
        const players = await sb(env, "players", {
            mlbam: `eq.${mlbam}`,
            select: "mlbam,retrosheet,name_first,name_last",
        });

        let player;
        if (players.length > 0) {
            player = players[0];
        } else {
            const mlbName = await fetchMLBPlayer(mlbam);
            if (!mlbName) return jsonError(404, "player not found");
            player = {
                mlbam,
                retrosheet: null,
                name_first: mlbName.first,
                name_last:  mlbName.last,
            };
        }

        // 2. Career rates (one fetch per role; both return [] if the
        //    player isn't in that table). Skip retrosheet-keyed fetches
        //    if we have no retrosheet id.
        const [batterRows, pitcherRows] = await Promise.all([
            player.retrosheet
                ? sb(env, "batter_rates", {
                    batter: `eq.${player.retrosheet}`,
                    select: "bats,vs_hand,outcome,n",
                })
                : Promise.resolve([]),
            player.retrosheet
                ? sb(env, "pitcher_rates", {
                    pitcher: `eq.${player.retrosheet}`,
                    select: "throws,vs_hand,outcome,n",
                })
                : Promise.resolve([]),
        ]);

        // 3. Current-season activity from the daily_pa event log.
        const [batterSeason, pitcherSeason] = await Promise.all([
            sb(env, "daily_pa", {
                batter_mlbam: `eq.${mlbam}`,
                select: "outcome,game_date,pitcher_hand",
                limit: "5000",
            }),
            sb(env, "daily_pa", {
                pitcher_mlbam: `eq.${mlbam}`,
                select: "outcome,game_date,batter_hand",
                limit: "5000",
            }),
        ]);

        // Determine "current season" from the latest game_date we have on
        // file for this player. Fall back to the calendar year when the
        // player has no daily_pa rows at all. Anything older than this
        // year gets folded into the career bars; this year is the "THIS
        // SEASON" callout.
        const latestDate = [...batterSeason, ...pitcherSeason]
            .map(r => r.game_date)
            .filter(Boolean)
            .reduce((m, d) => (m === null || d > m ? d : m), null);
        const currentYear = latestDate
            ? parseInt(latestDate.slice(0, 4), 10)
            : new Date().getUTCFullYear();

        // Coverage range for the "CAREER · YYYY–YYYY" label. Starts at the
        // Retrosheet floor and extends to the most recent COMPLETED season
        // present in the daily_pa log — the current season is in its own
        // "THIS SEASON" callout, so including it in the career label would
        // double-count visually. Updates without a deploy as the backfill
        // workflow catches up (2024 today → 2025 once backfill lands).
        let coverageEnd = RETROSHEET_END_YEAR;
        for (const r of [...batterSeason, ...pitcherSeason]) {
            if (!r.game_date) continue;
            const y = parseInt(r.game_date.slice(0, 4), 10);
            if (y !== currentYear && y > coverageEnd) coverageEnd = y;
        }

        return jsonResponse({
            player: {
                mlbam: player.mlbam,
                retrosheet: player.retrosheet,
                name: `${player.name_first || ""} ${player.name_last || ""}`.trim(),
                first: player.name_first,
                last:  player.name_last,
            },
            batter:  batterRows.length || batterSeason.length
                ? buildBatter(batterRows, batterSeason, currentYear)
                : null,
            pitcher: pitcherRows.length || pitcherSeason.length
                ? buildPitcher(pitcherRows, pitcherSeason, currentYear)
                : null,
            historical_years: { start: RETROSHEET_START_YEAR, end: coverageEnd },
            current_year: currentYear,
        }, 300);
    } catch (e) {
        return jsonError(502, `${e.message || e}`);
    }
}

// ── shape builders ──────────────────────────────────────────────────

function buildBatter(rows, seasonRows, currentYear) {
    // Career: aggregate by (vs_hand, outcome) across all years
    const byHand = { L: zeroOutcomes(), R: zeroOutcomes() };
    let dominantBats = null;
    const batsTally = {};
    for (const r of rows) {
        if (!byHand[r.vs_hand]) continue;
        byHand[r.vs_hand][r.outcome] = (byHand[r.vs_hand][r.outcome] || 0) + r.n;
        batsTally[r.bats] = (batsTally[r.bats] || 0) + r.n;
    }
    // Dominant bats side — for switch hitters this picks the side they
    // hit from more often. Used as the canonical "hand" label.
    if (Object.keys(batsTally).length) {
        dominantBats = Object.entries(batsTally).sort((a, b) => b[1] - a[1])[0][0];
    }

    // Split daily_pa rows into "this season" and prior seasons. Fold the
    // priors into the career bars so the historical picture extends past
    // the Retrosheet 2024 cutoff as the backfill catches up; this season
    // stays in its own callout so its sample (~30 PAs in May) doesn't get
    // lost in a career sample (thousands of PAs).
    const { current: seasonNow, prior: seasonPrior } =
        splitByYear(seasonRows, currentYear);
    for (const r of seasonPrior) {
        const hand = r.pitcher_hand;
        if (!byHand[hand]) continue;
        byHand[hand][r.outcome] = (byHand[hand][r.outcome] || 0) + 1;
    }

    return {
        bats: dominantBats,
        career: {
            vs_RHP: rateTable(byHand.R),
            vs_LHP: rateTable(byHand.L),
        },
        season: aggregateSeasonRows(seasonNow, "pitcher_hand"),
    };
}

function buildPitcher(rows, seasonRows, currentYear) {
    const byHand = { L: zeroOutcomes(), R: zeroOutcomes() };
    let throws = null;
    const throwsTally = {};
    for (const r of rows) {
        if (!byHand[r.vs_hand]) continue;
        byHand[r.vs_hand][r.outcome] = (byHand[r.vs_hand][r.outcome] || 0) + r.n;
        throwsTally[r.throws] = (throwsTally[r.throws] || 0) + r.n;
    }
    if (Object.keys(throwsTally).length) {
        throws = Object.entries(throwsTally).sort((a, b) => b[1] - a[1])[0][0];
    }

    // Same split as the batter side: fold pre-current-year daily_pa rows
    // into the career bars by batter handedness.
    const { current: seasonNow, prior: seasonPrior } =
        splitByYear(seasonRows, currentYear);
    for (const r of seasonPrior) {
        const hand = r.batter_hand;
        if (!byHand[hand]) continue;
        byHand[hand][r.outcome] = (byHand[hand][r.outcome] || 0) + 1;
    }

    return {
        throws,
        career: {
            vs_RHB: rateTable(byHand.R),
            vs_LHB: rateTable(byHand.L),
        },
        season: aggregateSeasonRows(seasonNow, "batter_hand"),
    };
}

// Partition a list of daily_pa rows into ones from `currentYear` and ones
// from any earlier year, by inspecting the leading "YYYY-" of game_date.
function splitByYear(rows, currentYear) {
    const yearStr = String(currentYear);
    const current = [];
    const prior   = [];
    for (const r of rows) {
        if ((r.game_date || "").slice(0, 4) === yearStr) current.push(r);
        else prior.push(r);
    }
    return { current, prior };
}

// Build a section like:
//   { pa: 25, latest_date: "2026-05-23",
//     overall: {K:7,BB:3,...},
//     splits: { vs_R: {pa:18, K:5,...}, vs_L: {pa:7, K:2,...} } }
function aggregateSeasonRows(rows, oppHandKey) {
    const overall = zeroOutcomes();
    const vs_R = zeroOutcomes();
    const vs_L = zeroOutcomes();
    let vsRPa = 0, vsLPa = 0;
    let latest = null;
    for (const r of rows) {
        overall[r.outcome] = (overall[r.outcome] || 0) + 1;
        if (r[oppHandKey] === "R") { vs_R[r.outcome] = (vs_R[r.outcome] || 0) + 1; vsRPa++; }
        if (r[oppHandKey] === "L") { vs_L[r.outcome] = (vs_L[r.outcome] || 0) + 1; vsLPa++; }
        if (r.game_date && (!latest || r.game_date > latest)) latest = r.game_date;
    }
    return {
        pa: rows.length,
        latest_date: latest,
        overall,
        splits: {
            vs_R: { pa: vsRPa, ...vs_R },
            vs_L: { pa: vsLPa, ...vs_L },
        },
    };
}

function zeroOutcomes() {
    const o = {};
    for (const k of OUTCOMES) o[k] = 0;
    return o;
}

function rateTable(counts) {
    const total = OUTCOMES.reduce((s, o) => s + (counts[o] || 0), 0);
    const rates = {};
    for (const o of OUTCOMES) rates[o] = total > 0 ? counts[o] / total : 0;
    return { pa: total, counts, rates };
}

// ── HTTP plumbing ────────────────────────────────────────────────────

async function sb(env, table, params) {
    const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
        headers: {
            "apikey":        env.SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
        },
        cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Supabase ${table} HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    return res.json();
}

async function fetchMLBPlayer(mlbam) {
    // Fallback for players who aren't in our 2020–2024 Chadwick map
    // (callups, debuts since 2025). We can still show their name.
    try {
        const res = await fetch(
            `https://statsapi.mlb.com/api/v1/people/${mlbam}`,
            {
                headers: { "User-Agent": "DIAMOND:CONTEXT/0.1" },
                cf: { cacheTtl: 86400, cacheEverything: true },
            },
        );
        if (!res.ok) return null;
        const d = await res.json();
        const p = d.people?.[0];
        if (!p) return null;
        return { first: p.firstName, last: p.lastName };
    } catch {
        return null;
    }
}

function jsonResponse(body, maxAge = 60) {
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
