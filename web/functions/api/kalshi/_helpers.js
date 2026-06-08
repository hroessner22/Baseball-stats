// Shared helpers for the /api/kalshi/* proxy endpoints.
//
// Kalshi is a CFTC-regulated prediction-market exchange. Their REST
// trading API does not allow browser CORS from arbitrary origins, so
// every authenticated call has to go through a server-side proxy.
// These workers are that proxy.
//
// SECURITY MODEL:
//   - The user's KALSHI BEARER TOKEN flows from the browser to here
//     via the `X-Kalshi-Token` request header on every call. We never
//     persist it — no logs, no caches, no KV writes.
//   - The login endpoint is the ONLY place we touch the user's
//     password. It's immediately forwarded to Kalshi and dropped from
//     memory; the bearer token Kalshi returns is what we hand back.
//   - The browser stores the token in localStorage. Any future call
//     re-attaches it on the request header.
//   - No PII, no trade detail, no key material is logged in worker
//     output — only HTTP status codes for debugging.

export const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

const COMMON_HEADERS = {
    "content-type":  "application/json",
    "cache-control": "no-store, private",
    "access-control-allow-origin":  "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-kalshi-token",
};

export function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: COMMON_HEADERS,
    });
}

export function corsPreflight() {
    return new Response(null, { status: 204, headers: COMMON_HEADERS });
}

// Read the user's Kalshi bearer token from the request header. We
// require it on every endpoint except /login. Returns null if missing
// or empty (caller returns 401 in that case).
export function readToken(request) {
    const h = request.headers.get("x-kalshi-token");
    if (!h || h.length < 4) return null;
    return h;
}

// Generic "forward an authenticated call to Kalshi" helper.
// `path` is the path AFTER /trade-api/v2 (e.g. "/portfolio/balance").
// Adds Authorization: Bearer {token}, forwards method + body, returns
// a JSON response back to the browser with the upstream status code.
export async function proxyAuthed(request, path, opts = {}) {
    const token = readToken(request);
    if (!token) {
        return jsonResponse({ error: "missing X-Kalshi-Token header" }, 401);
    }
    const url = `${KALSHI_BASE}${path}`;
    const init = {
        method: opts.method || "GET",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type":  "application/json",
            "User-Agent":    "DIAMOND-CONTEXT/0.1 (+https://diamond-context.pages.dev)",
        },
    };
    if (opts.body) init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);

    let upstream;
    try {
        upstream = await fetch(url, init);
    } catch (e) {
        return jsonResponse({ error: `kalshi fetch failed: ${e.message || e}` }, 502);
    }

    // Always return JSON to the browser even if Kalshi sends back text
    // (their error pages occasionally do). Parses defensively.
    let payload;
    const text = await upstream.text();
    try   { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { error: text || "kalshi returned non-JSON" }; }
    return jsonResponse(payload, upstream.status);
}
