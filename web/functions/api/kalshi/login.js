// POST /api/kalshi/login
//
// Body: { email, password }
//
// Forwards to Kalshi's /login endpoint, returns whatever Kalshi
// returns (which on success includes a `token` field the browser
// stores in localStorage and re-attaches as X-Kalshi-Token on every
// subsequent call).
//
// The password ONLY exists in memory for the duration of this
// invocation — no logging, no storage, no retention. The bearer
// token that comes back from Kalshi is what we hand to the browser.

import { KALSHI_BASE, jsonResponse, corsPreflight } from "./_helpers.js";

export async function onRequest(context) {
    const request = context.request;
    if (request.method === "OPTIONS") return corsPreflight();
    if (request.method !== "POST") {
        return jsonResponse({ error: "POST only" }, 405);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const { email, password } = body || {};
    if (!email || !password) {
        return jsonResponse({ error: "email and password required" }, 400);
    }

    let upstream;
    try {
        upstream = await fetch(`${KALSHI_BASE}/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent":   "DIAMOND-CONTEXT/0.1 (+https://diamond-context.pages.dev)",
            },
            body: JSON.stringify({ email, password }),
        });
    } catch (e) {
        return jsonResponse({ error: `kalshi /login failed: ${e.message || e}` }, 502);
    }

    const text = await upstream.text();
    let payload;
    try   { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { error: text || "kalshi returned non-JSON" }; }
    return jsonResponse(payload, upstream.status);
}
