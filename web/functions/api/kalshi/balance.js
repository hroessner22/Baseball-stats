// GET /api/kalshi/balance
//
// Returns the authenticated user's USD balance from
// Kalshi's /portfolio/balance endpoint. The bearer token must come in
// on the X-Kalshi-Token request header (set by the browser after the
// /login flow stashed it in localStorage).

import { proxyAuthed, corsPreflight } from "./_helpers.js";

export async function onRequest(context) {
    const request = context.request;
    if (request.method === "OPTIONS") return corsPreflight();
    return proxyAuthed(request, "/portfolio/balance");
}
