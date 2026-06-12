// /api/historical-coverage
//
// Per-season summary of the historical data the bot leans on. Two
// sources:
//   - 1910-2024 historicals from rates.db, baked at build time into
//     _historical_by_year.json (per-year PA count, batter / pitcher /
//     game counts, league K% / BB% / HR% / Hit%). 115 seasons total.
//   - Current 2026 season from Supabase (wpa_season — the live daily
//     plate-appearance ingest).
//
// Cached 1h at the edge — the historical baseline only changes when
// the Python pipeline re-derives rates.db, and the live PA count
// updates nightly.

import historical from "./_historical_by_year.json" assert { type: "json" };

const CACHE_SECONDS = 3600;

export async function onRequest(context) {
    const env = context.env || {};

    // Static historicals — newest first so the table reads top-down
    // from the current era backward.
    const historicalRows = (historical.rows || []).slice().reverse();

    // Live recent seasons — best-effort from Supabase's daily_pa rollup
    // (one row per calendar year, with games/players/K%/BB%/HR%/Hit%
    // computed from the actual PA events). Only seasons NEWER than the
    // static historical slice get used so we never double up on a year.
    // The most recent year is tagged live=true so the UI can highlight
    // it; older Supabase years (e.g. 2025 once 2026 is in progress) are
    // marked as completed.
    let liveSeasons = [];
    if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
        try {
            const url = `${env.SUPABASE_URL}/rest/v1/rpc/get_historical_coverage_by_year`;
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "apikey":        env.SUPABASE_ANON_KEY,
                    "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
                    "Content-Type":  "application/json",
                },
                body: "{}",
                cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
            });
            if (res.ok) {
                const rows = await res.json();
                const latestHistorical = historicalRows[0]?.year ?? 0;
                const sorted = (Array.isArray(rows) ? rows : [])
                    .filter((r) => Number(r.year) > latestHistorical)
                    .sort((a, b) => Number(b.year) - Number(a.year));
                const newestYear = sorted[0] ? Number(sorted[0].year) : null;
                liveSeasons = sorted.map((r) => ({
                    year:       Number(r.year),
                    pa:         r.pa         == null ? null : Number(r.pa),
                    batters:    r.batters    == null ? null : Number(r.batters),
                    pitchers:   r.pitchers   == null ? null : Number(r.pitchers),
                    games:      r.games      == null ? null : Number(r.games),
                    k_pct:      r.k_pct      == null ? null : Number(r.k_pct),
                    bb_pct:     r.bb_pct     == null ? null : Number(r.bb_pct),
                    hr_pct:     r.hr_pct     == null ? null : Number(r.hr_pct),
                    hit_pct:    r.hit_pct    == null ? null : Number(r.hit_pct),
                    last_game_date: r.last_game_date || null,
                    // Only the current year is "in progress" — older
                    // years in the live ingest are completed seasons.
                    live_season: Number(r.year) === newestYear,
                }));
            }
        } catch {
            // Best-effort — static slice still ships below.
        }
    }

    const rows = [...liveSeasons, ...historicalRows];

    return new Response(JSON.stringify({
        source:     historical.source || "Retrosheet PBP via rates.db",
        rows,
        fetched_at: new Date().toISOString(),
    }), {
        headers: {
            "content-type":  "application/json",
            "cache-control": `public, max-age=${CACHE_SECONDS}`,
            "access-control-allow-origin": "*",
        },
    });
}
