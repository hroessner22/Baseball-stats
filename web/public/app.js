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
let currentFeaturedPk = null;

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

        const featured = pickFeatured(data.games);
        currentFeaturedPk = featured?.game_pk ?? null;
        const others = featured
            ? data.games.filter((g) => g.game_pk !== featured.game_pk)
            : data.games;

        board.innerHTML = `
          ${featured ? renderFeatured(featured, null) : ""}
          <section class="tile-grid">${others.map(renderTile).join("")}</section>
        `;

        // Live featured games get a follow-up fetch for batter, pitcher, and
        // runner names — the schedule endpoint doesn't carry those.
        if (featured && featured.status === "Live") {
            hydrateFeatured(featured.game_pk);
        }
    } catch (e) {
        renderEmpty(board, "Could not load today's games.", `${e.message || e}`);
    }
}

// Pick the one game the Board should hero. Live games beat pregame games beat
// finals; within live, leverage decides. Within pregame, the next start wins.
function pickFeatured(games) {
    const live = games.filter((g) => g.status === "Live" && g.inning);
    if (live.length) {
        return live
            .map((g) => ({ g, lev: leverage(g) }))
            .sort((a, b) => b.lev - a.lev)[0].g;
    }
    const now = Date.now();
    const upcoming = games
        .filter((g) => g.status === "Preview" && g.start_time)
        .map((g) => ({ g, t: new Date(g.start_time).getTime() }))
        .filter((x) => x.t >= now - 30 * 60 * 1000) // include games within last 30 min
        .sort((a, b) => a.t - b.t);
    if (upcoming.length) return upcoming[0].g;
    const finals = games.filter((g) => g.status === "Final");
    if (finals.length) return finals[finals.length - 1];
    return games[0] || null;
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

async function hydrateFeatured(pk) {
    try {
        const res = await fetch(`/api/game/${pk}`);
        if (!res.ok) return;
        const detail = await res.json();
        if (pk !== currentFeaturedPk) return;
        const node = document.querySelector(".featured-card");
        if (!node) return;
        node.outerHTML = renderFeatured(tileShapeFromDetail(detail), detail);
    } catch {
        // featured card stays in shell mode — the page still works.
    }
}

// Reshape the /api/game/{id} response into the same shape /api/games/today
// gives so renderFeatured can take either as input.
function tileShapeFromDetail(d) {
    return {
        game_pk: d.game_pk,
        status: d.status,
        detail: d.detail,
        away: d.teams.away.abbr,
        home: d.teams.home.abbr,
        away_score: d.score.away,
        home_score: d.score.home,
        inning: d.inning,
        half: d.half,
        outs: d.outs,
        balls: d.balls,
        strikes: d.strikes,
        bases:
            (d.runners?.first  ? 1 : 0) |
            (d.runners?.second ? 2 : 0) |
            (d.runners?.third  ? 4 : 0),
        win_expectancy: d.win_expectancy,
        start_time: d.start_time,
        probables: null,
        decisions: null,
    };
}

function renderTile(g) {
    return `
      <a class="tile" href="#game/${g.game_pk}" data-status="${g.status}">
        ${hotPill(g)}
        <div class="matchup">
          <div class="team"><span class="name">${g.away}</span><span class="score">${g.away_score}</span></div>
          <div class="team"><span class="name">${g.home}</span><span class="score">${g.home_score}</span></div>
        </div>
        <div class="state">${stateLabel(g)}</div>
        ${tileExtra(g)}
        ${g.status === "Live" ? diamondSVG(g.bases) : ""}
        ${weBlock(g)}
      </a>
    `;
}

// Tile content under the state line. Each game state surfaces one extra fact:
//   Preview — probable pitchers ("RHP M. Keller vs RHP D. Cease")
//   Final   — winning + losing (+ save) pitcher ("W Cole · L Bello · S Holmes")
//   Live    — nothing extra here; count+outs ride on the state line itself.
function tileExtra(g) {
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

// ── FEATURED CARD ───────────────────────────────────────────────────
//
// The hero tile at the top of the Board — one game picked as the moment's
// most interesting story. Renders in two passes: a shell from the schedule
// data we already have, then a richer version once /api/game/{id} returns
// the current batter, pitcher, and runner names (live games only).

function renderFeatured(g, detail) {
    const we = g.win_expectancy;
    const reason = featuredReason(g);

    return `
      <a class="featured-card" href="#game/${g.game_pk}" data-status="${g.status}">
        <header class="featured-head">
          <span class="featured-badge"><span class="dot"></span>FEATURED</span>
          <span class="featured-reason">${reason}</span>
        </header>

        <div class="featured-body">
          <div class="featured-scores">
            <div class="team away">
              <span class="name">${g.away}</span>
              <span class="score">${g.away_score}</span>
            </div>
            <div class="team home">
              <span class="name">${g.home}</span>
              <span class="score">${g.home_score}</span>
            </div>
          </div>

          <div class="featured-field-wrap">
            ${featuredFieldSVG(g, detail)}
          </div>

          <div class="featured-context">
            <div class="state-line">${stateLabel(g)}</div>
            ${g.status === "Live" && (g.bases || g.bases === 0)
                ? `<div class="bases-line">${describeBasesShort(g.bases)}</div>`
                : ""}
            ${featuredPlayers(g, detail)}
          </div>
        </div>

        ${we != null ? featuredWeBar(g, we) : ""}
      </a>
    `;
}

function featuredReason(g) {
    if (g.status === "Live" && g.inning) {
        const diff = (g.home_score ?? 0) - (g.away_score ?? 0);
        const absDiff = Math.abs(diff);
        const baseDesc = (g.bases && g.bases > 0)
            ? `, ${describeBasesShort(g.bases).toLowerCase()}`
            : "";
        const innStr = `${arrowHalf(g.half).toUpperCase()} ${ordinalSuffix(g.inning).toLowerCase()}`;
        if (absDiff === 0) return `Tied in the ${ordinalSuffix(g.inning).toLowerCase()}${baseDesc}`;
        if (absDiff === 1) return `1-run game, ${innStr}${baseDesc}`;
        if (absDiff === 2) return `2-run game, ${innStr}${baseDesc}`;
        return `Live · ${innStr}`;
    }
    if (g.status === "Preview" && g.start_time) {
        const min = Math.round((new Date(g.start_time).getTime() - Date.now()) / 60000);
        if (min <= 0) return "First pitch any moment";
        if (min < 60) return `First pitch in ${min} min`;
        return `First pitch ${startTimeET(g.start_time)} ET`;
    }
    if (g.status === "Final") {
        const home = g.home_score, away = g.away_score;
        if (home === away) return "Game complete";
        const winner = home > away ? g.home : g.away;
        return `${winner} win — recap below`;
    }
    return g.status;
}

function featuredPlayers(g, detail) {
    // Live: current batter + pitcher (from hydrate).
    if (g.status === "Live") {
        if (detail?.batter || detail?.pitcher) {
            return `
              <div class="featured-players">
                <div class="player-row">
                  <span class="label">at bat</span>
                  <strong>${detail.batter ? detail.batter.name : "—"}</strong>
                  <span class="hand">${detail.batter?.bats ? detail.batter.bats + "HB" : ""}</span>
                </div>
                <div class="player-row">
                  <span class="label">pitching</span>
                  <strong>${detail.pitcher ? detail.pitcher.name : "—"}</strong>
                  <span class="hand">${detail.pitcher?.throws ? detail.pitcher.throws + "HP" : ""}</span>
                </div>
              </div>
            `;
        }
        // Shell render — placeholders so the card doesn't reflow when hydrated.
        return `
          <div class="featured-players">
            <div class="player-row dim">
              <span class="label">at bat</span><strong>…</strong>
            </div>
            <div class="player-row dim">
              <span class="label">pitching</span><strong>…</strong>
            </div>
          </div>
        `;
    }
    // Preview: probable pitchers.
    if (g.status === "Preview" && g.probables) {
        const fmt = (p) => p ? `${p.throws ? p.throws + "HP " : ""}${p.name}` : "TBA";
        return `
          <div class="featured-players">
            <div class="player-row">
              <span class="label">probable · ${g.away}</span>
              <strong>${fmt(g.probables.away)}</strong>
            </div>
            <div class="player-row">
              <span class="label">probable · ${g.home}</span>
              <strong>${fmt(g.probables.home)}</strong>
            </div>
          </div>
        `;
    }
    // Final: decisions.
    if (g.status === "Final" && g.decisions) {
        return `
          <div class="featured-players">
            ${g.decisions.winner
                ? `<div class="player-row"><span class="label">W</span><strong>${g.decisions.winner}</strong></div>`
                : ""}
            ${g.decisions.loser
                ? `<div class="player-row"><span class="label">L</span><strong>${g.decisions.loser}</strong></div>`
                : ""}
            ${g.decisions.save
                ? `<div class="player-row"><span class="label">S</span><strong>${g.decisions.save}</strong></div>`
                : ""}
          </div>
        `;
    }
    return "";
}

function featuredWeBar(g, we) {
    const homePct = Math.round(we * 100);
    const awayPct = 100 - homePct;
    const leader = homePct > awayPct ? g.home : awayPct > homePct ? g.away : null;
    const leaderPct = Math.max(homePct, awayPct);
    return `
      <div class="featured-we">
        <div class="we-bar"><span style="width:${homePct}%"></span></div>
        <div class="we-labels">
          <span>${g.away} ${awayPct}%</span>
          ${leader ? `<span class="leader">${leader} favored · ${leaderPct}%</span>` : `<span class="leader">coin flip</span>`}
          <span>${g.home} ${homePct}%</span>
        </div>
      </div>
    `;
}

// Bitmask-flavored cousin of describeBases (which takes an object). Used by
// the Board, where /api/games/today carries bases as a packed bitmask.
function describeBasesShort(mask) {
    const occ = [];
    if (mask & 1) occ.push("1st");
    if (mask & 2) occ.push("2nd");
    if (mask & 4) occ.push("3rd");
    if (occ.length === 0) return "bases empty";
    if (occ.length === 3) return "bases loaded";
    if (occ.length === 2 && (mask & 6) === 6) return "2nd & 3rd";
    return occ.join(" & ");
}

// Mini version of the Game view field, sized for the hero card. Reuses the
// `.field` CSS so colors and details match. Runner names only appear once
// /api/game/{id} has hydrated — the shell render passes `detail=null`.
function featuredFieldSVG(g, detail) {
    if (g.status !== "Live") {
        // Pregame and final get a quiet, simple diamond — no runners to plot.
        return diamondSVG(g.bases || 0);
    }
    const we = g.win_expectancy;
    const intensity = we == null ? 0 : Math.abs(we - 0.5) * 2;
    const bases = g.bases || 0;
    const occ = (mask) => (bases & mask) ? "true" : "false";
    const runnerLabel = (slot, x, y, anchor) =>
        detail?.runners?.[slot]
            ? `<text class="runner-name" x="${x}" y="${y}" text-anchor="${anchor}">${shortName(detail.runners[slot])}</text>`
            : "";

    return `
      <svg class="field featured-field" viewBox="0 0 500 500"
           preserveAspectRatio="xMidYMid meet"
           style="--we-intensity:${intensity}">
        <defs>
          <radialGradient id="grass-radial-feat" cx="0.5" cy="0.92" r="0.85">
            <stop offset="0%"   stop-color="#4A7A35"/>
            <stop offset="60%"  stop-color="#3F6B2A"/>
            <stop offset="100%" stop-color="#355A23"/>
          </radialGradient>
        </defs>
        <path class="outfield-grass" fill="url(#grass-radial-feat)"
              d="M 250,460 L 440,270 Q 250,40 60,270 Z"/>
        <path class="warning-track"
              d="M 440,270 L 425,283 Q 250,80 75,283 L 60,270 Q 250,40 440,270 Z"/>
        <line class="foul-line" x1="250" y1="460" x2="440" y2="270"/>
        <line class="foul-line" x1="250" y1="460" x2="60"  y2="270"/>
        <rect class="foul-pole" x="437" y="263" width="5" height="14"/>
        <rect class="foul-pole" x="58"  y="263" width="5" height="14"/>
        <path class="basepath" d="M 250,455 L 388,318 L 250,180 L 112,318 Z"/>
        <circle class="mound" cx="250" cy="355" r="22"/>
        <rect class="rubber" x="246" y="354" width="8" height="2.5"/>
        <polygon class="base home" points="244,458 256,458 256,464 250,470 244,464"/>
        <g transform="translate(390 320) rotate(45)">
          <rect class="base" data-occupied="${occ(1)}" x="-7" y="-7" width="14" height="14"/>
        </g>
        <g transform="translate(250 180) rotate(45)">
          <rect class="base" data-occupied="${occ(2)}" x="-7" y="-7" width="14" height="14"/>
        </g>
        <g transform="translate(110 320) rotate(45)">
          <rect class="base" data-occupied="${occ(4)}" x="-7" y="-7" width="14" height="14"/>
        </g>
        ${runnerLabel("first",  412, 326, "start")}
        ${runnerLabel("second", 250, 166, "middle")}
        ${runnerLabel("third",  88,  326, "end")}
      </svg>
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
        // Hydrate the matchup card (Phase 3.2) once the shell is in.
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
        const parts = [`${arrowHalf(g.half)} ${ordinalSuffix(g.inning)}`];
        if (g.outs != null) parts.push(`${g.outs} OUT`);
        if (g.balls != null && g.strikes != null) parts.push(`${g.balls}-${g.strikes}`);
        return parts.join(" · ");
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
