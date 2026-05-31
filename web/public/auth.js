// DIAMOND:CONTEXT email magic-link sign-in.
//
// Modern passwordless auth via Supabase Auth, modeled after the
// flows on Notion / Linear / Substack:
//   1. User clicks "Sign in" → modal opens with one email field
//   2. Submit → magic link sent to their inbox; modal shows
//      "Check your email" with a "Try again" link
//   3. User clicks the link in the email → lands back on
//      diamond-context.pages.dev with #access_token=... in the URL
//   4. onAuthChange fires → we stash the session in localStorage
//      (Supabase handles this automatically) and the header swaps
//      "Sign in" for the user's email + a "Sign out" affordance
//
// Why magic link instead of email + password:
//   - One field instead of two (lower friction)
//   - No "Forgot password?" flow to build (Supabase rotates the
//     link each request)
//   - Matches what people see on every modern SaaS sign-up today
//
// Implementation notes:
//   - This file is loaded as <script type="module"> so we can
//     `import` the Supabase JS client from a CDN. Everything that
//     needs to be reachable from non-module code gets attached to
//     window.Auth at the bottom.
//   - The Sign-in widget itself is created in DOM-managed style
//     (appended to document.body, not part of any re-rendered
//     view) so the periodic page polls don't wipe it out — same
//     pattern as the global stake widget.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL  = "https://jnobopyhciheyheqxrmy.supabase.co";
// Anon key — designed to be public; RLS on every table is what
// enforces what the browser can actually reach.
const SUPABASE_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impub2JvcHloY2loZXloZXF4cm15Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1OTM3NjAsImV4cCI6MjA5NTE2OTc2MH0.qQ7J0YYOSyrtL09Qsx6G5X6NBmQFo_3i0shlUybSDDg";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,   // pluck the magic-link token out of the URL on load
        storage: window.localStorage,
        storageKey: "diamond_context_auth",
    },
});


// ── Auth state ─────────────────────────────────────────────────────

let _currentUser = null;
const _changeListeners = new Set();

// Hydrate on load — supabase-js reads the persisted session out of
// localStorage automatically, but only resolves it asynchronously.
// Wait for it before deciding what to render.
async function hydrateInitialSession() {
    try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        _currentUser = data?.session?.user || null;
    } catch {
        _currentUser = null;
    }
    notifyChange();
    renderHeaderWidget();
}

supabase.auth.onAuthStateChange((event, session) => {
    _currentUser = session?.user || null;
    notifyChange();
    renderHeaderWidget();
    if (event === "SIGNED_IN") toast(`Signed in as ${_currentUser?.email}`, "ok");
    if (event === "SIGNED_OUT") toast("Signed out", "ok");
});

function notifyChange() {
    for (const cb of _changeListeners) {
        try { cb(_currentUser); } catch { /* listener error */ }
    }
}


// ── Public API ─────────────────────────────────────────────────────

async function signInWithEmail(email) {
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        throw new Error("Enter a valid email address");
    }
    const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
            // After the user clicks the magic link, Supabase
            // redirects here. The detectSessionInUrl option on
            // createClient catches the hash + finishes the sign-in.
            emailRedirectTo: window.location.origin + "/",
            // Create the user the first time they sign in — no
            // separate sign-up step needed for magic link.
            shouldCreateUser: true,
        },
    });
    if (error) throw error;
}

async function signOut() {
    await supabase.auth.signOut();
}

function getUser() {
    return _currentUser;
}

function isSignedIn() {
    return !!_currentUser;
}

function onChange(cb) {
    _changeListeners.add(cb);
    return () => _changeListeners.delete(cb);
}


// ── Sign-in modal ──────────────────────────────────────────────────

function openSignInModal() {
    if (document.querySelector(".auth-modal-overlay")) return;
    const overlay = document.createElement("div");
    overlay.className = "auth-modal-overlay";
    overlay.innerHTML = `
      <div class="auth-modal" role="dialog" aria-modal="true">
        <button class="auth-modal-close" aria-label="Close">×</button>
        <div class="auth-modal-body" data-step="enter">
          <h2 class="auth-modal-title">Sign in</h2>
          <p class="auth-modal-sub">
            Enter your email and we'll send you a magic link. No password to remember.
          </p>
          <form class="auth-form" data-form>
            <label class="auth-field">
              <span class="auth-field-label">Email</span>
              <input type="email" name="email" required autocomplete="email"
                     placeholder="you@example.com" autofocus />
            </label>
            <div class="auth-error" hidden></div>
            <button type="submit" class="auth-submit">Send magic link →</button>
          </form>
          <div class="auth-modal-footnote">
            First time here? Same form — a brand-new account is created automatically.
          </div>
        </div>
        <div class="auth-modal-body" data-step="sent" hidden>
          <div class="auth-sent-icon">✉️</div>
          <h2 class="auth-modal-title">Check your email</h2>
          <p class="auth-modal-sub">
            We sent a sign-in link to <strong data-sent-email></strong>.
            Click the link and you'll land back here, signed in.
          </p>
          <p class="auth-modal-tip">
            Can't find it? Check your spam folder, or
            <button type="button" class="auth-link" data-retry>try again with a different email</button>.
          </p>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".auth-modal-close").addEventListener("click", close);

    const form = overlay.querySelector("[data-form]");
    const errEl = overlay.querySelector(".auth-error");
    const submit = overlay.querySelector(".auth-submit");

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errEl.hidden = true;
        errEl.textContent = "";
        const email = new FormData(form).get("email");
        submit.disabled = true;
        submit.textContent = "Sending…";
        try {
            await signInWithEmail(String(email));
            overlay.querySelector("[data-step='enter']").hidden = true;
            overlay.querySelector("[data-step='sent']").hidden = false;
            overlay.querySelector("[data-sent-email]").textContent = String(email);
        } catch (err) {
            errEl.textContent = err.message || "Couldn't send the magic link. Try again in a moment.";
            errEl.hidden = false;
        } finally {
            submit.disabled = false;
            submit.textContent = "Send magic link →";
        }
    });

    overlay.querySelector("[data-retry]").addEventListener("click", () => {
        overlay.querySelector("[data-step='sent']").hidden = true;
        overlay.querySelector("[data-step='enter']").hidden = false;
        const input = overlay.querySelector("input[name='email']");
        input.value = "";
        input.focus();
    });

    // ESC dismisses
    const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
}


// ── Header widget (Sign in button OR signed-in pill) ──────────────

function renderHeaderWidget() {
    if (typeof document === "undefined") return;
    let host = document.getElementById("auth-header-widget");
    if (!host) {
        host = document.createElement("div");
        host.id = "auth-header-widget";
        host.className = "auth-header-widget";
        document.body.appendChild(host);
    }
    if (_currentUser) {
        const email = _currentUser.email || "Account";
        const initial = (email[0] || "?").toUpperCase();
        host.innerHTML = `
          <button class="auth-pill" data-auth-menu title="${escapeAttr(email)}">
            <span class="auth-avatar">${escapeText(initial)}</span>
            <span class="auth-email">${escapeText(email)}</span>
            <span class="auth-caret">▾</span>
          </button>
          <div class="auth-menu" data-auth-menu-panel hidden>
            <div class="auth-menu-email">${escapeText(email)}</div>
            <button type="button" class="auth-menu-item" data-auth-show-kalshi-guide>
              How to connect Kalshi
            </button>
            <button type="button" class="auth-menu-item auth-menu-danger" data-auth-signout>
              Sign out
            </button>
          </div>
        `;
        const pill = host.querySelector("[data-auth-menu]");
        const panel = host.querySelector("[data-auth-menu-panel]");
        pill.addEventListener("click", (e) => {
            e.stopPropagation();
            panel.hidden = !panel.hidden;
        });
        document.addEventListener("click", (e) => {
            if (!host.contains(e.target)) panel.hidden = true;
        }, { once: true });
        host.querySelector("[data-auth-signout]").addEventListener("click", async () => {
            panel.hidden = true;
            await signOut();
        });
        host.querySelector("[data-auth-show-kalshi-guide]").addEventListener("click", () => {
            panel.hidden = true;
            openKalshiGuide();
        });
    } else {
        host.innerHTML = `
          <button class="auth-signin-btn" data-auth-signin>Sign in</button>
        `;
        host.querySelector("[data-auth-signin]").addEventListener("click", openSignInModal);
    }
}


// ── Kalshi "How to connect" guide ──────────────────────────────────
//
// Surfaced from two places:
//   - The signed-in user menu (after they sign in, the next step is
//     usually connecting Kalshi to actually bet)
//   - The Connect Kalshi modal itself has a "Need help getting your
//     API key?" link that opens this same guide
//
// Content is intentionally hand-written, step-by-step, with the
// exact URLs and button names the user will see on kalshi.com.

function openKalshiGuide() {
    if (document.querySelector(".kalshi-guide-overlay")) return;
    const overlay = document.createElement("div");
    overlay.className = "kalshi-guide-overlay";
    overlay.innerHTML = `
      <div class="kalshi-guide" role="dialog" aria-modal="true">
        <button class="kalshi-guide-close" aria-label="Close">×</button>
        <header class="kalshi-guide-head">
          <h2>Connect your Kalshi account</h2>
          <p class="kalshi-guide-sub">
            Place real bets on Kalshi directly from this site. One-time setup, about 5 minutes.
          </p>
        </header>
        <ol class="kalshi-guide-steps">
          <li>
            <div class="kg-step-num">1</div>
            <div class="kg-step-body">
              <h3>Create a Kalshi account</h3>
              <p>
                Go to <a href="https://kalshi.com/sign-up" target="_blank" rel="noopener">kalshi.com/sign-up</a>
                and sign up. They'll email you a verification link — click it before continuing.
              </p>
              <p class="kg-tip">
                Kalshi is the only regulated prediction-market exchange in the US, so they ask for
                a Social Security number to verify identity. Standard for financial accounts.
              </p>
            </div>
          </li>
          <li>
            <div class="kg-step-num">2</div>
            <div class="kg-step-body">
              <h3>Deposit funds</h3>
              <p>
                In the Kalshi app, click <strong>Deposit</strong> (top-right). ACH transfers are free
                but take 1–3 business days. Debit card is instant but has a small fee.
              </p>
              <p class="kg-tip">
                You can place bets as small as 1¢ per contract, so $10 is plenty for testing.
              </p>
            </div>
          </li>
          <li>
            <div class="kg-step-num">3</div>
            <div class="kg-step-body">
              <h3>Generate an API key</h3>
              <p>
                Go to <a href="https://kalshi.com/account/profile" target="_blank" rel="noopener">kalshi.com/account/profile</a>,
                scroll down to <strong>API Keys</strong>, and click <strong>Create new API key</strong>.
                Give it any name (e.g. "DIAMOND:CONTEXT") and click Create.
              </p>
              <p>
                Kalshi shows you two things, ONCE:
              </p>
              <ul class="kg-list">
                <li>
                  A <strong>Key ID</strong> — a short string like
                  <code>9c3e1a40-8b22-4f8c-…</code>
                </li>
                <li>
                  A <strong>private key</strong> — a long block of text starting with
                  <code>-----BEGIN RSA PRIVATE KEY-----</code>. They prompt you to download it as
                  a <code>.pem</code> file.
                </li>
              </ul>
              <p class="kg-warn">
                <strong>Save both somewhere safe.</strong> Kalshi will never show you the private key
                again — if you lose it, you have to generate a new one.
              </p>
            </div>
          </li>
          <li>
            <div class="kg-step-num">4</div>
            <div class="kg-step-body">
              <h3>Paste credentials here</h3>
              <p>
                Back on this site, click any <strong>Buy YES / Buy NO</strong> button. If you're not
                connected yet, the <strong>Connect Kalshi</strong> modal pops up. Paste:
              </p>
              <ul class="kg-list">
                <li>The <strong>Key ID</strong> into the top field</li>
                <li>The entire <strong>private key</strong> (including the
                  <code>BEGIN</code> / <code>END</code> lines) into the PEM textarea</li>
              </ul>
              <p>
                Click <strong>Connect</strong>. Your balance shows up in the green KALSHI strip
                at the top of the Markets pane — that's how you know it worked.
              </p>
              <p class="kg-tip">
                Credentials stay <strong>in your browser only</strong> (localStorage). They never
                touch our servers — every Kalshi request is signed in your browser with the
                private key and sent through a thin proxy that strips no headers and logs nothing.
              </p>
            </div>
          </li>
          <li>
            <div class="kg-step-num">5</div>
            <div class="kg-step-body">
              <h3>Place your first bet</h3>
              <p>
                Set your <strong>Bet stake</strong> in the floating widget (top-right). $0.50 is
                the default. Then click any green <strong>Buy YES</strong> or red
                <strong>Buy NO</strong> on any market card.
              </p>
              <p>
                The bet modal shows the live orderbook + your contract count. Click
                <strong>Take offer</strong> to fill at the current ask, or switch to
                <strong>Post your own price</strong> to put a limit order on the book.
              </p>
              <p class="kg-tip">
                Your open orders show in the <strong>My Kalshi</strong> panel and refresh every 5
                seconds. Click cancel on any of them to pull the order.
              </p>
            </div>
          </li>
        </ol>
        <footer class="kalshi-guide-foot">
          <button type="button" class="kalshi-guide-dismiss">Got it</button>
        </footer>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".kalshi-guide-close").addEventListener("click", close);
    overlay.querySelector(".kalshi-guide-dismiss").addEventListener("click", close);
    const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
}


// ── Tiny toast (matches the Kalshi module's style) ─────────────────

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


// ── Escape helpers ─────────────────────────────────────────────────

function escapeText(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;"
    }[c]));
}
function escapeAttr(s) { return escapeText(s); }


// ── Bootstrap ──────────────────────────────────────────────────────

// Expose a tiny public surface for non-module callers (kalshi.js
// reads window.Auth?.getUser() so the Connect Kalshi modal can
// gate behavior on whether the user is signed in to DIAMOND:CONTEXT
// or not).
window.Auth = {
    openSignInModal,
    openKalshiGuide,
    signInWithEmail,
    signOut,
    getUser,
    isSignedIn,
    onChange,
};

// First paint — render the header widget immediately (anonymous
// state), then hydrate from any persisted session and re-render.
renderHeaderWidget();
hydrateInitialSession();
