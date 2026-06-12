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

    // Live current season — best-effort from Supabase. If the env vars
    // aren't set or the rpc fails, we still serve the static slice so
    // the page never renders blank.
    let currentSeason = null;
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
                // The rpc returns all seasons it knows about; pull only
                // the row that's NEWER than the latest historical year.
                // Older Supabase seasons (2020-2024) are duplicates of
                // what's already in the static slice.
                const latestHistorical = historicalRows[0]?.year ?? 0;
                const live = (Array.isArray(rows) ? rows : []).find(
                    (r) => Number(r.year) > latestHistorical && r.wpa_pas != null,
                );
                if (live) {
                    currentSeason = {
                        year:       Number(live.year),
                        pa:         Number(live.wpa_pas),
                        batters:    null,            // wpa_season doesn't track batters separately
                        pitchers:   null,
                        games:      null,
                        k_pct:      null,
                        bb_pct:     null,
                        hr_pct:     null,
                        hit_pct:    null,
                        live_season: true,
                    };
                }
            }
        } catch {
            // Best-effort — static slice still ships below.
        }
    }

    const rows = currentSeason
        ? [currentSeason, ...historicalRows]
        : historicalRows;

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
