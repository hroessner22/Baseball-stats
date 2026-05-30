// Kalshi in-site trading client (API-key + RSA signing edition).
//
// Kalshi deprecated email/password login on their new API
// (api.elections.kalshi.com). The ONLY auth path now is RSA-PSS
// signing of each request:
//
//   sig = RSA-PSS-SHA256(timestamp + METHOD + path, private_key)
//
// Headers on every authed request:
//   KALSHI-ACCESS-KEY:       <key_id from the user's Kalshi dashboard>
//   KALSHI-ACCESS-SIGNATURE: <base64-encoded signature>
//   KALSHI-ACCESS-TIMESTAMP: <ms timestamp at signing time>
//
// What this file owns:
//   - "Connect Kalshi" modal that takes a Kalshi key id + private key
//     (PEM, downloaded from kalshi.com → Profile → API Keys)
//   - Key id + PEM stored in localStorage; CryptoKey imported into
//     memory and re-imported on every page load
//   - WebCrypto RSA-PSS signing of each request, in the BROWSER —
//     the private key NEVER leaves the user's machine. Our Worker
//     proxy receives only the signed headers + the request envelope
//     and forwards to Kalshi as-is.
//   - GET balance / positions / orders
//   - POST a new order (with confirmation modal)
//   - Account strip in the page header showing balance + sign-out
//   - "Buy YES / Buy NO" inline buttons that get injected next to
//     every Kalshi market row on the per-game Markets tab
//
// Designed so app.js calls Kalshi.renderBetButtons(market) inline
// with each market card and Kalshi.renderAccountStrip() somewhere
// visible.

(function (root) {
"use strict";

const KEY_ID_KEY = "kalshi_key_id_v2";
const PEM_KEY    = "kalshi_pem_v2";
const LABEL_KEY  = "kalshi_label_v2";   // user-friendly name shown in strip
const BALANCE_REFRESH_MS = 30000;

let cachedBalanceCents = null;
let cachedBalanceFetchedAt = 0;
let balanceFetchInFlight = null;
let cachedPrivateKey = null;     // imported CryptoKey, kept in memory
let cachedPrivateKeyPem = null;  // PEM that produced cachedPrivateKey

// ── Storage ─────────────────────────────────────────────────────

function getKeyId() {
    try { return localStorage.getItem(KEY_ID_KEY) || null; }
    catch { return null; }
}
function getPem() {
    try { return localStorage.getItem(PEM_KEY) || null; }
    catch { return null; }
}
function getLabel() {
    try { return localStorage.getItem(LABEL_KEY) || ""; }
    catch { return ""; }
}
function setCredentials(keyId, pem, label) {
    try {
        localStorage.setItem(KEY_ID_KEY, keyId);
        localStorage.setItem(PEM_KEY, pem);
        if (label) localStorage.setItem(LABEL_KEY, label);
    } catch { /* localStorage disabled */ }
}
function clearCredentials() {
    try {
        localStorage.removeItem(KEY_ID_KEY);
        localStorage.removeItem(PEM_KEY);
        localStorage.removeItem(LABEL_KEY);
    } catch { /* no-op */ }
    cachedPrivateKey = null;
    cachedPrivateKeyPem = null;
    cachedBalanceCents = null;
    cachedBalanceFetchedAt = 0;
}
function isConnected() { return !!(getKeyId() && getPem()); }


// ── RSA-PSS signing (WebCrypto) ─────────────────────────────────

// Convert a PEM-encoded RSA private key into a non-extractable WebCrypto
// CryptoKey for RSA-PSS-SHA256 signing.
//
// WebCrypto's importKey only natively accepts PKCS#8 ("BEGIN PRIVATE KEY").
// Kalshi (and OpenSSL by default) gives keys in PKCS#1 ("BEGIN RSA PRIVATE
// KEY") — same underlying RSA material, different ASN.1 wrapper. We
// detect the format and wrap PKCS#1 bytes in a PKCS#8 envelope before
// handing to WebCrypto.
//
// Encrypted keys ("BEGIN ENCRYPTED PRIVATE KEY") need a passphrase and
// aren't supported here — user should download an unencrypted key from
// Kalshi.
async function importPrivateKey(pem) {
    if (cachedPrivateKey && cachedPrivateKeyPem === pem) return cachedPrivateKey;

    const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
    const isPkcs8 = /BEGIN PRIVATE KEY/.test(pem);
    const isEncrypted = /BEGIN ENCRYPTED PRIVATE KEY/.test(pem);

    if (isEncrypted) {
        throw new Error("Encrypted private keys aren't supported — download an unencrypted .pem from Kalshi.");
    }
    if (!isPkcs1 && !isPkcs8) {
        throw new Error("PEM must start with -----BEGIN RSA PRIVATE KEY----- or -----BEGIN PRIVATE KEY-----");
    }

    const cleaned = pem
        .replace(/-----BEGIN [A-Z ]+-----/g, "")
        .replace(/-----END [A-Z ]+-----/g, "")
        .replace(/\s+/g, "");
    if (!cleaned) throw new Error("Empty PEM body");

    const innerBytes = base64ToBytes(cleaned);
    const pkcs8Bytes = isPkcs1 ? wrapPkcs1AsPkcs8(innerBytes) : innerBytes;

    const key = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8Bytes.buffer,
        { name: "RSA-PSS", hash: "SHA-256" },
        false,          // not extractable
        ["sign"],
    );
    cachedPrivateKey = key;
    cachedPrivateKeyPem = pem;
    return key;
}

// Wrap a PKCS#1 RSAPrivateKey blob in a PKCS#8 PrivateKeyInfo envelope
// so WebCrypto can ingest it. Hand-built ASN.1 DER — the only thing
// that changes between keys is the inner length encoding, so we do
// short/medium/long length forms inline.
//
// PKCS#8 PrivateKeyInfo ::= SEQUENCE {
//   version                   INTEGER (0),
//   privateKeyAlgorithm       AlgorithmIdentifier (rsaEncryption + NULL),
//   privateKey                OCTET STRING (the PKCS#1 bytes)
// }
function wrapPkcs1AsPkcs8(pkcs1Bytes) {
    const PKCS1_LEN = pkcs1Bytes.length;
    // AlgorithmIdentifier for rsaEncryption (OID 1.2.840.113549.1.1.1):
    //   30 0D 06 09 2A 86 48 86 F7 0D 01 01 01 05 00
    const ALGO_ID = new Uint8Array([
        0x30, 0x0D,
        0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01,
        0x05, 0x00,
    ]);
    const VERSION = new Uint8Array([0x02, 0x01, 0x00]);
    const octetHeader = derLength(0x04, PKCS1_LEN);
    const innerLen = VERSION.length + ALGO_ID.length + octetHeader.length + PKCS1_LEN;
    const outerHeader = derLength(0x30, innerLen);

    const out = new Uint8Array(outerHeader.length + innerLen);
    let off = 0;
    out.set(outerHeader, off);   off += outerHeader.length;
    out.set(VERSION, off);       off += VERSION.length;
    out.set(ALGO_ID, off);       off += ALGO_ID.length;
    out.set(octetHeader, off);   off += octetHeader.length;
    out.set(pkcs1Bytes, off);
    return out;
}

// Build an ASN.1 DER `tag + length` prefix for a payload of `len` bytes.
// Handles short (<128), 1-byte, and 2-byte length forms — enough for any
// 2048/4096-bit RSA key. Larger keys would need 3+ byte forms; keep
// guarded.
function derLength(tag, len) {
    if (len < 0x80) {
        return new Uint8Array([tag, len]);
    } else if (len < 0x100) {
        return new Uint8Array([tag, 0x81, len]);
    } else if (len < 0x10000) {
        return new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
    }
    throw new Error("PEM payload too large to encode");
}

function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
function bytesToBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

// Signs (timestamp + METHOD + path) with the user's private key using
// RSA-PSS / SHA-256 / salt-length 32 — Kalshi's spec, same as their
// official Python SDK.
async function signRequest(privateKey, method, path) {
    const timestamp = Date.now().toString();
    const msg = timestamp + String(method).toUpperCase() + path;
    const data = new TextEncoder().encode(msg);
    const sigBytes = await crypto.subtle.sign(
        { name: "RSA-PSS", saltLength: 32 },
        privateKey,
        data,
    );
    return { timestamp, signature: bytesToBase64(new Uint8Array(sigBytes)) };
}


// ── API wrappers ────────────────────────────────────────────────

// Generic signed call to Kalshi via our /api/kalshi/proxy worker.
// `path` is the full Kalshi path including /trade-api/v2 prefix.
async function callKalshi(method, path, body = null) {
    const keyId = getKeyId();
    const pem = getPem();
    if (!keyId || !pem) throw new Error("not connected to Kalshi");
    const privateKey = await importPrivateKey(pem);
    // Sign path WITHOUT query string — Kalshi signs the path only.
    const signPath = path.split("?")[0];
    const { timestamp, signature } = await signRequest(privateKey, method, signPath);

    const res = await fetch("/api/kalshi/proxy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            method,
            path,
            headers: {
                "KALSHI-ACCESS-KEY":       keyId,
                "KALSHI-ACCESS-SIGNATURE": signature,
                "KALSHI-ACCESS-TIMESTAMP": timestamp,
            },
            body: body,
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // 401/403 → key revoked or signing mismatch. Drop creds so the
        // UI re-prompts cleanly.
        if (res.status === 401 || res.status === 403) clearCredentials();
        const msg = (data && (data.error?.message || data.error || data.message))
            || `kalshi ${path} → HTTP ${res.status}`;
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
}

async function getBalance() {
    if (!isConnected()) return null;
    const now = Date.now();
    if (now - cachedBalanceFetchedAt < BALANCE_REFRESH_MS && cachedBalanceCents != null) {
        return cachedBalanceCents;
    }
    if (balanceFetchInFlight) return balanceFetchInFlight;
    balanceFetchInFlight = (async () => {
        try {
            const data = await callKalshi("GET", "/trade-api/v2/portfolio/balance");
            cachedBalanceCents = Number(data.balance) || 0;
            cachedBalanceFetchedAt = Date.now();
            return cachedBalanceCents;
        } catch {
            return null;
        } finally {
            balanceFetchInFlight = null;
        }
    })();
    return balanceFetchInFlight;
}

async function placeOrder(opts) {
    // opts = { ticker, side ("yes"|"no"), count, price (cents 1-99) }
    const priceKey = opts.side === "yes" ? "yes_price" : "no_price";
    const payload = {
        ticker:          opts.ticker,
        client_order_id: cryptoUuid(),
        type:            "limit",
        action:          "buy",
        side:            opts.side,
        count:           opts.count,
        [priceKey]:      opts.price,
    };
    return callKalshi("POST", "/trade-api/v2/portfolio/orders", payload);
}

async function cancelOrder(orderId) {
    if (!orderId) throw new Error("orderId required");
    // Send the DELETE and capture whatever Kalshi returns so the
    // caller can surface useful detail to the user (rather than the
    // generic "Order cancelled" we showed before, which could be a
    // lie if Kalshi accepted the request but didn't actually cancel).
    const res = await callKalshi(
        "DELETE",
        `/trade-api/v2/portfolio/orders/${encodeURIComponent(orderId)}`,
    );
    // Verify by re-fetching the order. Kalshi sometimes accepts DELETE
    // but reports the order in a different terminal state (filled,
    // expired, etc.) by the time we look. Surfacing that to the user
    // is more honest than a green "cancelled" toast that doesn't match
    // what they see on kalshi.com.
    let finalStatus = null;
    try {
        const verify = await callKalshi(
            "GET",
            `/trade-api/v2/portfolio/orders/${encodeURIComponent(orderId)}`,
        );
        finalStatus = verify?.order?.status || null;
    } catch { /* verification is best-effort */ }
    return { cancel: res, finalStatus };
}

async function getOpenOrders() {
    if (!isConnected()) return [];
    try {
        const data = await callKalshi("GET", "/trade-api/v2/portfolio/orders?status=resting&limit=50");
        return data.orders || [];
    } catch { return []; }
}

async function getPositions() {
    if (!isConnected()) return { market_positions: [] };
    try {
        return await callKalshi("GET", "/trade-api/v2/portfolio/positions?limit=100");
    } catch { return { market_positions: [] }; }
}

// Public Kalshi orderbook — used by "take existing offer" mode to
// figure out what's actually available to fill against.
//
// Kalshi currently returns one of two shapes (both observed live):
//   OLD:  { orderbook:    { yes: [[price_cents, contract_qty], ...], no: [...] } }
//   NEW:  { orderbook_fp: { yes_dollars: [[price_$_str, qty_$_str], ...], no_dollars: [...] } }
//
// We normalize both to { yes: [[price_cents, contracts], ...], no: [...] }
// so the rest of the code is shape-agnostic. Both formats sort each
// array ASCENDING by price.
async function getOrderbook(ticker) {
    if (!ticker) return null;
    try {
        const res = await fetch("/api/kalshi/proxy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                method: "GET",
                path:   `/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook`,
                headers: {},
                body:    null,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return null;
        const raw = data.orderbook_fp || data.orderbook;
        return normalizeOrderbook(raw);
    } catch { return null; }
}

function normalizeOrderbook(raw) {
    if (!raw) return null;
    // Old format already in [price_cents, contracts] — pass through.
    if (raw.yes || raw.no) {
        return { yes: raw.yes || [], no: raw.no || [] };
    }
    // New format: price in dollars as string, qty in dollars as string.
    // Convert: price_cents = price_$ × 100; contracts = qty_$ / price_$.
    const conv = (arr) => (arr || []).map(([p, q]) => {
        const priceDollars = parseFloat(p);
        const qtyDollars   = parseFloat(q);
        if (!Number.isFinite(priceDollars) || priceDollars <= 0
            || !Number.isFinite(qtyDollars) || qtyDollars <= 0) {
            return [0, 0];
        }
        return [Math.round(priceDollars * 100), Math.floor(qtyDollars / priceDollars)];
    }).filter(([p, c]) => p > 0 && c > 0);
    return {
        yes: conv(raw.yes_dollars),
        no:  conv(raw.no_dollars),
    };
}

// On a binary Kalshi market, the YES order book and the NO order book
// are TWO sides of the same coin. If someone is bidding `q` × NO at
// price `p`¢, that's equivalent to someone OFFERING (asking) to sell
// YES at `(100 - p)`¢ for that same `q` quantity. This is how Kalshi
// expresses asks in its public orderbook: there's no separate "yes_ask"
// list — instead you read the "no" bids and flip them. Returns the
// best ask for the side you want to BUY, with the count available.
function bestAskForBuy(orderbook, side) {
    if (!orderbook) return null;
    // To buy YES at the lowest price, look at NO bids (highest first
    // when sorted by NO price = lowest YES ask).
    const otherSide = side === "yes" ? "no" : "yes";
    const otherBook = orderbook[otherSide] || [];
    // Kalshi sorts the array ascending by price. The HIGHEST NO bid
    // corresponds to the LOWEST YES ask. So we want the last entry.
    if (!otherBook.length) return null;
    const last = otherBook[otherBook.length - 1];
    const otherPrice = Number(last[0]);
    const count = Number(last[1]);
    const askPrice = 100 - otherPrice;
    if (!Number.isFinite(askPrice) || !Number.isFinite(count) || count < 1) return null;
    return { price: askPrice, count };
}

function cryptoUuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}


// ── Connect modal ───────────────────────────────────────────────

function openConnectModal() {
    const overlay = document.createElement("div");
    overlay.className = "kalshi-modal-overlay";
    overlay.innerHTML = `
      <div class="kalshi-modal" role="dialog" aria-modal="true" aria-labelledby="km-title">
        <button class="km-close" aria-label="Close">×</button>
        <h2 id="km-title">Connect Kalshi</h2>
        <p class="km-sub">
          Place bets directly from this site via your
          <a href="https://kalshi.com" target="_blank" rel="noopener">Kalshi</a>
          account. Kalshi is a CFTC-regulated US exchange, available in
          New York.
        </p>
        <ol class="km-steps">
          <li>Go to <a href="https://kalshi.com/account/profile" target="_blank" rel="noopener">kalshi.com / Profile / API Keys</a>.</li>
          <li>Click <strong>Create new API key</strong>. Save the key ID (a UUID) and download the private key file (.pem).</li>
          <li>Paste both below.</li>
        </ol>
        <p class="km-sub km-sub-trust">
          Your private key stays in your browser — it's imported as a
          non-extractable WebCrypto key and used to RSA-sign each
          request locally. Our server never sees the key, only the
          per-request signature.
        </p>
        <form class="km-form">
          <label class="km-field">
            <span>Key ID</span>
            <input type="text" name="key_id" autocomplete="off"
                   placeholder="e.g. 6f7e8c9d-1a2b-3c4d-..." required>
          </label>
          <label class="km-field">
            <span>Private key (paste the .pem file contents)</span>
            <textarea name="pem" rows="7" required spellcheck="false"
                      placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;MIIEowIBAAKCAQ...&#10;-----END RSA PRIVATE KEY-----"></textarea>
          </label>
          <label class="km-field km-field-inline">
            <span>Label (optional, shown in the account strip)</span>
            <input type="text" name="label" autocomplete="off"
                   placeholder="e.g. main account">
          </label>
          <div class="km-error" hidden></div>
          <div class="km-actions">
            <button type="button" class="km-cancel">Cancel</button>
            <button type="submit" class="km-submit">Connect</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    const form    = overlay.querySelector(".km-form");
    const errEl   = overlay.querySelector(".km-error");
    const submit  = overlay.querySelector(".km-submit");
    const close   = () => overlay.remove();
    overlay.querySelector(".km-close").addEventListener("click", close);
    overlay.querySelector(".km-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const data = new FormData(form);
        const keyId = String(data.get("key_id") || "").trim();
        const pem = String(data.get("pem") || "").trim();
        const label = String(data.get("label") || "").trim();
        errEl.hidden = true;
        submit.disabled = true;
        submit.textContent = "Validating…";
        try {
            if (!keyId) throw new Error("Key ID required");
            if (!/BEGIN[A-Z ]+PRIVATE KEY/.test(pem)) {
                throw new Error("Private key must be PEM format (starts with -----BEGIN ... PRIVATE KEY-----)");
            }
            // Test by trying to import the key + fetch balance.
            // Stash creds first so callKalshi() can use them.
            setCredentials(keyId, pem, label);
            try {
                await importPrivateKey(pem);
            } catch (e) {
                clearCredentials();
                throw new Error("Could not parse private key: " + (e.message || e));
            }
            // Real round-trip test.
            try {
                await callKalshi("GET", "/trade-api/v2/portfolio/balance");
            } catch (e) {
                clearCredentials();
                throw e;
            }
            close();
            renderAllAccountStrips();
            renderAllBetButtons();
            toast("Connected to Kalshi", "ok");
        } catch (err) {
            errEl.hidden = false;
            errEl.textContent = err.message || "Connection failed";
            submit.disabled = false;
            submit.textContent = "Connect";
        }
    });

    setTimeout(() => overlay.querySelector('input[name="key_id"]')?.focus(), 50);
}


// ── Bet modal (unchanged from prior version) ────────────────────

function openBetModal(market, outcome, seed = null) {
    if (!isConnected()) {
        openConnectModal();
        return;
    }
    const idMatch = String(outcome.id || "").match(/^(.*):(yes|no)$/i);
    const ticker = idMatch ? idMatch[1] : (market.raw_market_id || "");
    const side = (idMatch ? idMatch[2] : "yes").toLowerCase();
    const probPercent = outcome.probability != null
        ? Math.max(1, Math.min(99, Math.round(outcome.probability * 100)))
        : 50;
    // Seed = the stake + price the user already typed into the inline
    // calculator on the card. Pre-fill the "Contracts" field with the
    // rounded-down contract count their stake actually buys so they
    // don't have to do the dollars-to-contracts math twice.
    const seedCount = (seed && Number.isFinite(seed.stake_dollars) && Number.isFinite(seed.price_cents) && seed.price_cents > 0)
        ? Math.max(1, Math.floor(seed.stake_dollars / (seed.price_cents / 100)))
        : 1;

    const overlay = document.createElement("div");
    overlay.className = "kalshi-modal-overlay";
    overlay.innerHTML = `
      <div class="kalshi-modal kalshi-bet-modal" role="dialog" aria-modal="true">
        <button class="km-close" aria-label="Close">×</button>
        <h2>Buy ${side.toUpperCase()} · ${escapeHtml(outcome.name || "")}</h2>
        <p class="km-sub km-bet-ticker">${escapeHtml(market.title || "")}</p>
        <p class="km-sub km-ticker-line">Ticker <code>${escapeHtml(ticker)}</code></p>

        <!-- TAKE vs POST mode toggle. Take = fill immediately at the
             best available ask. Post = put your own price on the book
             and wait for someone to take it. -->
        <div class="km-mode-tabs" role="tablist">
          <button type="button" class="km-mode-tab active" data-mode="take" role="tab" aria-selected="true">
            Take existing offer
          </button>
          <button type="button" class="km-mode-tab" data-mode="post" role="tab" aria-selected="false">
            Post your own price
          </button>
        </div>

        <div class="km-mode-body km-mode-take">
          <div class="km-orderbook-info" data-ob-info>
            <span class="km-ob-loading">Loading orderbook…</span>
          </div>
          <form class="km-form km-bet-form" data-form="take">
            <label class="km-field">
              <span>Contracts to buy
                <button type="button" class="km-max-btn" data-take-max
                        title="Spend my full available balance">Max</button>
              </span>
              <input type="number" name="count" min="1" step="1" value="${seedCount}" required>
              <small class="km-hint" data-ob-hint></small>
            </label>
            <div class="km-total">
              Cost at best ask: <strong class="km-total-val">—</strong>
            </div>
            <div class="km-error" hidden></div>
            <div class="km-actions">
              <button type="button" class="km-cancel">Cancel</button>
              <button type="submit" class="km-submit" disabled>Take offer</button>
            </div>
          </form>
        </div>

        <div class="km-mode-body km-mode-post" hidden>
          <p class="km-sub km-mode-explainer">
            Your order sits on Kalshi's book at your chosen price until
            someone takes it (or you cancel). Pays $1 per contract if you win.
          </p>
          <form class="km-form km-bet-form" data-form="post">
            <label class="km-field">
              <span>Contracts
                <button type="button" class="km-max-btn" data-post-max
                        title="Buy as many as my balance allows at the chosen price">Max</button>
              </span>
              <input type="number" name="count" min="1" step="1" value="${seedCount}" required>
            </label>
            <label class="km-field">
              <span>Your limit price (¢)</span>
              <input type="number" name="price" min="1" max="99" step="1"
                     value="${probPercent}" required>
              <small class="km-hint">1¢-99¢. Each contract pays $1 if you win.</small>
            </label>
            <div class="km-total">
              Total cost: <strong class="km-total-val">$${(probPercent / 100).toFixed(2)}</strong>
            </div>
            <div class="km-error" hidden></div>
            <div class="km-actions">
              <button type="button" class="km-cancel">Cancel</button>
              <button type="submit" class="km-submit">Place limit order</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelectorAll(".km-close, .km-cancel").forEach((b) =>
        b.addEventListener("click", close));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    // Mode toggle behavior
    const takeBody = overlay.querySelector(".km-mode-take");
    const postBody = overlay.querySelector(".km-mode-post");
    const tabs = overlay.querySelectorAll(".km-mode-tab");
    tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
            tabs.forEach((t) => {
                const active = t === tab;
                t.classList.toggle("active", active);
                t.setAttribute("aria-selected", active ? "true" : "false");
            });
            const mode = tab.getAttribute("data-mode");
            takeBody.hidden = mode !== "take";
            postBody.hidden = mode !== "post";
        });
    });

    // POST form: original limit-order behavior
    const postForm = overlay.querySelector('[data-form="post"]');
    const postTotalEl = postForm.querySelector(".km-total-val");
    const postCnt = postForm.querySelector('input[name="count"]');
    const postPrc = postForm.querySelector('input[name="price"]');
    const postRecalc = () => {
        const cnt = Number(postCnt.value) || 0;
        const prc = Number(postPrc.value) || 0;
        postTotalEl.textContent = `$${((cnt * prc) / 100).toFixed(2)}`;
    };
    postCnt.addEventListener("input", postRecalc);
    postPrc.addEventListener("input", postRecalc);
    postForm.addEventListener("submit", (e) => {
        e.preventDefault();
        submitOrder(postForm, ticker, side, parseInt(postPrc.value, 10), parseInt(postCnt.value, 10), close, "post");
    });

    // TAKE form: fetch orderbook, fill out the best-ask info, set the
    // submit button live with the qty cap.
    const takeForm = overlay.querySelector('[data-form="take"]');
    const obInfo = overlay.querySelector("[data-ob-info]");
    const obHint = takeForm.querySelector("[data-ob-hint]");
    const takeTotal = takeForm.querySelector(".km-total-val");
    const takeCnt = takeForm.querySelector('input[name="count"]');
    const takeSubmit = takeForm.querySelector(".km-submit");

    let bestAsk = null;        // { price, count } once orderbook loads
    const recalcTake = () => {
        const cnt = Number(takeCnt.value) || 0;
        if (!bestAsk) {
            takeTotal.textContent = "—";
            takeSubmit.disabled = true;
            return;
        }
        const capped = Math.min(cnt, bestAsk.count);
        const cost = capped * bestAsk.price / 100;
        takeTotal.textContent = `$${cost.toFixed(2)} (${capped} × ${bestAsk.price}¢)`;
        takeSubmit.disabled = !(capped >= 1);
        if (cnt > bestAsk.count) {
            obHint.textContent = `Only ${bestAsk.count} available at ${bestAsk.price}¢ — your order will fill ${bestAsk.count} and reject the rest.`;
            obHint.className = "km-hint km-hint-warn";
        } else {
            obHint.textContent = `${bestAsk.count} available at ${bestAsk.price}¢.`;
            obHint.className = "km-hint";
        }
    };
    takeCnt.addEventListener("input", recalcTake);
    takeForm.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!bestAsk) return;
        const cnt = Math.min(parseInt(takeCnt.value, 10) || 0, bestAsk.count);
        if (cnt < 1) return;
        // Take = place a limit order AT the best ask price. Crosses the
        // book and fills against the resting offer.
        submitOrder(takeForm, ticker, side, bestAsk.price, cnt, close, "take");
    });

    // Load the orderbook for take mode.
    getOrderbook(ticker).then((ob) => {
        bestAsk = bestAskForBuy(ob, side);
        if (bestAsk) {
            obInfo.innerHTML = `
              <div class="km-ob-row">
                <span class="km-ob-label">Best ask</span>
                <span class="km-ob-val">${bestAsk.price}¢</span>
                <span class="km-ob-qty">× ${bestAsk.count} available</span>
              </div>
            `;
            takeCnt.max = bestAsk.count;
            recalcTake();
        } else {
            obInfo.innerHTML = `
              <div class="km-ob-empty">
                <strong>No offers to take.</strong>
                Nobody is currently selling ${side.toUpperCase()} on this
                market. Switch to <em>Post your own price</em> to put a
                bid on the book and wait, or pick a different market.
              </div>
            `;
            takeSubmit.disabled = true;
        }
    });

    // Max buttons: fill count with as many contracts as the user's
    // available Kalshi balance can afford at the relevant price.
    // Take mode uses the live best-ask; post mode uses the user's
    // limit price.
    overlay.querySelector("[data-take-max]")?.addEventListener("click", async () => {
        const bal = await getBalance();
        if (!bal || bal < 1) { toast("Need a Kalshi balance > $0 first", "err"); return; }
        if (!bestAsk) { toast("Wait for the orderbook to load", "err"); return; }
        const pCents = bestAsk.price;
        const maxAffordable = Math.floor(bal / pCents);
        const maxFillable = Math.min(maxAffordable, bestAsk.count);
        if (maxFillable < 1) {
            toast(`$${(bal/100).toFixed(2)} can't afford 1 at ${pCents}¢`, "err");
            return;
        }
        takeCnt.value = maxFillable;
        recalcTake();
    });

    overlay.querySelector("[data-post-max]")?.addEventListener("click", async () => {
        const bal = await getBalance();
        if (!bal || bal < 1) { toast("Need a Kalshi balance > $0 first", "err"); return; }
        const pCents = parseInt(postPrc.value, 10);
        if (!Number.isFinite(pCents) || pCents < 1) {
            toast("Set a valid limit price first", "err");
            return;
        }
        const maxAffordable = Math.floor(bal / pCents);
        if (maxAffordable < 1) {
            toast(`$${(bal/100).toFixed(2)} can't afford 1 at ${pCents}¢`, "err");
            return;
        }
        postCnt.value = maxAffordable;
        postRecalc();
    });

    setTimeout(() => takeCnt.focus(), 50);
}

// Shared submit for both take and post modes — fires placeOrder,
// shows toast, refreshes balance + open orders.
async function submitOrder(form, ticker, side, price, count, close, mode) {
    const submit = form.querySelector(".km-submit");
    const errEl = form.querySelector(".km-error");
    errEl.hidden = true;
    submit.disabled = true;
    const originalText = submit.textContent;
    submit.textContent = mode === "take" ? "Taking…" : "Placing…";
    try {
        const res = await placeOrder({ ticker, side, count, price });
        close();
        cachedBalanceCents = null;
        cachedBalanceFetchedAt = 0;
        renderAllAccountStrips();
        renderAllMyBets();
        const status = res?.order?.status || "submitted";
        const verb = mode === "take" ? "Took" : "Placed";
        toast(`${verb} ${count} × ${side.toUpperCase()} @ ${price}¢ (${status})`, "ok");
    } catch (err) {
        errEl.hidden = false;
        errEl.textContent = err.message || "Order failed";
        submit.disabled = false;
        submit.textContent = originalText;
    }
}


// ── Account strip ───────────────────────────────────────────────

function renderAccountStrip() {
    if (!isConnected()) {
        return `
          <div class="kalshi-strip kalshi-strip-disconnected">
            <button class="ks-cta" data-kalshi-connect>Connect Kalshi to bet live</button>
          </div>
        `;
    }
    const balCents = cachedBalanceCents;
    const balText = balCents != null ? `$${(balCents / 100).toFixed(2)}` : "…";
    const label = getLabel();
    return `
      <div class="kalshi-strip kalshi-strip-connected">
        <span class="ks-label">Kalshi</span>
        <span class="ks-balance">Balance <strong>${balText}</strong></span>
        ${label ? `<span class="ks-email">${escapeHtml(label)}</span>` : ""}
        <button class="ks-signout" data-kalshi-signout>Sign out</button>
      </div>
    `;
}

function renderAllAccountStrips() {
    document.querySelectorAll("[data-kalshi-strip]").forEach((el) => {
        el.innerHTML = renderAccountStrip();
    });
}


// ── My Bets panel — balance breakdown + open orders + cancel ────

// Shell that gets injected into any [data-kalshi-mybets] slot. Real
// content (orders, positions) is hydrated async from Kalshi via
// refreshMyBets() so the dashboard render isn't blocked on a network
// round-trip. Re-render is cheap.
function renderMyBetsPanel() {
    if (!isConnected()) {
        return `
          <div class="ks-mybets ks-mybets-disconnected">
            <div class="ks-mybets-head">My Kalshi bets</div>
            <p class="ks-mybets-empty">
              <button class="ks-cta" data-kalshi-connect>Connect Kalshi</button>
              to see your balance and open orders here.
            </p>
          </div>
        `;
    }
    const balCents = cachedBalanceCents;
    const balText = balCents != null ? `$${(balCents / 100).toFixed(2)}` : "…";
    return `
      <div class="ks-mybets">
        <div class="ks-mybets-head">
          <span>My Kalshi</span>
          <button class="ks-mybets-refresh" data-kalshi-mybets-refresh
                  title="Refresh">⟳</button>
        </div>
        <div class="ks-mybets-grid">
          <div class="ks-mybets-balance">
            <div class="ks-mybets-key">Available balance</div>
            <div class="ks-mybets-balance-val">${balText}</div>
          </div>
          <div class="ks-mybets-orders" data-kalshi-orders-slot>
            <div class="ks-mybets-key">Open orders</div>
            <div class="ks-mybets-orders-body">Loading…</div>
          </div>
        </div>
      </div>
    `;
}

function renderAllMyBets() {
    const slots = document.querySelectorAll("[data-kalshi-mybets]");
    if (!slots.length) return;
    slots.forEach((s) => { s.innerHTML = renderMyBetsPanel(); });
    if (isConnected()) refreshMyBets();
}

// Pulls open orders fresh and renders into the orders slot. Called on
// every render and on a 20s interval while the user is on the page.
let myBetsRefreshTimer = null;
async function refreshMyBets() {
    if (!isConnected()) return;
    const slots = document.querySelectorAll("[data-kalshi-orders-slot]");
    if (!slots.length) return;
    const [orders, balance] = await Promise.all([
        getOpenOrders(),
        getBalance(),
    ]);
    renderAllAccountStrips();
    // Update the balance display in the panel.
    document.querySelectorAll(".ks-mybets-balance-val").forEach((el) => {
        el.textContent = balance != null ? `$${(balance / 100).toFixed(2)}` : "…";
    });
    slots.forEach((slot) => {
        slot.innerHTML = `
          <div class="ks-mybets-key">Open orders (${orders.length})</div>
          ${orders.length === 0
            ? `<div class="ks-mybets-orders-empty">No resting orders. Place one from any Kalshi market card.</div>`
            : `<table class="ks-mybets-table">
                 <thead>
                   <tr><th>Market</th><th>Side</th><th>Qty</th><th>Price</th><th></th></tr>
                 </thead>
                 <tbody>
                   ${orders.map(renderMyBetRow).join("")}
                 </tbody>
               </table>`}
        `;
    });
}

function renderMyBetRow(o) {
    const ticker = o.ticker || "";
    const sideName = (o.yes_price != null) ? "YES" : "NO";
    const price = o.yes_price != null ? o.yes_price : o.no_price;
    const remaining = (o.remaining_count != null) ? o.remaining_count : o.count;
    // Truncate ticker — KXMLBGAME-26MAY301605KCTEX-TEX → KCTEX-TEX
    const shortTicker = ticker.replace(/^KXMLBGAME-\d+[A-Z]+\d+/, "").replace(/^-+/, "") || ticker;
    return `
      <tr data-order-id="${escapeHtmlAttr(o.order_id || "")}">
        <td title="${escapeHtmlAttr(ticker)}">
          <code class="ks-mybets-ticker">${escapeHtml(shortTicker)}</code>
        </td>
        <td><span class="ks-mybets-side ks-mybets-side-${sideName.toLowerCase()}">${sideName}</span></td>
        <td>${remaining}</td>
        <td>${price != null ? price + "¢" : "—"}</td>
        <td>
          <button class="ks-mybets-cancel" data-kalshi-cancel="${escapeHtmlAttr(o.order_id || "")}">Cancel</button>
        </td>
      </tr>
    `;
}

function renderAllBetButtons() {
    document.querySelectorAll("[data-kalshi-bet-slot]").forEach((slot) => {
        const enabled = isConnected();
        const side = slot.getAttribute("data-side") || "yes";
        const team = slot.getAttribute("data-team") || "";
        if (enabled) {
            slot.innerHTML = `<button class="ks-bet-btn ks-bet-${side}"
                data-kalshi-bet="1">Buy ${side.toUpperCase()}${team ? ` · ${escapeHtml(team)}` : ""}</button>`;
        } else {
            slot.innerHTML = `<button class="ks-bet-btn ks-bet-disconnected"
                data-kalshi-connect>Connect to bet</button>`;
        }
    });
}

function renderBetButtons(market) {
    if (market.source !== "kalshi") return "";
    const outs = (market.outcomes || []).slice(0, 2);
    // Stake input is GLOBAL — it lives in a floating widget pinned to
    // document.body via ensureGlobalStakeWidget(), so neither the 8s
    // markets-pane re-render nor the 5s game-view re-render can wipe
    // it out from under the user's typing. Bet cards just show two
    // Buy buttons with a live "to win" caption computed against that
    // single global stake. Read it once per render; the widget's
    // input listener calls refreshAllBetPayouts() to push fresh
    // captions into every visible button when the value changes.
    const stake = getGlobalStake();
    const tickerBases = outs.map((o) => {
        const m = String(o.id || "").match(/^(.*):(yes|no)$/i);
        return m ? m[1] : (market.raw_market_id || "");
    });
    const sameTickerBinary = outs.length === 2 && tickerBases[0] && tickerBases[0] === tickerBases[1];
    return `
      <div class="ks-bet-row" data-bet-row="1">
        <div class="ks-bet-buttons">
          ${outs.map((o) => {
              const idMatch = String(o.id || "").match(/^(.*):(yes|no)$/i);
              const side = (idMatch ? idMatch[2] : "yes").toLowerCase();
              const fullTicker = idMatch ? idMatch[1] : (market.raw_market_id || "");
              const yesCents = o.probability != null
                  ? Math.max(1, Math.min(99, Math.round(o.probability * 100)))
                  : null;
              const priceCents = yesCents == null
                  ? null
                  : (side === "yes" ? yesCents : 100 - yesCents);
              const payoutText = formatPayout(stake, priceCents);
              const action = sameTickerBinary
                  ? `Buy ${side.toUpperCase()}`
                  : `Buy ${o.name || side.toUpperCase()}`;
              return `
                <button class="ks-bet-btn ks-bet-${side}"
                        data-kalshi-bet="1"
                        data-ticker="${escapeHtmlAttr(fullTicker)}"
                        data-market-id="${escapeHtmlAttr(market.id || "")}"
                        data-market-title="${escapeHtmlAttr(market.title || "")}"
                        data-outcome-id="${escapeHtmlAttr(o.id || "")}"
                        data-outcome-name="${escapeHtmlAttr(o.name || "")}"
                        data-outcome-prob="${o.probability != null ? o.probability : ""}"
                        data-side="${side}"
                        data-price-cents="${priceCents != null ? priceCents : ""}">
                  <span class="ks-bet-btn-action">${escapeHtml(action)}</span>
                  <span class="ks-bet-btn-win" data-bet-payout>${payoutText}</span>
                </button>
              `;
          }).join("")}
        </div>
      </div>
    `;
}

// ── Global stake widget ────────────────────────────────────────────
//
// One stake input for every Kalshi bet, lives in document.body. The
// markets pane innerHTML wipes (every 8s) and the game-view innerHTML
// wipes (every 5s) can never see this element, so the user's typed
// value + cursor stay put across both. Position is sticky-top-right
// of the viewport; only visible when at least one Buy button is on
// screen. Value persists across hard reloads via localStorage.

const GLOBAL_STAKE_LS_KEY = "diamond_context_global_bet_stake";

function getGlobalStake() {
    if (typeof window === "undefined") return 0.50;
    if (window._globalBetStake != null) return window._globalBetStake;
    try {
        const fromLS = parseFloat(localStorage.getItem(GLOBAL_STAKE_LS_KEY) || "");
        if (Number.isFinite(fromLS) && fromLS > 0) {
            window._globalBetStake = fromLS;
            return fromLS;
        }
    } catch { /* localStorage blocked */ }
    window._globalBetStake = 0.50;
    return 0.50;
}

function setGlobalStake(val) {
    const num = parseFloat(val);
    if (!Number.isFinite(num) || num <= 0) return;
    window._globalBetStake = num;
    try { localStorage.setItem(GLOBAL_STAKE_LS_KEY, String(num)); } catch {}
    refreshAllBetPayouts();
}

function ensureGlobalStakeWidget() {
    if (typeof document === "undefined") return;
    if (document.getElementById("global-stake-widget")) return;
    const widget = document.createElement("div");
    widget.id = "global-stake-widget";
    widget.className = "global-stake-widget";
    widget.innerHTML = `
      <span class="gsw-label">Bet stake</span>
      <span class="gsw-prefix">$</span>
      <input type="number" id="global-stake-input"
             class="gsw-input" min="0.01" step="0.01"
             value="${getGlobalStake().toFixed(2)}" />
      <span class="gsw-help">Applied to every Buy button</span>
    `;
    document.body.appendChild(widget);
    const input = widget.querySelector("#global-stake-input");
    input.addEventListener("input", () => setGlobalStake(input.value));
    syncGlobalStakeWidgetVisibility();
}

// Show whenever there's at least one ANY-kind bet affordance on
// screen — covers .ks-bet-btn (per-game pane + team page) AND
// .md-game-outcome (slate dashboard's clickable price buttons,
// which route through openBetModal seeded with the global stake).
// MutationObserver re-runs this on any DOM change, so the widget
// appears/disappears as the user navigates.
function syncGlobalStakeWidgetVisibility() {
    if (typeof document === "undefined") return;
    const widget = document.getElementById("global-stake-widget");
    if (!widget) return;
    const hasBetSurface = !!document.querySelector(".ks-bet-btn, .md-game-outcome");
    widget.classList.toggle("is-visible", hasBetSurface);
}

// Recompute every visible Buy button's payout against the current
// global stake. Called when the stake input changes — orderbook
// hydration already updates payouts when prices move.
function refreshAllBetPayouts() {
    if (typeof document === "undefined") return;
    const stake = getGlobalStake();
    document.querySelectorAll(".ks-bet-btn").forEach((btn) => {
        const priceCents = parseInt(btn.getAttribute("data-price-cents") || "", 10);
        const slot = btn.querySelector("[data-bet-payout]");
        if (slot) slot.textContent = formatPayout(stake, Number.isFinite(priceCents) ? priceCents : null);
    });
}

// Stable key for persisting the user's typed stake. For player props
// the key is "player|stat" (e.g. "vinnie pasquantino|home runs") so
// the same stake survives chip switches to different thresholds. For
// any other market (team props, game lines), fall back to the full
// Kalshi ticker — per-market stable, no cross-threshold carryover
// since those aren't laddered the same way.
function computeStakeKey(market) {
    const t = (market.title || "").trim();
    const m = t.match(/^(.+?):\s*\d+(?:\.\d+)?\+?\s+(.+?)\??$/);
    if (m) return `kalshi|player|${m[1].toLowerCase()}|${m[2].toLowerCase()}`;
    return `kalshi|raw|${market.raw_market_id || market.id || t}`;
}

// Format the "to win $X.XX" caption inside a Buy button. Shows "—"
// while we don't yet have a live price (orderbook still loading).
function formatPayout(stake, priceCents) {
    if (!Number.isFinite(stake) || stake <= 0) return "enter stake";
    if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99) {
        return "win $—";
    }
    // profit = stake × (100 - p) / p. Fractional dollars; the bet
    // modal rounds to whole contracts at submit time.
    const profit = stake * (100 - priceCents) / priceCents;
    return `win $${profit.toFixed(2)}`;
}

// Hydrator hook: after the orderbook returns a live YES quote, find
// every Buy-button on the page that shares this ticker and refresh
// its data-price-cents + payout display against the GLOBAL stake.
// Called from app.js's hydrateKalshiBookCells. Idempotent.
function updateBetButtonsForTicker(ticker, yesProb) {
    if (!ticker || typeof document === "undefined") return;
    if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) return;
    const yesCents = Math.max(1, Math.min(99, Math.round(yesProb * 100)));
    const stake = getGlobalStake();
    const sel = `.ks-bet-btn[data-ticker="${cssEscape(ticker)}"]`;
    document.querySelectorAll(sel).forEach((btn) => {
        const side = btn.getAttribute("data-side");
        const priceCents = side === "yes" ? yesCents : 100 - yesCents;
        btn.setAttribute("data-price-cents", String(priceCents));
        const slot = btn.querySelector("[data-bet-payout]");
        if (slot) slot.textContent = formatPayout(stake, priceCents);
    });
}

function cssEscape(s) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^\w-]/g, (c) => "\\" + c);
}

function marketFromButton(btn) {
    return {
        id:             btn.getAttribute("data-market-id") || "",
        source:         "kalshi",
        title:          btn.getAttribute("data-market-title") || "",
        raw_market_id:  btn.getAttribute("data-ticker") || "",
        outcomes:       [],
    };
}
function outcomeFromButton(btn) {
    const p = btn.getAttribute("data-outcome-prob");
    return {
        id:          btn.getAttribute("data-outcome-id") || "",
        name:        btn.getAttribute("data-outcome-name") || "",
        probability: p === "" ? null : Number(p),
    };
}


// ── Global click delegation ─────────────────────────────────────

function attachDelegates() {
    document.addEventListener("click", async (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const connectBtn = t.closest("[data-kalshi-connect]");
        if (connectBtn) {
            e.preventDefault();
            openConnectModal();
            return;
        }
        const signoutBtn = t.closest("[data-kalshi-signout]");
        if (signoutBtn) {
            e.preventDefault();
            clearCredentials();
            renderAllAccountStrips();
            renderAllBetButtons();
            toast("Signed out of Kalshi", "ok");
            return;
        }
        const betBtn = t.closest("[data-kalshi-bet]");
        if (betBtn) {
            e.preventDefault();
            // Seed the modal with the global stake so the Contracts
            // field opens pre-filled with whatever count the user's
            // current stake actually buys at this side's price.
            const stake = getGlobalStake();
            const priceCents = parseInt(betBtn.getAttribute("data-price-cents") || "", 10);
            const seed = (Number.isFinite(stake) && Number.isFinite(priceCents) && priceCents > 0)
                ? { stake_dollars: stake, price_cents: priceCents }
                : null;
            openBetModal(marketFromButton(betBtn), outcomeFromButton(betBtn), seed);
            return;
        }
        const refreshBtn = t.closest("[data-kalshi-mybets-refresh]");
        if (refreshBtn) {
            e.preventDefault();
            // Bust the balance cache so the refresh button feels live.
            cachedBalanceCents = null;
            cachedBalanceFetchedAt = 0;
            refreshMyBets();
            return;
        }
        const cancelBtn = t.closest("[data-kalshi-cancel]");
        if (cancelBtn) {
            e.preventDefault();
            const orderId = cancelBtn.getAttribute("data-kalshi-cancel");
            if (!orderId) return;
            // Quick confirm so a fat-finger doesn't pull a resting
            // bid the user actually wanted to keep.
            if (!confirm("Cancel this order on Kalshi?")) return;
            cancelBtn.disabled = true;
            cancelBtn.textContent = "Cancelling…";
            try {
                const result = await cancelOrder(orderId);
                cachedBalanceCents = null;
                cachedBalanceFetchedAt = 0;
                const status = result.finalStatus;
                if (status === "canceled" || status === "cancelled") {
                    toast("Order cancelled on Kalshi ✓", "ok");
                } else if (status === "executed" || status === "filled") {
                    toast("Too late — order had already filled.", "err");
                } else if (status === null) {
                    // Couldn't verify; treat as best-effort success.
                    toast("Cancel submitted (status unconfirmed)", "ok");
                } else {
                    // Kalshi accepted DELETE but order isn't in a
                    // cancelled state — show exactly what they say.
                    toast(`Cancel may not have worked — Kalshi status: ${status}`, "err");
                }
                refreshMyBets();
            } catch (err) {
                toast(`Cancel failed: ${err.message || err}`, "err");
                cancelBtn.disabled = false;
                cancelBtn.textContent = "Cancel";
            }
            return;
        }
    });

}


// ── Tiny toast notification ─────────────────────────────────────

function toast(msg, kind = "ok") {
    let host = document.querySelector(".ks-toasts");
    if (!host) {
        host = document.createElement("div");
        host.className = "ks-toasts";
        document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = `ks-toast ks-toast-${kind}`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.classList.add("ks-toast-show"), 10);
    setTimeout(() => {
        el.classList.remove("ks-toast-show");
        setTimeout(() => el.remove(), 220);
    }, 4200);
}


// ── Escape helpers ──────────────────────────────────────────────

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;"
    }[c]));
}
function escapeHtmlAttr(s) { return escapeHtml(s); }


// ── Bootstrap ───────────────────────────────────────────────────

attachDelegates();

// Global stake widget: bootstrap once on load, then keep its
// visibility in sync as the user toggles between Live View / Markets.
// MutationObserver watches the body for #markets-pane coming and going
// — far simpler than threading visibility through every renderGame call.
if (typeof document !== "undefined") {
    const bootstrap = () => {
        ensureGlobalStakeWidget();
        syncGlobalStakeWidgetVisibility();
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bootstrap);
    } else {
        bootstrap();
    }
    const visObserver = new MutationObserver(syncGlobalStakeWidgetVisibility);
    visObserver.observe(document.body, { childList: true, subtree: true });
}

// Initial pull when the page loads while already connected.
if (isConnected()) {
    getBalance().then(() => { renderAllAccountStrips(); renderAllMyBets(); });
}

// Polling intervals run UNCONDITIONALLY — they cheaply no-op when
// the user isn't connected or when there's no panel slot on the page.
// Two separate cadences:
//   - Balance + account strip every 30s (slow-changing).
//   - Open-orders panel every 5s (the user wants to see fills + status
//     change without clicking refresh).
setInterval(() => {
    if (!isConnected()) return;
    getBalance().then(renderAllAccountStrips);
}, BALANCE_REFRESH_MS);

setInterval(() => {
    if (!isConnected()) return;
    const slot = document.querySelector("[data-kalshi-mybets]");
    if (!slot) return;
    refreshMyBets();
}, 5_000);


// ── Public surface ──────────────────────────────────────────────

root.Kalshi = {
    isConnected,
    getLabel,
    getBalance,
    getOpenOrders,
    getPositions,
    getOrderbook,
    placeOrder,
    cancelOrder,
    openConnectModal,
    openBetModal,
    renderAccountStrip,
    renderBetButtons,
    renderMyBetsPanel,
    renderAllAccountStrips,
    renderAllBetButtons,
    renderAllMyBets,
    refreshMyBets,
    // Called by app.js's hydrateKalshiBookCells once the live Kalshi
    // orderbook quote lands — refreshes the "to win" payout display
    // on each Buy button without re-rendering the whole pane.
    updateBetButtonsForTicker,
    // Global stake helpers — read/write the single body-level input
    // value. ensureGlobalStakeWidget() can be called defensively from
    // anywhere; the bootstrap below already runs on script load.
    getGlobalStake,
    setGlobalStake,
    ensureGlobalStakeWidget,
    toast,
};

})(typeof window !== "undefined" ? window : globalThis);
