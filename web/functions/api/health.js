// /api/health
//
// Quick health check of upstream services + our own flakiest endpoints.
// The frontend health monitor polls this every 30s, surfaces a status
// indicator, and triggers auto-recovery when things come back online.
//
// Each check:
//   - fetches the target URL with no auth
//   - records HTTP status + latency
//   - never blocks the rest (Promise.allSettled)
//
// Response shape:
//   {
//     ok: true | false,                  // false if ANY check failed
//     checks: {
//       mlb_stats:    { ok, status, latency_ms, [error] },
//       polymarket:   { ok, status, latency_ms, [error] },
//       kalshi:       { ok, status, latency_ms, [error] },
//       our_markets:  { ok, status, latency_ms, [error] },  // /api/markets
//       our_games:    { ok, status, latency_ms, [error] },  // /api/games/today
//     },
//     timestamp: "ISO 8601 string"
//   }
//
// Cached 15s at the edge — health doesn't need finer granularity, and
// we don't want every viewer's poll hammering upstreams independently.

const UPSTREAM_CHECKS = [
    {
        name: "mlb_stats",
        url:  "https://statsapi.mlb.com/api/v1/teams/121",  // Mets, small payload
    },
    {
        name: "polymarket",
        url:  "https://gamma-api.polymarket.com/events?tag_slug=baseball&limit=1",
    },
    {
        name: "kalshi",
        url:  "https://api.elections.kalshi.com/trade-api/v2/exchange/status",
    },
];

const PER_CHECK_TIMEOUT_MS = 8000;

export async function onRequest(context) {
    const origin = new URL(context.request.url).origin;

    // Add a couple of our own endpoints — the markets one is the
    // flaky 503-er we want to catch fast.
    const allChecks = [
        ...UPSTREAM_CHECKS,
        { name: "our_games",    url: `${origin}/api/games/today` },
        // Ping the same shape the frontend actually calls — the
        // Kalshi-only filtered path. If THAT 503s we have a real
        // problem; the full 11-adapter fan-out is exercised by
        // ?debug=1 only and not worth tying user-facing health to.
        { name: "our_markets",  url: `${origin}/api/markets?scope=game_day&source=kalshi` },
    ];

    const results = await Promise.allSettled(
        allChecks.map((c) => checkOne(c)),
    );

    const checks = {};
    for (let i = 0; i < results.length; i++) {
        const name = allChecks[i].name;
        if (results[i].status === "fulfilled") {
            checks[name] = results[i].value;
        } else {
            checks[name] = {
                ok: false,
                status: 0,
                latency_ms: 0,
                error: String(results[i].reason?.message || results[i].reason || "unknown"),
            };
        }
    }

    const allOk = Object.values(checks).every((c) => c.ok);

    return new Response(JSON.stringify({
        ok: allOk,
        checks,
        timestamp: new Date().toISOString(),
    }), {
        headers: {
            "content-type":  "application/json",
            "cache-control": "public, max-age=15",
            "access-control-allow-origin": "*",
        },
    });
}

async function checkOne({ name, url }) {
    const start = Date.now();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PER_CHECK_TIMEOUT_MS);
        const res = await fetch(url, {
            headers: { "user-agent": "DIAMOND-CONTEXT-health/0.1" },
            signal:  controller.signal,
        });
        clearTimeout(timeoutId);
        return {
            ok: res.ok,
            status: res.status,
            latency_ms: Date.now() - start,
        };
    } catch (e) {
        return {
            ok: false,
            status: 0,
            latency_ms: Date.now() - start,
            error: String(e.message || e).slice(0, 200),
        };
    }
}
