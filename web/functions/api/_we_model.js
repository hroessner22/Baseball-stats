// Calibrated, pitcher-aware pregame moneyline win-expectancy.
//
// Logistic model fit on 3,201 games (2025-26) with LEAK-FREE features
// (scripts/calibrate_we.py + enrich_starters.py). It replaces the old
// pitcher-BLIND pregame WE (state table + team-record adjustment) that gave
// NYM 49% against Chase Burns because it couldn't see the ace.
//
// IMPORTANT — what this model is and isn't:
//   - It is well-CALIBRATED (predicted range ~0.26-0.77, reliability tight).
//   - It is only ~1.6% better than "always pick home" — MLB moneylines are
//     efficiently priced; more factors (we tried real ERA) don't break through.
//   - Its real value is CONFIDENCE GATING: model-favorite win rate climbs with
//     confidence (|WE-0.5|>=0.10 -> ~63%, >=0.15 -> ~70%). The bot bets ONLY
//     the large-margin tier, and only when Kalshi underprices it. Coinflips are
//     where the bleed was — those get skipped.
//
// Features are home-minus-away differences:
//   off_diff    = team runs scored / game           (season)
//   def_diff    = team runs allowed / game          (season)
//   era_diff    = starting pitcher season ERA
//   k_diff      = starting pitcher K-rate (K / batter faced)
//   recent_diff = last-10-game run differential / game

const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";
const MLB = "https://statsapi.mlb.com/api/v1";

// Portable coefficients (raw, un-standardized). See enrich_starters.py.
const COEF = {
    b0:      0.136110,
    off:     0.152126,
    def:    -0.100842,
    era:    -0.076347,
    k:       1.058712,
    recent:  0.042369,
};
// |WE-0.5| at/above this is the "confident / large-margin" tier the bot bets.
export const WE_MODEL_CONFIDENT_MARGIN = 0.10;

const logistic = (z) => 1 / (1 + Math.exp(-z));

async function mlbJson(url, cacheTtl = 1800) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": UA },
            cf: { cacheTtl, cacheEverything: true },
            signal: ctrl.signal,
        });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; } finally { clearTimeout(t); }
}

// Team season runs scored/game (offense) and runs allowed/game (defense).
async function teamRunEnv(teamId, season) {
    const [hit, pit] = await Promise.all([
        mlbJson(`${MLB}/teams/${teamId}/stats?stats=season&group=hitting&season=${season}`),
        mlbJson(`${MLB}/teams/${teamId}/stats?stats=season&group=pitching&season=${season}`),
    ]);
    const hs = hit?.stats?.[0]?.splits?.[0]?.stat;
    const ps = pit?.stats?.[0]?.splits?.[0]?.stat;
    const hg = Number(hs?.gamesPlayed) || 0, pg = Number(ps?.gamesPlayed) || 0;
    return {
        rs: hg ? (Number(hs.runs) || 0) / hg : null,
        ra: pg ? (Number(ps.runs) || 0) / pg : null,
    };
}

// Last-10 finished games' run differential per game, from the team schedule.
async function recent10(teamId, season, asOf) {
    // asOf = ISO date 'YYYY-MM-DD'; look back ~24 days to be sure of 10 games.
    const end = asOf;
    const start = new Date(new Date(asOf + "T00:00:00Z").getTime() - 24 * 864e5)
        .toISOString().slice(0, 10);
    const d = await mlbJson(
        `${MLB.replace("/v1","/v1")}/schedule?sportId=1&teamId=${teamId}` +
        `&startDate=${start}&endDate=${end}&gameType=R`, 1800);
    const diffs = [];
    for (const day of d?.dates || []) {
        for (const g of day.games || []) {
            if (g.status?.codedGameState !== "F") continue;
            const h = g.teams?.home, a = g.teams?.away;
            if (h?.score == null || a?.score == null) continue;
            const isHome = h.team?.id === teamId;
            const rs = isHome ? h.score : a.score;
            const ra = isHome ? a.score : h.score;
            diffs.push({ date: g.officialDate, d: rs - ra });
        }
    }
    diffs.sort((x, y) => (x.date < y.date ? 1 : -1));     // newest first
    const last = diffs.slice(0, 10);
    return last.length ? last.reduce((s, x) => s + x.d, 0) / last.length : 0;
}

// Starter season ERA + K-rate.
async function starterStats(pid, season) {
    if (!pid) return { era: 4.3, krate: 0.225 };           // league fallback
    const d = await mlbJson(`${MLB}/people/${pid}/stats?stats=season&group=pitching&season=${season}`);
    const s = d?.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return { era: 4.3, krate: 0.225 };
    const era = Number(s.era);
    const bf = Number(s.battersFaced) || 0, k = Number(s.strikeOuts) || 0;
    return {
        era: Number.isFinite(era) ? era : 4.3,
        krate: bf >= 30 ? k / bf : 0.225,
    };
}

// Compute the calibrated pregame P(home win). Returns null if data is too
// thin to trust (caller then falls back to the state/team-strength WE).
//   ctx = { homeId, awayId, homeSP, awaySP, season, asOf }
export async function computeModelWE(ctx) {
    const { homeId, awayId, homeSP, awaySP, season, asOf } = ctx;
    if (!homeId || !awayId || !season) return null;
    const [hEnv, aEnv, hSP, aSP, hRec, aRec] = await Promise.all([
        teamRunEnv(homeId, season), teamRunEnv(awayId, season),
        starterStats(homeSP, season), starterStats(awaySP, season),
        recent10(homeId, season, asOf), recent10(awayId, season, asOf),
    ]);
    if (hEnv.rs == null || aEnv.rs == null || hEnv.ra == null || aEnv.ra == null) {
        return null;   // season offense/defense missing — don't guess
    }
    const z = COEF.b0
        + COEF.off    * (hEnv.rs - aEnv.rs)
        + COEF.def    * (hEnv.ra - aEnv.ra)
        + COEF.era    * (hSP.era - aSP.era)
        + COEF.k      * (hSP.krate - aSP.krate)
        + COEF.recent * (hRec - aRec);
    const we = logistic(z);
    return {
        we_home: we,
        confident: Math.abs(we - 0.5) >= WE_MODEL_CONFIDENT_MARGIN,
        inputs: {
            home_rs: round3(hEnv.rs), away_rs: round3(aEnv.rs),
            home_ra: round3(hEnv.ra), away_ra: round3(aEnv.ra),
            home_sp_era: round3(hSP.era), away_sp_era: round3(aSP.era),
            home_recent10: round3(hRec), away_recent10: round3(aRec),
        },
    };
}

function round3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }
