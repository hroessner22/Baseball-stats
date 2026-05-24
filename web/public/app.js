// DIAMOND:CONTEXT — the Board and the Game view.
//
// One page, two screens, routed by URL hash:
//   #           — the Board (today's games).
//   #game/{pk}  — the Game (one game's live state + the context card).

const board = document.getElementById("board");
const gameView = document.getElementById("game-view");

const BOARD_REFRESH_MS = 30_000;
const GAME_REFRESH_MS = 15_000;

let boardTimer = null;
let gameTimer = null;
let activeGameId = null;

window.addEventListener("hashchange", handleRoute);
window.addEventListener("load", handleRoute);

function handleRoute() {
    const m = window.location.hash.match(/^#game\/(\d+)/);
    if (m) {
        const id = m[1];
        if (id !== activeGameId) showGameView(id);
    } else {
        showBoard();
    }
}

// ── BOARD ────────────────────────────────────────────────────────────

function showBoard() {
    activeGameId = null;
    if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
    gameView.hidden = true;
    board.hidden = false;
    refreshBoard();
    if (!boardTimer) boardTimer = setInterval(refreshBoard, BOARD_REFRESH_MS);
}

async function refreshBoard() {
    try {
        const res = await fetch("/api/games/today");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.games || data.games.length === 0) {
            renderEmpty(board, "No games on the schedule today.", "Check back tomorrow.");
            return;
        }
        board.innerHTML = data.games.map(renderTile).join("");
    } catch (e) {
        renderEmpty(board, "Could not load today's games.", `${e.message || e}`);
    }
}

function renderTile(g) {
    return `
      <a class="tile" href="#game/${g.game_pk}" data-status="${g.status}">
        <div class="matchup">
          <div class="team"><span class="name">${g.away}</span><span class="score">${g.away_score}</span></div>
          <div class="team"><span class="name">${g.home}</span><span class="score">${g.home_score}</span></div>
        </div>
        <div class="state">${stateLabel(g)}</div>
        ${g.status === "Live" ? diamondSVG(g.bases) : ""}
        ${weBlock(g)}
      </a>
    `;
}

// ── GAME VIEW ────────────────────────────────────────────────────────

function showGameView(id) {
    activeGameId = id;
    if (boardTimer) { clearInterval(boardTimer); boardTimer = null; }
    board.hidden = true;
    gameView.hidden = false;
    renderEmpty(gameView, "Loading game…", "");
    refreshGame(id);
    if (gameTimer) clearInterval(gameTimer);
    gameTimer = setInterval(() => refreshGame(id), GAME_REFRESH_MS);
}

async function refreshGame(id) {
    if (id !== activeGameId) return;
    try {
        const res = await fetch(`/api/game/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const g = await res.json();
        if (id !== activeGameId) return;
        gameView.innerHTML = renderGame(g);
    } catch (e) {
        renderEmpty(gameView, "Could not load this game.", `${e.message || e}`);
    }
}

function renderGame(g) {
    return `
      <a class="back-link" href="#">← BOARD</a>
      <div class="game-pane">
        ${fieldPane(g)}
        ${cardPane(g)}
      </div>
    `;
}

function fieldPane(g) {
    const we = g.win_expectancy;
    const intensity = we == null ? 0 : Math.abs(we - 0.5) * 2;
    const occ = (slot) => g.runners?.[slot] ? "true" : "false";

    return `
      <div class="field-pane">
        <svg class="field" viewBox="0 0 500 500" style="--we-intensity:${intensity}">
          <path class="grass" d="M 250,450 L 480,180 A 280,280 0 0 0 20,180 Z"/>
          <line class="foul-line" x1="250" y1="450" x2="480" y2="180"/>
          <line class="foul-line" x1="250" y1="450" x2="20" y2="180"/>
          <polygon class="dirt" points="250,450 380,320 250,190 120,320"/>
          <circle class="mound" cx="250" cy="320" r="14"/>
          <rect class="base home"   x="245" y="445" width="10" height="10"/>
          <rect class="base first"  data-occupied="${occ("first")}"  x="375" y="315" width="10" height="10"/>
          <rect class="base second" data-occupied="${occ("second")}" x="245" y="185" width="10" height="10"/>
          <rect class="base third"  data-occupied="${occ("third")}"  x="115" y="315" width="10" height="10"/>
          ${g.runners?.first  ? `<text class="runner-name" x="395" y="320" text-anchor="start">${shortName(g.runners.first)}</text>`  : ""}
          ${g.runners?.second ? `<text class="runner-name" x="250" y="175" text-anchor="middle">${shortName(g.runners.second)}</text>` : ""}
          ${g.runners?.third  ? `<text class="runner-name" x="105" y="320" text-anchor="end">${shortName(g.runners.third)}</text>`   : ""}
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

function diamondSVG(bases) {
    const lit = (bit) => (bases & bit) ? "occupied" : "";
    return `
      <svg class="diamond" viewBox="0 0 40 40" aria-hidden="true">
        <polygon points="20,3 36,20 20,37 4,20" fill="none"
                 stroke="currentColor" stroke-width="0.5"/>
        <circle cx="36" cy="20" r="3" class="base ${lit(1)}"/>
        <circle cx="20" cy="3"  r="3" class="base ${lit(2)}"/>
        <circle cx="4"  cy="20" r="3" class="base ${lit(4)}"/>
      </svg>
    `;
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
        return `${arrowHalf(g.half)} ${ordinalSuffix(g.inning)}`;
    }
    return (g.detail || g.status).toUpperCase();
}

function weBlock(g) {
    if (g.win_expectancy == null) return "";
    const homePct = Math.round(g.win_expectancy * 100);
    const awayPct = 100 - homePct;
    const winning = homePct > awayPct ? g.home : awayPct > homePct ? g.away : "—";
    const pct = Math.max(homePct, awayPct);
    return `
      <div class="we">
        ${pct}%
        <span class="label">${winning}</span>
      </div>
    `;
}

function renderEmpty(container, message, sub) {
    container.innerHTML = `
      <div class="empty">
        <p>${message}</p>
        ${sub ? `<p class="sub">${sub}</p>` : ""}
      </div>
    `;
}
