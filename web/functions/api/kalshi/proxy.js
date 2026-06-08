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

    // ── SERVER-SIDE BUY PROTECTIONS ──────────────────────────────────
    // Bypass-proof — runs on the Cloudflare Worker every Kalshi call
    // routes through. Stale tabs running old client code CANNOT get
    // around these. SELLs always pass; only BUYs are filtered.
    //
    // BUYS_KILLED       — kill switch. true = no BUYs at all.
    // NO_SIDE_KILLED    — block side: 'no' BUYs (regardless of edge).
    // UNIT_CAP_CENTS    — max total cost per single order (count×price).
    //
    // Update these constants + deploy to change behavior.
    const BUYS_KILLED    = false;
    const NO_SIDE_KILLED = true;   // user: 'stop only buying NOs'
    const UNIT_CAP_CENTS = 10;     // user: '10 cents a bet and no more'
    // HARD 50/50 — moneyline (WE) is our strongest signal; reserve
    // half the bankroll exclusively for it, half exclusively for
    // player props. Enforced server-side because stale tabs ignore
    // client-side caps. The proxy fetches current positions before
    // each BUY and rejects if this order would push the bet's kind
    // past its cap.
    const KIND_CAP_CENTS = 50;     // 50¢ per kind, 100¢ total

    if (String(method).toUpperCase() === "POST"
        && String(path).includes("/portfolio/orders")) {
        let parsedBody = null;
        try { parsedBody = body && typeof body === "string" ? JSON.parse(body) : body; }
        catch { parsedBody = null; }
        const action = String(parsedBody?.action || "").toLowerCase();
        const side   = String(parsedBody?.side   || "").toLowerCase();
        const ticker = String(parsedBody?.ticker || "");
        const count  = Number(parsedBody?.count) || 0;
        const yesP   = Number(parsedBody?.yes_price) || 0;
        const noP    = Number(parsedBody?.no_price)  || 0;
        const price  = side === "no" ? noP : yesP;
        const cost   = count * price;

        if (action === "buy") {
            if (BUYS_KILLED) {
                return jsonResponse({
                    error: "BUY orders are disabled server-side",
                    hint:  "Set BUYS_KILLED=false in proxy.js to re-enable.",
                }, 503);
            }
            if (NO_SIDE_KILLED && side === "no") {
                return jsonResponse({
                    error: "NO-side BUYs are disabled server-side",
                    hint:  "Set NO_SIDE_KILLED=false in proxy.js to re-enable.",
                }, 503);
            }
            if (cost > UNIT_CAP_CENTS) {
                return jsonResponse({
                    error: "Order cost exceeds server-side unit cap",
                    hint:  `Cost ${cost}¢ > cap ${UNIT_CAP_CENTS}¢ (${count}×${price}¢). Lower count or price.`,
                }, 503);
            }

            // ── 50/50 KIND CAP ───────────────────────────────────────
            // Classify the bet by ticker shape:
            //   KXMLBGAME-...    → moneyline
            //   KXMLB{HR|HIT|KS|TB}-... → player_prop
            const isProp = /^KXMLB(HR|HIT|KS|TB)/i.test(ticker);
            const isML   = /^KXMLBGAME/i.test(ticker);
            if (isProp || isML) {
                // Auth headers required to query positions — without
                // them we can't enforce the cap, so reject.
                if (presentAuth.length !== authKeys.length) {
                    return jsonResponse({
                        error: "Auth required to BUY (50/50 cap needs position lookup)",
                    }, 401);
                }
                let posData = null;
                try {
                    const posRes = await fetch(
                        `${KALSHI_HOST}/trade-api/v2/portfolio/positions?limit=100`,
                        { method: "GET", headers: {
                            "Content-Type": "application/json",
                            "User-Agent":   "DIAMOND-CONTEXT/0.1 (+https://diamond-context.pages.dev)",
                            ...authHeaders,
                        }}
                    );
                    if (posRes.ok) posData = await posRes.json();
                } catch { posData = null; }
                // Fail closed — if we can't see positions, we can't
                // safely guarantee the cap, so refuse the BUY.
                if (!posData) {
                    return jsonResponse({
                        error: "Could not fetch positions to verify 50/50 cap",
                    }, 503);
                }
                let kindOpenCents = 0;
                for (const p of (posData.market_positions || [])) {
                    const qty = Math.abs(p.position || 0);
                    if (qty === 0) continue;
                    const t  = String(p.ticker || "");
                    const pIsProp = /^KXMLB(HR|HIT|KS|TB)/i.test(t);
                    const pIsML   = /^KXMLBGAME/i.test(t);
                    if ((isProp && pIsProp) || (isML && pIsML)) {
                        const entry = p.average_yes_price
                                   ?? p.average_no_price
                                   ?? p.average_cost_cents
                                   ?? 0;
                        kindOpenCents += qty * entry;
                    }
                }
                if (kindOpenCents + cost > KIND_CAP_CENTS) {
                    return jsonResponse({
                        error: "50/50 kind cap exceeded server-side",
                        hint:  `${isProp ? "player_prop" : "moneyline"} open ${kindOpenCents}¢ + ${cost}¢ = ${kindOpenCents+cost}¢ > cap ${KIND_CAP_CENTS}¢. WE bets get the other half.`,
                    }, 503);
                }
            }
        }
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
