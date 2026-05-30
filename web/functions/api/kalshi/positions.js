// GET /api/kalshi/positions
//
// Returns the user's open positions across all Kalshi markets. The
// shape Kalshi sends is { market_positions: [...], event_positions: [...] }
// — we pass it straight through so the browser can render either or
// both. Token comes in via X-Kalshi-Token.

import { proxyAuthed, corsPreflight } from "./_helpers.js";

export async function onRequest(context) {
    const request = context.request;
    if (request.method === "OPTIONS") return corsPreflight();
    // Default to a reasonable cap on positions returned — Kalshi's
    // pagination supports up to 1000 per page but we don't need that.
    return proxyAuthed(request, "/portfolio/positions?limit=100");
}
