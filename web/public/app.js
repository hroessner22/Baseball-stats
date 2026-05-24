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
    showBoard();
    setActiveNav("live");
}

function setActiveNav(route) {
    document.querySelectorAll("nav .nav-item").forEach((el) => {
        el.classList.toggle("active", el.dataset.route === route);
    });
}

// ── BOARD ────────────────────────────────────────────────────────────

function showBoard() {
    activeGameId = null;
    if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
    if (standingsTimer) { clearInterval(standingsTimer); standingsTimer = null; }
    if (leadersTimer) { clearInterval(leadersTimer); leadersTimer = null; }
    if (mvpTimer) { clearInterval(mvpTimer); mvpTimer = null; }
    gameView.hidden = true;
    standingsView.hidden = true;
    leadersView.hidden = true;
    mvpView.hidden = true;
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
    board.hidden = true;
    standingsView.hidden = true;
    leadersView.hidden = true;
    mvpView.hidden = true;
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
    board.hidden = true;
    gameView.hidden = true;
    leadersView.hidden = true;
    mvpView.hidden = true;
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
    board.hidden = true;
    gameView.hidden = true;
    standingsView.hidden = true;
    mvpView.hidden = true;
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
    board.hidden = true;
    gameView.hidden = true;
    standingsView.hidden = true;
    leadersView.hidden = true;
    mvpView.hidden = false;
    renderEmpty(mvpView, "Loading MVP race…", "");
    refreshMVP();
    if (!mvpTimer) mvpTimer = setInterval(refreshMVP, MVP_REFRESH_MS);
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
        gameView.innerHTML = renderGame(g);
        if (g.status === "Live" && g.batter?.id && g.pitcher?.id) {
            hydrateMatchup(g.batter.id, g.pitcher.id, id);
        }
    } catch (e) {
        renderEmpty(gameView, "Could not load this game.", `${e.message || e}`);
    }
}

function renderGame(g) {
    return `
      <a class="back-link" href="#">← BOARD</a>
      ${renderTicker(g.game_pk, scheduleCache?.games || [])}
      <div class="game-pane">
        ${fieldPane(g)}
        ${cardPane(g)}
      </div>
    `;
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
            from how often a team in this exact state has won — 115 seasons.
          </div>

          <div class="read">${liveRead(g, we)}</div>
        </div>
        <div id="matchup-slot"></div>
      </div>
    `;
}

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
        slot.innerHTML = renderMatchupCard(m);
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
        return `
          <div class="outcome-row">
            <span class="outcome-label">${OUTCOME_LABEL[o] || o}</span>
            <span class="outcome-bar"><span style="width:${width}%"></span></span>
            <span class="outcome-pct">${pct}%</span>
          </div>
        `;
    }).join("");

    return `
      <div class="card matchup-card">
        <div class="subject">
          ${m.batter.name} (${m.batter.bats}HB) vs ${m.pitcher.name} (${m.pitcher.throws}HP)
        </div>

        <div class="question">What's about to happen?</div>
        <div class="outcome-table">${rows}</div>

        <div class="evidence">
          batter ${m.sample.batter_pa.toLocaleString()} PA vs ${m.pitcher.throws}HP ·
          pitcher ${m.sample.pitcher_bf.toLocaleString()} BF vs ${m.batter.bats}HB ·
          ${m.years.start}–${m.years.end}
        </div>
      </div>
    `;
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
