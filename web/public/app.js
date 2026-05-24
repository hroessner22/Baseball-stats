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

const BOARD_REFRESH_MS = 30_000;
const GAME_REFRESH_MS = 15_000;
const STANDINGS_REFRESH_MS = 5 * 60_000;
const LEADERS_REFRESH_MS = 5 * 60_000;
const MVP_REFRESH_MS = 5 * 60_000;

let boardTimer = null;
let gameTimer = null;
let standingsTimer = null;
let leadersTimer = null;
let mvpTimer = null;
let activeGameId = null;

window.addEventListener("hashchange", handleRoute);
window.addEventListener("load", handleRoute);

function handleRoute() {
    const hash = window.location.hash;
    const m = hash.match(/^#game\/(\d+)/);
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
    if (hash === "#about") {
        showAbout();
        // No nav highlight — the about page is reached from the footer,
        // not the bottom nav.
        setActiveNav(null);
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
}

function showBoard() {
    activeGameId = null;
    if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
    if (standingsTimer) { clearInterval(standingsTimer); standingsTimer = null; }
    if (leadersTimer) { clearInterval(leadersTimer); leadersTimer = null; }
    if (mvpTimer) { clearInterval(mvpTimer); mvpTimer = null; }
    hideAllViews();
    board.hidden = false;
    refreshBoard();
    if (!boardTimer) boardTimer = setInterval(refreshBoard, BOARD_REFRESH_MS);
}

// Cache for the most recent schedule fetch. The Game view's ticker reads
// from here so we don't double-fetch on every Game view refresh.
let scheduleCache = null;

async function refreshBoard() {
    try {
        const res = await fetch("/api/games/today");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        scheduleCache = data;
        if (!data.games || data.games.length === 0) {
            renderEmpty(board, "No games on the schedule today.", "Check back tomorrow.");
            return;
        }

        const sorted = sortGames(data.games);
        board.innerHTML = sorted.map(renderTile).join("");

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
            ? `${p.throws ? p.throws + "HP " : ""}${shortName(p.name)}`
            : "TBA";
        return `
          <div class="tile-extra probables">
            ${fmt(g.probables.away)} <span class="dim">vs</span> ${fmt(g.probables.home)}
          </div>
        `;
    }
    if (g.status === "Final" && g.decisions) {
        const parts = [];
        if (g.decisions.winner) parts.push(`<span class="dim">W</span> ${lastName(g.decisions.winner)}`);
        if (g.decisions.loser)  parts.push(`<span class="dim">L</span> ${lastName(g.decisions.loser)}`);
        if (g.decisions.save)   parts.push(`<span class="dim">S</span> ${lastName(g.decisions.save)}`);
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
    return `
      <div class="player-row ${dim}">
        <span class="label">at bat</span>
        <strong>${fmt(detail?.batter, "bats")}</strong>
      </div>
      <div class="player-row ${dim}">
        <span class="label">pitching</span>
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

// ── (the standalone Featured Game card was retired in favor of expanded
// tiles for every game, sorted by leverage. The picker function `leverage`
// lives up top and now drives sort order. The bigger field SVG and players
// block live inside the tile.) ──







// ── GAME VIEW ────────────────────────────────────────────────────────

function showGameView(id) {
    activeGameId = id;
    if (boardTimer) { clearInterval(boardTimer); boardTimer = null; }
    if (standingsTimer) { clearInterval(standingsTimer); standingsTimer = null; }
    if (leadersTimer) { clearInterval(leadersTimer); leadersTimer = null; }
    if (mvpTimer) { clearInterval(mvpTimer); mvpTimer = null; }
    hideAllViews();
    gameView.hidden = false;
    renderEmpty(gameView, "Loading game…", "");
    refreshGame(id);
    if (gameTimer) clearInterval(gameTimer);
    gameTimer = setInterval(() => refreshGame(id), GAME_REFRESH_MS);
}

// ── STANDINGS VIEW ──────────────────────────────────────────────────

function showStandings() {
    activeGameId = null;
    if (boardTimer) { clearInterval(boardTimer); boardTimer = null; }
    if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
    if (leadersTimer) { clearInterval(leadersTimer); leadersTimer = null; }
    if (mvpTimer) { clearInterval(mvpTimer); mvpTimer = null; }
    hideAllViews();
    standingsView.hidden = false;
    renderEmpty(standingsView, "Loading standings…", "");
    refreshStandings();
    if (!standingsTimer) standingsTimer = setInterval(refreshStandings, STANDINGS_REFRESH_MS);
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
    if (boardTimer) { clearInterval(boardTimer); boardTimer = null; }
    if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
    if (standingsTimer) { clearInterval(standingsTimer); standingsTimer = null; }
    if (mvpTimer) { clearInterval(mvpTimer); mvpTimer = null; }
    hideAllViews();
    leadersView.hidden = false;
    renderEmpty(leadersView, "Loading leaders…", "");
    refreshLeaders();
    if (!leadersTimer) leadersTimer = setInterval(refreshLeaders, LEADERS_REFRESH_MS);
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
    return `
      <li class="leader-row" data-rank="${l.rank}">
        <span class="leader-rank">${l.rank}</span>
        <span class="leader-name">${shortName(l.name)}</span>
        ${team}
        <span class="leader-value">${l.value}</span>
      </li>
    `;
}

// ── MVP / CY YOUNG VIEW ─────────────────────────────────────────────

function showMVP() {
    activeGameId = null;
    if (boardTimer) { clearInterval(boardTimer); boardTimer = null; }
    if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
    if (standingsTimer) { clearInterval(standingsTimer); standingsTimer = null; }
    if (leadersTimer) { clearInterval(leadersTimer); leadersTimer = null; }
    hideAllViews();
    mvpView.hidden = false;
    renderEmpty(mvpView, "Loading MVP race…", "");
    refreshMVP();
    if (!mvpTimer) mvpTimer = setInterval(refreshMVP, MVP_REFRESH_MS);
}

// ── ABOUT VIEW ──────────────────────────────────────────────────────

function showAbout() {
    activeGameId = null;
    if (boardTimer) { clearInterval(boardTimer); boardTimer = null; }
    if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
    if (standingsTimer) { clearInterval(standingsTimer); standingsTimer = null; }
    if (leadersTimer) { clearInterval(leadersTimer); leadersTimer = null; }
    if (mvpTimer) { clearInterval(mvpTimer); mvpTimer = null; }
    hideAllViews();
    aboutView.hidden = false;
    aboutView.innerHTML = renderAbout();
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
        const res = await fetch("/api/mvp");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.races || data.races.length === 0) {
            renderEmpty(mvpView, "MVP race not available.", "Check back later.");
            return;
        }
        mvpView.innerHTML = renderMVP(data);
    } catch (e) {
        renderEmpty(mvpView, "Could not load MVP race.", `${e.message || e}`);
    }
}

function renderMVP(data) {
    return `
      <header class="mvp-head">
        <h2>MVP RACE</h2>
        <span class="mvp-meta">${data.season} season · top 5 by primary stat</span>
      </header>
      <div class="mvp-grid">
        ${data.races.map(renderRaceCard).join("")}
      </div>
      <footer class="mvp-foot">
        Hitters ranked by OPS · Pitchers ranked by ERA. Headline stats only —
        WAR proxies and leverage-weighted contribution will land alongside
        the Deep Dive engine.
      </footer>
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
    return `
      <li class="cand-row" data-rank="${c.rank}">
        <div class="cand-id">
          <span class="cand-rank">${c.rank}</span>
          <span class="cand-name">${shortName(c.name)}</span>
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
            hydrateMatchup(g.batter.id, g.pitcher.id, id);
        }
        if (gameViewMode === "gamecast") {
            refreshGamecast(id);
        }
    } catch (e) {
        renderEmpty(gameView, "Could not load this game.", `${e.message || e}`);
    }
}

// Two presentations of the same live game: the existing Live View (field,
// WE card, matchup card) and the new Gamecast (play-by-play with pitch
// data and predicted-vs-actual). Module-level state so the toggle survives
// the every-15s re-render.
let gameViewMode = "live"; // "live" | "gamecast"
let cachedGamecastHTML = "";

function renderGame(g) {
    const isCast = gameViewMode === "gamecast";
    return `
      <a class="back-link" href="#">← BOARD</a>
      ${renderTicker(g.game_pk, scheduleCache?.games || [])}
      <div class="game-mode-toggle">
        <button class="${!isCast ? 'active' : ''}" data-mode="live">Live View</button>
        <button class="${isCast ? 'active' : ''}" data-mode="gamecast">Gamecast</button>
      </div>
      ${isCast
        ? `<div id="gamecast-pane" class="gamecast-pane">${cachedGamecastHTML || gamecastLoadingShell()}</div>`
        : `<div class="game-pane">
             ${fieldPane(g)}
             ${cardPane(g)}
           </div>`}
    `;
}

function gamecastLoadingShell() {
    return `<div class="gamecast-loading">Loading play-by-play…</div>`;
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
            <strong>${shortName(play.batter.name)}</strong>
            <span class="dim">(${play.batter.hand}HB)</span>
            <span class="dim"> vs </span>
            <strong>${shortName(play.pitcher.name)}</strong>
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
        ${g.batter ? matchupRow("at bat", g.batter.name, `${g.batter.bats}HB`) : ""}
        ${g.pitcher ? matchupRow("pitching", g.pitcher.name, `${g.pitcher.throws}HP`) : ""}
      </div>
    `;
}

function situationStrip(g) {
    if (g.status === "Live" && g.inning) {
        return `
          <div class="situation">
            <span class="inning">${arrowHalf(g.half)} ${ordinalSuffix(g.inning)}</span>
            <span class="dot">·</span>
            <span class="outs">${g.outs} OUT</span>
            <span class="dot">·</span>
            <span class="count">${g.balls}-${g.strikes}</span>
          </div>
        `;
    }
    return `<div class="situation"><span class="state-label">${(g.detail || g.status).toUpperCase()}</span></div>`;
}

function matchupRow(label, name, hand) {
    return `
      <div class="player-row">
        <span class="label">${label}</span>
        <strong>${name}</strong>
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

    return `
      <div class="card-pane">
        <div class="card">
          <div class="subject">
            ${awayAbbr}–${homeAbbr} · ${g.score.away}-${g.score.home}
          </div>
          <div class="situation-line">${stateLine}</div>

          <div class="question">Who is winning?</div>
          <div class="answer">
            <strong>${winning}</strong>
            <span class="pct">${winPct}%</span>
          </div>
          <div class="bar"><span style="width:${homePct}%"></span></div>
          <div class="bar-labels">
            <span>${awayAbbr} ${awayPct}%</span>
            <span>${homeAbbr} ${homePct}%</span>
          </div>

          <div class="evidence">
            From 115 seasons of Retrosheet game logs — how often a team in
            this exact state has won. <a href="#about" class="evidence-link">How it works</a>.
          </div>

          <div class="read">${liveRead(g, we)}</div>
        </div>
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

async function hydrateMatchup(batterMlbam, pitcherMlbam, requestedFor) {
    try {
        const res = await fetch(
            `/api/matchup?batter=${batterMlbam}&pitcher=${pitcherMlbam}`
        );
        if (!res.ok) return;
        const m = await res.json();
        if (requestedFor !== activeGameId) return;
        const slot = document.getElementById("matchup-slot");
        if (!slot || !m.available) return;
        const html = renderMatchupCard(m);
        slot.innerHTML = html;
        cachedMatchupSlot = html;
        cachedMatchupKey = `${batterMlbam}-${pitcherMlbam}`;
    } catch (e) {
        // silently absent — the page works without the matchup card
    }
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

    return `
      <div class="card matchup-card">
        <div class="subject">
          ${m.batter.name} (${m.batter.bats}HB) vs ${m.pitcher.name} (${m.pitcher.throws}HP)
        </div>

        <div class="question">What's about to happen?</div>
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

function liveRead(g, we) {
    const homeAbbr = g.teams.home.abbr;
    const awayAbbr = g.teams.away.abbr;
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
