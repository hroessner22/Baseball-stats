// /api/historical-coverage
//
// Per-season summary of the historical data the bot leans on. Calls
// the get_historical_coverage_by_year() Postgres function, which joins
// batter_rates + pitcher_rates + league_rates (Retrosheet aggregates,
// 2020-2024) with wpa_season (live 2026 plate-appearance ingest).
//
// Response shape:
//   { rows: [ { year, batter_events, batters, pitcher_events,
//               pitchers, league_events, wpa_pas, wpa_players }, ... ],
//     fetched_at: ISO timestamp }
//
// Cached 1h at the edge — sample sizes only move when the nightly
// ingest runs.

const CACHE_SECONDS = 3600;

export async function onRequest(context) {
    const env = context.env || {};
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return jsonError(500, "SUPABASE_URL / SUPABASE_ANON_KEY not configured");
    }

    const url = `${env.SUPABASE_URL}/rest/v1/rpc/get_historical_coverage_by_year`;
    try {
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
        if (!res.ok) {
            return jsonError(502, `Supabase HTTP ${res.status}`);
        }
        const rows = await res.json();
        return new Response(JSON.stringify({
            rows: Array.isArray(rows) ? rows : [],
            fetched_at: new Date().toISOString(),
        }), {
            headers: {
                "content-type":  "application/json",
                "cache-control": `public, max-age=${CACHE_SECONDS}`,
                "access-control-allow-origin": "*",
            },
        });
    } catch (e) {
        return jsonError(502, e.message || String(e));
    }
}

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
    });
}
