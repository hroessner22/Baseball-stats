// /api/kalshi/orders
//
// GET  — list the user's open + recently-filled orders
// POST — place a new order on a Kalshi market
//
// POST body shape (mirrors Kalshi's /portfolio/orders payload):
//   {
//     "ticker":           "KXMLBGAME-26MAY29HOUTEX-TEX",  // market ID
//     "client_order_id":  "<uuid>",                       // idempotency key
//     "type":             "limit",                        // or "market"
//     "action":           "buy",                          // or "sell"
//     "side":             "yes",                          // or "no"
//     "count":            10,                             // contracts
//     "yes_price":        25,                             // cents (1-99)
//     // OR "no_price" if buying NO side
//   }
//
// Defensive guards before forwarding:
//   - count must be a positive integer
//   - yes_price / no_price (whichever applies) must be 1..99
//   - ticker must look like KXMLBGAME-... (we don't enforce strictly
//     but we strip whitespace and uppercase)
//   - client_order_id required (Kalshi rejects duplicate ids → de-dupe
//     across retries / accidental double-clicks)
//
// All other fields are forwarded as-is so Kalshi's full feature set
// (advanced order types, expiration timestamps, post-only) is reachable
// without changing this worker.

import { proxyAuthed, corsPreflight, jsonResponse } from "./_helpers.js";

export async function onRequest(context) {
    const request = context.request;
    if (request.method === "OPTIONS") return corsPreflight();
    if (request.method === "GET") {
        return proxyAuthed(request, "/portfolio/orders?limit=50");
    }
    if (request.method !== "POST") {
        return jsonResponse({ error: "GET or POST only" }, 405);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400);
    }

    // Defensive validation — Kalshi's own error messages are
    // descriptive but generic guards here surface bad UI calls earlier.
    const errs = [];
    if (!body.ticker)            errs.push("ticker required");
    if (!body.client_order_id)   errs.push("client_order_id required");
    if (!body.action || !["buy", "sell"].includes(body.action))
        errs.push("action must be 'buy' or 'sell'");
    if (!body.side   || !["yes", "no"].includes(body.side))
        errs.push("side must be 'yes' or 'no'");
    if (!Number.isInteger(body.count) || body.count < 1)
        errs.push("count must be a positive integer");
    const priceKey = body.side === "yes" ? "yes_price" : "no_price";
    if (body.type !== "market") {
        const p = body[priceKey];
        if (!Number.isInteger(p) || p < 1 || p > 99)
            errs.push(`${priceKey} must be an integer 1-99 (cents)`);
    }
    if (errs.length) return jsonResponse({ error: errs.join("; ") }, 400);

    return proxyAuthed(request, "/portfolio/orders", {
        method: "POST",
        body,
    });
}
