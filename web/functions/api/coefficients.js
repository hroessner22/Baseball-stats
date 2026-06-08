// /api/coefficients
//
// Serves the empirically-derived bot coefficients computed by
// scripts/derive_coefficients.py against rates.db (Retrosheet
// 2018-2024 — 15M PAs, ~575K games with weather).
//
// The bot fetches this once per session and uses it to replace
// every hand-waved bucket:
//   - hitter_quality_by_season_avg: AVG bucket → empirical
//     P(1+H), P(2+H), P(1+HR), P(2+TB) per game
//   - kprop_by_pitcher_season_k9: K/9 bucket → empirical
//     P(N+ K in a start) for thresholds 3-10
//   - weather: (temp_bucket, wind_bucket) → hit_multiplier and
//     hr_multiplier vs neutral (60-70°F, 0-5mph)
//   - league_per_pa: outcome rate league-wide for sanity
//
// Cached 24h at the edge; data only changes when the Python script
// regenerates it.

import coefficients from "./_bot_coefficients.json" assert { type: "json" };

const CACHE_SECONDS = 24 * 3600;

export async function onRequest() {
    return new Response(JSON.stringify(coefficients), {
        headers: {
            "content-type":  "application/json",
            "cache-control": `public, max-age=${CACHE_SECONDS}`,
            "access-control-allow-origin": "*",
        },
    });
}
