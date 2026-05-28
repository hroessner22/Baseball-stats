// DIAMOND:CONTEXT — the Board and the Game view.
//
// One page, two screens, routed by URL hash:
//   #           — the Board (today's games).
//   #game/{pk}  — the Game (one game's live state + the context card).

const board = document.getElementById("board");
const gameView = document.getElementById("game-view");
const standingsView = document.getElementById("standings-view");
const leadersView = document.getElementById("leaders-view");
const mvpView = document.getElementById("mvp-view");
const aboutView = document.getElementById("about-view");
const hotView = document.getElementById("hot-view");
const playerView = document.getElementById("player-view");
const marketsView = document.getElementById("markets-view");

const BOARD_REFRESH_MS = 30_000;
// Game view polls fast — every PA boundary (out, hit, walk, run scoring,
// inning change, pitcher change) gets reflected in the WE bar within a
// couple seconds. The upstream MLB feed is edge-cached 10s, so even 5s
// polling collapses to ~1 real upstream call per 10s.
const GAME_REFRESH_MS = 5_000;
const STANDINGS_REFRESH_MS = 5 * 60_000;
const LEADERS_REFRESH_MS = 5 * 60_000;
const MVP_REFRESH_MS = 5 * 60_000;
const HOT_REFRESH_MS = 15_000;
// Markets dashboard polls every 20s — sportsbook lines move on that
// order, and the upstream /api/markets is edge-cached for 30s anyway.
const MARKETS_REFRESH_MS = 20_000;

let boardTimer = null;
let gameTimer = null;
let standingsTimer = null;
let leadersTimer = null;
let mvpTimer = null;
let hotTimer = null;
let marketsDashboardTimer = null;
let activeGameId = null;

window.addEventListener("hashchange", handleRoute);
window.addEventListener("load", handleRoute);
window.addEventListener("load", loadFooterAccuracy);

// Read the latest calibration row and surface it in the footer. Small
// piece of code, big credibility move — the model goes from "trust us"
// to "here's the receipt." Errors silent; the footer just stays without
// the accuracy line if /api/metrics returns nothing.
async function loadFooterAccuracy() {
    try {
        const res = await fetch("/api/metrics");
        if (!res.ok) return;
        const data = await res.json();
        // .production is the row for the variant currently serving live
        // (v3_recency as of PR #68). .variants is the comparison set
        // across naive / v1 / v2 / v3 — surfaced as a tooltip so users
        // can see "did each layer earn its keep" without needing the
        // full About page.
        const prod = data?.production || data?.metrics;
        if (!prod) return;
        const el = document.getElementById("footer-accuracy");
        if (!el) return;

        const acc   = Math.round(prod.top_pick_accuracy * 100);
        const brier = Number(prod.brier_score).toFixed(2);
        const n     = Number(prod.sample_size).toLocaleString();

        // Build the comparison tooltip. We list every variant we have
        // a metric for, sorted by Brier (best first). Annotates which
        // is "live" so the user knows which number is real.
        const variants = data?.variants || [];
        const tooltipLines = variants
            .slice()
            .sort((a, b) => (a.brier_score ?? 99) - (b.brier_score ?? 99))
            .map((v) => {
                const isProd = v.variant === prod.variant;
                const tag = isProd ? " ← live" : "";
                const tAcc = Math.round((v.top_pick_accuracy || 0) * 100);
                const tBri = Number(v.brier_score || 0).toFixed(3);
                return `${variantLabel(v.variant)}: ${tAcc}% · Brier ${tBri}${tag}`;
            });
        const tooltip = tooltipLines.length
            ? "Model variants ranked by Brier (lower = better):\n\n" +
              tooltipLines.join("\n") + "\n\n" +
              "naive = league baseline · v1 = historical · v2 = +daily · v3 = +recency"
            : "Model accuracy";

        el.innerHTML = `
          <span class="ma-dot"></span>
          Model: <strong>${acc}% top-pick</strong>
          · Brier <strong>${brier}</strong>
          · over ${n} PAs
          <span class="ma-variant" title="${escapeHTMLAttr(tooltip)}">(${variantLabel(prod.variant)})</span>
          <a href="#about" class="ma-link">how</a>
        `;
        el.hidden = false;
    } catch {
        // silent
    }
}

function variantLabel(v) {
    if (v === "naive")                       return "naive baseline";
    if (v === "v1_historical")               return "v1 · historical only";
    if (v === "v2_with_daily")               return "v2 · +daily 1×";
    if (v === "v3_recency")                  return "v3 · +recency factor";
    if (v === "v4_daily_3x")                 return "v4 · daily 3×";
    if (v === "v4_daily_5x")                 return "v4 · daily 5×";
    if (v === "v4_daily_10x")                return "v4 · daily 10×";
    if (v === "v5_daily_5x_plus_recency")    return "v5 · daily 5× + recency";
    if (v === "v5_daily_10x_plus_recency")   return "v5 · daily 10× + recency";
    return v || "unknown";
}

function escapeHTMLAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function handleRoute() {
    const hash = window.location.hash;
    // Accept numeric MLBAM game_pk or the literal "demo" sentinel.
    const m = hash.match(/^#game\/(demo|\d+)/);
    if (m) {
        const id = m[1];
        if (id !== activeGameId) showGameView(id);
        setActiveNav("live");
        return;
    }
    if (hash === "#standings") {
        showStandings();
        setActiveNav("standings");
        return;
    }
    if (hash === "#leaders") {
        showLeaders();
        setActiveNav("leaders");
        return;
    }
    if (hash === "#mvp") {
        showMVP();
        setActiveNav("mvp");
        return;
    }
    if (hash === "#markets") {
        showMarketsDashboard();
        setActiveNav("markets");
        return;
    }
    if (hash === "#about") {
        showAbout();
        // No nav highlight — the about page is reached from the footer,
        // not the bottom nav.
        setActiveNav(null);
        return;
    }
    if (hash === "#hot") {
        showHot();
        setActiveNav("hot");
        return;
    }
    const playerMatch = hash.match(/^#player\/(\d+)/);
    if (playerMatch) {
        showPlayer(playerMatch[1]);
        // No nav highlight — player pages are reached from clickable
        // names in matchup cards / Gamecast, not from the bottom nav.
        setActiveNav(null);
        return;
    }
    // #live/YYYY-MM-DD = Board for a specific date (yesterday, last week,
    // an opening day in 2008, anything). Bare #live (or #) is today.
    const dateMatch = hash.match(/^#live\/(\d{4}-\d{2}-\d{2})$/);
    if (dateMatch) {
        showBoard(dateMatch[1]);
        setActiveNav("live");
        return;
    }
    showBoard();
    setActiveNav("live");
}

function setActiveNav(route) {
    document.querySelectorAll("nav .nav-item").forEach((el) => {
        el.classList.toggle("active", el.dataset.route === route);
    });
}

// ── DATE HELPERS ────────────────────────────────────────────────────
// Used by the Board's date navigation. Same Eastern-time anchor as the
// API so the user's "today" matches MLB's day boundary.

function todayInET() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year").value;
    const m = parts.find((p) => p.type === "month").value;
    const d = parts.find((p) => p.type === "day").value;
    return `${y}-${m}-${d}`;
}

function shiftDate(yyyyMmDd, days) {
    const [y, m, d] = yyyyMmDd.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    const ny = dt.getUTCFullYear();
    const nm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const nd = String(dt.getUTCDate()).padStart(2, "0");
    return `${ny}-${nm}-${nd}`;
}

function formatShortDate(yyyyMmDd) {
    const [y, m, d] = yyyyMmDd.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC", month: "short", day: "numeric",
    }).format(dt);
}

function formatLongDate(yyyyMmDd) {
    const [y, m, d] = yyyyMmDd.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC", weekday: "long",
        month: "long", day: "numeric", year: "numeric",
    }).format(dt);
}

// The little ← May 24 │ TODAY · Mon, May 25 │ May 26 → bar that sits
// above the tile grid. "TODAY" pill brightens when on today; an
// HTML5 date picker is hidden behind the date label for jumping
// to an arbitrary day.
function renderBoardDateBar(date) {
    const today = todayInET();
    const isToday = date === today;
    const prev = shiftDate(date, -1);
    const next = shiftDate(date, +1);
    // Don't let the user navigate past today — MLB hasn't played
    // tomorrow's games yet, so a "next" arrow into the future would
    // just show the schedule with no scores or anything else useful.
    const showNext = date < today;

    const prevHref = `#live/${prev}`;
    const nextHref = `#live/${next}`;
    const todayHref = `#live`;

    return `
      <header class="board-datebar">
        <a class="bd-arrow" href="${prevHref}" aria-label="Previous day">
          ← <span class="bd-arrow-date">${formatShortDate(prev)}</span>
        </a>
        <div class="bd-center">
          ${isToday
            ? `<span class="bd-today-pill">TODAY</span>
               <span class="bd-date">${formatLongDate(date)}</span>`
            : `<a class="bd-today-link" href="${todayHref}">jump to today</a>
               <span class="bd-date">${formatLongDate(date)}</span>`}
        </div>
        ${showNext
            ? `<a class="bd-arrow" href="${nextHref}" aria-label="Next day">
                 <span class="bd-arrow-date">${formatShortDate(next)}</span> →
               </a>`
            : `<span class="bd-arrow disabled" aria-hidden="true">
                 <span class="bd-arrow-date">future</span> →
               </span>`}
        <input type="date" class="bd-jump" value="${date}" max="${today}"
               aria-label="Jump to a date"/>
      </header>
    `;
}

// Wire the HTML5 date picker globally — when its value changes, route
// to that date's Board. Event delegation survives the innerHTML
// rerenders that Board refreshes do.
document.addEventListener("change", (e) => {
    if (!e.target.matches(".bd-jump")) return;
    const v = e.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    const today = todayInET();
    window.location.hash = v === today ? "#live" : `#live/${v}`;
});

// ── BOARD ────────────────────────────────────────────────────────────

// One place to flip every <main> off — each show* function turns its own
// view back on right after. Saves having to remember every existing view
// when a new one (like the about page) gets added.
function hideAllViews() {
    board.hidden = true;
    gameView.hidden = true;
    standingsView.hidden = true;
    leadersView.hidden = true;
    mvpView.hidden = true;
    aboutView.hidden = true;
    hotView.hidden = true;
    playerView.hidden = true;
    marketsView.hidden = true;
}

// Centralized timer-clear so each show* doesn't have to know about every
// other view's timer. Each show* function flips its own timer back on.
function clearAllTimers() {
    if (boardTimer)     { clearInterval(boardTimer);     boardTimer = null; }
    if (gameTimer)      { clearInterval(gameTimer);      gameTimer = null; }
    if (standingsTimer) { clearInterval(standingsTimer); standingsTimer = null; }
    if (leadersTimer)   { clearInterval(leadersTimer);   leadersTimer = null; }
    if (mvpTimer)       { clearInterval(mvpTimer);       mvpTimer = null; }
    if (hotTimer)       { clearInterval(hotTimer);       hotTimer = null; }
    if (marketsDashboardTimer) { clearInterval(marketsDashboardTimer); marketsDashboardTimer = null; }
    stopMarketsPoll();
}

// Currently-displayed Board date. Empty string = today (the API default).
// Set by showBoard(date) when route matches #live/YYYY-MM-DD.
let boardDate = "";

function showBoard(date) {
    activeGameId = null;
    boardDate = date || "";
    clearAllTimers();
    hideAllViews();
    board.hidden = false;
    refreshBoard();
    // Past dates never change — no need to keep polling.
    if (!boardDate || boardDate === todayInET()) {
        boardTimer = setInterval(refreshBoard, BOARD_REFRESH_MS);
    }
}

// Cache for the most recent schedule fetch. The Game view's ticker reads
// from here so we don't double-fetch on every Game view refresh.
let scheduleCache = null;

async function refreshBoard() {
    try {
        const url = boardDate
            ? `/api/games/today?date=${encodeURIComponent(boardDate)}`
            : "/api/games/today";
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        scheduleCache = data;
        const sorted = sortGames(data.games || []);
        const header = renderBoardDateBar(data.date || boardDate || todayInET());
        if (sorted.length === 0) {
            const dateLabel = formatLongDate(data.date || boardDate || todayInET());
            board.innerHTML = header + `
              <div class="empty">
                <p>No games on the schedule for ${dateLabel}.</p>
                <p class="sub">Try another day.</p>
              </div>
            `;
            return;
        }

        board.innerHTML = header + sorted.map(renderTile).join("");

        // Live tiles need batter + pitcher names — the schedule endpoint
        // doesn't carry those. Fire one fetch per live tile in parallel;
        // the edge cache (10s) collapses repeats to one upstream.
        for (const g of sorted) {
            if (g.status === "Live") hydrateLiveTile(g.game_pk);
        }
    } catch (e) {
        renderEmpty(board, "Could not load today's games.", `${e.message || e}`);
    }
}

// Sort the slate so the most interesting games come first: live games by
// leverage (closest score × late inning × runners on), then pregame games by
// start time (earliest first), then finals.
function sortGames(games) {
    const live    = games.filter((g) => g.status === "Live" && g.inning);
    const preview = games.filter((g) => g.status === "Preview");
    const finals  = games.filter((g) => g.status === "Final");
    const others  = games.filter((g) => !["Live","Preview","Final"].includes(g.status));

    live.sort((a, b) => leverage(b) - leverage(a));
    preview.sort((a, b) => (new Date(a.start_time || 0)) - (new Date(b.start_time || 0)));
    finals.sort((a, b) => (b.game_pk || 0) - (a.game_pk || 0));

    return [...live, ...preview, ...finals, ...others];
}

// Leverage score for live games. Tied + late + runners on rates highest.
function leverage(g) {
    const diff = Math.abs((g.home_score ?? 0) - (g.away_score ?? 0));
    const closeness = Math.max(0, 5 - diff) / 5;
    const inningWeight = Math.min(g.inning, 9) / 9;
    const runnersOn = popcount(g.bases || 0) / 3;
    return closeness * 0.5 + inningWeight * 0.3 + runnersOn * 0.2;
}

function popcount(n) {
    let c = 0;
    while (n) { c += n & 1; n >>>= 1; }
    return c;
}

// Live tile follow-up. Per-tile fetch fills in the current batter and
// pitcher names — the schedule endpoint /api/games/today doesn't carry
// them. Each lookup hits the edge cache (10s), so the second call for the
// same game finds a warm response.
async function hydrateLiveTile(pk) {
    try {
        const res = await fetch(`/api/game/${pk}`);
        if (!res.ok) return;
        const d = await res.json();
        const slot = document.querySelector(`.tile[data-pk="${pk}"] .tile-players`);
        if (slot) slot.innerHTML = livePlayersHTML(d);
    } catch {
        // tile stays in shell mode — page still works.
    }
}

function renderTile(g) {
    const recAway = g.record?.away || "";
    const recHome = g.record?.home || "";
    const fmtScore = (s) => g.status === "Preview" ? "—" : s;

    return `
      <a class="tile" href="#game/${g.game_pk}" data-status="${g.status}" data-pk="${g.game_pk}">
        ${hotPill(g)}
        <div class="matchup">
          <div class="team">
            <span class="team-id">
              <span class="name">${g.away}</span>
              ${recAway ? `<span class="rec">${recAway}</span>` : ""}
            </span>
            <span class="score">${fmtScore(g.away_score)}</span>
          </div>
          <div class="team">
            <span class="team-id">
              <span class="name">${g.home}</span>
              ${recHome ? `<span class="rec">${recHome}</span>` : ""}
            </span>
            <span class="score">${fmtScore(g.home_score)}</span>
          </div>
        </div>
        <div class="state">${stateLabel(g)}</div>
        ${tileBody(g)}
        ${tileWeBar(g)}
      </a>
    `;
}

// Middle section under the state line. Branches by game state:
//   Live    — batter/pitcher slot (filled by hydrateLiveTile).
//   Preview — probable pitchers row.
//   Final   — winning / losing / save pitcher row.
function tileBody(g) {
    if (g.status === "Live") {
        return `
          <div class="tile-players">
            ${livePlayersHTML(null)}
          </div>
        `;
    }
    if (g.status === "Preview" && g.probables) {
        const fmt = (p) => p
            ? `<span class="tile-pitcher">
                 ${inlineAvatar(p.id, { size: 28, class: "tile-photo", alt: p.name })}
                 <span class="tile-pitcher-text">${p.throws ? p.throws + "HP " : ""}${shortName(p.name)}</span>
               </span>`
            : `<span class="tile-pitcher-tba">TBA</span>`;
        return `
          <div class="tile-extra probables">
            ${fmt(g.probables.away)} <span class="dim">vs</span> ${fmt(g.probables.home)}
          </div>
        `;
    }
    if (g.status === "Final" && g.decisions) {
        const parts = [];
        const seg = (tag, name, id) => `
          <span class="tile-decision">
            <span class="dim">${tag}</span>
            ${inlineAvatar(id, { size: 24, class: "tile-photo", alt: name })}
            ${lastName(name)}
          </span>`;
        if (g.decisions.winner) parts.push(seg("W", g.decisions.winner, g.decisions.winner_id));
        if (g.decisions.loser)  parts.push(seg("L", g.decisions.loser,  g.decisions.loser_id));
        if (g.decisions.save)   parts.push(seg("S", g.decisions.save,   g.decisions.save_id));
        if (parts.length === 0) return "";
        return `<div class="tile-extra decisions">${parts.join(" · ")}</div>`;
    }
    return "";
}

// The batter/pitcher block for a live tile. Called twice: once with detail=null
// for the shell render (shows em-dashes), then again from hydrateLiveTile with
// the /api/game/{id} response.
function livePlayersHTML(detail) {
    const dim = detail ? "" : "dim";
    const fmt = (p, hand) => {
        if (!p) return "—";
        return `${p.name ? shortName(p.name) : "—"}${p[hand] ? " (" + p[hand] + ")" : ""}`;
    };
    const photo = (p) => inlineAvatar(p?.id, { size: 28, class: "tile-live-photo", alt: p?.name });
    return `
      <div class="player-row ${dim}">
        <span class="label">at bat</span>
        ${photo(detail?.batter)}
        <strong>${fmt(detail?.batter, "bats")}</strong>
      </div>
      <div class="player-row ${dim}">
        <span class="label">pitching</span>
        ${photo(detail?.pitcher)}
        <strong>${fmt(detail?.pitcher, "throws")}</strong>
      </div>
    `;
}

// Sportsbook-style WE bar across the tile bottom. Hidden for pregame.
function tileWeBar(g) {
    if (g.win_expectancy == null) return "";
    const homePct = Math.round(g.win_expectancy * 100);
    const awayPct = 100 - homePct;
    return `
      <div class="tile-we">
        <div class="we-bar"><span style="width:${homePct}%"></span></div>
        <div class="we-labels">
          <span>${g.away} ${awayPct}%</span>
          <span>${g.home} ${homePct}%</span>
        </div>
      </div>
    `;
}


// HOT badge for live games in the late innings that are still close. Threshold
// is "7th inning or later AND within 2 runs" — the back half of a one-score
// game is when every pitch starts to matter.
function hotPill(g) {
    if (g.status !== "Live" || !g.inning) return "";
    const close = Math.abs((g.home_score ?? 0) - (g.away_score ?? 0)) <= 2;
    const late = g.inning >= 7;
    if (!(close && late)) return "";
    return `<span class="hot-pill" aria-label="High leverage"><span class="dot"></span>HOT</span>`;
}

function lastName(fullName) {
    const parts = fullName.trim().split(/\s+/);
    return parts.length < 2 ? fullName : parts[parts.length - 1];
}

// MLB headshot URL helpers. We were using midfield.mlbstatic.com's
// /spots/N endpoint for inline avatars — it returns a tight face crop
// that ALSO clips the top of the cap. Switched everything to the
// cloudinary headshot path (img.mlbstatic.com .../headshot/67/current)
// which serves the full head + shoulders + the whole hat. CSS handles
// the circular display via `object-position: top` so the cap always
// lands inside the frame even on circle crops.
//
// Both serve cleanly when the MLBAM id is unknown / null — they fall
// back to a generic silhouette. Cached at the edge by Cloudflare
// automatically.
function playerHeadshotSpot(mlbam, size = 60) {
    if (!mlbam) return null;
    // Request 2× the display size so the image stays crisp on retina,
    // and so the whole cap is in the source rather than a face-tight
    // crop. f_auto picks WebP/AVIF when the client supports it.
    const w = Math.max(120, size * 2);
    return `https://img.mlbstatic.com/mlb-photos/image/upload/`
         + `w_${w},q_auto:best,f_auto`
         + `/v1/people/${mlbam}/headshot/67/current`;
}
// Tiny inline avatar used in tables / rows / strips. One helper for
// the whole site so swap-outs (CDN change, fallback URL, etc.) happen
// in one place. Bumped baseline default size 24 → 32 so faces are
// readable at glance distance.
function inlineAvatar(mlbam, opts = {}) {
    const size  = opts.size  || 32;
    const cdnSize = opts.cdnSize || size;
    const cls   = opts.class || "ph-avatar";
    const label = opts.alt   || "";
    if (!mlbam) {
        return `<span class="${cls} ${cls}-empty" aria-hidden="true" style="width:${size}px;height:${size}px;"></span>`;
    }
    return `<img class="${cls}" src="${playerHeadshotSpot(mlbam, cdnSize)}" alt="${escapeHTMLAttr(label)}" loading="lazy" width="${size}" height="${size}" onerror="this.style.opacity='0';"/>`;
}
function bsPhoto(mlbam) {
    return inlineAvatar(mlbam, { size: 32, class: "bs-photo" });
}

function playerHeadshotLarge(mlbam, width = 240) {
    if (!mlbam) return null;
    return `https://img.mlbstatic.com/mlb-photos/image/upload/`
         + `w_${width},q_auto:best,f_auto/v1/people/${mlbam}/headshot/67/current`;
}

// ── (the standalone Featured Game card was retired in favor of expanded
// tiles for every game, sorted by leverage. The picker function `leverage`
// lives up top and now drives sort order. The bigger field SVG and players
// block live inside the tile.) ──







// ── GAME VIEW ────────────────────────────────────────────────────────

function showGameView(id) {
    activeGameId = id;
    clearAllTimers();
    hideAllViews();
    gameView.hidden = false;
    renderEmpty(gameView, "Loading game…", "");
    // Drop any per-game caches from the previous game — the pill, the
    // markets pane, and the boxscore must all re-fetch for the new pk.
    cachedMarketConsensusSlot = "";
    cachedMarketConsensusPk = null;
    cachedMarketsHTML = "";
    cachedMarketsPk = null;
    refreshGame(id);
    gameTimer = setInterval(() => refreshGame(id), GAME_REFRESH_MS);
}

// ── STANDINGS VIEW ──────────────────────────────────────────────────

function showStandings() {
    activeGameId = null;
    clearAllTimers();
    hideAllViews();
    standingsView.hidden = false;
    renderEmpty(standingsView, "Loading standings…", "");
    refreshStandings();
    standingsTimer = setInterval(refreshStandings, STANDINGS_REFRESH_MS);
}

async function refreshStandings() {
    try {
        const res = await fetch("/api/standings");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.divisions || data.divisions.length === 0) {
            renderEmpty(standingsView, "Standings not available.", "Check back later.");
            return;
        }
        standingsView.innerHTML = renderStandings(data);
    } catch (e) {
        renderEmpty(standingsView, "Could not load standings.", `${e.message || e}`);
    }
}

function renderStandings(data) {
    // Group by league so AL and NL get their own row of three divisions.
    const al = data.divisions.filter((d) => d.league === "AL").sort(divisionOrder);
    const nl = data.divisions.filter((d) => d.league === "NL").sort(divisionOrder);
    return `
      <header class="standings-head">
        <h2>STANDINGS</h2>
        <span class="standings-meta">${data.season} season</span>
      </header>
      <section class="standings-league">
        <h3 class="league-label">American League</h3>
        <div class="standings-grid">
          ${al.map(renderDivisionBlock).join("")}
        </div>
      </section>
      <section class="standings-league">
        <h3 class="league-label">National League</h3>
        <div class="standings-grid">
          ${nl.map(renderDivisionBlock).join("")}
        </div>
      </section>
    `;
}

// East -> Central -> West in each league.
function divisionOrder(a, b) {
    const order = { 201: 0, 202: 1, 200: 2, 204: 0, 205: 1, 203: 2 };
    return (order[a.id] ?? 99) - (order[b.id] ?? 99);
}

function renderDivisionBlock(div) {
    return `
      <div class="division-block">
        <header class="division-head">
          <span class="division-name">${div.name}</span>
        </header>
        <table class="standings-table">
          <thead>
            <tr>
              <th class="col-team">TEAM</th>
              <th class="col-wl">W-L</th>
              <th class="col-pct">PCT</th>
              <th class="col-gb">GB</th>
              <th class="col-strk">STRK</th>
              <th class="col-l10">L10</th>
              <th class="col-rd">RD</th>
            </tr>
          </thead>
          <tbody>
            ${div.teams.map((t, i) => renderTeamRow(t, i === 0)).join("")}
          </tbody>
        </table>
      </div>
    `;
}

function renderTeamRow(t, isLeader) {
    const streakCls = t.streak?.startsWith("W") ? "streak-win"
                    : t.streak?.startsWith("L") ? "streak-loss"
                    : "";
    const rdCls = t.run_diff > 0 ? "rd-pos"
                : t.run_diff < 0 ? "rd-neg"
                : "";
    return `
      <tr class="${isLeader ? "leader" : ""}">
        <td class="col-team"><strong>${t.team}</strong></td>
        <td class="col-wl">${t.wins}-${t.losses}</td>
        <td class="col-pct">${t.pct}</td>
        <td class="col-gb">${t.gb}</td>
        <td class="col-strk ${streakCls}">${t.streak}</td>
        <td class="col-l10">${t.last10}</td>
        <td class="col-rd ${rdCls}">${t.run_diff > 0 ? "+" : ""}${t.run_diff}</td>
      </tr>
    `;
}

// ── LEADERS VIEW ────────────────────────────────────────────────────

function showLeaders() {
    activeGameId = null;
    clearAllTimers();
    hideAllViews();
    leadersView.hidden = false;
    renderEmpty(leadersView, "Loading leaders…", "");
    refreshLeaders();
    leadersTimer = setInterval(refreshLeaders, LEADERS_REFRESH_MS);
}

async function refreshLeaders() {
    try {
        const res = await fetch("/api/leaders");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.hitting && !data.pitching) {
            renderEmpty(leadersView, "Leaders not available.", "Check back later.");
            return;
        }
        leadersView.innerHTML = renderLeaders(data);
    } catch (e) {
        renderEmpty(leadersView, "Could not load leaders.", `${e.message || e}`);
    }
}

function renderLeaders(data) {
    return `
      <header class="leaders-head">
        <h2>LEADERS</h2>
        <span class="leaders-meta">${data.season} season · top 5</span>
      </header>
      <section class="leaders-section">
        <h3 class="leaders-section-label">Hitting</h3>
        <div class="leaders-grid">
          ${data.hitting.map(renderLeaderCard).join("")}
        </div>
      </section>
      <section class="leaders-section">
        <h3 class="leaders-section-label">Pitching</h3>
        <div class="leaders-grid">
          ${data.pitching.map(renderLeaderCard).join("")}
        </div>
      </section>
    `;
}

function renderLeaderCard(cat) {
    if (!cat.leaders || cat.leaders.length === 0) {
        return `
          <div class="leader-card">
            <header class="leader-head"><span class="leader-stat">${cat.label}</span></header>
            <div class="leader-empty">no data yet</div>
          </div>
        `;
    }
    return `
      <div class="leader-card">
        <header class="leader-head"><span class="leader-stat">${cat.label}</span></header>
        <ol class="leader-list">
          ${cat.leaders.map(renderLeaderRow).join("")}
        </ol>
      </div>
    `;
}

function renderLeaderRow(l) {
    const team = l.team ? `<span class="leader-team">${l.team}</span>` : "";
    const photo = inlineAvatar(l.person_id, { size: 32, class: "leader-photo", alt: l.name });
    const nameHtml = l.person_id
        ? `<a class="leader-name player-link" href="#player/${l.person_id}">${shortName(l.name)}</a>`
        : `<span class="leader-name">${shortName(l.name)}</span>`;
    return `
      <li class="leader-row" data-rank="${l.rank}">
        <span class="leader-rank">${l.rank}</span>
        ${photo}
        ${nameHtml}
        ${team}
        <span class="leader-value">${l.value}</span>
      </li>
    `;
}

// ── MVP / CY YOUNG VIEW ─────────────────────────────────────────────

function showMVP() {
    activeGameId = null;
    clearAllTimers();
    hideAllViews();
    mvpView.hidden = false;
    renderEmpty(mvpView, "Loading MVP race…", "");
    refreshMVP();
    mvpTimer = setInterval(refreshMVP, MVP_REFRESH_MS);
}

// ── MARKETS DASHBOARD ───────────────────────────────────────────────
//
// Every public prediction-market quote for today's MLB slate, in one
// scrollable surface. Reaches /api/markets which fans out to
// Polymarket / Kalshi / Manifold / (Odds API when keyed). Grouped by
// question type so users see "all the moneylines, all the totals, all
// the player props" in one place. Polls every 20s so the page feels
// like the lines are moving in real time.
//
// Cross-source consensus is computed per group on the server side via
// groupByQuestion → row-level outcomes carry per-source probabilities
// the renderer can compare side-by-side.

function showMarketsDashboard() {
    activeGameId = null;
    clearAllTimers();
    hideAllViews();
    marketsView.hidden = false;
    renderEmpty(marketsView, "Pulling every public MLB market…", "");
    refreshMarketsDashboard();
    marketsDashboardTimer = setInterval(refreshMarketsDashboard, MARKETS_REFRESH_MS);
}

async function refreshMarketsDashboard() {
    try {
        const res = await fetch(`/api/markets`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (marketsView.hidden) return;  // user navigated away mid-flight
        marketsView.innerHTML = renderMarketsDashboard(data);
    } catch (e) {
        // First load only — if we already painted, keep showing it.
        if (!marketsView.querySelector(".markets-dashboard")) {
            renderEmpty(marketsView, "Couldn't load markets.", `${e.message || e}`);
        }
    }
}

function renderMarketsDashboard(d) {
    const totalLine = `${d.total} live quote${d.total === 1 ? "" : "s"} across ${d.sources.length} source${d.sources.length === 1 ? "" : "s"}`;
    const sourceChips = d.sources.map((s) =>
        `<span class="md-source-chip md-source-chip-${s}">${s} · ${d.counts_by_source[s]}</span>`
    ).join("");

    return `
      <div class="markets-dashboard">
        <header class="md-header">
          <h2 class="md-title">Today's MLB markets</h2>
          <div class="md-sub">${totalLine}</div>
          <div class="md-sources">${sourceChips}</div>
          <div class="md-meta">
            Auto-refreshes every 20s · Pulled ${formatRelativeTime(d.fetched_at)}
          </div>
        </header>

        ${renderMarketsSection("Moneyline (who wins)",     d.markets.moneyline)}
        ${renderMarketsSection("Spread (run line)",         d.markets.spread)}
        ${renderMarketsSection("Total runs (over/under)",   d.markets.total)}
        ${renderMarketsSection("Player props",              d.markets.player_prop)}
        ${renderMarketsSection("Team props",                d.markets.team_prop)}
        ${renderMarketsSection("Series outcomes",           d.markets.series)}
        ${renderMarketsSection("Futures (season-long)",     d.markets.future)}
        ${renderMarketsSection("Other questions",           d.markets.other)}

        <footer class="md-footnote">
          Quotes pulled live from Polymarket (gamma API), Kalshi (events
          API), Manifold (binary markets)${d.sources.includes("odds_api") ? ", and The Odds API" : ""}.
          For per-game side-by-side comparison vs our model, open a game
          and pick the Markets tab.
        </footer>
      </div>
    `;
}


// ── ABOUT VIEW ──────────────────────────────────────────────────────

function showAbout() {
    activeGameId = null;
    clearAllTimers();
    hideAllViews();
    aboutView.hidden = false;
    aboutView.innerHTML = renderAbout();
}

// ── PLAYER PROFILE VIEW ─────────────────────────────────────────────
//
// Reached by clicking any player's name in the matchup card, Gamecast,
// or anywhere else we render a name. Shows career splits from
// batter_rates / pitcher_rates plus this-season activity from daily_pa.
// Bookmarkable URL: #player/{mlbam}.

function showPlayer(mlbam) {
    activeGameId = null;
    clearAllTimers();
    hideAllViews();
    playerView.hidden = false;
    renderEmpty(playerView, "Loading player…", "");
    refreshPlayer(mlbam);
}

async function refreshPlayer(mlbam) {
    try {
        // Two parallel fetches: the standard player profile + the
        // "tonight" projection (which independently checks if the
        // player has a game today). Tonight endpoint returns
        // available:false when there's no game; the UI handles that
        // gracefully by skipping the projection card.
        const [profileRes, tonightRes] = await Promise.all([
            fetch(`/api/player/${mlbam}`),
            fetch(`/api/player/${mlbam}/tonight`),
        ]);
        if (!profileRes.ok) throw new Error(`HTTP ${profileRes.status}`);
        const data = await profileRes.json();
        const tonight = tonightRes.ok ? await tonightRes.json() : null;
        playerView.innerHTML = renderPlayer(data, tonight);

        // After paint, look up any prediction-market player props for
        // this player tonight — when found, they attach to Player
        // Tonight's stat tiles. Silent on miss (most players in most
        // games have no public quotes). Runs after the main paint so
        // the page isn't blocked on a markets fetch.
        if (tonight?.available && tonight.game?.game_pk) {
            const p = data.player || {};
            const playerName = p.full_name
                || `${p.first || p.name_first || ""} ${p.last || p.name_last || ""}`.trim();
            hydratePlayerProps(tonight.game.game_pk, playerName, mlbam);
        }
    } catch (e) {
        renderEmpty(playerView, "Couldn't load player.", `${e.message || e}`);
    }
}

// Pull the FULL all-MLB markets bundle (not just game-tagged) and
// filter player_prop rows by player name. Game-tagged player props
// would miss most cases — Polymarket / Kalshi MLB player markets
// usually carry only the player name in the title, not the team, so
// they don't bind to a specific game by tricode. We match by name.
// Silent on miss (most non-marquee players have no public quotes).
async function hydratePlayerProps(gamePk, playerName, mlbam) {
    if (!playerName) return;
    try {
        const res = await fetch(`/api/markets`);
        if (!res.ok) return;
        const data = await res.json();
        const slot = document.getElementById("pt-market-chips-slot");
        if (!slot) return;  // Player Tonight not present (no projection)

        const allProps = (data?.markets?.player_prop || []);
        const matches = filterMarketsByPlayerName(allProps, playerName);
        slot.innerHTML = renderPlayerPropChips(matches, playerName);
    } catch { /* silent — no chips section if anything goes wrong */ }
}

// Robust player-name filter — every token (last name and first name)
// must be present in the market title, case-insensitive. Skips tokens
// shorter than 3 chars (initials, "Jr", etc.) to keep matches tight.
function filterMarketsByPlayerName(markets, playerName) {
    const tokens = (playerName || "")
        .toLowerCase()
        .split(/[\s.]+/)
        .filter((t) => t.length >= 3 && !["jr", "sr", "the"].includes(t));
    if (!tokens.length) return [];
    return (markets || []).filter((m) => {
        const title = (m.title || "").toLowerCase();
        return tokens.every((t) => title.includes(t));
    });
}

function renderPlayerPropChips(matches, playerName) {
    if (!matches.length) return "";
    const chips = matches.map((m) => {
        // Sort outcomes so the favored "yes/over" side shows first.
        const outcomes = (m.outcomes || []).slice().sort((a, b) => (b.probability || 0) - (a.probability || 0));
        const best = outcomes[0];
        const pct  = best?.probability != null ? fmtPct(best.probability) : "—";
        const side = (best?.name || "Yes").trim();
        const src  = m.source || "?";
        return `
          <a class="pt-prop-chip" href="${m.url || "#"}" target="_blank" rel="noopener" title="${escapeHTMLAttr(m.title)}">
            <span class="pt-prop-chip-side">${escapeHTML(side)}</span>
            <span class="pt-prop-chip-pct">${pct}</span>
            <span class="pt-prop-chip-src">${src}</span>
          </a>
        `;
    }).join("");
    return `
      <div class="pt-prop-strip">
        <div class="pt-prop-strip-head">
          Markets quoting ${escapeHTML(playerName)} tonight
        </div>
        <div class="pt-prop-strip-chips">${chips}</div>
        <div class="pt-prop-strip-note">
          Open the Markets tab on the game for full per-market detail.
        </div>
      </div>
    `;
}

// The 9 outcome buckets the engine speaks in. Used to compute slash
// lines + rate stats from the raw counts our APIs return.
const OUTCOMES_ARRAY = ["K", "BB", "HBP", "1B", "2B", "3B", "HR", "OUT", "OTHER"];

function renderPlayer(d, tonight) {
    const p = d.player;
    return `
      <a class="back-link" href="#">← BOARD</a>
      <article class="player-doc">
        ${renderHeroHeader(p, d)}
        ${tonight && tonight.available ? renderTonightCard(p, tonight) : ""}
        ${d.batter  ? renderBatterModule(d.batter,  d.current_year) : ""}
        ${d.pitcher ? renderPitcherModule(d.pitcher, d.current_year) : ""}
        ${(!d.batter && !d.pitcher) ? renderNoDataState(d) : ""}
      </article>
    `;
}

// Hero header — the convention every site uses. Name (huge) on the
// left, jersey# on the right, a meta strip below with position, team,
// bats/throws, age, height/weight. Missing fields just drop out
// rather than render with em-dashes.
function renderHeroHeader(player, d) {
    const bio = player.bio || {};
    const handFromBats = d.batter?.bats || bio.bats;
    const handFromThrows = d.pitcher?.throws || bio.throws;
    const handStr = bio.bats && bio.throws
        ? `Bats ${bio.bats} · Throws ${bio.throws}`
        : handFromBats
            ? `Bats ${handFromBats}`
            : handFromThrows
                ? `Throws ${handFromThrows}`
                : "";
    const sizeLine = (bio.height && bio.weight) ? `${bio.height} / ${bio.weight} lbs` : "";
    const jersey = bio.jersey ? `#${bio.jersey}` : "";
    const meta = [
        bio.position && bio.team_name
            ? `${bio.position} · ${bio.team_name}`
            : (bio.position || bio.team_name || ""),
        handStr,
        bio.age != null ? `Age ${bio.age}` : "",
        sizeLine,
        player.retrosheet ? "" : "modern callup",
    ].filter(Boolean);
    // Headshot from MLB's CDN. Falls back to a generic silhouette
    // automatically when MLBAM is unknown — same URL pattern serves
    // both cases. onerror swaps to a placeholder div if even the
    // generic 404s (rare but possible for very old / dropped players).
    const headshotUrl = playerHeadshotLarge(player.mlbam, 240);
    const headshot = headshotUrl
        ? `<div class="ph-headshot">
              <img src="${headshotUrl}" alt="${player.name}"
                   loading="eager"
                   onerror="this.style.display='none'; this.parentElement.classList.add('ph-headshot-fallback');"/>
              <div class="ph-headshot-initials" aria-hidden="true">${player.first?.[0] || ""}${player.last?.[0] || ""}</div>
           </div>`
        : "";

    return `
      <header class="player-hero">
        ${headshot}
        <div class="ph-body">
          <div class="ph-name-row">
            <h1 class="ph-name">${player.name}</h1>
            ${jersey ? `<span class="ph-jersey">${jersey}</span>` : ""}
          </div>
          ${meta.length ? `<div class="ph-meta">${meta.map(m => `<span>${m}</span>`).join("<span class=\"ph-dot\">·</span>")}</div>` : ""}
        </div>
      </header>
    `;
}

// "Tonight" projection card — shown at the top of the player profile
// when the player has a game today. Combines: matchup info + expected
// line (engine prediction × estimated PAs) + recent form + head-to-
// head + hit streak. The product completion of today's session — the
// engine outputs a per-PA prediction, this card turns it into "what
// you should expect from this player tonight."
function renderTonightCard(player, t) {
    const game = t.game || {};
    const opp = t.opponent || {};
    const opPit = t.opposing_pitcher;
    const exp = t.expected_line;
    const status = game.status || "Preview";

    // Header — varies by game state. Pregame: "TONIGHT vs LAD · 7:05 ET".
    // Live: "▲ 5TH · vs LAD · 2-1". Final: hide the card (game's already played).
    if (status === "Final") {
        // Could show today's result, but the slash strips already cover
        // recent games via daily_pa. Skip for now.
        return "";
    }

    const oppLabel = opp.abbr || opp.name || "opponent";
    const headerWhen = status === "Live" && game.teams?.away
        ? `Live · vs ${oppLabel}`
        : `Tonight · vs ${oppLabel} · ${formatGameTime(game.start_time)}`;

    // Expected line — render only if matchup engine had data. For
    // pitcher-side TBA or matchup-engine fallback cases, show the
    // game info but skip the projection block.
    const expectedBlock = exp ? `
      <div class="pt-expected">
        <div class="pt-expected-head">Projected line tonight</div>
        <div class="pt-expected-grid">
          <div class="pt-stat"><div class="pt-stat-val">${exp.h.toFixed(1)}</div><div class="pt-stat-key">H</div></div>
          <div class="pt-stat"><div class="pt-stat-val">${exp.hr.toFixed(2)}</div><div class="pt-stat-key">HR</div></div>
          <div class="pt-stat"><div class="pt-stat-val">${exp.bb.toFixed(1)}</div><div class="pt-stat-key">BB</div></div>
          <div class="pt-stat"><div class="pt-stat-val">${exp.k.toFixed(1)}</div><div class="pt-stat-key">K</div></div>
          <div class="pt-stat"><div class="pt-stat-val">${exp.on_base.toFixed(1)}</div><div class="pt-stat-key">on-base</div></div>
        </div>
        <div class="pt-expected-meta">
          over ~${exp.expected_pas.toFixed(1)} PAs ·
          projected OBP <strong>${fmtAvg(exp.obp_proj)}</strong> ·
          SLG <strong>${fmtAvg(exp.slg_proj)}</strong>
        </div>
      </div>
    ` : `
      <div class="pt-expected-empty">
        Matchup-engine projection unavailable — opposing pitcher
        ${opPit?.name ? "(" + opPit.name + ") " : ""}may not be in our
        sample yet.
      </div>
    `;

    // Recent form — last-7-games window is the headline; last-30-games
    // shown smaller. The field names on the API side still read
    // last_7_days / last_30_days for compatibility but the actual
    // semantics are now "last N games played" (per /goal — see
    // computeRecentForm() in api/player/[mlbam]/tonight.js).
    const rf7  = t.recent_form?.last_7_days;
    const rf30 = t.recent_form?.last_30_days;
    const actuals = t.recent_form?.actual_games || {};
    const tag = (label, actual) => actual && actual < label
        ? `last ${actual} games` : `last ${label} games`;
    const recentBlock = (rf7 && rf7.pa > 0) ? `
      <div class="pt-recent">
        <div class="pt-recent-head">Recent form</div>
        <div class="pt-recent-row">
          <span class="pt-recent-label">${tag(7, actuals.l7)}</span>
          <span class="pt-recent-line">
            <strong>${rf7.h}-for-${rf7.ab}</strong>
            · ${rf7.avg}/${rf7.obp}/${rf7.slg}
            · ${rf7.hr} HR · ${rf7.bb} BB · ${rf7.k} K
          </span>
        </div>
        ${(rf30 && rf30.pa > 0) ? `
          <div class="pt-recent-row pt-recent-dim">
            <span class="pt-recent-label">${tag(30, actuals.l30)}</span>
            <span class="pt-recent-line">
              <strong>${rf30.h}-for-${rf30.ab}</strong>
              · ${rf30.avg}/${rf30.obp}/${rf30.slg}
              · ${rf30.hr} HR
            </span>
          </div>` : ""}
      </div>
    ` : "";

    // Head-to-head vs tonight's starter. Limited (2025+ only — daily_pa
    // started 2025-03-27), but interesting when sample exists.
    const h2h = t.head_to_head;
    const h2hBlock = (h2h && h2h.pa > 0) ? `
      <div class="pt-h2h">
        <div class="pt-h2h-head">vs ${opPit?.name || "tonight's starter"}</div>
        <div class="pt-h2h-line">
          <strong>${h2h.h}-for-${h2h.ab}</strong>
          · ${h2h.avg}/${h2h.obp}/${h2h.slg}
          ${h2h.hr ? `· ${h2h.hr} HR` : ""}
        </div>
        ${h2h.sample_note ? `<div class="pt-h2h-note">${h2h.sample_note}</div>` : ""}
      </div>
    ` : (opPit ? `
      <div class="pt-h2h">
        <div class="pt-h2h-head">vs ${opPit.name}</div>
        <div class="pt-h2h-note">No PAs vs this pitcher in 2025-26.</div>
      </div>` : "");

    // Streaks — only show when notable (≥ 3 games).
    const s = t.streaks || {};
    const streakBlock = (s.hit_streak >= 3 || s.on_base_streak >= 4) ? `
      <div class="pt-streaks">
        ${s.hit_streak >= 3 ? `<span class="pt-streak-pill pt-streak-hit">🔥 ${s.hit_streak}-game hit streak</span>` : ""}
        ${s.on_base_streak >= 4 ? `<span class="pt-streak-pill">📈 ${s.on_base_streak}-game on-base streak</span>` : ""}
      </div>` : "";

    // Lineup spot + pitcher chip — sit just below the header.
    const lineupTag = t.lineup_spot
        ? `<span class="pt-tag">batting ${ordinalSuffix(t.lineup_spot).toLowerCase()}</span>`
        : "";
    const pitcherChip = opPit
        ? `<span class="pt-tag pt-tag-pitcher">
             ${inlineAvatar(opPit.id, { size: 36, class: "pt-tag-photo", alt: opPit.name })}
             <span class="pt-tag-text">vs <a class="player-link" href="#player/${opPit.id}">${opPit.name}</a>${opPit.throws ? " (" + opPit.throws + "HP)" : ""}</span>
           </span>`
        : "";

    return `
      <section class="player-tonight">
        <header class="pt-header">
          <span class="pt-when">${headerWhen}</span>
          <div class="pt-tags">${lineupTag}${pitcherChip}</div>
        </header>
        ${expectedBlock}
        <div id="pt-market-chips-slot"></div>
        ${recentBlock}
        ${h2hBlock}
        ${streakBlock}
      </section>
    `;
}

function formatGameTime(iso) {
    if (!iso) return "TBD";
    try {
        const d = new Date(iso);
        return d.toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit",
            timeZone: "America/New_York",
        }) + " ET";
    } catch {
        return "TBD";
    }
}

// Renders the batter module — three modules stacked:
//   1. Slash strips: current season + career (5-tile each)
//   2. Matchup band: vs LHP / vs RHP, current + career
//   3. Rate profile + outcome breakdown
//
// "Career" here = vs_RHP + vs_LHP combined (PA-weighted) plus current-
// season PAs from daily_pa (per PR #56).
function renderBatterModule(b, currentYear) {
    const careerCounts = combineSplits(b.career.vs_RHP.counts, b.career.vs_LHP.counts);
    const seasonSlash = slashLine(b.season.overall || {});
    const careerSlash = slashLine(careerCounts);

    const rhpCareerSlash = slashLine(b.career.vs_RHP.counts);
    const lhpCareerSlash = slashLine(b.career.vs_LHP.counts);
    const rhpSeasonSlash = slashLine(b.season.splits?.vs_R || {});
    const lhpSeasonSlash = slashLine(b.season.splits?.vs_L || {});

    return `
      <section class="player-module">
        ${renderSlashStrip({
            label: `${currentYear} Season`,
            extra: b.season.latest_date ? `Last game ${b.season.latest_date}` : "",
            slash: seasonSlash,
            paLabel: "PA",
        })}
        ${renderSlashStrip({
            label: "Career",
            extra: `${(careerSlash.PA).toLocaleString()} PA combined`,
            slash: careerSlash,
            paLabel: "PA",
        })}
        ${renderMatchupBand({
            currentYear,
            seasonR: rhpSeasonSlash, seasonL: lhpSeasonSlash,
            careerR: rhpCareerSlash, careerL: lhpCareerSlash,
            handTag: "P",
        })}
        ${renderRateProfile(seasonSlash, careerSlash, currentYear)}
        ${renderOutcomeBreakdown(b.career)}
      </section>
    `;
}

// Same shape as the batter module but pivoted to the pitcher's view —
// "Against" stats. For pitchers, the OPS line is what hitters do
// AGAINST them (lower is better). vs_RHB / vs_LHB split is the
// platoon angle on the pitching side.
function renderPitcherModule(p, currentYear) {
    const careerCounts = combineSplits(p.career.vs_RHB.counts, p.career.vs_LHB.counts);
    const seasonSlash = slashLine(p.season.overall || {});
    const careerSlash = slashLine(careerCounts);

    const rhbCareerSlash = slashLine(p.career.vs_RHB.counts);
    const lhbCareerSlash = slashLine(p.career.vs_LHB.counts);
    const rhbSeasonSlash = slashLine(p.season.splits?.vs_R || {});
    const lhbSeasonSlash = slashLine(p.season.splits?.vs_L || {});

    return `
      <section class="player-module">
        <div class="pm-pitcher-note">Hitter performance AGAINST this pitcher — lower is better.</div>
        ${renderSlashStrip({
            label: `${currentYear} Season (Against)`,
            extra: p.season.latest_date ? `Last game ${p.season.latest_date}` : "",
            slash: seasonSlash,
            paLabel: "BF",
        })}
        ${renderSlashStrip({
            label: "Career (Against)",
            extra: `${(careerSlash.PA).toLocaleString()} BF combined`,
            slash: careerSlash,
            paLabel: "BF",
        })}
        ${renderMatchupBand({
            currentYear,
            seasonR: rhbSeasonSlash, seasonL: lhbSeasonSlash,
            careerR: rhbCareerSlash, careerL: lhbCareerSlash,
            handTag: "B",
        })}
        ${renderRateProfile(seasonSlash, careerSlash, currentYear)}
        ${renderOutcomeBreakdown(p.career, "B")}
      </section>
    `;
}

// 5-tile horizontal strip: AVG / OBP / SLG / OPS / HR — the canonical
// hitter headline every baseball site leads with. Below the tiles, a
// "PA · AB · H · 2B · 3B · HR" counting-stats line for context.
function renderSlashStrip({ label, extra, slash, paLabel }) {
    return `
      <div class="slash-strip">
        <div class="ss-head">
          <span class="ss-label">${label}</span>
          ${extra ? `<span class="ss-extra">${extra}</span>` : ""}
        </div>
        <div class="ss-grid">
          <div class="ss-tile"><div class="ss-val">${slash.AVG}</div><div class="ss-key">AVG</div></div>
          <div class="ss-tile"><div class="ss-val">${slash.OBP}</div><div class="ss-key">OBP</div></div>
          <div class="ss-tile"><div class="ss-val">${slash.SLG}</div><div class="ss-key">SLG</div></div>
          <div class="ss-tile"><div class="ss-val">${slash.OPS}</div><div class="ss-key">OPS</div></div>
          <div class="ss-tile ss-tile-counter"><div class="ss-val">${slash.HR}</div><div class="ss-key">HR</div></div>
        </div>
        <div class="ss-counts">
          <span><strong>${slash.PA}</strong> ${paLabel}</span>
          <span class="ss-dot">·</span>
          <span><strong>${slash.AB}</strong> AB</span>
          <span class="ss-dot">·</span>
          <span><strong>${slash.H}</strong> H</span>
          <span class="ss-dot">·</span>
          <span><strong>${slash.BB}</strong> BB</span>
          <span class="ss-dot">·</span>
          <span><strong>${slash.K}</strong> K</span>
        </div>
      </div>
    `;
}

// THE MATCHUP band — the visual centerpiece of our player page, the
// one thing that differentiates us from ESPN/MLB.com. Other sites
// bury platoon splits under a "Splits" tab; we promote them above
// career totals because the matchup-by-hand IS the pitch this app
// makes. Renders 4 cards: vs L/R for current season + career.
function renderMatchupBand({ currentYear, seasonR, seasonL, careerR, careerL, handTag }) {
    const oppTagR = `RH${handTag}`;  // "RHP" or "RHB"
    const oppTagL = `LH${handTag}`;
    const card = (label, slash, oppTag) => {
        if (slash.PA === 0) return `
          <div class="mb-card mb-empty">
            <div class="mb-head"><span class="mb-label">${label}</span><span class="mb-pa">no data</span></div>
          </div>`;
        return `
          <div class="mb-card">
            <div class="mb-head">
              <span class="mb-label">${label}</span>
              <span class="mb-pa">n = ${slash.PA.toLocaleString()}</span>
            </div>
            <div class="mb-slash">
              <span class="mb-slash-val">${slash.AVG}</span>
              <span class="mb-slash-sep">/</span>
              <span class="mb-slash-val">${slash.OBP}</span>
              <span class="mb-slash-sep">/</span>
              <span class="mb-slash-val">${slash.SLG}</span>
            </div>
            <div class="mb-row"><span>OPS</span><strong>${slash.OPS}</strong></div>
            <div class="mb-row"><span>HR</span><strong>${slash.HR}</strong></div>
            <div class="mb-row"><span>K%</span><strong>${pct(slash.KP)}</strong></div>
            <div class="mb-row"><span>BB%</span><strong>${pct(slash.BBP)}</strong></div>
            <div class="mb-row"><span>ISO</span><strong>${slash.ISO}</strong></div>
          </div>
        `;
    };
    return `
      <div class="matchup-band">
        <div class="mb-band-title">The Matchup — split by opposing hand</div>
        <div class="mb-section">
          <div class="mb-section-head">${currentYear} Season</div>
          <div class="mb-grid">
            ${card(`vs ${oppTagR}`, seasonR, oppTagR)}
            ${card(`vs ${oppTagL}`, seasonL, oppTagL)}
          </div>
        </div>
        <div class="mb-section">
          <div class="mb-section-head">Career</div>
          <div class="mb-grid">
            ${card(`vs ${oppTagR}`, careerR, oppTagR)}
            ${card(`vs ${oppTagL}`, careerL, oppTagL)}
          </div>
        </div>
      </div>
    `;
}

// Rate profile — the "advanced" view a la FanGraphs dashboard. Current
// season vs career, side by side. We render the same six rates every
// site shows because they're the digestible-yet-meaningful tier.
function renderRateProfile(seasonSlash, careerSlash, currentYear) {
    const row = (label, key, fmt) => `
      <tr>
        <th>${label}</th>
        <td>${fmt(seasonSlash[key])}</td>
        <td>${fmt(careerSlash[key])}</td>
      </tr>`;
    return `
      <div class="rate-profile">
        <div class="rp-head">Rate Profile</div>
        <table class="rp-table">
          <thead>
            <tr><th></th><th>${currentYear}</th><th>Career</th></tr>
          </thead>
          <tbody>
            ${row("K% — strikeout rate",          "KP",   pct)}
            ${row("BB% — walk rate",              "BBP",  pct)}
            ${row("ISO — isolated power",         "ISO",  identity)}
            ${row("BABIP — BA on balls in play",  "BABIP", identity)}
            ${row("HR/PA",                        "HRP",  pct)}
            ${row("H/PA",                         "HP",   pct)}
          </tbody>
        </table>
      </div>
    `;
}

// Outcome breakdown — the existing bar-chart view of how a hitter's
// PAs distribute across the 9 outcome buckets, kept smaller and below
// the slash/matchup hierarchy. Useful for understanding the matchup
// engine's logic ("Judge has 8% HR rate vs RHP overall") without
// scrolling somewhere else.
function renderOutcomeBreakdown(career, oppTag = "P") {
    const oppL = `LH${oppTag}`;
    const oppR = `RH${oppTag}`;
    const rTable = oppTag === "P" ? career.vs_RHP : career.vs_RHB;
    const lTable = oppTag === "P" ? career.vs_LHP : career.vs_LHB;
    return `
      <div class="outcome-breakdown">
        <div class="ob-head">Outcome breakdown (career)</div>
        <div class="ob-grid">
          ${renderCareerSplit(`vs ${oppR}`, rTable)}
          ${renderCareerSplit(`vs ${oppL}`, lTable)}
        </div>
      </div>
    `;
}

function renderCareerSplit(label, table) {
    if (!table || table.pa === 0) {
        return `<div class="career-split career-split-empty">
                  <header class="cs-head">
                    <span class="cs-label">${label}</span>
                    <span class="cs-pa">no data</span>
                  </header>
                </div>`;
    }
    const entries = Object.entries(table.rates).sort((a, b) => b[1] - a[1]);
    const top = entries[0]?.[1] || 1;
    return `
      <div class="career-split">
        <header class="cs-head">
          <span class="cs-label">${label}</span>
          <span class="cs-pa">${table.pa.toLocaleString()} PA</span>
        </header>
        ${entries.map(([o, p]) => {
            const pctVal = Math.round(p * 100);
            const width = Math.max(2, Math.round((p / top) * 100));
            const n = table.counts[o] || 0;
            return `
              <div class="cs-row">
                <span class="cs-outcome">${OUTCOME_LABEL[o] || o}</span>
                <span class="cs-bar"><span style="width:${width}%"></span></span>
                <span class="cs-pct">${pctVal}%</span>
                <span class="cs-n">(${n})</span>
              </div>
            `;
        }).join("")}
      </div>
    `;
}

function renderNoDataState(d) {
    return `
      <div class="player-empty">
        <p>No data for this player in our ${d.historical_years.start}–${d.historical_years.end}
           historical window, and they haven't appeared in this season's
           daily ingest yet.</p>
        <p>If they're a recent callup, they'll show up in the matchup
           engine once they've taken some PAs.</p>
      </div>
    `;
}

// ── stat-line derivations ──────────────────────────────────────────

// Compute a full slash line + rate-stat block from the 9 outcome
// counts. The counts object may include extra keys (`pa`, `latest_date`)
// — we filter to just the outcome keys so the PA sum is honest.
function slashLine(counts) {
    const c = (k) => counts[k] || 0;
    const BB  = c("BB"),  HBP = c("HBP"), K = c("K");
    const _1B = c("1B"),  _2B = c("2B"),  _3B = c("3B"), HR = c("HR");
    const OUT = c("OUT"), OTHER = c("OTHER");
    const H   = _1B + _2B + _3B + HR;
    const PA  = OUTCOMES_ARRAY.reduce((s, k) => s + c(k), 0);
    // AB = PA - BB - HBP - sacrifices. We don't track SAC separately
    // (it's folded into OUT for sac flies/bunts, OTHER for catcher
    // interference). Ignoring it slightly inflates AB / understates
    // AVG — real impact: <1% drift on a regular's season.
    const AB  = Math.max(0, PA - BB - HBP);
    const TB  = _1B + 2 * _2B + 3 * _3B + 4 * HR;
    const AVG = AB > 0 ? H / AB : 0;
    const OBP = PA > 0 ? (H + BB + HBP) / PA : 0;
    const SLG = AB > 0 ? TB / AB : 0;
    const OPS = OBP + SLG;
    const ISO = SLG - AVG;
    const babipDenom = AB - K - HR;
    return {
        AVG: fmtAvg(AVG), OBP: fmtAvg(OBP),
        SLG: fmtAvg(SLG), OPS: fmtAvg(OPS),
        ISO: fmtAvg(ISO),
        BABIP: babipDenom > 0 ? fmtAvg((H - HR) / babipDenom) : ".000",
        PA, AB, H, HR, BB, K,
        KP:  PA > 0 ? K   / PA : 0,
        BBP: PA > 0 ? BB  / PA : 0,
        HRP: PA > 0 ? HR  / PA : 0,
        HP:  PA > 0 ? H   / PA : 0,
    };
}

// Sum two outcome-count dicts (e.g. vs_RHP + vs_LHP → all-hands
// career). Missing keys treated as 0.
function combineSplits(a, b) {
    const out = {};
    for (const k of OUTCOMES_ARRAY) out[k] = (a?.[k] || 0) + (b?.[k] || 0);
    return out;
}

// Baseball-convention number formatting: 3-decimal, leading zero
// stripped (`.305`, not `0.305`). >= 1.000 keeps the leading digit.
function fmtAvg(x) {
    if (!Number.isFinite(x) || x < 0) return ".000";
    if (x >= 1) return x.toFixed(3);
    return x.toFixed(3).slice(1);
}
function pct(x) {
    if (!Number.isFinite(x) || x < 0) return "0.0%";
    return `${(x * 100).toFixed(1)}%`;
}
function identity(x) { return x; }

// ── HOT MOMENTS VIEW ────────────────────────────────────────────────
//
// "What should I be watching RIGHT NOW?" — auto-surfaces the highest-
// leverage live moments across the slate. Uses the existing leverage()
// score (closeness × inning weight × runners-on). Refreshes every 15s.
//
// Empty when no games are live; an honest "come back at first pitch"
// state rather than fake data.

function showHot() {
    activeGameId = null;
    clearAllTimers();
    hideAllViews();
    hotView.hidden = false;
    renderEmpty(hotView, "Loading hot moments…", "");
    refreshHot();
    hotTimer = setInterval(refreshHot, HOT_REFRESH_MS);
}

async function refreshHot() {
    try {
        const res = await fetch("/api/games/today");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        scheduleCache = data;

        const live = (data.games || []).filter(
            (g) => g.status === "Live" && g.inning
        );
        if (live.length === 0) {
            // Look ahead to the next pregame game for a softer empty state.
            const upcoming = (data.games || [])
                .filter((g) => g.status === "Preview" && g.start_time)
                .sort((a, b) => (new Date(a.start_time)) - (new Date(b.start_time)))[0];
            const sub = upcoming
                ? `Next first pitch: ${shortName(upcoming.away)} at ${shortName(upcoming.home)} · ${startTimeET(upcoming.start_time)} ET.`
                : "Check back when first pitch is in.";
            renderEmpty(hotView, "No live games right now.", sub);
            return;
        }

        const ranked = live
            .map((g) => ({ g, lev: leverage(g) }))
            .sort((a, b) => b.lev - a.lev)
            .slice(0, 6);

        hotView.innerHTML = renderHot(ranked);
    } catch (e) {
        renderEmpty(hotView, "Couldn't load.", `${e.message || e}`);
    }
}

function renderHot(ranked) {
    return `
      <header class="hot-head">
        <h2><span class="hot-flame">🔥</span> HOT MOMENTS</h2>
        <span class="hot-meta">
          ${ranked.length} live game${ranked.length === 1 ? "" : "s"}
          · sorted by leverage (closeness × late innings × runners on)
        </span>
      </header>
      <div class="hot-grid">
        ${ranked.map(({ g, lev }, i) => renderHotCard(g, lev, i)).join("")}
      </div>
    `;
}

function renderHotCard(g, lev, rank) {
    const reason = hotReason(g);
    const we = g.win_expectancy;
    const homePct = we != null ? Math.round(we * 100) : 50;
    const awayPct = 100 - homePct;
    const leverageBar = Math.round(Math.min(1, lev) * 100);
    return `
      <a class="hot-card" href="#game/${g.game_pk}">
        <header class="hot-card-head">
          <span class="hot-rank">#${rank + 1}</span>
          <span class="hot-reason">${reason}</span>
          <span class="hot-lev">leverage ${Math.round(lev * 100)}</span>
        </header>
        <div class="hot-matchup">
          <div class="hot-team">
            <span class="hot-team-name">${g.away}</span>
            <span class="hot-team-score">${g.away_score}</span>
          </div>
          <div class="hot-team">
            <span class="hot-team-name">${g.home}</span>
            <span class="hot-team-score">${g.home_score}</span>
          </div>
        </div>
        <div class="hot-state">${stateLabel(g)}</div>
        ${we != null ? `
          <div class="hot-we">
            <div class="hot-we-bar">
              <span style="width:${homePct}%"></span>
            </div>
            <div class="hot-we-labels">
              <span>${g.away} ${awayPct}%</span>
              <span>${g.home} ${homePct}%</span>
            </div>
          </div>
        ` : ""}
        <div class="hot-meter" title="Leverage: ${lev.toFixed(2)}">
          <span style="width:${leverageBar}%"></span>
        </div>
        <div class="hot-cta">Open game view →</div>
      </a>
    `;
}

// Plain-English reason a moment is hot. The leverage function gives us
// the magnitude; this gives us the why.
function hotReason(g) {
    const diff = Math.abs((g.home_score ?? 0) - (g.away_score ?? 0));
    const bases = g.bases || 0;
    const basesDesc = basesShort(bases);
    const inn = ordinalSuffix(g.inning).toLowerCase();
    const late = g.inning >= 7;
    const ninth = g.inning >= 9;

    if (diff === 0 && ninth) {
        return basesDesc ? `Tied in extras / 9th — ${basesDesc}` : "Tied in extras / 9th";
    }
    if (diff === 0 && late) {
        return basesDesc ? `Tied, ${inn} — ${basesDesc}` : `Tied in the ${inn}`;
    }
    if (diff <= 1 && late) {
        return basesDesc ? `1-run game, ${inn} — ${basesDesc}` : `1-run game, ${inn}`;
    }
    if (bases === 7) {
        return `Bases loaded, ${inn}`;
    }
    if (bases & 4) {
        return basesDesc ? `Scoring threat — ${basesDesc}, ${inn}` : `Scoring threat, ${inn}`;
    }
    if (diff <= 2 && late) {
        return `${diff}-run game in the ${inn}`;
    }
    if (basesDesc) return `${basesDesc}, ${inn}`;
    return `${diff === 0 ? "Tied" : `${diff}-run game`} in the ${inn}`;
}

function renderAbout() {
    return `
      <article class="about-doc">
        <header class="about-head">
          <h1>How DIAMOND<span class="colon">:</span>CONTEXT works</h1>
          <p class="about-tagline">
            A live baseball companion. Every game on now, every number
            backed by data, every prediction explained.
          </p>
        </header>

        <section>
          <h2>The Win Expectancy bar</h2>
          <p>
            When you're inside a game and the right-side card says
            <strong>"MIA 53%"</strong>, that means: across the equivalent
            inning-half + score-difference state in 115 seasons of
            history, the home team has won 53% of the time.
          </p>
          <p>
            It updates every half-inning as the score and inning change.
            A coin flip in the 4th is very different from a coin flip in
            the 9th — both might read 50%, but the leverage is wildly
            different.
          </p>
          <p class="about-source">
            <strong>Data:</strong> Retrosheet game logs, 1910–2024
            (115 seasons). All in-house aggregation.
          </p>
        </section>

        <section>
          <h2>The matchup prediction</h2>
          <p>
            When a live game is up and a real plate appearance is happening,
            the card asks <strong>"What's about to happen?"</strong> and
            shows a 9-bucket probability distribution: strikeout, walk,
            single, double, triple, home run, in-play out, HBP, error.
          </p>
          <p>
            The math is the <strong>odds-ratio method</strong> (also called
            log-5 in older sabermetrics writing). For each outcome:
          </p>
          <pre class="about-formula">predicted ≈ (batter × pitcher) / league</pre>
          <p>
            Three inputs per outcome:
          </p>
          <ul>
            <li><strong>Batter's rate</strong> for that outcome, against
                pitchers of the opposing throwing hand.</li>
            <li><strong>Pitcher's rate</strong> for that outcome, against
                batters of the opposing hitting side.</li>
            <li><strong>League baseline</strong> for the same handedness
                matchup (R-vs-R, R-vs-L, etc.).</li>
          </ul>
          <p>
            Click any row in the matchup card to see all three numbers
            and the combined prediction, with a one-line narrative
            saying which side is doing the pulling.
          </p>
          <p>
            We regress each component toward the league baseline by a
            fixed 100 plate appearances — this stops a player's tiny
            sample (early in a career, or in our case early in the
            season) from producing wildly overconfident predictions.
          </p>
          <p class="about-source">
            <strong>Data:</strong> Retrosheet play-by-play, 2020–2024
            modern era. We restricted the loaded historical window to
            five seasons to fit Supabase's free tier; the engine itself
            can process the full Retrosheet archive back to 1910.
          </p>
        </section>

        <section>
          <h2>The daily ingest — how the model "learns"</h2>
          <p>
            Every morning at ~7 AM ET, a GitHub Actions cron pulls
            yesterday's completed games from the MLB Stats API, parses
            every plate appearance, and writes them into a Supabase
            event log called <code>daily_pa</code>.
          </p>
          <p>
            The matchup engine reads <em>both</em> the historical
            (2020–2024) rates table <em>and</em> the growing event log,
            and adds the live PA counts on top of the historical
            baseline. So predictions get sharper as the season's sample
            grows — that's what the green
            <span class="dot-inline"></span>
            <strong>"Plus N fresh plate appearances…"</strong> pill
            below each matchup card is showing you.
          </p>
          <p>
            The model formula itself doesn't change. What changes is the
            data behind it. That's the honest version of "self-learning"
            for our setup — no neural net, no online gradient descent,
            just always-fresh data feeding the same well-understood
            statistical method.
          </p>
          <p class="about-source">
            <strong>Data:</strong> MLB Stats API live feed, ingested daily.
          </p>
        </section>

        <section>
          <h2>The other pages</h2>
          <ul>
            <li><strong>STANDINGS</strong> — current division standings
                with W-L, PCT, games back, streak, last-10, run differential.
                Sourced live from the MLB Stats API standings endpoint.</li>
            <li><strong>LEADERS</strong> — top-5 boards across hitting
                (HR, AVG, RBI, OPS, SB, R) and pitching (W, ERA, K, SV, WHIP).
                Live from MLB Stats API.</li>
            <li><strong>MVP</strong> — top-5 AL and NL candidates for MVP
                (by OPS) and Cy Young (by ERA). MLB doesn't publish an
                "MVP rank" stat, so we use these as the canonical batter
                and pitcher signals.</li>
          </ul>
        </section>

        <section>
          <h2>A short glossary</h2>
          <dl class="about-glossary">
            <dt>PA</dt><dd>plate appearance — any time a batter steps in,
                including walks and HBP (not just at-bats).</dd>
            <dt>BF</dt><dd>batters faced — same as PA, from the pitcher's side.</dd>
            <dt>BA / AVG</dt><dd>batting average — hits ÷ at-bats.</dd>
            <dt>OBP</dt><dd>on-base percentage — times reached ÷ PA.</dd>
            <dt>SLG</dt><dd>slugging — total bases ÷ at-bats.</dd>
            <dt>OPS</dt><dd>OBP + SLG. Most-used quick measure of hitting.</dd>
            <dt>ERA</dt><dd>earned run average — earned runs allowed per 9 innings.</dd>
            <dt>WHIP</dt><dd>walks + hits per inning pitched.</dd>
            <dt>WE</dt><dd>win expectancy — the home team's probability of winning from the current state.</dd>
            <dt>RHP / LHP</dt><dd>right-handed / left-handed pitcher.</dd>
            <dt>RHB / LHB</dt><dd>right-handed / left-handed batter.</dd>
          </dl>
        </section>

        <section>
          <h2>What's not in the model yet</h2>
          <ul>
            <li>Pitch-level data — we work at the plate-appearance level,
                not pitch-by-pitch.</li>
            <li>Statcast metrics (exit velocity, launch angle, expected stats).</li>
            <li>Park factors, weather, rest days, lineup protection,
                bullpen fatigue.</li>
            <li>Defensive runs saved.</li>
          </ul>
          <p>
            These are on the roadmap. See
            <a href="https://github.com/hroessner22/Baseball-stats/blob/main/docs/04-ROADMAP.md"
               target="_blank" rel="noopener">docs/04-ROADMAP.md</a> in the repo.
          </p>
        </section>

        <footer class="about-foot">
          <p>
            Source code, methodology docs, and the issue tracker live at
            <a href="https://github.com/hroessner22/Baseball-stats" target="_blank" rel="noopener">
              github.com/hroessner22/Baseball-stats</a>.
          </p>
          <p class="about-attribution">
            The historical play-by-play data here was obtained free of
            charge from and is copyrighted by
            <a href="https://www.retrosheet.org" target="_blank" rel="noopener">Retrosheet</a>.
            Interested parties may contact Retrosheet at 20 Sunset Rd.,
            Newark, DE 19711.
          </p>
        </footer>
      </article>
    `;
}

async function refreshMVP() {
    try {
        // Fetch the existing OPS/ERA-based MVP races AND the new WPA
        // leaderboards in parallel — the WPA one is the leverage-
        // weighted contribution the old footer note promised. Both
        // arrive together so the page renders in one shot.
        const [mvpRes, batterWpaRes, pitcherWpaRes] = await Promise.all([
            fetch("/api/mvp"),
            fetch("/api/leaders/wpa?role=batter&limit=10"),
            fetch("/api/leaders/wpa?role=pitcher&limit=10"),
        ]);
        if (!mvpRes.ok) throw new Error(`HTTP ${mvpRes.status}`);
        const data = await mvpRes.json();
        const batterWpa  = batterWpaRes.ok  ? await batterWpaRes.json()  : null;
        const pitcherWpa = pitcherWpaRes.ok ? await pitcherWpaRes.json() : null;
        if (!data.races || data.races.length === 0) {
            renderEmpty(mvpView, "MVP race not available.", "Check back later.");
            return;
        }
        mvpView.innerHTML = renderMVP(data, batterWpa, pitcherWpa);
    } catch (e) {
        renderEmpty(mvpView, "Could not load MVP race.", `${e.message || e}`);
    }
}

function renderMVP(data, batterWpa, pitcherWpa) {
    return `
      <header class="mvp-head">
        <h2>MVP RACE</h2>
        <span class="mvp-meta">${data.season} season</span>
      </header>
      ${renderWpaBand(batterWpa, pitcherWpa, data.season)}
      <div class="mvp-section-head">League leaders by traditional stats</div>
      <div class="mvp-grid">
        ${data.races.map(renderRaceCard).join("")}
      </div>
      <footer class="mvp-foot">
        WPA = the sum of how much each player's PAs moved the win
        probability — leverage-weighted contribution.
        OPS &amp; ERA are headline stats; WPA is what actually swung games.
      </footer>
    `;
}

// The WPA band — sits ABOVE the traditional OPS/ERA grid as the
// editorial position of this app. "Stats are stats; this is who's
// actually moved win probability." Two cards side by side: hitter
// WPA leaders and pitcher WPA leaders.
function renderWpaBand(batter, pitcher, season) {
    const card = (title, blurb, data) => {
        if (!data || !data.leaders || data.leaders.length === 0) {
            return `
              <article class="wpa-card wpa-empty">
                <header class="wpa-head">
                  <span class="wpa-title">${title}</span>
                  <span class="wpa-blurb">${blurb}</span>
                </header>
                <div class="wpa-empty-msg">
                  WPA leaderboard not built yet for ${season} — first run lands tomorrow morning.
                </div>
              </article>`;
        }
        const rows = data.leaders.map((l) => {
            const wpaStr = (l.wpa >= 0 ? "+" : "") + l.wpa.toFixed(2);
            const cls = l.wpa >= 0 ? "wpa-pos" : "wpa-neg";
            const photo = l.player_mlbam
                ? `<img class="wpa-photo" src="${playerHeadshotSpot(l.player_mlbam, 72)}" alt="" loading="lazy" onerror="this.style.opacity='0';"/>`
                : `<span class="wpa-photo wpa-photo-empty" aria-hidden="true"></span>`;
            return `
              <li class="wpa-row">
                <span class="wpa-rank">${l.rank}</span>
                ${photo}
                <a class="wpa-name player-link" href="#player/${l.player_mlbam}">${shortName(l.name)}</a>
                <span class="wpa-pa">${l.pa_count} PA</span>
                <span class="wpa-val ${cls}">${wpaStr}</span>
              </li>`;
        }).join("");
        return `
          <article class="wpa-card">
            <header class="wpa-head">
              <span class="wpa-title">${title}</span>
              <span class="wpa-blurb">${blurb}</span>
            </header>
            <ol class="wpa-list">${rows}</ol>
          </article>`;
    };
    return `
      <div class="wpa-band">
        <div class="wpa-band-head">
          <span class="wpa-band-title">Who's actually moved win probability</span>
          <span class="wpa-band-meta">Win Probability Added · ${season} · qualifier 50+ PA/BF</span>
        </div>
        <div class="wpa-grid">
          ${card("HITTERS", "Most positive WP swings on their PAs this season",          batter)}
          ${card("PITCHERS", "Most opposing-WP suppressed across their batters faced",   pitcher)}
        </div>
      </div>
    `;
}

function renderRaceCard(race) {
    return `
      <article class="race-card" data-group="${race.group}">
        <header class="race-head">
          <span class="race-title">${race.title}</span>
        </header>
        ${race.candidates.length === 0
            ? `<div class="race-empty">no qualified players yet</div>`
            : `<ol class="race-list">${race.candidates.map(renderCandidate).join("")}</ol>`}
      </article>
    `;
}

function renderCandidate(c) {
    const team = c.team ? `<span class="cand-team">${c.team}</span>` : "";
    const statCells = c.stats.map((s, i) => `
      <div class="cand-stat ${i === 0 ? "primary" : ""}">
        <span class="cand-stat-value">${s.value}</span>
        <span class="cand-stat-label">${s.label}</span>
      </div>
    `).join("");
    const photo = inlineAvatar(c.person_id, { size: 40, class: "cand-photo", alt: c.name });
    const nameNode = c.person_id
        ? `<a class="cand-name player-link" href="#player/${c.person_id}">${shortName(c.name)}</a>`
        : `<span class="cand-name">${shortName(c.name)}</span>`;
    return `
      <li class="cand-row" data-rank="${c.rank}">
        <div class="cand-id">
          <span class="cand-rank">${c.rank}</span>
          ${photo}
          ${nameNode}
          ${team}
        </div>
        <div class="cand-stats">${statCells}</div>
      </li>
    `;
}

async function refreshGame(id) {
    if (id !== activeGameId) return;
    try {
        // Game detail + the day's schedule (for the ticker), in parallel.
        // Both endpoints are edge-cached, so the schedule refetch is cheap.
        const [gameRes, schedRes] = await Promise.all([
            fetch(`/api/game/${id}`),
            fetch(`/api/games/today`),
        ]);
        if (!gameRes.ok) throw new Error(`HTTP ${gameRes.status}`);
        const g = await gameRes.json();
        if (schedRes.ok) scheduleCache = await schedRes.json();
        if (id !== activeGameId) return;

        // Keep the cached matchup card across renders and across PA
        // changes — clearing on pair change left a visible gap while the
        // new fetch was in flight. Let hydrateMatchup overwrite when
        // fresh data lands. Briefly showing the previous PA's names is
        // less disruptive than showing nothing.
        gameView.innerHTML = renderGame(g);
        if (g.status === "Live" && g.batter?.id && g.pitcher?.id) {
            // Pass the live count so the matchup engine returns
            // count-aware rates (e.g. Judge on 3-0 vs Judge on 0-2 look
            // completely different to the model). Frontend re-fetches
            // whenever (batter, pitcher, balls, strikes) changes.
            hydrateMatchup(g.batter.id, g.pitcher.id, id, g.balls, g.strikes);
        }
        if (gameViewMode === "gamecast") {
            refreshGamecast(id);
        }
        if (gameViewMode === "boxscore") {
            hydrateBoxscore(id, g.status);
        }
        if (gameViewMode === "markets") {
            hydrateMarkets(id);
            // Reasserts the timer in case it was cleared by a game
            // switch — startMarketsPoll clears any prior timer first.
            startMarketsPoll(id);
        } else {
            stopMarketsPoll();
            // Even when not on the Markets tab, fill the consensus pill
            // on the Live View card so users see market vs us at a glance.
            // Game-switch invalidates the cache. Edge cache means most
            // refreshes are essentially free.
            if (gameViewMode === "live"
                && (cachedMarketConsensusPk !== id || g.status === "Live")) {
                hydrateMarketConsensusPill(id);
            }
        }
        if (g.status === "Final") {
            hydrateRecap(id);
        }
        // Trace runs for both live and final — live games keep adding
        // points as half-innings complete; final games have the full curve.
        if (g.status === "Live" || g.status === "Final") {
            hydrateTrace(id, g.status);
        }
        // Projected (matchup-blended) WE only makes sense mid-PA.
        // Pass the game object so the renderer can use team abbreviations
        // in labels (HOME → BAL, AWAY → TB) instead of generic "home WP".
        if (g.status === "Live" && g.batter?.id && g.pitcher?.id) {
            hydrateProjectedWE(id, g);
            // Bullpen-aware forward forecast — depends on lineup +
            // pitcher sequence, so refreshes per game poll.
            hydrateForecastWE(id, g);
        }
    } catch (e) {
        renderEmpty(gameView, "Could not load this game.", `${e.message || e}`);
    }
}

// Three presentations of the same game: Live View (field + WE card +
// matchup), Gamecast (play-by-play with pitch data + predicted vs
// actual), Box Score (line score + batting/pitching tables — the
// textbook page from any newspaper). Module-level state so the toggle
// survives the every-5s re-render.
let gameViewMode = "live"; // "live" | "gamecast" | "boxscore" | "markets"
let cachedGamecastHTML = "";
let cachedBoxscoreHTML = "";
let cachedBoxscorePk = null;
let cachedBoxscoreStatus = null;
// Raw JSON kept around so the team toggle can re-render a slice of
// the existing data without re-hitting the API on every flip.
let cachedBoxscoreData = null;
// Markets pane: rapid-update poll (20s) handles its own loop independent
// of the game's 5s tick, so the timer doesn't leak across game switches.
let cachedMarketsHTML = "";
let cachedMarketsPk = null;
let marketsPollTimer = null;
// Per-game consensus pill: shown on the Live View card next to our WE
// so the user can see the market vs. us at a glance even without
// switching to the Markets tab. Updated every game-refresh tick (5s,
// but the upstream is edge-cached at 20s so most refreshes are cheap).
let cachedMarketConsensusSlot = "";
let cachedMarketConsensusPk = null;

function renderGame(g) {
    const mode = gameViewMode;
    return `
      <a class="back-link" href="#">← BOARD</a>
      ${renderTicker(g.game_pk, scheduleCache?.games || [])}
      <div class="game-mode-toggle">
        <button class="${mode === 'live'     ? 'active' : ''}" data-mode="live">Live View</button>
        <button class="${mode === 'gamecast' ? 'active' : ''}" data-mode="gamecast">Gamecast</button>
        <button class="${mode === 'boxscore' ? 'active' : ''}" data-mode="boxscore">Box Score</button>
        <button class="${mode === 'markets'  ? 'active' : ''}" data-mode="markets">Markets</button>
      </div>
      ${mode === 'gamecast'
        ? `<div id="gamecast-pane" class="gamecast-pane">${cachedGamecastHTML || gamecastLoadingShell()}</div>`
        : mode === 'boxscore'
        ? `<div id="boxscore-pane" class="boxscore-pane">${cachedBoxscoreHTML || boxscoreLoadingShell()}</div>`
        : mode === 'markets'
        ? `<div id="markets-pane" class="markets-pane">${cachedMarketsHTML || marketsLoadingShell()}</div>`
        : `<div class="game-pane">
             ${fieldPane(g)}
             ${cardPane(g)}
           </div>`}
    `;
}

function gamecastLoadingShell() {
    return `<div class="gamecast-loading">Loading play-by-play…</div>`;
}
function boxscoreLoadingShell() {
    return `<div class="boxscore-loading">Loading box score…</div>`;
}
function marketsLoadingShell() {
    return `<div class="markets-loading">Pulling live lines from Polymarket, Kalshi, Manifold…</div>`;
}

// Event delegation — innerHTML rerenders kill direct handlers, so wire
// the toggle once at module load and let it fire whenever a button with
// data-mode is clicked.
document.addEventListener("click", (e) => {
    const btn = e.target.closest(".game-mode-toggle button[data-mode]");
    if (!btn) return;
    e.preventDefault();
    const mode = btn.dataset.mode;
    if (mode === gameViewMode) return;
    gameViewMode = mode;
    if (activeGameId) refreshGame(activeGameId);
});

// ── GAMECAST ────────────────────────────────────────────────────────

async function refreshGamecast(gameId) {
    if (gameViewMode !== "gamecast") return;
    try {
        const res = await fetch(`/api/game/${gameId}/plays`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (gameId !== activeGameId) return;

        // Show the most recent dozen PAs. Older history is reachable by
        // scrolling but we don't pre-fetch predictions for all of them —
        // would mean hundreds of /api/matchup hits per game refresh.
        const recent = (data.plays || []).slice(0, 12);

        // Predictions per unique pair, fetched in parallel. Cloudflare's
        // edge cache collapses duplicates from the rest of the page.
        const pairs = [...new Set(recent.map((p) => `${p.batter.id}-${p.pitcher.id}`))];
        const predictionMap = {};
        await Promise.all(pairs.map(async (key) => {
            const [b, p] = key.split("-");
            try {
                const r = await fetch(`/api/matchup?batter=${b}&pitcher=${p}`);
                if (r.ok) predictionMap[key] = await r.json();
            } catch { /* fall through; render shows "no data" for this pair */ }
        }));
        if (gameId !== activeGameId) return;

        const html = renderGamecast(recent, predictionMap);
        cachedGamecastHTML = html;
        const pane = document.getElementById("gamecast-pane");
        if (pane) pane.innerHTML = html;
    } catch (e) {
        const pane = document.getElementById("gamecast-pane");
        if (pane && !cachedGamecastHTML) {
            pane.innerHTML = `<div class="empty">Couldn't load play-by-play: ${e.message || e}</div>`;
        }
        // If we already had a cached gamecast, keep showing it — silent fail.
    }
}

function renderGamecast(plays, predictionMap) {
    if (!plays.length) {
        return `<div class="empty">No plays yet — first pitch is on its way.</div>`;
    }
    return `
      <div class="gamecast-list">
        ${plays.map((p) => renderPABlock(p, predictionMap[`${p.batter.id}-${p.pitcher.id}`])).join("")}
      </div>
    `;
}

function renderPABlock(play, prediction) {
    const inn = `${play.half === "top" ? "▲" : "▼"} ${ordinalSuffix(play.inning)}`;
    const score = play.score_after
        ? `${play.score_after.away}-${play.score_after.home}`
        : "";
    const outcomeBadge = renderPAOutcomeBadge(play, prediction);

    const predictedBlock = prediction?.available
        ? renderPredictedDistribution(prediction.predicted, play.outcome)
        : `<div class="pa-no-data">No historical matchup data for this pairing.</div>`;

    const pitchesBlock = play.pitches.length
        ? play.pitches.map((p, i) => renderPitchRow(p, i)).join("")
        : `<div class="pa-no-data">No pitch data for this PA yet.</div>`;

    return `
      <article class="pa-block" data-outcome="${play.outcome || 'other'}">
        <header class="pa-head">
          <span class="pa-inning">${inn}</span>
          <span class="pa-matchup">
            <a class="pa-avatar-link" href="#player/${play.batter.id}" aria-label="${escapeHTMLAttr(play.batter.name)}">${inlineAvatar(play.batter.id, { size: 48, class: "pa-avatar", alt: play.batter.name })}</a>
            <a class="player-link" href="#player/${play.batter.id}"><strong>${shortName(play.batter.name)}</strong></a>
            <span class="dim">(${play.batter.hand}HB)</span>
            <span class="dim"> vs </span>
            <a class="pa-avatar-link" href="#player/${play.pitcher.id}" aria-label="${escapeHTMLAttr(play.pitcher.name)}">${inlineAvatar(play.pitcher.id, { size: 48, class: "pa-avatar", alt: play.pitcher.name })}</a>
            <a class="player-link" href="#player/${play.pitcher.id}"><strong>${shortName(play.pitcher.name)}</strong></a>
            <span class="dim">(${play.pitcher.hand}HP)</span>
          </span>
          ${score ? `<span class="pa-score">${score}</span>` : ""}
          ${outcomeBadge}
        </header>
        <div class="pa-body">
          <section class="pa-prediction">
            <div class="pa-section-head">Predicted before PA · top 5</div>
            ${predictedBlock}
          </section>
          <section class="pa-pitches">
            <div class="pa-section-head">Pitches (${play.pitches.length})</div>
            ${pitchesBlock}
          </section>
        </div>
      </article>
    `;
}

function renderPredictedDistribution(predicted, actualOutcome) {
    const entries = Object.entries(predicted).sort((a, b) => b[1] - a[1]);
    const top = entries[0]?.[1] || 1;
    return entries.slice(0, 5).map(([o, p]) => {
        const pct = Math.round(p * 100);
        const width = Math.max(2, Math.round((p / top) * 100));
        const isActual = o === actualOutcome;
        return `
          <div class="pa-pred-row ${isActual ? 'actual' : ''}">
            <span class="pa-pred-label">${OUTCOME_LABEL[o] || o}</span>
            <span class="pa-pred-bar"><span style="width:${width}%"></span></span>
            <span class="pa-pred-pct">${pct}%</span>
            <span class="pa-pred-check">${isActual ? '✓' : ''}</span>
          </div>
        `;
    }).join("");
}

function renderPitchRow(pitch, idx) {
    const velo = pitch.velo != null ? `${pitch.velo}` : "—";
    const count = pitch.count_after
        ? `${pitch.count_after.balls}-${pitch.count_after.strikes}`
        : "";
    const cls =
        pitch.result_code === "B" ? "ball" :
        (pitch.result_code === "C" || pitch.result_code === "S") ? "strike" :
        (pitch.result_code === "F" || pitch.result_code === "T") ? "foul" :
        (pitch.result_code === "X" || pitch.result_code === "E") ? "in-play" :
        "";
    return `
      <div class="pa-pitch-row ${cls}">
        <span class="pa-pitch-num">${idx + 1}</span>
        <span class="pa-pitch-type">${shortenPitchType(pitch.type)}</span>
        <span class="pa-pitch-velo">${velo}<span class="dim">mph</span></span>
        <span class="pa-pitch-result">${pitch.result}</span>
        <span class="pa-pitch-count">${count}</span>
      </div>
    `;
}

function renderPAOutcomeBadge(play, prediction) {
    const evt = play.outcome_event || play.outcome || "?";
    if (!prediction?.available || !play.outcome) {
        return `<span class="pa-outcome-badge">${evt}</span>`;
    }
    const entries = Object.entries(prediction.predicted).sort((a, b) => b[1] - a[1]);
    const rank = entries.findIndex(([o]) => o === play.outcome) + 1;
    const rankSuffix = rank > 0 ? ` · model ranked #${rank}` : "";
    return `<span class="pa-outcome-badge" data-outcome="${play.outcome}">${evt}${rankSuffix}</span>`;
}

// "Four-Seam Fastball" → "4-seam", "Knuckle Curve" → "Knuckle CB", etc.
// The full names eat tile width on the pitch row.
function shortenPitchType(name) {
    if (!name) return "?";
    const lower = name.toLowerCase();
    if (lower.includes("four-seam"))   return "4-seam";
    if (lower.includes("two-seam"))    return "2-seam";
    if (lower.includes("sinker"))      return "Sinker";
    if (lower.includes("cutter"))      return "Cutter";
    if (lower.includes("slider"))      return "Slider";
    if (lower.includes("sweeper"))     return "Sweeper";
    if (lower.includes("curveball"))   return "Curve";
    if (lower.includes("knuckle"))     return "Knuckle CB";
    if (lower.includes("changeup"))    return "Changeup";
    if (lower.includes("splitter"))    return "Splitter";
    if (lower.includes("knuckleball")) return "Knuckler";
    if (lower.includes("eephus"))      return "Eephus";
    return name;
}

// Thin horizontal strip at the top of the Game view showing every other game
// on the slate. Click to swap. Scrolls horizontally if the slate doesn't fit
// the viewport width. The active game is highlighted but still rendered so
// the eye keeps its place when you scan.
function renderTicker(activePk, games) {
    if (!games || games.length === 0) return "";
    const sorted = sortGames(games);
    return `
      <nav class="ticker" aria-label="other games">
        ${sorted.map((g) => renderTickerGame(g, g.game_pk === Number(activePk))).join("")}
      </nav>
    `;
}

function renderTickerGame(g, isActive) {
    const cls = isActive ? "ticker-game active" : "ticker-game";
    const fmtScore = (s) => g.status === "Preview" ? "—" : s;
    return `
      <a class="${cls}" href="#game/${g.game_pk}" data-status="${g.status}">
        <div class="t-teams">
          <div class="t-row"><span class="t-abbr">${g.away}</span><span class="t-score">${fmtScore(g.away_score)}</span></div>
          <div class="t-row"><span class="t-abbr">${g.home}</span><span class="t-score">${fmtScore(g.home_score)}</span></div>
        </div>
        <div class="t-state">${tickerState(g)}</div>
      </a>
    `;
}

function tickerState(g) {
    if (g.status === "Preview" && g.start_time) {
        return startTimeET(g.start_time);
    }
    if (g.status === "Final") return "F";
    if (g.status === "Live" && g.inning) {
        return `${arrowHalf(g.half)}${g.inning}`;
    }
    return (g.detail || g.status).slice(0, 6).toUpperCase();
}

function fieldPane(g) {
    const we = g.win_expectancy;
    const intensity = we == null ? 0 : Math.abs(we - 0.5) * 2;
    const occ = (slot) => g.runners?.[slot] ? "true" : "false";
    const runnerLabel = (slot, x, y, anchor) =>
        g.runners?.[slot]
            ? `<text class="runner-name" x="${x}" y="${y}" text-anchor="${anchor}">${shortName(g.runners[slot])}</text>`
            : "";

    return `
      <div class="field-pane" style="--we-intensity:${intensity}">
        <svg class="field" viewBox="0 0 500 500" preserveAspectRatio="xMidYMid meet">
          <defs>
            <radialGradient id="grass-radial" cx="0.5" cy="0.92" r="0.85">
              <stop offset="0%"   stop-color="#4A7A35"/>
              <stop offset="60%"  stop-color="#3F6B2A"/>
              <stop offset="100%" stop-color="#355A23"/>
            </radialGradient>
          </defs>

          <!-- Fair territory grass — fan shape, deeper in center -->
          <path class="outfield-grass"
                d="M 250,460 L 440,270 Q 250,40 60,270 Z"/>

          <!-- Warning track (the dirt ring inside the outfield wall) -->
          <path class="warning-track"
                d="M 440,270 L 425,283 Q 250,80 75,283 L 60,270 Q 250,40 440,270 Z"/>

          <!-- Foul lines (chalk) -->
          <line class="foul-line" x1="250" y1="460" x2="440" y2="270"/>
          <line class="foul-line" x1="250" y1="460" x2="60"  y2="270"/>

          <!-- Foul poles -->
          <rect class="foul-pole" x="437" y="263" width="5" height="14"/>
          <rect class="foul-pole" x="58"  y="263" width="5" height="14"/>

          <!-- Basepaths (dirt diamond outline) -->
          <path class="basepath" d="M 250,455 L 388,318 L 250,180 L 112,318 Z"/>

          <!-- Pitcher's mound + rubber -->
          <circle class="mound" cx="250" cy="355" r="22"/>
          <rect class="rubber" x="246" y="354" width="8" height="2.5"/>

          <!-- Bases -->
          <polygon class="base home"
                   points="244,458 256,458 256,464 250,470 244,464"/>
          <g transform="translate(390 320) rotate(45)">
            <rect class="base" data-occupied="${occ("first")}"
                  x="-7" y="-7" width="14" height="14"/>
          </g>
          <g transform="translate(250 180) rotate(45)">
            <rect class="base" data-occupied="${occ("second")}"
                  x="-7" y="-7" width="14" height="14"/>
          </g>
          <g transform="translate(110 320) rotate(45)">
            <rect class="base" data-occupied="${occ("third")}"
                  x="-7" y="-7" width="14" height="14"/>
          </g>

          <!-- Runner names (legible against grass via text stroke) -->
          ${runnerLabel("first",  412, 326, "start")}
          ${runnerLabel("second", 250, 166, "middle")}
          ${runnerLabel("third",  88,  326, "end")}
        </svg>
        ${situationStrip(g)}
        ${g.batter ? matchupRow("at bat", g.batter.name, `${g.batter.bats}HB`, g.batter.id) : ""}
        ${g.pitcher ? matchupRow("pitching", g.pitcher.name, `${g.pitcher.throws}HP`, g.pitcher.id) : ""}
        ${renderThisInning(g)}
      </div>
    `;
}

// "This inning" play-by-play strip — every completed PA in the
// current half-inning, oldest first. Shows the user how the frame
// has unfolded so far without making them flip to Gamecast for
// the same info.
function renderThisInning(g) {
    if (g.status !== "Live" || !g.this_inning || g.this_inning.length === 0) {
        return "";
    }
    const arrow = g.half === "top" ? "▲" : "▼";
    const innLabel = `${arrow} ${ordinalSuffix(g.inning)} so far`;
    const rows = g.this_inning.map((p) => {
        // Compact result chip per PA. Color = the outcome category we
        // already use elsewhere (green for hits, red for outs/K, blue
        // for walks, etc.).
        const outcomeCls = paOutcomeClass(p.eventType);
        const outcomeLabel = shortEventLabel(p.event || p.eventType || "—");
        const avatar = inlineAvatar(p.batter_id, { size: 30, class: "ti-photo", alt: p.batter });
        const batterLink = p.batter_id
            ? `<a class="player-link" href="#player/${p.batter_id}">${shortName(p.batter)}</a>`
            : shortName(p.batter || "—");
        return `
          <div class="ti-row">
            <span class="ti-outcome ${outcomeCls}">${outcomeLabel}</span>
            ${avatar}
            <span class="ti-batter">${batterLink}</span>
            <span class="ti-desc">${escapeHTML(p.description || "")}</span>
          </div>
        `;
    }).join("");
    const currentRow = g.batter
        ? `<div class="ti-row ti-now">
              <span class="ti-outcome ti-now-chip">NOW</span>
              ${inlineAvatar(g.batter.id, { size: 30, class: "ti-photo", alt: g.batter.name })}
              <span class="ti-batter">${shortName(g.batter.name)}</span>
              <span class="ti-desc">at bat · ${g.balls}-${g.strikes}, ${g.outs} out</span>
           </div>`
        : "";
    return `
      <div class="this-inning">
        <div class="ti-head">${innLabel}</div>
        ${rows}
        ${currentRow}
      </div>
    `;
}

// Map a Statcast event type to a short outcome chip label.
function shortEventLabel(eventType) {
    if (!eventType) return "—";
    const e = eventType.toLowerCase();
    if (e.includes("strikeout")) return "K";
    if (e.includes("walk"))      return "BB";
    if (e.includes("hit_by_pitch")) return "HBP";
    if (e.includes("home_run") || e === "home run") return "HR";
    if (e === "triple" || e === "3b") return "3B";
    if (e === "double" || e === "2b") return "2B";
    if (e === "single" || e === "1b") return "1B";
    if (e.includes("error")) return "E";
    if (e.includes("fielders_choice")) return "FC";
    if (e.includes("sac_fly")) return "SF";
    if (e.includes("sac_bunt")) return "SAC";
    if (e.includes("double_play")) return "DP";
    if (e.includes("triple_play")) return "TP";
    if (e.includes("out") || e.includes("fly") || e.includes("ground"))
        return "OUT";
    // Capitalize first letter and shorten as a fallback
    return (eventType[0] || "").toUpperCase() + eventType.slice(1, 4);
}

// Outcome → CSS class (color category). Matches the bar-chart colors
// elsewhere in the app.
function paOutcomeClass(eventType) {
    if (!eventType) return "";
    const e = eventType.toLowerCase();
    if (e.includes("strikeout") || e.includes("out") || e.includes("double_play"))
        return "ti-out";
    if (e.includes("walk") || e.includes("hit_by_pitch"))
        return "ti-walk";
    if (e.includes("home_run") || e === "triple" || e === "double" || e === "single")
        return "ti-hit";
    return "";
}

function situationStrip(g) {
    if (g.status === "Live" && g.inning) {
        // Spell out the half (Top / Bottom) so the ▲/▼ symbol isn't
        // the only signal, and label bases as "runner on Xth" instead
        // of "1st" (ambiguous with "first inning"). Outs use "OUT" vs
        // "OUTS" agreement. Count carries an explicit "count" suffix.
        const halfWord = g.half === "top" ? "Top" : "Bottom";
        const bases    = (g.runners?.first ? 1 : 0)
                       | (g.runners?.second ? 2 : 0)
                       | (g.runners?.third ? 4 : 0);
        const basesLabel = bases > 0 ? describeBasesShort(bases) : "bases empty";
        const outsLabel  = g.outs === 1 ? "1 out" : `${g.outs} outs`;
        return `
          <div class="situation" title="Top of inning (▲) means away team batting; Bottom (▼) means home team batting">
            <span class="inning">${arrowHalf(g.half)} ${halfWord} ${ordinalSuffix(g.inning).toLowerCase()}</span>
            <span class="dot">·</span>
            <span class="outs">${outsLabel}</span>
            <span class="dot">·</span>
            <span class="bases">${basesLabel}</span>
            <span class="dot">·</span>
            <span class="count" title="${g.balls} ball${g.balls === 1 ? "" : "s"}, ${g.strikes} strike${g.strikes === 1 ? "" : "s"}">${g.balls}-${g.strikes} count</span>
          </div>
        `;
    }
    return `<div class="situation"><span class="state-label">${(g.detail || g.status).toUpperCase()}</span></div>`;
}

function matchupRow(label, name, hand, mlbam) {
    // Wrap the name in a player link when we have an MLBAM id — clicking
    // the batter / pitcher takes you to their profile page (same target
    // as the player links inside the recent-PA list).
    const nameHtml = mlbam
        ? `<a class="player-link" href="#player/${mlbam}"><strong>${name}</strong></a>`
        : `<strong>${name}</strong>`;
    const headshot = mlbam
        ? `<a href="#player/${mlbam}" class="pr-avatar" aria-label="${name} profile">
              <img src="${playerHeadshotSpot(mlbam, 96)}" alt=""
                   loading="lazy" onerror="this.style.opacity='0';"/>
           </a>`
        : `<span class="pr-avatar pr-avatar-empty" aria-hidden="true"></span>`;
    return `
      <div class="player-row">
        <span class="label">${label}</span>
        ${headshot}
        ${nameHtml}
        <span class="hand">${hand}</span>
      </div>
    `;
}

function cardPane(g) {
    const we = g.win_expectancy;
    const homeAbbr = g.teams.home.abbr;
    const awayAbbr = g.teams.away.abbr;

    if (we == null) {
        return `
          <div class="card-pane">
            <div class="card">
              <div class="subject">${awayAbbr}–${homeAbbr}</div>
              <div class="situation-line">${(g.detail || g.status).toUpperCase()}</div>
              <div class="read">${preGameRead(g)}</div>
            </div>
          </div>
        `;
    }

    const homePct = Math.round(we * 100);
    const awayPct = 100 - homePct;
    const winning = homePct > awayPct ? homeAbbr : awayAbbr;
    const winPct = Math.max(homePct, awayPct);
    const runnersText = describeBases(g.runners);
    const stateLine =
        g.status === "Live" && g.inning
            ? `${arrowHalf(g.half)} ${ordinalSuffix(g.inning)} · ${g.outs} out · ${runnersText} · ${g.balls}-${g.strikes}`
            : (g.detail || g.status).toUpperCase();

    // "live updating" indicator — only on Live games, sits next to the
    // subject line. Tells the user the WE bar is actively re-polling
    // (every 5s) and the number they're seeing isn't stale.
    const liveIndicator = g.status === "Live"
        ? `<span class="we-live"><span class="we-live-dot"></span>LIVE</span>`
        : "";

    return `
      <div class="card-pane">
        <div class="card">
          <div class="subject">
            <span>${awayAbbr}–${homeAbbr} · ${g.score.away}-${g.score.home}</span>
            ${liveIndicator}
          </div>
          <div class="situation-line">${stateLine}</div>

          <div class="question">${g.status === "Final" ? "Who won?" : "Who is winning?"}</div>
          <div class="answer">
            <strong>${winning}</strong>
            <span class="pct">${winPct}%</span>
          </div>
          <div class="bar"><span style="width:${homePct}%"></span></div>
          <div class="bar-labels">
            <span>${awayAbbr} ${awayPct}%</span>
            <span>${homeAbbr} ${homePct}%</span>
          </div>
          ${g.status === "Live" ? `<div class="why-line">${whyFavored(g, we, winning)}</div>` : ""}

          ${(g.status !== "Final" && g.team_adjustment) ? renderTeamStrength(g) : ""}

          <div id="projected-we-slot">${g.status === "Live" ? cachedProjectedSlot : ""}</div>
          <div id="forecast-we-slot">${g.status === "Live" ? cachedForecastSlot : ""}</div>
          <div id="market-consensus-slot">${cachedMarketConsensusSlot}</div>

          <div class="evidence">
            From 115 seasons of Retrosheet game logs — how often a team in
            this exact state has won. <a href="#about" class="evidence-link">How it works</a>.
          </div>

          <div class="read">${liveRead(g, we)}</div>
        </div>
        <div id="trace-slot">${cachedTraceSlot}</div>
        ${g.status === "Final" ? `<div id="recap-slot">${cachedRecapSlot}</div>` : ""}
        <div id="matchup-slot">${cachedMatchupSlot}</div>
      </div>
    `;
}

// Cached matchup card HTML so a 15-second refresh doesn't blow the card
// out of the DOM and back. The card only needs to re-fetch when the
// batter/pitcher pair changes (≈ once per PA), but the surrounding
// game-view innerHTML gets rewritten every refresh — without this cache
// the matchup slot would be empty for the few hundred ms between
// renderGame() returning and hydrateMatchup() finishing its fetch.
let cachedMatchupSlot = "";
let cachedMatchupKey = null;

// Same cache pattern for the LLM-generated recap. We only fetch once
// per Game view session (or once per game across users, server-side).
let cachedRecapSlot = "";
let cachedRecapPk = null;

// WE trace card cache. Final games cache forever (data doesn't change);
// live games refresh because new half-innings add points.
let cachedTraceSlot = "";
let cachedTracePk = null;
let cachedTraceStatus = null;

// Projected-WE block — the matchup-engine-blended look-ahead WE for
// the current PA. Refreshes with the game (every 5s) so the leverage
// number stays current.
let cachedProjectedSlot = "";

// Forward forecast (bullpen-aware Monte Carlo). Refreshes per game
// poll. The number changes more slowly than projected-WE since it
// depends on game state + lineup + bullpen sequence, not just count.
let cachedForecastSlot = "";

// ── BOX SCORE ───────────────────────────────────────────────────────

// Fetches and renders the textbook newspaper-style box score (line
// score + per-batter + per-pitcher lines). For Final games we cache
// forever (data is frozen); for Live games we refresh each tick (5s)
// so the score and stat lines tick up as the game progresses.
async function hydrateBoxscore(gameId, status) {
    if (status === "Final"
        && cachedBoxscorePk === gameId
        && cachedBoxscoreStatus === "Final") {
        return;  // immutable
    }
    try {
        const res = await fetch(`/api/game/${gameId}/boxscore`);
        if (!res.ok) return;
        const data = await res.json();
        if (gameId !== String(activeGameId)) return;
        const pane = document.getElementById("boxscore-pane");
        if (!pane) return;
        const html = renderBoxscore(data);
        pane.innerHTML = html;
        cachedBoxscoreHTML = html;
        cachedBoxscorePk = gameId;
        cachedBoxscoreStatus = data.status;
        cachedBoxscoreData = data;
    } catch {
        // silent — pane stays with cached content (or loading shell)
    }
}

// Which team's batting + pitching tables to show in the box score.
// Toggle is a segmented control INSIDE the boxscore pane so it doesn't
// fight the outer Live View / Gamecast / Box Score tab strip. Default
// to "home" — the average user is more likely to be following their
// home team than the visitor.
let boxscoreTeam = "home";  // "home" | "away"

function renderBoxscore(d) {
    if (!d.available) {
        return `<div class="empty">${d.reason || "Box score not available."}</div>`;
    }
    const team = boxscoreTeam;
    return `
      <div class="boxscore">
        ${renderLineScore(d)}
        <div class="bs-team-toggle" role="tablist">
          <button class="${team === 'away' ? 'active' : ''}" data-bs-team="away" role="tab">${d.teams.away.abbr}</button>
          <button class="${team === 'home' ? 'active' : ''}" data-bs-team="home" role="tab">${d.teams.home.abbr}</button>
        </div>
        ${renderBattingTable(team, d)}
        ${renderPitchingTable(team, d)}
      </div>
    `;
}

// Toggle the box-score team WITHOUT re-fetching — the JSON is already
// in cachedBoxscoreData, we just re-render which slice we show. Same
// delegated-click pattern as the outer game-mode toggle.
document.addEventListener("click", (e) => {
    const btn = e.target.closest(".bs-team-toggle button[data-bs-team]");
    if (!btn) return;
    e.preventDefault();
    const team = btn.dataset.bsTeam;
    if (team === boxscoreTeam) return;
    boxscoreTeam = team;
    if (cachedBoxscoreData) {
        const pane = document.getElementById("boxscore-pane");
        if (pane) {
            const html = renderBoxscore(cachedBoxscoreData);
            pane.innerHTML = html;
            cachedBoxscoreHTML = html;
        }
    }
});

// Top-of-page rectangle. Innings 1..N across, then R H E columns.
// Cells show "—" for innings the team didn't bat (walk-off bottom-9
// games, top-of-9 unplayed when home is ahead, future innings of a
// game in progress).
function renderLineScore(d) {
    const innings = d.line_score.innings;
    const inningCols = innings.map((inn) => `<th>${inn.num}</th>`).join("");
    const rowFor = (side) => {
        const cells = innings.map((inn) => {
            const runs = inn[side]?.runs;
            return `<td>${runs == null ? "—" : runs}</td>`;
        }).join("");
        const t = d.line_score.totals[side] || {};
        return `
          <tr>
            <th scope="row" class="ls-team">${d.teams[side].abbr}</th>
            ${cells}
            <td class="ls-tot ls-tot-r">${t.runs ?? "—"}</td>
            <td class="ls-tot">${t.hits ?? "—"}</td>
            <td class="ls-tot">${t.errors ?? "—"}</td>
          </tr>
        `;
    };
    return `
      <table class="bs-linescore">
        <thead>
          <tr>
            <th></th>${inningCols}
            <th class="ls-tot-h">R</th>
            <th class="ls-tot-h">H</th>
            <th class="ls-tot-h">E</th>
          </tr>
        </thead>
        <tbody>
          ${rowFor("away")}
          ${rowFor("home")}
        </tbody>
      </table>
    `;
}

function renderBattingTable(side, d) {
    const team  = d.teams[side];
    const lines = d.batting[side];
    const tot   = d.batting.totals[side];
    const rows  = lines.map((b) => `
      <tr>
        <td class="bs-order">${b.order ?? ""}</td>
        <td class="bs-name">
          <span class="bs-name-wrap">
            ${bsPhoto(b.mlbam)}
            <span class="bs-name-text">
              ${b.mlbam
                ? `<a class="player-link" href="#player/${b.mlbam}">${b.box_name}</a>`
                : b.box_name}
              <span class="bs-pos">${b.position}</span>
            </span>
          </span>
        </td>
        <td>${b.AB}</td>
        <td>${b.R}</td>
        <td>${b.H}</td>
        <td>${b.RBI}</td>
        <td>${b.BB}</td>
        <td>${b.K}</td>
        <td>${b.LOB}</td>
        <td class="bs-season">${b.season.AVG}</td>
      </tr>
    `).join("");
    return `
      <div class="bs-team-block">
        <h3 class="bs-team-head">${team.name} · Batting</h3>
        <table class="bs-table">
          <thead>
            <tr>
              <th></th>
              <th class="bs-name">Batter</th>
              <th>AB</th><th>R</th><th>H</th><th>RBI</th>
              <th>BB</th><th>K</th><th>LOB</th>
              <th class="bs-season">AVG</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td></td>
              <td class="bs-name">Totals</td>
              <td>${tot.AB}</td><td>${tot.R}</td><td>${tot.H}</td><td>${tot.RBI}</td>
              <td>${tot.BB}</td><td>${tot.K}</td><td>${tot.LOB}</td>
              <td class="bs-season">${tot.AVG}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
}

function renderPitchingTable(side, d) {
    const team  = d.teams[side];
    const lines = d.pitching[side];
    const tot   = d.pitching.totals[side];
    const rows  = lines.map((p) => `
      <tr>
        <td class="bs-name">
          <span class="bs-name-wrap">
            ${bsPhoto(p.mlbam)}
            <span class="bs-name-text">
              ${p.mlbam
                ? `<a class="player-link" href="#player/${p.mlbam}">${p.box_name}</a>`
                : p.box_name}
              ${p.decision ? `<span class="bs-decision">${p.decision}</span>` : ""}
            </span>
          </span>
        </td>
        <td>${p.IP}</td>
        <td>${p.H}</td>
        <td>${p.R}</td>
        <td>${p.ER}</td>
        <td>${p.BB}</td>
        <td>${p.K}</td>
        <td>${p.HR}</td>
        <td class="bs-pitches">${p.pitches}-${p.strikes}</td>
        <td class="bs-season">${p.season.ERA}</td>
      </tr>
    `).join("");
    return `
      <div class="bs-team-block">
        <h3 class="bs-team-head">${team.name} · Pitching</h3>
        <table class="bs-table">
          <thead>
            <tr>
              <th class="bs-name">Pitcher</th>
              <th>IP</th><th>H</th><th>R</th><th>ER</th>
              <th>BB</th><th>K</th><th>HR</th>
              <th class="bs-pitches" title="Pitches thrown – Strikes (out of total)">P/S</th>
              <th class="bs-season">ERA</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td class="bs-name">Totals</td>
              <td>${tot.IP}</td><td>${tot.H}</td><td>${tot.R}</td><td>${tot.ER}</td>
              <td>${tot.BB}</td><td>${tot.K}</td><td>${tot.HR}</td>
              <td class="bs-pitches"></td>
              <td class="bs-season">${tot.ERA}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
}

// ── MARKETS ─────────────────────────────────────────────────────────
//
// Fetches /api/game/{id}/markets — every public prediction-market line
// for this game (Polymarket, Kalshi, Manifold, plus The Odds API when
// configured) — and renders them grouped by question type, with our
// model's WE shown next to the cross-source consensus so users can see
// where we agree or diverge.
//
// Lines move fast, so the markets pane runs its own 20s poll timer
// independent of the outer 5s game refresh. The timer is owned by the
// game-mode toggle handler: switching away cancels it; switching in
// starts it; switching games clears+restarts it.

async function hydrateMarkets(gameId) {
    try {
        const res = await fetch(`/api/game/${gameId}/markets`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (String(gameId) !== String(activeGameId)) return;
        // Also update the cached consensus pill — even when viewers
        // are on the Markets tab, the Live View card behind it should
        // reflect the same numbers when they tab back.
        cachedMarketConsensusSlot = renderMarketConsensusPill(data);
        cachedMarketConsensusPk = gameId;
        const pillSlot = document.getElementById("market-consensus-slot");
        if (pillSlot) pillSlot.innerHTML = cachedMarketConsensusSlot;
        const pane = document.getElementById("markets-pane");
        if (!pane) return;
        const html = renderMarkets(data);
        pane.innerHTML = html;
        cachedMarketsHTML = html;
        cachedMarketsPk = gameId;
    } catch (e) {
        const pane = document.getElementById("markets-pane");
        if (pane && !cachedMarketsHTML) {
            pane.innerHTML = `<div class="empty">Couldn't load markets: ${e.message || e}</div>`;
        }
        // Otherwise keep showing what we have — a single failed poll
        // shouldn't blank the pane.
    }
}

// Lightweight version of hydrateMarkets used by the Live View card to
// fill the consensus pill without rendering the full markets pane.
// Same endpoint — the Cloudflare edge cache (20s) means this is a
// shared response with the Markets tab when both are open.
async function hydrateMarketConsensusPill(gameId) {
    try {
        const res = await fetch(`/api/game/${gameId}/markets`);
        if (!res.ok) return;
        const data = await res.json();
        if (String(gameId) !== String(activeGameId)) return;
        cachedMarketConsensusSlot = renderMarketConsensusPill(data);
        cachedMarketConsensusPk = gameId;
        const slot = document.getElementById("market-consensus-slot");
        if (slot) slot.innerHTML = cachedMarketConsensusSlot;
    } catch { /* keep cached pill; silent fail */ }
}

// Compact pill rendered between the WE bar and our evidence line.
// Shows the market's consensus probability for the home team next to
// ours, plus a one-word verdict on the edge. Hidden entirely when no
// moneyline market exists yet (most non-primetime games).
function renderMarketConsensusPill(data) {
    if (!data || !data.available || !data.market_count) return "";

    const home = data.teams?.home?.abbr || "HOME";
    const away = data.teams?.away?.abbr || "AWAY";
    const cons = data.consensus?.home_win;
    const ours = data.our_we_home;

    // Headline row: moneyline-style "home win" probability — our model
    // vs cross-source market consensus. Hidden when no moneyline market
    // exists (we still show supplementary chips below if those markets
    // exist on their own).
    let headline = "";
    if (cons != null && ours != null) {
        const edge = ours - cons;
        const dir  = Math.abs(edge) < 0.02 ? "match"
                   : edge > 0 ? "we_higher" : "market_higher";
        const verdict = dir === "match"
            ? `model and market agree`
            : dir === "we_higher"
                ? `we're +${(edge * 100).toFixed(1)}pp on ${home}`
                : `market's +${(-edge * 100).toFixed(1)}pp on ${home}`;
        headline = `
          <div class="mc-pill-row">
            <div class="mc-pill-num"><div class="mc-pill-num-val">${fmtPct(ours)}</div><div class="mc-pill-num-key">our model</div></div>
            <div class="mc-pill-vs">vs</div>
            <div class="mc-pill-num"><div class="mc-pill-num-val">${fmtPct(cons)}</div><div class="mc-pill-num-key">market (${data.sources_present.length} src)</div></div>
          </div>
          <div class="mc-pill-verdict mc-pill-verdict-${dir}">${verdict}</div>
        `;
    }

    // Supplementary chips: total runs O/U, run-line spread, then high-
    // probability futures/team props for either team. We surface the
    // most interesting non-moneyline markets here so users always see
    // SOMETHING when markets exist, even for non-primetime games where
    // the moneyline hasn't traded yet.
    const totalChip  = renderTotalRunsChip(data.markets?.total);
    const spreadChip = renderSpreadChip(data.markets?.spread, home);
    const futureChips = renderFutureChips(data.markets?.future, home, away);
    const propChips   = renderTeamPropChips(data.markets?.team_prop, home, away);
    const extrasInner =
        (totalChip || "") + (spreadChip || "") + futureChips + propChips;
    const extras = extrasInner ? `<div class="mc-pill-extras">${extrasInner}</div>` : "";

    // Hide entirely if BOTH headline and extras are empty.
    if (!headline && !extras) return "";

    // Headline-less mode: when no moneyline consensus exists but we DO
    // have futures/props, still show the label + extras so the user
    // sees "Market lines available" with the chips below.
    const labelText = headline
        ? "Market lines"
        : `Market lines · no game-day moneyline yet`;

    return `
      <div class="mc-pill">
        <div class="mc-pill-head">
          <span class="mc-pill-label">${labelText}</span>
          <a class="mc-pill-link" href="#" data-mc-open-markets="1">Open all (${data.market_count}) →</a>
        </div>
        ${headline}
        ${extras}
      </div>
    `;
}

// Pull top futures markets for either team — World Series, division
// title, season-wins-over, etc. Surface up to 4 with the highest
// non-null probability on either outcome. Chips link into the
// Markets tab where the full list lives.
function renderFutureChips(futures, homeAbbr, awayAbbr) {
    if (!futures || !futures.length) return "";
    const ranked = futures
        .map((m) => {
            const out = (m.outcomes || []).find((o) => o.probability != null);
            const prob = out?.probability;
            return { m, out, prob };
        })
        .filter((r) => r.prob != null)
        .sort((a, b) => (b.prob || 0) - (a.prob || 0))
        .slice(0, 4);
    if (!ranked.length) return "";
    return ranked.map(({ m, out, prob }) => `
      <a class="mc-line-chip mc-line-chip-future" href="${m.url || "#"}" target="_blank" rel="noopener" title="${escapeHTMLAttr(m.title)}">
        <span class="mc-line-key">FUTURE</span>
        <span class="mc-line-val">${shortenFutureTitle(m.title, homeAbbr, awayAbbr)}</span>
        <span class="mc-line-pct">${fmtPct(prob)}</span>
        <span class="mc-line-src">${m.source}</span>
      </a>
    `).join("");
}

function renderTeamPropChips(props, homeAbbr, awayAbbr) {
    if (!props || !props.length) return "";
    const ranked = props
        .map((m) => {
            const best = (m.outcomes || [])
                .filter((o) => o.probability != null)
                .sort((a, b) => (b.probability || 0) - (a.probability || 0))[0];
            return { m, best };
        })
        .filter((r) => r.best)
        .slice(0, 3);
    if (!ranked.length) return "";
    return ranked.map(({ m, best }) => `
      <a class="mc-line-chip mc-line-chip-prop" href="${m.url || "#"}" target="_blank" rel="noopener" title="${escapeHTMLAttr(m.title)}">
        <span class="mc-line-key">PROP</span>
        <span class="mc-line-val">${escapeHTML(best.name || "")}</span>
        <span class="mc-line-pct">${fmtPct(best.probability)}</span>
        <span class="mc-line-src">${m.source}</span>
      </a>
    `).join("");
}

// Compact a future title for chip display. "Will the Atlanta Braves
// win the 2026 World Series?" → "ATL win WS 2026". Falls back to the
// original title (truncated) when no pattern matches.
function shortenFutureTitle(title, home, away) {
    if (!title) return "";
    let t = title
        .replace(/^Will (the )?/i, "")
        .replace(/Atlanta Braves/i, home === "ATL" ? home : "ATL")
        .replace(/Boston Red Sox/i, home === "BOS" || away === "BOS" ? "BOS" : "BOS")
        .replace(/2026 World Series\??$/i, "WS 2026")
        .replace(/2026 American League Championship Series\??$/i, "ALCS")
        .replace(/2026 National League Championship Series\??$/i, "NLCS")
        .replace(/2026 AL East title\??$/i, "AL East")
        .replace(/2026 NL East title\??$/i, "NL East")
        .replace(/2026 MLB Regular Season/i, "regular season")
        .replace(/\?$/, "");
    if (t.length > 40) t = t.slice(0, 38) + "…";
    return t.trim();
}

// Pull the best total-runs market and surface as a chip:
// "TOTAL · over 8.5 @ 56% · 3 sources"
function renderTotalRunsChip(totals) {
    if (!totals || !totals.length) return "";
    // Best market = highest liquidity, ties broken by most outcomes.
    const sorted = totals.slice().sort((a, b) =>
        (b.liquidity_usd || 0) - (a.liquidity_usd || 0)
    );
    const m = sorted[0];
    if (!m) return "";
    const overOut = (m.outcomes || []).find((o) => /over/i.test(o.name)) || m.outcomes?.[0];
    if (!overOut) return "";
    const thresholdMatch = (m.title || "").match(/(\d+(?:\.\d+)?)/);
    const threshold = thresholdMatch ? thresholdMatch[1] : "";
    return `
      <a class="mc-line-chip mc-line-chip-total" href="#" data-mc-open-markets="1" title="${escapeHTMLAttr(m.title)}">
        <span class="mc-line-key">TOTAL</span>
        <span class="mc-line-val">over ${threshold || "?"}</span>
        <span class="mc-line-pct">${fmtPct(overOut.probability)}</span>
        <span class="mc-line-src">${m.source}</span>
      </a>
    `;
}

// Pull the best run-line spread market and surface as a chip:
// "SPREAD · SF -1.5 @ 38% · polymarket"
function renderSpreadChip(spreads, homeAbbr) {
    if (!spreads || !spreads.length) return "";
    const sorted = spreads.slice().sort((a, b) =>
        (b.liquidity_usd || 0) - (a.liquidity_usd || 0)
    );
    const m = sorted[0];
    if (!m) return "";
    const out = (m.outcomes || []).find((o) =>
        (o.name || "").toLowerCase().includes(homeAbbr.toLowerCase())
    ) || m.outcomes?.[0];
    if (!out) return "";
    return `
      <a class="mc-line-chip mc-line-chip-spread" href="#" data-mc-open-markets="1" title="${escapeHTMLAttr(m.title)}">
        <span class="mc-line-key">SPREAD</span>
        <span class="mc-line-val">${escapeHTML(out.name || "")}</span>
        <span class="mc-line-pct">${fmtPct(out.probability)}</span>
        <span class="mc-line-src">${m.source}</span>
      </a>
    `;
}

// Click-to-jump from the pill into the Markets tab.
document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-mc-open-markets]");
    if (!link) return;
    e.preventDefault();
    if (gameViewMode !== "markets") {
        gameViewMode = "markets";
        if (activeGameId) refreshGame(activeGameId);
    }
});

function startMarketsPoll(gameId) {
    stopMarketsPoll();
    // 20s cadence — matches the endpoint's cache-control max-age, so
    // each poll hits the edge cache exactly when it expires.
    marketsPollTimer = setInterval(() => {
        if (gameViewMode !== "markets" || String(gameId) !== String(activeGameId)) {
            stopMarketsPoll();
            return;
        }
        hydrateMarkets(gameId);
    }, 20000);
}
function stopMarketsPoll() {
    if (marketsPollTimer) {
        clearInterval(marketsPollTimer);
        marketsPollTimer = null;
    }
}

function renderMarkets(d) {
    if (!d.available) {
        return `<div class="empty">${d.reason || "No markets available for this game."}</div>`;
    }
    if (!d.market_count) {
        return `
          <div class="markets-empty">
            <div class="markets-empty-title">No public markets quoted on this game yet.</div>
            <div class="markets-empty-sub">
              We watch Polymarket, Kalshi, Manifold${d.sources_present?.length ? "" : " (plus The Odds API when configured)"}.
              Most weekday games get lines closer to first pitch.
            </div>
          </div>
        `;
    }

    const ourWe   = d.our_we_home;
    const consHome = d.consensus?.home_win;
    const consAway = d.consensus?.away_win;
    const edge    = d.consensus?.edge_home;

    return `
      <div class="markets">
        ${renderMarketsHeader(d, ourWe, consHome, consAway, edge)}
        ${renderMarketsSection("Moneyline (who wins)",    d.markets.moneyline)}
        ${renderMarketsSection("Spread (run line)",       d.markets.spread)}
        ${renderMarketsSection("Total runs (over/under)", d.markets.total)}
        ${renderMarketsSection("Player props",            d.markets.player_prop)}
        ${renderMarketsSection("Team props",              d.markets.team_prop)}
        ${renderMarketsSection("Series outcomes",         d.markets.series)}
        ${renderMarketsSection("Futures (season-long)",   d.markets.future)}
        ${renderMarketsSection("Other questions",         d.markets.other)}
        <div class="markets-footnote">
          Updates every 20s.
          ${d.market_count} live quote${d.market_count === 1 ? "" : "s"}
          across ${d.sources_present.length} source${d.sources_present.length === 1 ? "" : "s"}
          (${d.sources_present.join(", ")}).
          Pulled ${formatRelativeTime(d.fetched_at)}.
        </div>
      </div>
    `;
}

function renderMarketsHeader(d, ourWe, consHome, consAway, edge) {
    const home = d.teams.home.abbr;
    const away = d.teams.away.abbr;
    const oursPct = ourWe != null ? fmtPct(ourWe) : "—";
    const consPct = consHome != null ? fmtPct(consHome) : "—";
    const edgeTxt = edge != null
        ? `${edge > 0 ? "+" : ""}${(edge * 100).toFixed(1)}pp`
        : "—";
    const edgeClass = edge == null
        ? "edge-flat"
        : Math.abs(edge) < 0.02
            ? "edge-flat"
            : edge > 0 ? "edge-us-higher" : "edge-market-higher";
    const edgeLabel = edge == null
        ? "No moneyline quoted yet"
        : Math.abs(edge) < 0.02
            ? "We agree with the market"
            : edge > 0
                ? `We have ${home} ${edgeTxt} higher than the market`
                : `Market has ${home} ${(-edge * 100).toFixed(1)}pp higher than us`;
    return `
      <div class="markets-header">
        <div class="markets-headline">
          <div class="markets-side">
            <div class="markets-side-label">Our model — ${home} win</div>
            <div class="markets-side-num">${oursPct}</div>
          </div>
          <div class="markets-vs">vs</div>
          <div class="markets-side">
            <div class="markets-side-label">Market consensus — ${home} win</div>
            <div class="markets-side-num">${consPct}</div>
          </div>
        </div>
        <div class="markets-edge ${edgeClass}">${edgeLabel}</div>
        <div class="markets-subhead">
          ${consAway != null ? `${away} win consensus: ${fmtPct(consAway)}` : ""}
        </div>
      </div>
    `;
}

function renderMarketsSection(title, rows) {
    if (!rows || !rows.length) return "";
    return `
      <section class="markets-section">
        <h3 class="markets-section-title">${title}</h3>
        <div class="markets-rows">
          ${rows.map(renderMarketRow).join("")}
        </div>
      </section>
    `;
}

function renderMarketRow(market) {
    const src = market.source || "?";
    const status = market.status || "open";
    const statusBadge = status !== "open"
        ? `<span class="market-status market-status-${status}">${status}</span>`
        : "";
    const liquidity = market.liquidity_usd != null
        ? ` · $${formatCompactNumber(market.liquidity_usd)} liq`
        : "";
    const volume = market.volume_usd != null
        ? ` · $${formatCompactNumber(market.volume_usd)} vol`
        : "";
    // Outcomes: sort by probability desc so the favored side is first.
    const outcomes = (market.outcomes || [])
        .slice()
        .sort((a, b) => (b.probability || 0) - (a.probability || 0));
    return `
      <article class="market-row" data-source="${src}">
        <header class="market-row-head">
          <span class="market-source market-source-${src}">${src}</span>
          ${statusBadge}
          <a class="market-title" href="${market.url || "#"}" target="_blank" rel="noopener">
            ${escapeHTML(market.title || "Untitled market")}
          </a>
        </header>
        <div class="market-outcomes">
          ${outcomes.map(renderMarketOutcome).join("")}
        </div>
        <div class="market-meta">${src}${liquidity}${volume}</div>
      </article>
    `;
}

function renderMarketOutcome(outcome) {
    const prob = outcome.probability;
    const pct  = prob != null ? fmtPct(prob) : "—";
    const bar  = prob != null ? Math.round(prob * 100) : 0;
    return `
      <div class="market-outcome">
        <div class="mo-name">${escapeHTML(outcome.name || "")}</div>
        <div class="mo-bar"><div class="mo-bar-fill" style="width:${bar}%"></div></div>
        <div class="mo-pct">${pct}</div>
      </div>
    `;
}

function fmtPct(p) {
    if (p == null) return "—";
    return `${(p * 100).toFixed(1)}%`;
}

function formatCompactNumber(n) {
    if (n == null) return "—";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
    return String(Math.round(n));
}

function formatRelativeTime(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    return `${Math.round(secs / 3600)}h ago`;
}

// (escapeHTML already defined below; reuse it for market titles.)


// ── MATCHUP ENGINE (Phase 3.2) ──────────────────────────────────────

const OUTCOME_LABEL = {
    K:     "strikeout",
    BB:    "walk",
    HBP:   "hit by pitch",
    "1B":  "single",
    "2B":  "double",
    "3B":  "triple",
    HR:    "home run",
    OUT:   "in-play out",
    OTHER: "error / fielder's choice",
};

async function hydrateMatchup(batterMlbam, pitcherMlbam, requestedFor, balls, strikes) {
    try {
        // Build the request key including count so the cache key knows
        // about pitch-level state. Without this, the matchup card
        // wouldn't re-fetch on a count change and the user would see
        // the prior pitch's prediction frozen on screen.
        const countQuery = (balls != null && strikes != null)
            ? `&balls=${balls}&strikes=${strikes}`
            : "";
        const key = `${batterMlbam}-${pitcherMlbam}-${balls}-${strikes}`;
        if (cachedMatchupKey === key && cachedMatchupSlot) {
            // Same count we last rendered — skip the network call and
            // keep the cached card up.
            return;
        }
        const res = await fetch(
            `/api/matchup?batter=${batterMlbam}&pitcher=${pitcherMlbam}${countQuery}`
        );
        if (!res.ok) return;
        const m = await res.json();
        if (requestedFor !== activeGameId) return;
        const slot = document.getElementById("matchup-slot");
        if (!slot || !m.available) return;
        const html = renderMatchupCard(m);
        slot.innerHTML = html;
        cachedMatchupSlot = html;
        cachedMatchupKey = key;
        // After paint, look up player-prop markets for both sides and
        // surface them as chips under the outcome distribution. Silent
        // on no-match.
        hydrateMatchupPropChips(requestedFor, m.batter?.name, m.pitcher?.name);
    } catch (e) {
        // silently absent — the page works without the matchup card
    }
}

// Loads the projected (matchup-engine-blended) WE for the current PA.
// Renders inline in the WE card so the user sees both the current
// state-based WE AND the expected post-PA WE given who's actually
// pitching to whom. The gap between the two is the leverage of the PA.
async function hydrateProjectedWE(gameId, gameForLabels) {
    try {
        const res = await fetch(`/api/game/${gameId}/we-projected`);
        if (!res.ok) return;
        const data = await res.json();
        if (gameId !== String(activeGameId)) return;
        const slot = document.getElementById("projected-we-slot");
        if (!slot) return;
        const html = renderProjectedWE(data, gameForLabels);
        slot.innerHTML = html;
        cachedProjectedSlot = html;
    } catch {
        // silent — slot stays with cached content
    }
}

// Loads the bullpen-aware forward forecast — the Monte Carlo end-of-
// game WE projection that uses the actual lineup + matchup engine for
// the team currently batting and the predicted reliever sequence.
// Refreshes per game poll (every 5s) since the forecast changes when
// the score shifts, batters cycle, or a new pitcher enters.
async function hydrateForecastWE(gameId, gameForLabels) {
    try {
        const res = await fetch(`/api/game/${gameId}/we-forward`);
        if (!res.ok) return;
        const data = await res.json();
        if (gameId !== String(activeGameId)) return;
        const slot = document.getElementById("forecast-we-slot");
        if (!slot) return;
        const html = renderForecastWE(data, gameForLabels);
        slot.innerHTML = html;
        cachedForecastSlot = html;
    } catch {
        // silent — slot stays with cached content
    }
}

function renderForecastWE(d, game) {
    if (!d.available) return "";
    const homePct = Math.round((d.forecast_we || 0) * 100);
    const awayPct = 100 - homePct;
    const curPct  = Math.round((d.current_we  || 0) * 100);
    const delta   = homePct - curPct;
    const arrow   = delta > 0 ? "▲" : delta < 0 ? "▼" : "→";
    const arrowCls = delta > 0 ? "up" : delta < 0 ? "down" : "flat";

    const homeAbbr = game?.teams?.home?.abbr || "HOME";
    const awayAbbr = game?.teams?.away?.abbr || "AWAY";
    const favored  = homePct >= awayPct ? homeAbbr : awayAbbr;
    const favPct   = Math.max(homePct, awayPct);

    // Render the pitcher sequence as a compact "Pitcher → Pitcher → Closer"
    // chain with friendlier role labels. Only includes pitchers who actually
    // appeared in the median simulation.
    const used = (d.pitcher_sequence || []).filter((p) => p.pa_count > 0);
    const chain = used.map((p) => {
        const roleHint = p.role === "closer"            ? "closer"
                       : p.role === "current_starter"   ? "current"
                       : p.role?.startsWith("inning_")  ? `${p.role.replace("inning_","")}th inn`
                       : "";
        const roleTag = roleHint ? `<span class="fwe-role">${roleHint}</span>` : "";
        const we = p.we_at_exit !== null ? `${Math.round(p.we_at_exit * 100)}%` : "—";
        const photo = inlineAvatar(p.id || p.mlbam, { size: 26, class: "fwe-photo", alt: p.name });
        const nameNode = (p.id || p.mlbam)
            ? `<a class="fwe-name player-link" href="#player/${p.id || p.mlbam}">${lastName(p.name)}</a>`
            : `<span class="fwe-name">${lastName(p.name)}</span>`;
        return `<span class="fwe-pitcher" title="${p.pa_count} PAs simulated · ${homeAbbr} WP at exit ${we}">${photo}${nameNode}${roleTag}</span>`;
    }).join("<span class=\"fwe-arrow\">→</span>");

    return `
      <div class="forecast-we">
        <div class="fwe-headline">
          <span class="fwe-arrow-pre ${arrowCls}">${arrow}</span>
          End-of-game forecast: <strong>${favored} ${favPct}%</strong>
          <span class="fwe-tag" title="Runs ${d.n_simulations || 25} simulations of the rest of the game using each team's actual lineup, current pitcher, and the manager's likely bullpen sequence. The percentage = share of simulations the team won.">SIMULATED ⓘ</span>
        </div>
        ${chain ? `<div class="fwe-chain"><span class="fwe-chain-label">Likely pitchers:</span>${chain}</div>` : ""}
        <div class="fwe-meta">${homeAbbr} ${homePct}% · ${awayAbbr} ${awayPct}% — averaged over ${d.n_simulations || 25} simulated games</div>
      </div>
    `;
}


function renderProjectedWE(d, game) {
    if (!d.available) return "";
    const proj   = Math.round((d.projected_we || 0) * 100);
    const cur    = Math.round((d.current_we   || 0) * 100);
    const lev    = Math.round((d.leverage     || 0) * 100);
    const best   = Math.round((d.best?.we     || 0) * 100);
    const worst  = Math.round((d.worst?.we    || 0) * 100);
    const arrow  = proj > cur ? "▲" : proj < cur ? "▼" : "→";
    const arrowCls = proj > cur ? "up" : proj < cur ? "down" : "flat";

    // Team abbreviations — the projection numbers are always HOME WP,
    // so label them by the home team's abbr so users don't have to
    // remember which side is which.
    const homeAbbr = game?.teams?.home?.abbr || "HOME";
    const awayAbbr = game?.teams?.away?.abbr || "AWAY";

    const bestLabel  = d.best?.outcome  ? `${OUTCOME_LABEL[d.best.outcome]  || d.best.outcome}`  : "";
    const worstLabel = d.worst?.outcome ? `${OUTCOME_LABEL[d.worst.outcome] || d.worst.outcome}` : "";

    const countBadge = d.count_aware && d.count
        ? `<span class="pw-count" title="Per-pitch projection using count-aware rates (Statcast 2020-2024)">${d.count.balls}-${d.count.strikes}</span>`
        : "";
    const headlineWord = d.count_aware ? "after this pitch" : "after this PA";

    return `
      <div class="projected-we">
        <div class="pw-headline">
          <span class="pw-arrow ${arrowCls}">${arrow}</span>
          ${homeAbbr} ${headlineWord}: <strong>${proj}%</strong> · ${awayAbbr} <strong>${100 - proj}%</strong>
          ${countBadge}
          <span class="pw-lev">${lev}-pt swing</span>
        </div>
        <div class="pw-range">
          best case for ${homeAbbr}: <strong>${best}%</strong> on a ${bestLabel}
          · worst case: <strong>${worst}%</strong> on a ${worstLabel}
        </div>
      </div>
    `;
}

// Loads the WE trace — one data point per completed half-inning,
// rendered as an SVG line chart. For Final games we cache forever
// (data is frozen). For Live games we re-fetch each tick — the edge
// cache (30s) and small payload absorb the cost.
async function hydrateTrace(gameId, status) {
    if (status === "Final" && cachedTracePk === gameId && cachedTraceStatus === "Final") {
        return; // Final-game trace is immutable
    }
    try {
        const res = await fetch(`/api/game/${gameId}/we-trace`);
        if (!res.ok) return;
        const data = await res.json();
        if (gameId !== String(activeGameId)) return;
        const slot = document.getElementById("trace-slot");
        if (!slot) return;
        const html = renderTraceCard(data);
        slot.innerHTML = html;
        cachedTraceSlot = html;
        cachedTracePk = gameId;
        cachedTraceStatus = data.status;
    } catch {
        // silent — slot just stays empty / cached
    }
}

function renderTraceCard(data) {
    const points = (data.points || []).filter((p) => p.we !== null);
    if (points.length < 2) {
        // Not enough completed halves to plot. Hide entirely (no card).
        return "";
    }

    // SVG dimensions. preserveAspectRatio: none lets the SVG stretch to
    // whatever the parent card's width is.
    const W = 360;
    const H = 110;
    const PAD = { l: 4, r: 4, t: 6, b: 16 };

    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;

    const xAt = (i) => PAD.l + (i / (points.length - 1)) * innerW;
    const yAt = (we) => PAD.t + (1 - we) * innerH;
    const refY = yAt(0.5);

    // Line: a single polyline through every (x, y). Plus a filled area
    // beneath it for the home team (above 50%) and a separate area for
    // the away team (below 50%) so the chart visually reads "who's
    // ahead in WE."
    const linePts = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.we).toFixed(1)}`).join(" ");

    // Build a filled path that follows the line then closes to the
    // bottom of the chart — for the "home WE shaded green" area.
    const lastX = xAt(points.length - 1).toFixed(1);
    const firstX = xAt(0).toFixed(1);
    const bottomY = (PAD.t + innerH).toFixed(1);
    const homeAreaPath =
        `M ${firstX},${bottomY} L ` + linePts.split(" ").join(" L ") + ` L ${lastX},${bottomY} Z`;

    // Final point marker so the end of the curve is unambiguous.
    const last = points[points.length - 1];
    const lastDotX = xAt(points.length - 1);
    const lastDotY = yAt(last.we);
    const lastIsHomeFav = last.we >= 0.5;

    // Inning tick marks — only major innings (1, 3, 5, 7, 9) to keep
    // axis legible. We skip the "pre-game" point's label.
    const ticks = points.map((p, i) => ({ idx: i, p })).filter(
        ({ p }) => p.inning > 0 && [1, 3, 5, 7, 9].includes(p.inning) && p.half === "bottom"
    );

    const homeAbbr = "HOME";  // We don't have team abbrs here; could pass them in
    const awayAbbr = "AWAY";

    // Interactive markers — one circle per data point, hoverable. Bigger
    // for the biggest-swing and for the final/current point. data-point
    // carries the JSON the tooltip displays. With ~70+ PAs per game, we
    // shrink the per-PA dots to 1.8 to keep the curve readable; the
    // biggest swing + the most recent point stay larger.
    const markersSvg = points.map((p, i) => {
        const x = xAt(i);
        const y = yAt(p.we);
        const isBiggest = !!p.biggest_swing;
        const isLast    = i === points.length - 1;
        const r = isBiggest ? 5 : isLast ? 3.5 : 1.8;
        const fill = isBiggest
            ? "var(--accent-live)"
            : isLast
                ? (p.we >= 0.5 ? "var(--accent-win)" : "var(--accent-live)")
                : "var(--accent-action)";
        const cls = `trace-marker${isBiggest ? " biggest" : ""}${isLast ? " final" : ""}`;
        const payload = JSON.stringify({
            i,
            inning: p.inning,
            half:   p.half,
            outs:   p.outs ?? 0,
            bases:  p.bases ?? 0,
            home:   p.home,
            away:   p.away,
            we:     p.we,
            event:  p.event,
            description: p.description,
            batter:     p.batter,
            batter_id:  p.batter_id,
            pitcher:    p.pitcher,
            pitcher_id: p.pitcher_id,
            we_delta: p.we_delta,
            biggest_swing: isBiggest,
            pitches: p.pitches || null,
        }).replace(/"/g, "&quot;");
        return `
          <circle class="${cls}"
                  cx="${x.toFixed(1)}" cy="${y.toFixed(1)}"
                  r="${r}"
                  fill="${fill}"
                  stroke="var(--bg)" stroke-width="1.5"
                  data-trace-idx="${i}"
                  data-trace-point="${payload}"
                  tabindex="0"/>
        `;
    }).join("");

    // Big-swing call-out below the chart (text version of the biggest_swing
    // marker so it's discoverable even without hovering).
    const biggest = points.find((p) => p.biggest_swing);
    let biggestLine = "";
    if (biggest) {
        const deltaPct = Math.round((biggest.we_delta || 0) * 100);
        const sign = deltaPct >= 0 ? "+" : "";
        const innLabel = `${biggest.half === "top" ? "▲" : "▼"} ${ordinalSuffix(biggest.inning).toLowerCase()}`;
        const what = biggest.event ? biggest.event : "Big swing";
        biggestLine = `
          <div class="trace-biggest">
            <span class="tb-dot"></span>
            Biggest swing: <strong>${sign}${deltaPct}%</strong>
            in the ${innLabel} — ${what}.
          </div>`;
    }

    return `
      <div class="card trace-card">
        <div class="trace-head">
          <span class="trace-label">WE TRACE</span>
          <span class="trace-meta">${points.length - 1} plate appearance${points.length - 1 === 1 ? "" : "s"} · hover any point</span>
        </div>
        <div class="trace-chart-wrap"
             data-trace-w="${W}" data-trace-h="${H}"
             data-trace-pad-l="${PAD.l}" data-trace-pad-r="${PAD.r}"
             data-trace-n="${points.length}">
          <svg class="trace-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
            <defs>
              <linearGradient id="we-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stop-color="rgba(34, 197, 94, 0.35)"/>
                <stop offset="50%"  stop-color="rgba(34, 197, 94, 0.05)"/>
                <stop offset="100%" stop-color="rgba(239, 68, 68, 0.05)"/>
              </linearGradient>
            </defs>
            <line x1="${PAD.l}" y1="${refY.toFixed(1)}" x2="${(W - PAD.r).toFixed(1)}" y2="${refY.toFixed(1)}"
                  stroke="rgba(148, 163, 184, 0.25)" stroke-dasharray="3,4" stroke-width="1"/>
            <path d="${homeAreaPath}" fill="url(#we-grad)"/>
            <polyline points="${linePts}" fill="none"
                      stroke="var(--accent-action)" stroke-width="2"
                      stroke-linejoin="round" stroke-linecap="round"/>
            <!-- Transparent overlay rect captures pointer events anywhere
                 in the chart area — gives users a continuous hover surface
                 instead of having to land on tiny 1.8px PA dots. Painted
                 BEFORE markers so markers and guides remain interactive
                 (overlay sits underneath in paint order). -->
            <rect class="trace-overlay" x="0" y="0" width="${W}" height="${H}"
                  fill="transparent"/>
            <!-- Crosshair guide (hidden until mouseenter on the chart). One
                 vertical line + a follower dot. Both repositioned by the
                 chart-hover handler in viewBox coordinates. -->
            <line class="trace-guide" x1="0" y1="${PAD.t}" x2="0" y2="${(H - PAD.b).toFixed(1)}"
                  stroke="rgba(255,255,255,0.32)" stroke-width="1" stroke-dasharray="2,3"
                  visibility="hidden"/>
            <circle class="trace-guide-dot" r="3.5"
                    fill="var(--accent-action)" stroke="var(--bg)" stroke-width="1.5"
                    visibility="hidden"/>
            ${markersSvg}
          </svg>
          <div class="trace-tooltip" hidden></div>
        </div>
        <div class="trace-axis">
          <span class="trace-axis-end left">start</span>
          <span class="trace-axis-end right">${data.status === "Final" ? "final" : "now"}</span>
        </div>
        ${biggestLine}
        ${data.status === "Final"
            // Final games already show the outcome prominently in the main
            // card pane above (the "AZ 100%" answer + the final score in
            // the subject line). Repeating "Home at 100% (final)" under
            // the chart is just noise — drop it for Final games.
            ? ""
            : `<div class="trace-foot">
                 ${last.we >= 0.5
                   ? `Home at <strong>${Math.round(last.we * 100)}%</strong> right now.`
                   : `Home at <strong>${Math.round(last.we * 100)}%</strong> — away favored right now.`}
               </div>`}
      </div>
    `;
}

// Document-level delegation for trace-marker hover + chart-area hover.
// The chart-area handler (mousemove anywhere over .trace-chart-wrap)
// gives users a continuous hover surface — they don't have to land on
// the small per-PA dots. As the cursor moves, we snap to the nearest
// PA index, render a vertical guide line + follower dot at that index,
// and show its tooltip. Clicking a marker still pins it.
let tracePinnedMarker = null;
let traceHoverFrame = null;   // requestAnimationFrame token for throttling
document.addEventListener("mouseover", (e) => {
    const marker = e.target.closest(".trace-marker");
    if (!marker || tracePinnedMarker) return;
    showTraceTooltip(marker);
});
// Mouseout: hide when the cursor leaves the chart area entirely (the
// chart-wrap, the tooltip, OR a marker) AND isn't moving into one of
// those safe targets. This lets the user move freely between marker →
// tooltip → another marker without the tooltip vanishing under them.
document.addEventListener("mouseout", (e) => {
    if (tracePinnedMarker) return;
    const leftWrap    = e.target.closest(".trace-chart-wrap");
    const leftTooltip = e.target.closest(".trace-tooltip");
    if (!leftWrap && !leftTooltip) return;
    const intoSafe = e.relatedTarget?.closest?.(".trace-chart-wrap, .trace-tooltip");
    if (intoSafe) return;
    hideTraceTooltip();
    hideTraceGuide();
});
// Continuous-hover handler — anywhere in the chart, snap to the nearest
// PA's marker, show its tooltip, and draw a vertical guide line. rAF-
// throttled so we re-position at most once per frame even on fast
// mouse moves. Pinned state takes precedence.
document.addEventListener("mousemove", (e) => {
    const wrap = e.target.closest(".trace-chart-wrap");
    if (!wrap) return;
    if (tracePinnedMarker) return;
    if (traceHoverFrame) return;  // already queued for this frame
    traceHoverFrame = requestAnimationFrame(() => {
        traceHoverFrame = null;
        updateChartHover(wrap, e.clientX);
    });
});

function updateChartHover(wrap, mouseClientX) {
    const svg = wrap.querySelector(".trace-svg");
    if (!svg) return;
    // Map mouse client-x into the SVG's viewBox coordinate space. The
    // SVG uses preserveAspectRatio="none" so width stretches linearly.
    const rect = wrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const vbW = parseFloat(wrap.dataset.traceW);
    const padL = parseFloat(wrap.dataset.tracePadL);
    const padR = parseFloat(wrap.dataset.tracePadR);
    const n    = parseInt(wrap.dataset.traceN, 10);
    if (!Number.isFinite(vbW) || n < 2) return;

    const mxView = ((mouseClientX - rect.left) / rect.width) * vbW;
    const innerW = vbW - padL - padR;
    const frac   = (mxView - padL) / innerW;
    const idx    = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));

    const marker = svg.querySelector(`.trace-marker[data-trace-idx="${idx}"]`);
    if (!marker) return;
    showTraceTooltip(marker);

    // Snap guide line + dot to this marker's (cx, cy).
    const guide = svg.querySelector(".trace-guide");
    const dot   = svg.querySelector(".trace-guide-dot");
    if (guide && dot) {
        const cx = marker.getAttribute("cx");
        const cy = marker.getAttribute("cy");
        guide.setAttribute("x1", cx);
        guide.setAttribute("x2", cx);
        guide.setAttribute("visibility", "visible");
        dot.setAttribute("cx", cx);
        dot.setAttribute("cy", cy);
        dot.setAttribute("visibility", "visible");
    }
}

function hideTraceGuide() {
    document.querySelectorAll(".trace-guide, .trace-guide-dot").forEach((el) => {
        el.setAttribute("visibility", "hidden");
    });
}
document.addEventListener("click", (e) => {
    const marker = e.target.closest(".trace-marker");
    if (marker) {
        e.preventDefault();
        tracePinnedMarker = marker;
        showTraceTooltip(marker);
        return;
    }
    // Click inside the tooltip on a link → follow it; don't unpin.
    if (tracePinnedMarker && e.target.closest(".trace-tooltip a")) {
        return;
    }
    if (tracePinnedMarker && !e.target.closest(".trace-tooltip")) {
        tracePinnedMarker = null;
        hideTraceTooltip();
        hideTraceGuide();
    }
});

function showTraceTooltip(marker) {
    const wrap = marker.closest(".trace-chart-wrap");
    const tip = wrap?.querySelector(".trace-tooltip");
    if (!tip) return;
    let data;
    try { data = JSON.parse(marker.dataset.tracePoint); }
    catch { return; }

    const arrow = data.half === "top" ? "▲" : data.half === "bottom" ? "▼" : "·";
    const innLabel = data.inning === 0
        ? "PRE-GAME"
        : `${arrow} ${ordinalSuffix(data.inning).toUpperCase()}`;
    const we = Math.round(data.we * 100);
    const score = `${data.away}-${data.home}`;

    // Delta vs the previous point (or vs pre-game baseline for the first
    // PA). If we_delta isn't on the payload (e.g. demo path didn't compute
    // it), suppress the line rather than showing a meaningless 0%.
    const haveDelta = data.we_delta != null;
    const delta = haveDelta
        ? `${data.we_delta >= 0 ? "+" : ""}${Math.round(data.we_delta * 100)}%`
        : "";
    const deltaClass = haveDelta
        ? (data.we_delta >= 0 ? "tt-delta tt-delta-up" : "tt-delta tt-delta-down")
        : "";

    const swingNote = data.biggest_swing
        ? ` <span class="tt-swing">biggest swing ${delta}</span>`
        : haveDelta
            ? ` <span class="${deltaClass}">${delta}</span>`
            : "";

    // Situation strip: outs dots (●●○ pattern) + bases diamond (small SVG).
    // Pre-game point has inning 0 and no real situation; skip the strip.
    const situationLine = data.inning > 0
        ? `<div class="tt-situation">
              ${renderOutsDots(data.outs)}
              ${renderBasesGlyph(data.bases)}
              <span class="tt-bases-label">${describeBasesShort(data.bases)}</span>
           </div>`
        : "";

    const eventLine = data.event
        ? `<div class="tt-event">${data.event}</div>`
        : "";
    const descLine = data.description
        ? `<div class="tt-desc">${escapeHTML(data.description)}</div>`
        : "";

    // Batter / pitcher names — clickable when we have IDs, so the user can
    // jump from "who moved the curve here" to the player profile.
    // Tiny avatars next to the names so the player is recognizable
    // without reading.
    const batterHtml = data.batter
        ? (data.batter_id
            ? `<a class="tt-link tt-link-with-photo" href="#player/${data.batter_id}">${inlineAvatar(data.batter_id, { size: 26, class: "tt-photo", alt: data.batter })}${shortName(data.batter)}</a>`
            : `<span class="tt-link-with-photo">${inlineAvatar(null, { size: 26, class: "tt-photo" })}${shortName(data.batter)}</span>`)
        : "";
    const pitcherHtml = data.pitcher
        ? (data.pitcher_id
            ? `<a class="tt-link tt-link-with-photo" href="#player/${data.pitcher_id}">${inlineAvatar(data.pitcher_id, { size: 26, class: "tt-photo", alt: data.pitcher })}${shortName(data.pitcher)}</a>`
            : `<span class="tt-link-with-photo">${inlineAvatar(null, { size: 26, class: "tt-photo" })}${shortName(data.pitcher)}</span>`)
        : "";
    const playersLine = (batterHtml && pitcherHtml)
        ? `<div class="tt-players">${batterHtml} vs ${pitcherHtml}</div>`
        : "";

    // Pitch-by-pitch progression — when the PA's playEvents are
    // attached, render each pitch as a tight one-line row showing the
    // pitch type, velocity, result, and the count after. Last-pitch
    // result gets colored by whether it was the PA-ending one. Skipped
    // entirely when the trace doesn't have per-pitch data (e.g. the
    // demo game, which uses per-half summaries instead).
    const pitchesBlock = (data.pitches && data.pitches.length)
        ? renderPitchSequence(data.pitches)
        : "";

    tip.innerHTML = `
      <div class="tt-head">
        <span class="tt-inning">${innLabel}</span>
        <span class="tt-score">${score}</span>
        <span class="tt-we">${we}%</span>${swingNote}
      </div>
      ${situationLine}
      ${eventLine}
      ${playersLine}
      ${descLine}
      ${pitchesBlock}
    `;

    // Position the tooltip near the marker, but stay inside the chart wrap.
    const wrapRect = wrap.getBoundingClientRect();
    const mRect = marker.getBoundingClientRect();
    const mxInWrap = mRect.left + mRect.width / 2 - wrapRect.left;
    const myInWrap = mRect.top  + mRect.height / 2 - wrapRect.top;

    // Default: tooltip BELOW the marker; if it would overflow, swap above.
    tip.hidden = false;
    const ttRect = tip.getBoundingClientRect();
    let left = mxInWrap - ttRect.width / 2;
    let top  = myInWrap + 12;
    if (left < 4) left = 4;
    if (left + ttRect.width > wrapRect.width - 4) {
        left = wrapRect.width - ttRect.width - 4;
    }
    if (top + ttRect.height > wrapRect.height + 80) {
        top = myInWrap - ttRect.height - 10;
    }
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;
}

function hideTraceTooltip() {
    document.querySelectorAll(".trace-tooltip").forEach((tip) => { tip.hidden = true; });
}

// Loads the LLM-generated recap for a Final game. Server-side caches in
// game_recaps, so the first user hitting a freshly-Final game pays the
// Anthropic call; every subsequent request (this session or others)
// returns the cached row instantly.
async function hydrateRecap(gameId) {
    // Same key as cached row → no reload needed.
    if (cachedRecapPk === gameId && cachedRecapSlot) return;
    try {
        const res = await fetch(`/api/game/${gameId}/recap`);
        if (!res.ok) return;
        const data = await res.json();
        if (gameId !== String(activeGameId)) return;
        const slot = document.getElementById("recap-slot");
        if (!slot) return;
        const html = renderRecapCard(data);
        slot.innerHTML = html;
        cachedRecapSlot = html;
        cachedRecapPk = gameId;
    } catch {
        // silent — slot stays empty, page still works
    }
}

function renderRecapCard(d) {
    if (d.unavailable) {
        // Most common: ANTHROPIC_API_KEY not set, or game not yet Final.
        return `
          <div class="card recap-card recap-unavailable">
            <div class="recap-head">
              <span class="recap-label">RECAP</span>
            </div>
            <div class="recap-empty">${d.reason || "Recap unavailable."}</div>
          </div>
        `;
    }
    if (!d.recap) return "";
    // The recap text is plain prose with paragraph breaks — convert
    // double newlines into <p> tags so it lays out cleanly.
    const paragraphs = d.recap
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${escapeHTML(p)}</p>`)
        .join("");
    const meta = d.cached
        ? `<span class="recap-meta">cached · auto-generated</span>`
        : `<span class="recap-meta">fresh · auto-generated</span>`;
    return `
      <div class="card recap-card">
        <div class="recap-head">
          <span class="recap-label">RECAP</span>
          ${meta}
        </div>
        <div class="recap-body">${paragraphs}</div>
        <div class="recap-foot">
          Generated by ${d.model || "Claude"} from our play-by-play and
          predicted-vs-actual data.
          <a href="#about" class="recap-link">How it works</a>.
        </div>
      </div>
    `;
}

// HTML-escape so user-controllable content (player names, etc., though
// these come from MLB API and are already safe) never breaks rendering
// or opens an XSS vector.
function escapeHTML(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Hot/cold pill for one player. Reads the recency form factors from
// the matchup response — the per-outcome ratios of last-30d rate vs
// season rate, regressed by sample. Hit-rate ratio is what fans
// care about most for batters; for pitchers we flip it (their job
// is to suppress hits, so high hit-rate factor = pitcher is COLD).
function renderFormPill(name, form, role) {
    // Need ≥ 30 daily PAs/BFs to show a form signal at all — below
    // that the regression toward 1.0 makes the ratio meaningless and
    // a "hot" pill on a 12-PA sample is just noise.
    if (!form || form.sample_pa < 30) return "";

    const hitFactor = form.hit_rate_factor;
    // For batters: high hit-rate factor = hot. For pitchers: high
    // means batters are hitting them well = COLD pitcher.
    const isHot  = role === "batter"  ? hitFactor >= 1.10 : hitFactor <= 0.90;
    const isCold = role === "batter"  ? hitFactor <= 0.90 : hitFactor >= 1.10;
    if (!isHot && !isCold) return "";

    const lastName = name.split(/\s+/).pop();
    const emoji = isHot ? "🔥" : "🧊";
    const label = isHot ? "hot" : "cold";
    const pct = Math.round((hitFactor - 1) * 100);
    const sign = pct >= 0 ? "+" : "";
    const tooltip = role === "batter"
        ? `${lastName} has been ${label} recently — hit rate ${sign}${pct}% vs his season baseline (last 30 days weighted heavier). The matchup prediction is adjusted for this.`
        : `${lastName} has been ${label} recently — batters' hit rate against him ${sign}${pct}% vs his season baseline. The matchup prediction is adjusted for this.`;
    const cls = isHot ? "form-hot" : "form-cold";
    return `<span class="form-pill ${cls}" title="${tooltip}">${emoji} ${lastName} ${label}</span>`;
}

function renderMatchupCard(m) {
    const entries = Object.entries(m.predicted)
        .sort((a, b) => b[1] - a[1]);
    // Scale bar widths so the most-likely outcome's bar reaches ~100%.
    const top = entries[0][1] || 1;
    const rows = entries.map(([o, p]) => {
        const pct = Math.round(p * 100);
        const width = Math.round((p / top) * 100);
        // Each row is a <details> so the user can expand to see exactly
        // what feeds the prediction — the brand thesis ("every number
        // explains itself") expressed in the most concrete possible way.
        return `
          <details class="outcome-detail">
            <summary class="outcome-row">
              <span class="outcome-label">${OUTCOME_LABEL[o] || o}</span>
              <span class="outcome-bar"><span style="width:${width}%"></span></span>
              <span class="outcome-pct">${pct}%</span>
              <span class="outcome-caret" aria-hidden="true">▾</span>
            </summary>
            ${explainOutcome(o, m)}
          </details>
        `;
    }).join("");

    const liveBatter = m.sample.batter_pa_current_season || 0;
    const livePitcher = m.sample.pitcher_bf_current_season || 0;
    const liveTotal = liveBatter + livePitcher;
    // The model gets fresher every morning's ingest. Show the user how many
    // current-season PAs are in this prediction's sample so the "learns
    // over time" promise is visible, not just claimed.
    const liveLine = liveTotal > 0
        ? `<div class="live-sample">
             <span class="dot"></span>
             Plus ${liveBatter.toLocaleString()} fresh plate appearances from ${shortName(m.batter.name)}
             and ${livePitcher.toLocaleString()} from ${shortName(m.pitcher.name)} this season.
           </div>`
        : "";

    // "What have they actually done this season?" — strictly the daily_pa
    // outcomes, no prediction math layered on top. Honest descriptive
    // counterpoint to the predicted distribution above.
    const rf = m.recent_form;
    const recentForm = (rf && (rf.batter.pa > 0 || rf.pitcher.bf > 0))
        ? `
          <div class="recent-form">
            <div class="recent-form-head">Recent form · current season</div>
            ${rf.batter.pa > 0
                ? `<div class="rf-row">
                     <span class="rf-label">${shortName(m.batter.name)}</span>
                     <span class="rf-stats">${describeRecentOutcomes(rf.batter.pa, rf.batter.outcomes)}</span>
                   </div>`
                : ""}
            ${rf.pitcher.bf > 0
                ? `<div class="rf-row">
                     <span class="rf-label">${shortName(m.pitcher.name)}</span>
                     <span class="rf-stats">${describeRecentOutcomes(rf.pitcher.bf, rf.pitcher.outcomes)}</span>
                   </div>`
                : ""}
          </div>
        `
        : "";

    // Count-aware badge: when the per-count rates kicked in, surface the
    // count so the user knows the prediction shifted because of where
    // the PA actually is, not just "Judge vs Kershaw average."
    const countBadge = m.count_aware
        ? `<span class="count-aware-badge" title="Prediction shifts because of the current ${m.count.balls}-${m.count.strikes} count. ${m.batter.name} has ${m.count.batter_pa} PAs and ${m.pitcher.name} has ${m.count.pitcher_bf} BF at this exact count in our Statcast 2020-2024 sample.">
              ${m.count.balls} balls · ${m.count.strikes} strikes ⓘ
           </span>`
        : "";

    // Form pills — show when a player is meaningfully hot or cold
    // recently. Hit-rate factor: 1.10+ is hot, 0.90- is cold (10%
    // deviation from career baseline after sample-size regression).
    // Suppress when there isn't enough recent data (need ≥ 30 PAs).
    const batterForm = renderFormPill(m.batter.name, m.form?.batter, "batter");
    const pitcherForm = renderFormPill(m.pitcher.name, m.form?.pitcher, "pitcher");

    return `
      <div class="card matchup-card">
        <div class="subject">
          <a class="mc-avatar" href="#player/${m.batter.mlbam}" aria-label="${m.batter.name}"><img src="${playerHeadshotSpot(m.batter.mlbam, 120)}" alt="" loading="lazy" onerror="this.style.opacity='0';"/></a>
          <a class="player-link" href="#player/${m.batter.mlbam}">${m.batter.name}</a> (${m.batter.bats}HB)
          <span class="mc-vs">vs</span>
          <a class="mc-avatar" href="#player/${m.pitcher.mlbam}" aria-label="${m.pitcher.name}"><img src="${playerHeadshotSpot(m.pitcher.mlbam, 120)}" alt="" loading="lazy" onerror="this.style.opacity='0';"/></a>
          <a class="player-link" href="#player/${m.pitcher.mlbam}">${m.pitcher.name}</a> (${m.pitcher.throws}HP)
        </div>
        ${(batterForm || pitcherForm) ? `<div class="form-strip">${batterForm}${pitcherForm}</div>` : ""}

        <div class="question">How is this plate appearance likely to end? ${countBadge}</div>
        <div class="outcome-table">${rows}</div>

        <div class="evidence">
          Based on ${shortName(m.batter.name)}'s ${m.sample.batter_pa.toLocaleString()}
          plate appearances vs ${handPhrase(m.pitcher.throws)} pitchers and
          ${shortName(m.pitcher.name)}'s ${m.sample.pitcher_bf.toLocaleString()}
          ${handPhrase(m.batter.bats)} batters faced (${m.years.start}–${m.years.end}).
          <a href="#about" class="evidence-link">How it works</a>.
        </div>
        ${liveLine}
        ${recentForm}
        <div id="matchup-prop-chips-slot"></div>
      </div>
    `;
}

// Pull the FULL all-MLB markets bundle (not just game-tagged) and
// surface player props for the current batter + pitcher under the
// matchup card's outcome distribution. Pulls from /api/markets
// because player props mostly don't bind to game tricodes — they
// live as season-long markets named by player only.
async function hydrateMatchupPropChips(gameId, batterName, pitcherName) {
    if (!gameId || (!batterName && !pitcherName)) return;
    try {
        const res = await fetch(`/api/markets`);
        if (!res.ok) return;
        const data = await res.json();
        const slot = document.getElementById("matchup-prop-chips-slot");
        if (!slot) return;
        const all = data?.markets?.player_prop || [];
        const batterMatches  = filterMarketsByPlayerName(all, batterName);
        const pitcherMatches = filterMarketsByPlayerName(all, pitcherName);
        slot.innerHTML = renderMatchupPropStrips(batterName, batterMatches, pitcherName, pitcherMatches);
    } catch { /* silent */ }
}

function renderMatchupPropStrips(batterName, batterMatches, pitcherName, pitcherMatches) {
    const strip = (label, matches) => {
        if (!matches || !matches.length) return "";
        const chips = matches.slice(0, 6).map((m) => {
            const outcomes = (m.outcomes || []).slice().sort((a, b) => (b.probability || 0) - (a.probability || 0));
            const best = outcomes[0];
            const pct = best?.probability != null ? fmtPct(best.probability) : "—";
            return `
              <a class="mc-prop-chip" href="${m.url || "#"}" target="_blank" rel="noopener" title="${escapeHTMLAttr(m.title)}">
                <span class="mc-prop-chip-side">${escapeHTML((best?.name || "").trim())}</span>
                <span class="mc-prop-chip-pct">${pct}</span>
                <span class="mc-prop-chip-src">${m.source || "?"}</span>
              </a>
            `;
        }).join("");
        return `
          <div class="mc-prop-strip-row">
            <div class="mc-prop-strip-label">${escapeHTML(label)} props</div>
            <div class="mc-prop-strip-chips">${chips}</div>
          </div>
        `;
    };
    const batter  = strip(batterName,  batterMatches);
    const pitcher = strip(pitcherName, pitcherMatches);
    if (!batter && !pitcher) return "";
    return `
      <div class="mc-prop-strip">
        <div class="mc-prop-strip-head">Market lines on this matchup</div>
        ${batter}
        ${pitcher}
      </div>
    `;
}

// "R" → "right-handed", "L" → "left-handed". Switch-hitters (S) face
// pitchers from the opposite side, so for label purposes either word
// works — keep it short.
function handPhrase(code) {
    if (code === "R") return "right-handed";
    if (code === "L") return "left-handed";
    return "either-handed";
}

// "Why is this prediction what it is?" — the breakdown for one outcome
// bucket. Shows the three ingredients to the odds-ratio prediction
// (batter rate, pitcher rate, league baseline) plus a one-line narrative
// comparing the combined number to league average. The brand thesis
// ("every number explains itself") rendered in HTML.
function explainOutcome(o, m) {
    const b  = (m.batter_rates[o]  || 0) * 100;
    const p  = (m.pitcher_rates[o] || 0) * 100;
    const lg = (m.league[o]        || 0) * 100;
    const combined = (m.predicted[o] || 0) * 100;
    const label = OUTCOME_LABEL[o] || o;

    // Tilt: how much above / below league baseline is each side, and
    // which side is doing more of the pulling. Drives the narrative.
    const ratio = (x) => lg > 0 ? x / lg : 1;
    const batterTilt  = ratio(b);
    const pitcherTilt = ratio(p);
    const combinedTilt = ratio(combined);

    let narrative;
    if (combinedTilt >= 1.15) {
        const driver = batterTilt > pitcherTilt
            ? `${shortName(m.batter.name)} ${label.toLowerCase()}s ${pct(batterTilt - 1)} more than league`
            : `${shortName(m.pitcher.name)} allows ${label.toLowerCase()} ${pct(pitcherTilt - 1)} more than league`;
        narrative = `Above league avg — ${driver}.`;
    } else if (combinedTilt <= 0.85) {
        const driver = batterTilt < pitcherTilt
            ? `${shortName(m.batter.name)} ${label.toLowerCase()}s ${pct(1 - batterTilt)} less than league`
            : `${shortName(m.pitcher.name)} allows ${label.toLowerCase()} ${pct(1 - pitcherTilt)} less than league`;
        narrative = `Below league avg — ${driver}.`;
    } else {
        narrative = `Near league average.`;
    }

    return `
      <div class="outcome-breakdown">
        <div class="bd-row">
          <span class="bd-label">Batter</span>
          <span class="bd-value">${b.toFixed(1)}%</span>
          <span class="bd-note">${shortName(m.batter.name)} vs ${m.pitcher.throws}HP</span>
        </div>
        <div class="bd-row">
          <span class="bd-label">Pitcher</span>
          <span class="bd-value">${p.toFixed(1)}%</span>
          <span class="bd-note">${shortName(m.pitcher.name)} vs ${m.batter.bats}HB</span>
        </div>
        <div class="bd-row">
          <span class="bd-label">League</span>
          <span class="bd-value">${lg.toFixed(1)}%</span>
          <span class="bd-note">baseline ${m.batter.bats}HB vs ${m.pitcher.throws}HP</span>
        </div>
        <div class="bd-row total">
          <span class="bd-label">Combined</span>
          <span class="bd-value">${combined.toFixed(1)}%</span>
          <span class="bd-note">${narrative}</span>
        </div>
      </div>
    `;
}

function pct(x) {
    return `${Math.round(x * 100)}%`;
}

// Compact descriptive outcome line: "25 PA — 7 K · 3 BB · 1 HR · 5 H · 12 OUT".
// Only includes outcome buckets that actually fired so the line stays short.
function describeRecentOutcomes(total, outcomes) {
    const k = outcomes.K || 0;
    const bb = (outcomes.BB || 0) + (outcomes.HBP || 0);
    const hr = outcomes.HR || 0;
    const hits = (outcomes["1B"] || 0) + (outcomes["2B"] || 0) +
                 (outcomes["3B"] || 0) + hr;
    const outs = outcomes.OUT || 0;
    const parts = [];
    if (k) parts.push(`${k} K`);
    if (bb) parts.push(`${bb} BB`);
    if (hr) parts.push(`${hr} HR`);
    if (hits) parts.push(`${hits} H`);
    if (outs) parts.push(`${outs} OUT`);
    return `${total} PA — ${parts.join(" · ")}`;
}

// One-sentence "why is this team favored?" — picks the most salient
// state factor (score, base situation, late-inning leverage) and
// builds a short explainer. Shown under the bar labels on Live games
// so users see why the number is what it is, not just the number.
function whyFavored(g, we, favoredAbbr) {
    if (g.status !== "Live" || !g.inning) return "";
    const homeAbbr = g.teams.home.abbr;
    const awayAbbr = g.teams.away.abbr;
    const otherAbbr = favoredAbbr === homeAbbr ? awayAbbr : homeAbbr;

    const lead    = (g.score?.home ?? 0) - (g.score?.away ?? 0);
    const margin  = Math.abs(lead);
    const inning  = g.inning;
    const half    = g.half;
    const outs    = g.outs ?? 0;
    const bases   = (g.runners?.first ? 1 : 0) | (g.runners?.second ? 2 : 0) | (g.runners?.third ? 4 : 0);
    const balls   = g.balls ?? 0;
    const strikes = g.strikes ?? 0;
    const battingAbbr = half === "bottom" ? homeAbbr : awayAbbr;
    const innOrd  = ordinalSuffix(inning).toLowerCase();
    const fullCount = balls === 3 && strikes === 2;

    // Coin-flip range: no clear favorite, explain the leverage.
    if (Math.abs(we - 0.5) < 0.05) {
        if (bases === 7) return `Bases loaded with ${outs} out — any contact swings it.`;
        if (margin === 0 && inning >= 9) return `Tied in extras — every pitch matters.`;
        if (margin === 0) return `Tied in the ${innOrd} — a true coin flip.`;
        return `Within a run — the next PA decides the leverage.`;
    }

    const parts = [];

    // Lead is the single biggest factor.
    if (margin >= 5) {
        parts.push(`${favoredAbbr} up ${margin}`);
    } else if (margin >= 2 && inning >= 7) {
        parts.push(`${favoredAbbr} up ${margin} in the late innings`);
    } else if (margin >= 1) {
        parts.push(`${favoredAbbr} up ${margin}`);
    } else {
        // Tied — the situation IS the story.
        parts.push(`tied in the ${innOrd}`);
    }

    // Base situation when interesting.
    if (bases === 7) parts.push(`${battingAbbr} bases loaded`);
    else if (bases === 6) parts.push(`${battingAbbr} runners on 2nd & 3rd`);
    else if ((bases & 4) && outs <= 1) parts.push(`${battingAbbr} runner on 3rd, ${outs} out`);
    else if (bases === 2 && inning >= 10) parts.push(`ghost runner on 2nd`);

    // Outs + count for leverage.
    if (outs === 2 && fullCount) parts.push(`2 outs, full count`);
    else if (outs === 2 && (bases & 4)) parts.push(`2 outs (runner on 3rd needs the hit)`);
    else if (fullCount && bases !== 0) parts.push(`full count`);

    // Team form mention when the team-strength adjustment is meaningful
    // (≥ 2pp shift either direction). Tells the user the WE moved off
    // baseline because of recent record / Pythagorean, not just state.
    const tDelta = g.team_adjustment?.delta_from_baseline || 0;
    if (Math.abs(tDelta) >= 0.02) {
        const homeForm = g.team_adjustment?.home;
        const awayForm = g.team_adjustment?.away;
        const homeHot = homeForm?.l10?.pct >= 0.6 || (homeForm?.streak && homeForm.streak.startsWith("W"));
        const awayHot = awayForm?.l10?.pct >= 0.6 || (awayForm?.streak && awayForm.streak.startsWith("W"));
        const hotTeam = tDelta > 0
            ? (homeHot ? homeAbbr : null)
            : (awayHot ? awayAbbr : null);
        if (hotTeam) {
            const form = tDelta > 0 ? homeForm : awayForm;
            const desc = form.l10
                ? `${form.l10.w}-${form.l10.l} L10`
                : (form.streak || "rolling");
            parts.push(`${hotTeam} ${desc}`);
        }
    }

    return parts.join(" · ") + ".";
}

// Team-strength comparison card — surfaces the team-form data that
// drives the headline WE adjustment. Without this, users see the WE
// number shifted off baseline but can't see WHY (other than the brief
// "AZ 11-4 L10" mention in the why-line). The card shows both teams
// side-by-side with their season W-L, Pythagorean (luck-adjusted),
// L10, and streak — plus the resulting pregame WE differential.
function renderTeamStrength(g) {
    const ta = g.team_adjustment;
    if (!ta || !ta.home || !ta.away) return "";

    const homeAbbr = g.teams.home.abbr;
    const awayAbbr = g.teams.away.abbr;
    const h = ta.home;
    const a = ta.away;

    // Show only when adjustment is non-trivial (>= 1pp). Below that
    // it's just noise and adds clutter.
    const deltaPp = Math.round(Math.abs(ta.delta_from_baseline) * 100);
    if (deltaPp < 1) return "";

    const favoredAbbr = ta.delta_from_baseline > 0 ? homeAbbr : awayAbbr;
    const favorWord = deltaPp >= 5 ? "favored" : "slight edge";

    const streakClass = (code) => {
        if (!code) return "";
        if (code.startsWith("W")) return "ts-streak-win";
        if (code.startsWith("L")) return "ts-streak-loss";
        return "";
    };

    const renderSide = (abbr, s) => {
        const l10 = s.l10 || {};
        const l30 = s.l30 || {};
        return `
          <div class="ts-side">
            <div class="ts-side-head">
              <span class="ts-abbr">${abbr}</span>
              <span class="ts-record">${s.season_w}-${s.season_l}</span>
              ${s.streak ? `<span class="ts-streak ${streakClass(s.streak)}">${s.streak}</span>` : ""}
            </div>
            <div class="ts-rows">
              <div class="ts-row">
                <span class="ts-key">SEASON</span>
                <span class="ts-val">${fmtAvg(s.season_pct)}</span>
              </div>
              <div class="ts-row">
                <span class="ts-key" title="Pythagorean: RS²/(RS²+RA²) — luck-adjusted true talent">PYTH</span>
                <span class="ts-val">${fmtAvg(s.pyth_pct)}</span>
              </div>
              ${l30.pct != null ? `
                <div class="ts-row">
                  <span class="ts-key">L30</span>
                  <span class="ts-val">${l30.w}-${l30.l} <span class="ts-pct">(${fmtAvg(l30.pct)})</span></span>
                </div>` : ""}
              ${l10.pct != null ? `
                <div class="ts-row">
                  <span class="ts-key">L10</span>
                  <span class="ts-val">${l10.w}-${l10.l} <span class="ts-pct">(${fmtAvg(l10.pct)})</span></span>
                </div>` : ""}
              <div class="ts-row ts-row-bold">
                <span class="ts-key">COMBINED</span>
                <span class="ts-val">${fmtAvg(s.combined_pct)}</span>
              </div>
            </div>
          </div>
        `;
    };

    return `
      <div class="team-strength">
        <div class="ts-head">
          <span class="ts-label">Team form</span>
          <span class="ts-summary">${favoredAbbr} ${favorWord} — shifts WE ${deltaPp}pp from "average teams" baseline</span>
        </div>
        <div class="ts-grid">
          ${renderSide(awayAbbr, a)}
          ${renderSide(homeAbbr, h)}
        </div>
      </div>
    `;
}

function liveRead(g, we) {
    const homeAbbr = g.teams.home.abbr;
    const awayAbbr = g.teams.away.abbr;

    // Final-specific copy: no "from here" / "leaning" — the game's over,
    // either a margin call or a one-score finish. The main card already
    // shouts the winner; this line just colors the outcome.
    if (g.status === "Final") {
        const homeScore = g.score?.home ?? 0;
        const awayScore = g.score?.away ?? 0;
        const margin = Math.abs(homeScore - awayScore);
        if (margin === 0) return "Final.";              // shouldn't happen (ties are rare/impossible in MLB)
        if (margin >= 5)  return "A blowout.";
        if (margin <= 1)  return "Decided by one run.";
        return `Won by ${margin}.`;
    }

    if (Math.abs(we - 0.5) < 0.07) return "A coin flip — every pitch moves the needle.";
    if (we > 0.85) return `${homeAbbr} are heavily favored from here.`;
    if (we > 0.6)  return `${homeAbbr} are leaning into a win.`;
    if (we < 0.15) return `${awayAbbr} are heavily favored from here.`;
    if (we < 0.4)  return `${awayAbbr} are leaning into a win.`;
    return "Anyone's game.";
}

function preGameRead(g) {
    if (g.status === "Preview") {
        const t = g.start_time ? startTimeET(g.start_time) : "";
        return t ? `First pitch ${t} ET.` : "Not yet underway.";
    }
    if (g.status === "Final") {
        const home = g.score.home, away = g.score.away;
        const winner = home > away ? g.teams.home.abbr : away > home ? g.teams.away.abbr : null;
        if (winner) return `${winner} won — ${Math.max(home, away)}-${Math.min(home, away)}.`;
        return "Game complete.";
    }
    return (g.detail || g.status).toUpperCase();
}

function describeBases(runners) {
    if (!runners) return "bases empty";
    const occ = [];
    if (runners.first)  occ.push("1st");
    if (runners.second) occ.push("2nd");
    if (runners.third)  occ.push("3rd");
    if (occ.length === 0) return "bases empty";
    if (occ.length === 3) return "bases loaded";
    if (occ.length === 2 && runners.second && runners.third) return "2nd & 3rd";
    return occ.join(" & ");
}

// Same as describeBases but takes a 0-7 bitmask (bit 0=1st, 1=2nd, 2=3rd) —
// the encoding the per-PA WE trace points carry. Short labels for the
// trace tooltip ("empty" / "loaded" / "1st & 2nd").
function describeBasesShort(bases) {
    const occ = [];
    if (bases & 1) occ.push("1st");
    if (bases & 2) occ.push("2nd");
    if (bases & 4) occ.push("3rd");
    if (occ.length === 0) return "bases empty";
    if (occ.length === 3) return "bases loaded";
    if (occ.length === 2 && (bases & 2) && (bases & 4)) return "2nd & 3rd";
    return occ.join(" & ");
}

// Render the pitch sequence for one PA as a compact monospace block,
// one row per pitch: number, type code, velocity, result, count after.
// Result text is colored by category (strike = orange, ball = blue,
// in_play = green) so the eye can find the action without reading.
// Designed for the trace tooltip so the user can hover a PA dot and
// see HOW the at-bat unfolded, not just its eventual outcome.
function renderPitchSequence(pitches) {
    const resultClass = (res) => {
        if (!res) return "";
        const r = res.toLowerCase();
        if (r.includes("ball"))                      return "tp-ball";
        if (r.includes("called strike"))             return "tp-strike-called";
        if (r.includes("swinging strike"))           return "tp-strike-swing";
        if (r.includes("foul"))                      return "tp-strike-foul";
        if (r.includes("in play"))                   return "tp-in-play";
        if (r.includes("hit by pitch"))              return "tp-hbp";
        return "";
    };
    // Compact result label (MLB calls "Swinging Strike" — we shorten).
    const shortResult = (res) => {
        if (!res) return "";
        const r = res.toLowerCase();
        if (r === "called strike")     return "strike (looking)";
        if (r === "swinging strike")   return "strike (whiff)";
        if (r === "in play, no out")   return "in play (safe)";
        if (r === "in play, out(s)")   return "in play (out)";
        if (r === "in play, run(s)")   return "in play (run)";
        return res.toLowerCase();
    };
    const rows = pitches.map((p) => {
        const velo = p.velo ? `${p.velo.toFixed(0)} mph` : "—";
        const after = (p.b != null && p.s != null) ? `${p.b}-${p.s}` : "";
        return `
          <div class="tt-pitch">
            <span class="tp-num">${p.num}</span>
            <span class="tp-type">${p.type || "?"}</span>
            <span class="tp-velo">${velo}</span>
            <span class="tp-res ${resultClass(p.res)}">${shortResult(p.res)}</span>
            <span class="tp-count">${after}</span>
          </div>
        `;
    }).join("");
    return `
      <div class="tt-pitches">
        <div class="tt-pitches-head">Pitch sequence</div>
        ${rows}
      </div>
    `;
}

// Three-dot outs glyph: ●●○ for 2 out, ●○○ for 1, ○○○ for 0.
function renderOutsDots(outs) {
    const dots = [0, 1, 2].map((i) =>
        `<span class="tt-outs-dot${i < outs ? " on" : ""}"></span>`
    ).join("");
    return `<span class="tt-outs" title="${outs} out">${dots}</span>`;
}

// Tiny baseball-diamond glyph showing which bases are occupied. SVG so it
// scales cleanly inside the tooltip; each base is a diamond filled when
// its bit is set in `bases` (1=1st, 2=2nd, 4=3rd).
function renderBasesGlyph(bases) {
    const fillFor = (occ) =>
        occ ? "var(--accent-action)" : "transparent";
    const stroke = "currentColor";
    return `
      <svg class="tt-bases" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
        <!-- 2nd base (top) -->
        <rect x="7" y="1" width="4" height="4" transform="rotate(45 9 3)"
              fill="${fillFor(bases & 2)}" stroke="${stroke}" stroke-width="0.8"/>
        <!-- 3rd base (left) -->
        <rect x="1" y="7" width="4" height="4" transform="rotate(45 3 9)"
              fill="${fillFor(bases & 4)}" stroke="${stroke}" stroke-width="0.8"/>
        <!-- 1st base (right) -->
        <rect x="13" y="7" width="4" height="4" transform="rotate(45 15 9)"
              fill="${fillFor(bases & 1)}" stroke="${stroke}" stroke-width="0.8"/>
      </svg>
    `;
}

function shortName(fullName) {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length < 2) return fullName;
    return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

function arrowHalf(half) {
    return half === "top" ? "▲" : "▼";
}

// ── SHARED ──────────────────────────────────────────────────────────

function ordinalSuffix(n) {
    if (n >= 11 && n <= 13) return `${n}TH`;
    const last = n % 10;
    return `${n}${last === 1 ? "ST" : last === 2 ? "ND" : last === 3 ? "RD" : "TH"}`;
}

function startTimeET(iso) {
    return new Date(iso).toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric", minute: "2-digit",
    });
}

function stateLabel(g) {
    if (g.status === "Preview") return `${startTimeET(g.start_time)} ET`;
    if (g.status === "Final") return "FINAL";
    if (g.status === "Live" && g.inning) {
        const parts = [`${arrowHalf(g.half)} ${ordinalSuffix(g.inning)}`];
        if (g.outs != null) parts.push(`${g.outs} OUT`);
        if (g.balls != null && g.strikes != null) parts.push(`${g.balls}-${g.strikes}`);
        const bases = basesShort(g.bases || 0);
        if (bases) parts.push(bases);
        return parts.join(" · ");
    }
    return (g.detail || g.status).toUpperCase();
}

// Short text form of the base state — folded into the state line so the tile
// doesn't need a field SVG to convey "runner on 2nd". CSS uppercases.
function basesShort(mask) {
    if (!mask) return null;
    if (mask === 7) return "loaded";
    const labels = [];
    if (mask & 1) labels.push("1st");
    if (mask & 2) labels.push("2nd");
    if (mask & 4) labels.push("3rd");
    return labels.join(" & ");
}

function renderEmpty(container, message, sub) {
    container.innerHTML = `
      <div class="empty">
        <p>${message}</p>
        ${sub ? `<p class="sub">${sub}</p>` : ""}
      </div>
    `;
}
