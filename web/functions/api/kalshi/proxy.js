// /api/kalshi/proxy
//
// Generic envelope proxy for the Kalshi API. Replaces the old
// per-endpoint workers (login, balance, positions, orders) because
// Kalshi deprecated email/password login and now requires RSA-signed
// requests for every authenticated call. The signature is computed in
// the BROWSER over (timestamp + method + path), so the path and the
// signed headers travel together as a single envelope.
//
// Request body (JSON):
//   {
//     "method":   "GET" | "POST" | "DELETE",
//     "path":     "/trade-api/v2/portfolio/balance" (full path incl. prefix),
//     "headers":  {
//       "KALSHI-ACCESS-KEY":       "<key id>",
//       "KALSHI-ACCESS-SIGNATURE": "<base64 RSA-PSS signature>",
//       "KALSHI-ACCESS-TIMESTAMP": "<ms timestamp string>"
//     },
//     "body":     <object or null>
//   }
//
// We forward to https://api.elections.kalshi.com{path} with the
// caller's signed headers attached and stream the response back.
//
// SECURITY: the worker never sees the user's private key (it stays in
// the browser via WebCrypto). It also doesn't log key ids, signatures,
// timestamps, request bodies, or trade detail.

import { jsonResponse, corsPreflight } from "./_helpers.js";

const KALSHI_HOST = "https://api.elections.kalshi.com";

export async function onRequest(context) {
    const request = context.request;
    if (request.method === "OPTIONS") return corsPreflight();
    if (request.method !== "POST") {
        return jsonResponse({ error: "POST only" }, 405);
    }

    let envelope;
    try {
        envelope = await request.json();
    } catch {
        return jsonResponse({ error: "invalid JSON envelope" }, 400);
    }

    const { method, path, headers, body } = envelope || {};
    if (!method || !path) {
        return jsonResponse({ error: "method and path required" }, 400);
    }
    // The path must start with /trade-api/v2 — refuse anything else so
    // we can't be used as an open proxy to arbitrary Kalshi internals.
    if (!String(path).startsWith("/trade-api/v2/")) {
        return jsonResponse({ error: "path must start with /trade-api/v2/" }, 400);
    }
    // Auth headers are OPTIONAL — public Kalshi endpoints like
    // /markets/{ticker}/orderbook work without them. If any of the
    // three are present, all three must be present (partial auth would
    // confuse Kalshi). Otherwise we forward without them.
    const authHeaders = {};
    const authKeys = ["KALSHI-ACCESS-KEY", "KALSHI-ACCESS-SIGNATURE", "KALSHI-ACCESS-TIMESTAMP"];
    const presentAuth = authKeys.filter((k) => headers && headers[k]);
    if (presentAuth.length && presentAuth.length !== authKeys.length) {
        return jsonResponse({ error: "incomplete Kalshi auth headers" }, 400);
    }
    if (presentAuth.length === authKeys.length) {
        for (const k of authKeys) authHeaders[k] = headers[k];
    }

    const url = `${KALSHI_HOST}${path}`;
    const init = {
        method: String(method).toUpperCase(),
        headers: {
            "Content-Type": "application/json",
            "User-Agent":   "DIAMOND-CONTEXT/0.1 (+https://diamond-context.pages.dev)",
            ...authHeaders,
        },
    };
    if (body != null) {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    let upstream;
    try {
        upstream = await fetch(url, init);
    } catch (e) {
        return jsonResponse({ error: `kalshi fetch failed: ${e.message || e}` }, 502);
    }
    const text = await upstream.text();
    let payload;
    try   { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { error: text || "kalshi returned non-JSON" }; }
    return jsonResponse(payload, upstream.status);
}
