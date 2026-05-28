// Team strength + recent form, used to adjust state-based WE for the
// fact that not all teams are equally capable.
//
// The headline WE table (WE_TABLE_V2) is an empirical "league-average
// teams" baseline — it answers "of all historical games in this state,
// how often did the home team win?" That undercounts the value of
// being a hot or talented team and overcounts the value of being a
// cold or weak one. Adding a team-strength shift on top closes the
// gap that Russell Carleton at Baseball Prospectus quantified as
// median 3 percentage points, 90th-pctile 10, max 26 in extremes.
//
// What this module exposes:
//
//   fetchTeamStrength(teamId, season)
//     Returns { season_pct, pyth_pct, l30_pct, l10_pct, combined_pct,
//               streak, ... } for one team. Hits MLB Stats API standings
//     + schedule endpoints. Edge-cached for 1 hour.
//
//   pregameHomeWE(homeStrength, awayStrength)
//     Returns the pre-game home win probability given both teams'
//     strengths. Baseline 0.54 (MLB home-field advantage from 132
//     seasons of Retrosheet) plus a strength-differential shift
//     capped at ±15 percentage points.
//
//   teamStrengthAdjustment(homeStrength, awayStrength)
//     Returns { pregame_we, delta_from_baseline, breakdown }. The
//     `delta` is what gets added to every state-based WE lookup so
//     the team-strength signal flows through the headline number,
//     the projected-WE card, AND the bullpen-aware forecast.

const HOME_FIELD_ADVANTAGE = 0.54;
const STRENGTH_SCALAR      = 0.20;   // each .100 of W% diff → 2pp WE shift
const ADJUSTMENT_CAP_PP    = 0.15;   // cap the shift at ±15 pp
const STANDINGS_TTL        = 3600;   // 1 hour at the edge
const SCHEDULE_TTL         = 1800;   // 30 minutes (more dynamic)
const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";


// Public: combined-strength lookup for one team. Hits standings +
// schedule in parallel, blends into a single 0-1 number.
export async function fetchTeamStrength(teamId, season) {
    if (!teamId || !season) return null;
    try {
        const [standings, schedule] = await Promise.all([
            fetchStandings(season),
            fetchTeamSchedule(teamId, season),
        ]);
        const tr = findTeamRecord(standings, teamId);
        if (!tr) return null;

        // Season + Pythagorean from standings (one source of truth).
        const season_w   = tr.wins ?? 0;
        const season_l   = tr.losses ?? 0;
        const season_pct = winPct(season_w, season_l);
        const rs = tr.runsScored ?? 0;
        const ra = tr.runsAllowed ?? 0;
        const pyth_pct = pythagoreanWinPct(rs, ra);

        const l10 = pickSplit(tr, "lastTen");
        const home = pickSplit(tr, "home");
        const away = pickSplit(tr, "away");

        // L30 + L15 — the team's last 30 / 15 GAMES actually played
        // (NOT the last 30 / 15 days). A team with a rainout still
        // gets a true L30; a date window would have undercounted.
        const l30 = computeRecentRecord(schedule, teamId, 30);
        const l15 = computeRecentRecord(schedule, teamId, 15);

        // Combined strength: long-run true talent + recent form.
        // Weights chosen for v1 — calibration will refine.
        //   25%  season actual W-L
        //   25%  season Pythagorean (luck-adjusted)
        //   30%  last 30 games played
        //   20%  last 10 games (lastTen split from standings)
        const combined_pct =
            0.25 * season_pct +
            0.25 * pyth_pct +
            0.30 * (l30?.pct ?? season_pct) +
            0.20 * (l10?.pct ?? season_pct);

        return {
            team_id:       teamId,
            season,
            season_w,  season_l,  season_pct,
            pyth_pct,
            run_differential: rs - ra,
            runs_scored:   rs,
            runs_allowed:  ra,
            l30: l30 || null,
            l15: l15 || null,
            l10: l10 || null,
            home_split: home || null,
            away_split: away || null,
            streak: tr.streak?.streakCode || null,
            combined_pct,
        };
    } catch {
        return null;
    }
}


// Public: pre-game home-WE based on team-strength differential.
// Baseline 0.54 + (home_combined - away_combined) × 0.20, clipped
// to ±15 percentage points of swing total.
export function pregameHomeWE(homeStrength, awayStrength) {
    if (!homeStrength || !awayStrength) return HOME_FIELD_ADVANTAGE;
    const delta = homeStrength.combined_pct - awayStrength.combined_pct;
    const raw   = HOME_FIELD_ADVANTAGE + delta * STRENGTH_SCALAR;
    const lo    = HOME_FIELD_ADVANTAGE - ADJUSTMENT_CAP_PP;
    const hi    = HOME_FIELD_ADVANTAGE + ADJUSTMENT_CAP_PP;
    return Math.max(lo, Math.min(hi, raw));
}


// Public: the single number we add to every state-based WE lookup in
// this game. = pregame_we - 0.54. Plus the breakdown for the UI.
export function teamStrengthAdjustment(homeStrength, awayStrength) {
    const pregame = pregameHomeWE(homeStrength, awayStrength);
    return {
        pregame_we:           pregame,
        delta_from_baseline:  pregame - HOME_FIELD_ADVANTAGE,
        home: homeStrength,
        away: awayStrength,
    };
}


// ── internals ──────────────────────────────────────────────────────

function winPct(w, l) {
    if (w + l === 0) return 0.500;
    return w / (w + l);
}


// Pythagorean expectation — RS² / (RS² + RA²). The Bill James
// classic; later refinements (Pythagenpat) use a variable exponent
// but the squared-runs form is well within noise at MLB run-scoring
// levels and is the standard sabermetric "luck-adjusted W%".
function pythagoreanWinPct(rs, ra) {
    if (rs <= 0 && ra <= 0) return 0.500;
    return (rs * rs) / (rs * rs + ra * ra);
}


function pickSplit(teamRecord, type) {
    const splits = teamRecord.records?.splitRecords || [];
    const sr = splits.find((s) => s.type === type);
    if (!sr) return null;
    return {
        w: sr.wins,
        l: sr.losses,
        pct: winPct(sr.wins || 0, sr.losses || 0),
    };
}


// Look up a team's record from the standings response.
function findTeamRecord(standings, teamId) {
    for (const rec of standings.records || []) {
        for (const tr of rec.teamRecords || []) {
            if (tr.team?.id === teamId) return tr;
        }
    }
    return null;
}


async function fetchStandings(season) {
    const url = `https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${season}`;
    const res = await fetch(url, {
        headers: { "User-Agent": UA },
        cf: { cacheTtl: STANDINGS_TTL, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`standings HTTP ${res.status}`);
    return res.json();
}


// Pull the team's full season schedule with final scores so we can
// count W-L over any sub-window (L30, L15, etc.) without extra calls.
async function fetchTeamSchedule(teamId, season) {
    // Reasonable defaults: April 1 → today. Covers ~all completed games.
    const today = new Date();
    const endDate = today.toISOString().slice(0, 10);
    const url =
        `https://statsapi.mlb.com/api/v1/schedule?` +
        `sportId=1&teamId=${teamId}&season=${season}` +
        `&startDate=${season}-03-01&endDate=${endDate}`;
    const res = await fetch(url, {
        headers: { "User-Agent": UA },
        cf: { cacheTtl: SCHEDULE_TTL, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`schedule HTTP ${res.status}`);
    return res.json();
}


// Count W-L from the team's last N GAMES actually played — NOT the last
// N days. User pointed out the prior implementation was a date window,
// which means a team with a rainout or schedule gap would get fewer
// than 30 games counted as "L30". This walks the team's full schedule,
// pulls every final game, sorts newest-first, and keeps the first N.
//
// `n` is the game count; old callers that passed `days=30` semantics
// still get the right behavior because the threshold value is unchanged.
function computeRecentRecord(scheduleData, teamId, n) {
    // Collect every final game involving this team, with timestamp +
    // win bool so we can sort newest first then slice the top N.
    const completed = [];
    for (const day of scheduleData?.dates || []) {
        for (const g of day.games || []) {
            const status = g.status?.abstractGameState;
            if (status !== "Final") continue;
            const home = g.teams?.home;
            const away = g.teams?.away;
            if (!home?.team?.id || !away?.team?.id) continue;
            const isHome = home.team.id === teamId;
            const isAway = away.team.id === teamId;
            if (!isHome && !isAway) continue;
            const homeRuns = home.score ?? 0;
            const awayRuns = away.score ?? 0;
            if (homeRuns === awayRuns) continue;  // tie (shouldn't happen in MLB)
            const ts = Date.parse(g.gameDate);
            if (!Number.isFinite(ts)) continue;
            const won = isHome ? homeRuns > awayRuns : awayRuns > homeRuns;
            completed.push({ ts, won });
        }
    }
    // Newest first → slice to N.
    completed.sort((a, b) => b.ts - a.ts);
    const window = completed.slice(0, n);
    if (window.length === 0) return null;

    let w = 0, l = 0;
    for (const g of window) {
        if (g.won) w += 1; else l += 1;
    }
    return {
        w, l,
        pct:           winPct(w, l),
        // Reflect what we actually had to work with — if the team hasn't
        // played 30 games yet, we report what we found and how many.
        window_games:  window.length,
        requested:     n,
        short_window:  window.length < n,
    };
}
