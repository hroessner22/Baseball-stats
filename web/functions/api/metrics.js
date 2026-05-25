// /api/metrics
//
// Returns the latest calibration snapshot — one row per engine
// variant from public.model_metrics, written nightly by
// src/calibration.py after the daily PA ingest finishes.
//
// Response shape:
//   {
//     production: { variant, sample_size, top_pick_accuracy, brier_score, ... }
//     variants:   [ row per variant in the most recent calibration run ]
//     fetched_at: ISO timestamp
//   }
//
// `production` is the v3_recency row when present — the variant that
// matches what /api/matchup is actually serving. Falls back to the
// most recent row of any variant if v3 isn't there yet.

export async function onRequest(context) {
    const env = context.env || {};
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return jsonError(500, "SUPABASE_URL / SUPABASE_ANON_KEY not configured");
    }

    // Pull a small recent window so we can pluck the latest row PER
    // variant. The nightly run writes 4 rows with the same
    // computed_at, so the top 8 rows always contains the latest set.
    const url = `${env.SUPABASE_URL}/rest/v1/model_metrics` +
                `?select=*&order=computed_at.desc&limit=20`;
    try {
        const res = await fetch(url, {
            headers: {
                "apikey":        env.SUPABASE_ANON_KEY,
                "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
            },
            cf: { cacheTtl: 300, cacheEverything: true },
        });
        if (!res.ok) {
            return jsonError(502, `Supabase HTTP ${res.status}`);
        }
        const rows = await res.json();

        // Group by variant and pick the most recent row per variant.
        const byVariant = new Map();
        for (const r of rows) {
            const v = r.variant || "v1_historical";
            if (!byVariant.has(v)) byVariant.set(v, r);
        }
        const variants = Array.from(byVariant.values());

        // "Production" = whichever variant is currently serving live.
        // v4_daily_10x as of the PR that swept variants and picked the
        // lowest-Brier one across 202k PAs. Falls back through the
        // chain if a newer/older deploy is in flight.
        const production =
            byVariant.get("v4_daily_10x") ||
            byVariant.get("v3_recency") ||
            byVariant.get("v2_with_daily") ||
            byVariant.get("v1_historical") ||
            variants[0] || null;

        return new Response(JSON.stringify({
            production,
            variants,
            // Legacy: some callers (older deploys) still read .metrics
            metrics: production,
            fetched_at: new Date().toISOString(),
        }), {
            headers: {
                "content-type": "application/json",
                "cache-control": "public, max-age=300",
                "access-control-allow-origin": "*",
            },
        });
    } catch (e) {
        return jsonError(502, `${e.message || e}`);
    }
}

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}
