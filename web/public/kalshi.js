// Kalshi in-site trading client.
//
// What this file owns:
//   - The "Connect Kalshi" modal (email + password → bearer token)
//   - localStorage of the token
//   - GET balance / positions / orders
//   - POST a new order (with a confirmation modal)
//   - Account strip in the page header showing balance + sign-out
//   - "Buy YES / Buy NO" buttons that get injected next to every
//     Kalshi market row on the Live View and the per-game Markets tab.
//
// The user's password ONLY exists in memory during the /login call.
// We never persist it. The bearer token that comes back from Kalshi is
// what we keep in localStorage and re-attach as X-Kalshi-Token on
// every subsequent API call.
//
// Loaded as a plain script, attaches to `window.Kalshi`. Designed so
// app.js calls `Kalshi.renderBetButtons(market)` inline with each
// market card and `Kalshi.renderAccountStrip()` somewhere visible.
//
// Phase 1 (this commit): connect, balance, positions, single-leg
// limit orders. Phase 2 will add cancels, market orders, positions
// PnL.

(function (root) {
"use strict";

const TOKEN_KEY = "kalshi_token_v1";
const EMAIL_KEY = "kalshi_email_v1";    // displayed in the account strip
const BALANCE_REFRESH_MS = 30000;       // re-poll balance every 30s

let cachedBalanceCents = null;
let cachedBalanceFetchedAt = 0;
let balanceFetchInFlight = null;

// ── Token storage ────────────────────────────────────────────────

function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; }
    catch { return null; }
}
function setToken(token, email) {
    try {
        localStorage.setItem(TOKEN_KEY, token);
        if (email) localStorage.setItem(EMAIL_KEY, email);
    } catch { /* localStorage disabled — operate in-memory only */ }
}
function clearToken() {
    try {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(EMAIL_KEY);
    } catch { /* no-op */ }
    cachedBalanceCents = null;
    cachedBalanceFetchedAt = 0;
}
function getEmail() {
    try { return localStorage.getItem(EMAIL_KEY) || ""; }
    catch { return ""; }
}
function isConnected() { return !!getToken(); }


// ── API wrappers ────────────────────────────────────────────────

async function login(email, password) {
    const res = await fetch("/api/kalshi/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
        throw new Error(data.error || data.message || `login failed (HTTP ${res.status})`);
    }
    setToken(data.token, email);
    return data;
}

async function fetchAuthed(path, opts = {}) {
    const token = getToken();
    if (!token) throw new Error("not connected to Kalshi");
    const res = await fetch(path, {
        method:  opts.method  || "GET",
        headers: {
            "content-type":     "application/json",
            "x-kalshi-token":   token,
            ...(opts.headers || {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // 401 → token expired or revoked. Drop it so the UI re-prompts.
        if (res.status === 401) clearToken();
        const msg = data.error || data.message || `kalshi ${path} → HTTP ${res.status}`;
        throw new Error(msg);
    }
    return data;
}

async function getBalance() {
    if (!isConnected()) return null;
    // Single in-flight de-dupe + 30s cache so the UI can call this
    // freely on every render.
    const now = Date.now();
    if (now - cachedBalanceFetchedAt < BALANCE_REFRESH_MS && cachedBalanceCents != null) {
        return cachedBalanceCents;
    }
    if (balanceFetchInFlight) return balanceFetchInFlight;
    balanceFetchInFlight = (async () => {
        try {
            const data = await fetchAuthed("/api/kalshi/balance");
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
    return fetchAuthed("/api/kalshi/orders", { method: "POST", body: payload });
}

function cryptoUuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // Fallback for very old browsers — should never hit on modern Chrome/Safari.
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
          Sign in to your <a href="https://kalshi.com" target="_blank" rel="noopener">Kalshi</a>
          account to place bets directly from this site. Kalshi is a
          CFTC-regulated US exchange and is available in New York.
        </p>
        <p class="km-sub km-sub-trust">
          Your password is forwarded to Kalshi over HTTPS once and
          discarded. Only the resulting bearer token is stored — in
          your browser's localStorage, never on our servers.
        </p>
        <form class="km-form">
          <label class="km-field">
            <span>Email</span>
            <input type="email" name="email" autocomplete="email" required>
          </label>
          <label class="km-field">
            <span>Password</span>
            <input type="password" name="password" autocomplete="current-password" required>
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
        const email = String(data.get("email") || "").trim();
        const password = String(data.get("password") || "");
        errEl.hidden = true;
        submit.disabled = true;
        submit.textContent = "Connecting…";
        try {
            await login(email, password);
            close();
            renderAllAccountStrips();
            renderAllBetButtons();
            toast("Connected to Kalshi", "ok");
        } catch (err) {
            errEl.hidden = false;
            errEl.textContent = err.message || "Login failed";
            submit.disabled = false;
            submit.textContent = "Connect";
        }
    });

    // Autofocus email
    setTimeout(() => overlay.querySelector('input[name="email"]')?.focus(), 50);
}


// ── Bet modal ───────────────────────────────────────────────────

// market = { id, source: "kalshi", title, outcomes: [...], raw_market_id, url }
// outcome = { id, name, probability, ... }
function openBetModal(market, outcome) {
    if (!isConnected()) {
        openConnectModal();
        return;
    }
    const ticker = market.raw_market_id || market.id?.split(":").pop() || "";
    // outcome.name on a Kalshi moneyline is the team tricode they YES on.
    // The actual side (YES/NO) is encoded in the outcome.id suffix.
    const sideMatch = String(outcome.id || "").match(/:(yes|no)$/i);
    const side = (sideMatch ? sideMatch[1] : "yes").toLowerCase();
    const probPercent = outcome.probability != null
        ? Math.max(1, Math.min(99, Math.round(outcome.probability * 100)))
        : 50;

    const overlay = document.createElement("div");
    overlay.className = "kalshi-modal-overlay";
    overlay.innerHTML = `
      <div class="kalshi-modal kalshi-bet-modal" role="dialog" aria-modal="true">
        <button class="km-close" aria-label="Close">×</button>
        <h2>Buy ${side.toUpperCase()} · ${escapeHtml(outcome.name || "")}</h2>
        <p class="km-sub km-bet-ticker">${escapeHtml(market.title || "")}</p>
        <p class="km-sub km-ticker-line">Ticker <code>${escapeHtml(ticker)}</code></p>
        <form class="km-form km-bet-form">
          <label class="km-field">
            <span>Contracts</span>
            <input type="number" name="count" min="1" step="1" value="1" required>
          </label>
          <label class="km-field">
            <span>Limit price (¢)</span>
            <input type="number" name="price" min="1" max="99" step="1"
                   value="${probPercent}" required>
            <small class="km-hint">Last quote ≈ ${probPercent}¢. Each contract pays $1 if you win.</small>
          </label>
          <div class="km-total">
            Total cost: <strong class="km-total-val">$${(probPercent / 100).toFixed(2)}</strong>
          </div>
          <div class="km-error" hidden></div>
          <div class="km-actions">
            <button type="button" class="km-cancel">Cancel</button>
            <button type="submit" class="km-submit">Place bet</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    const form = overlay.querySelector(".km-form");
    const errEl = overlay.querySelector(".km-error");
    const totalEl = overlay.querySelector(".km-total-val");
    const submit = overlay.querySelector(".km-submit");
    const cntIn = form.querySelector('input[name="count"]');
    const prcIn = form.querySelector('input[name="price"]');
    const recalc = () => {
        const cnt = Number(cntIn.value) || 0;
        const prc = Number(prcIn.value) || 0;
        totalEl.textContent = `$${((cnt * prc) / 100).toFixed(2)}`;
    };
    cntIn.addEventListener("input", recalc);
    prcIn.addEventListener("input", recalc);

    const close = () => overlay.remove();
    overlay.querySelector(".km-close").addEventListener("click", close);
    overlay.querySelector(".km-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errEl.hidden = true;
        submit.disabled = true;
        submit.textContent = "Placing…";
        try {
            const cnt = parseInt(cntIn.value, 10);
            const prc = parseInt(prcIn.value, 10);
            const res = await placeOrder({ ticker, side, count: cnt, price: prc });
            close();
            // Invalidate balance cache — order may have moved funds.
            cachedBalanceCents = null;
            cachedBalanceFetchedAt = 0;
            renderAllAccountStrips();
            const status = res?.order?.status || "submitted";
            toast(`Order ${status}: ${cnt} × ${side.toUpperCase()} @ ${prc}¢`, "ok");
        } catch (err) {
            errEl.hidden = false;
            errEl.textContent = err.message || "Order failed";
            submit.disabled = false;
            submit.textContent = "Place bet";
        }
    });

    setTimeout(() => cntIn.focus(), 50);
}


// ── Account strip ───────────────────────────────────────────────

// Returns the HTML string for an account strip. Drop it inline anywhere
// in the page — it renders one of two states:
//   not-connected: "Connect Kalshi" CTA
//   connected:     balance + email + sign out
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
    const email = getEmail();
    return `
      <div class="kalshi-strip kalshi-strip-connected">
        <span class="ks-label">Kalshi</span>
        <span class="ks-balance">Balance <strong>${balText}</strong></span>
        ${email ? `<span class="ks-email">${escapeHtml(email)}</span>` : ""}
        <button class="ks-signout" data-kalshi-signout>Sign out</button>
      </div>
    `;
}

function renderAllAccountStrips() {
    document.querySelectorAll("[data-kalshi-strip]").forEach((el) => {
        el.innerHTML = renderAccountStrip();
    });
}

// Re-render every bet-button slot on the page. Called after connect /
// sign-out so the "Bet" buttons appear or disappear in lockstep.
function renderAllBetButtons() {
    document.querySelectorAll("[data-kalshi-bet-slot]").forEach((slot) => {
        // The market + outcome are encoded in the slot's data attrs so
        // the render call doesn't need the original market object.
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

// Returns inline HTML for a Buy YES + Buy NO pair to render next to a
// Kalshi moneyline / spread / total row. The outcomes are passed in as
// JSON-stringified data attrs so the click handler can reconstruct the
// market context without us holding refs to every market.
function renderBetButtons(market) {
    if (market.source !== "kalshi") return "";
    const outs = (market.outcomes || []).slice(0, 2);
    return `
      <div class="ks-bet-row">
        ${outs.map((o) => {
            const sideMatch = String(o.id || "").match(/:(yes|no)$/i);
            const side = (sideMatch ? sideMatch[1] : "yes").toLowerCase();
            const cents = o.probability != null
                ? Math.max(1, Math.min(99, Math.round(o.probability * 100)))
                : 50;
            return `
              <button class="ks-bet-btn ks-bet-${side}"
                      data-kalshi-bet="1"
                      data-ticker="${escapeHtmlAttr(market.raw_market_id || "")}"
                      data-market-id="${escapeHtmlAttr(market.id || "")}"
                      data-market-title="${escapeHtmlAttr(market.title || "")}"
                      data-outcome-id="${escapeHtmlAttr(o.id || "")}"
                      data-outcome-name="${escapeHtmlAttr(o.name || "")}"
                      data-outcome-prob="${o.probability != null ? o.probability : ""}"
                      data-side="${side}">
                Buy ${side.toUpperCase()} ${escapeHtml(o.name || "")} · ${cents}¢
              </button>
            `;
        }).join("")}
      </div>
    `;
}

// Reconstruct the minimum market + outcome shape from a clicked button's
// data attrs (avoids storing global market refs).
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
            clearToken();
            renderAllAccountStrips();
            renderAllBetButtons();
            toast("Signed out of Kalshi", "ok");
            return;
        }
        const betBtn = t.closest("[data-kalshi-bet]");
        if (betBtn) {
            e.preventDefault();
            openBetModal(marketFromButton(betBtn), outcomeFromButton(betBtn));
            return;
        }
    });
}

// ── Tiny toast notification (slide-in, auto-dismiss) ────────────

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
    }, 3600);
}


// ── Escape helpers (defensive XSS protection in raw HTML strings) ─

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;"
    }[c]));
}
function escapeHtmlAttr(s) { return escapeHtml(s); }


// ── Bootstrap ───────────────────────────────────────────────────

attachDelegates();
// Pre-warm balance on page load when connected so the first render
// of the account strip shows a real number instead of "…".
if (isConnected()) {
    getBalance().then(renderAllAccountStrips);
    // Then re-poll every 30s so the displayed balance stays current
    // after fills.
    setInterval(() => getBalance().then(renderAllAccountStrips), BALANCE_REFRESH_MS);
}


// ── Public surface ──────────────────────────────────────────────

root.Kalshi = {
    isConnected,
    getEmail,
    getBalance,
    placeOrder,
    openConnectModal,
    openBetModal,
    renderAccountStrip,
    renderBetButtons,
    renderAllAccountStrips,
    renderAllBetButtons,
    toast,
};

})(typeof window !== "undefined" ? window : globalThis);
