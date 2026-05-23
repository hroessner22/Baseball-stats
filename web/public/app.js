// DIAMOND:CONTEXT — the Board.
//
// Polls /api/games/today every 30s and renders each game as a tile.
// Each tile is one card: matchup, state, base-diamond (when live), and
// the win-expectancy callout.

const board = document.getElementById("board");
const REFRESH_MS = 30_000;

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
        const arrow = g.half === "top" ? "▲" : "▼";
        return `${arrow} ${ordinalSuffix(g.inning)}`;
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

function renderTile(g) {
    return `
      <div class="tile" data-game-pk="${g.game_pk}" data-status="${g.status}">
        <div class="matchup">
          <div class="team"><span class="name">${g.away}</span><span class="score">${g.away_score}</span></div>
          <div class="team"><span class="name">${g.home}</span><span class="score">${g.home_score}</span></div>
        </div>
        <div class="state">${stateLabel(g)}</div>
        ${g.status === "Live" ? diamondSVG(g.bases) : ""}
        ${weBlock(g)}
      </div>
    `;
}

function renderEmpty(message, sub) {
    board.innerHTML = `
      <div class="empty">
        <p>${message}</p>
        ${sub ? `<p class="sub">${sub}</p>` : ""}
      </div>
    `;
}

async function refresh() {
    try {
        const res = await fetch("/api/games/today");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.games || data.games.length === 0) {
            renderEmpty("No games on the schedule today.", "Check back tomorrow.");
            return;
        }
        board.innerHTML = data.games.map(renderTile).join("");
    } catch (e) {
        renderEmpty("Could not load today's games.", `${e.message || e}`);
    }
}

refresh();
setInterval(refresh, REFRESH_MS);
