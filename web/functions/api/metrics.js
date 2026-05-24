// /api/metrics
//
// Returns the most recent row from public.model_metrics — the calibration
// snapshot computed nightly by src/calibration.py after the daily PA
// ingest finishes. Powers the footer line that says "Model: X% top-pick
// over Y PAs."

export async function onRequest(context) {
    const env = context.env || {};
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return jsonError(500, "SUPABASE_URL / SUPABASE_ANON_KEY not configured");
    }

    const url = `${env.SUPABASE_URL}/rest/v1/model_metrics` +
                `?select=*&order=computed_at.desc&limit=1`;
    try {
        const res = await fetch(url, {
            headers: {
                "apikey":        env.SUPABASE_ANON_KEY,
                "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
            },
            // 5-minute edge cache — the source updates once a day, so
            // anything tighter would be wasted load on Supabase.
            cf: { cacheTtl: 300, cacheEverything: true },
        });
        if (!res.ok) {
            return jsonError(502, `Supabase HTTP ${res.status}`);
        }
        const rows = await res.json();
        const latest = rows[0] || null;
        return new Response(JSON.stringify({
            metrics: latest,
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
