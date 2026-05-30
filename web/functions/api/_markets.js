// Markets SDK — vendored from sports-oracle's @oracle/markets package.
//
// Source: github.com/alexroessner/sports-oracle/packages/markets
// Vendored 2026-05-27, rewritten 2026-05-28 after live testing showed
// the original adapters either filtered too aggressively (Polymarket)
// or pointed at endpoints that didn't return what we needed (Kalshi).
//
// What this fetches now:
//   - Polymarket: every event under tag_slug=baseball. Includes nightly
//     game events when present plus futures (World Series, MVP, etc.).
//   - Kalshi: every market under series_ticker=KXMLBGAME for per-game
//     moneylines, plus a curated list of season-prop series (HR leader,
//     RBI leader, pitcher-of-the-month, team season wins) for futures.
//     Pairs of -{HOME}/-{AWAY} tickers fold into a single two-outcome
//     Market so the UI sees one row per game.
//   - Manifold: open binary markets matching MLB search.
//   - The Odds API: still keyed; wakes up when ODDS_API_KEY is set.
//
// Unified Market shape (top-level so the UI doesn't have to dig into
// metadata): {
//   id, source, sport, league, title, description,
//   url,                  // tappable source link
//   outcomes: [{ id, name, probability?, price?, point? }],
//   question_type,        // moneyline | spread | total | player_prop
//                         // team_prop | series | future | other
//   status,               // open | closed | resolved | cancelled | unknown
//   start_time, close_time,
//   home_tricode, away_tricode, home_team, away_team,
//   liquidity_usd, volume_usd,
//   raw_market_id, source_event_id, source_event_title,
// }
//
// All probabilities normalized to [0, 1]. The shape is intentionally
// FLAT — the UI was previously reading m.url, m.liquidity_usd, etc.,
// and silently rendering "—" because those fields were nested under
// .metadata in the previous shape.

const POLY_GAMMA = "https://gamma-api.polymarket.com";
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const MANIFOLD_BASE = "https://api.manifold.markets/v0";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const BOVADA_BASE   = "https://www.bovada.lv/services/sports/event/coupon/events/A/description";

const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";


// ── MLB team normalization ────────────────────────────────────────

export const MLB_TEAMS = [
    ["ARI","Arizona Diamondbacks",["arizona","d-backs","dbacks","diamondbacks","az"]],
    ["ATL","Atlanta Braves",["atlanta","braves"]],
    ["BAL","Baltimore Orioles",["baltimore","orioles","os"]],
    ["BOS","Boston Red Sox",["boston","red sox","redsox"]],
    ["CHC","Chicago Cubs",["chicago cubs","cubs"]],
    ["CHW","Chicago White Sox",["chicago white sox","white sox","whitesox","cws"]],
    ["CIN","Cincinnati Reds",["cincinnati","reds"]],
    ["CLE","Cleveland Guardians",["cleveland","guardians","indians"]],
    ["COL","Colorado Rockies",["colorado","rockies"]],
    ["DET","Detroit Tigers",["detroit","tigers"]],
    ["HOU","Houston Astros",["houston","astros"]],
    ["KC","Kansas City Royals",["kansas city","royals","kcr"]],
    ["LAA","Los Angeles Angels",["la angels","angels","anaheim"]],
    ["LAD","Los Angeles Dodgers",["la dodgers","dodgers","los angeles d"]],
    ["MIA","Miami Marlins",["miami","marlins","florida"]],
    ["MIL","Milwaukee Brewers",["milwaukee","brewers"]],
    ["MIN","Minnesota Twins",["minnesota","twins"]],
    ["NYM","New York Mets",["ny mets","mets","new york m"]],
    ["NYY","New York Yankees",["ny yankees","yankees","yanks","new york y"]],
    ["OAK","Oakland Athletics",["oakland","athletics","as","a's","ath"]],
    ["PHI","Philadelphia Phillies",["philadelphia","phillies","phils"]],
    ["PIT","Pittsburgh Pirates",["pittsburgh","pirates","bucs"]],
    ["SD","San Diego Padres",["san diego","padres","sdp"]],
    ["SEA","Seattle Mariners",["seattle","mariners","ms"]],
    ["SF","San Francisco Giants",["san francisco","giants","sfg"]],
    ["STL","St. Louis Cardinals",["st louis","saint louis","cardinals","cards"]],
    ["TB","Tampa Bay Rays",["tampa bay","rays","tbr"]],
    ["TEX","Texas Rangers",["texas","rangers"]],
    ["TOR","Toronto Blue Jays",["toronto","blue jays","jays"]],
    ["WSH","Washington Nationals",["washington","nationals","nats","was"]],
];

const TEAM_LOOKUP = {};
for (const [tri, name, aliases] of MLB_TEAMS) {
    TEAM_LOOKUP[tri.toLowerCase()] = tri;
    TEAM_LOOKUP[name.toLowerCase()] = tri;
    for (const a of aliases) TEAM_LOOKUP[a.toLowerCase()] = tri;
}

export function teamTricode(input) {
    if (!input) return null;
    const k = String(input).trim().toLowerCase();
    if (TEAM_LOOKUP[k]) return TEAM_LOOKUP[k];
    for (const [tri, name] of MLB_TEAMS) {
        if (k.includes(tri.toLowerCase())) return tri;
        if (k.includes(name.toLowerCase())) return tri;
    }
    return null;
}

// Try to extract home/away tricode from a title string. Title formats
// vary across sources but most use "X vs Y", "X @ Y", or "MLB: X vs Y".
// Falls back to scanning the title for any mention of a team name —
// returns just that one as `home` so single-team futures ("Will the
// Braves win the World Series?") still bind to a team.
export function extractTeamsFromTitle(title) {
    if (!title) return { home: null, away: null };
    const cleaned = title.replace(/^(MLB|NBA|NHL|NFL):\s*/i, "");
    const at = cleaned.match(/(.+?)\s+@\s+(.+)/);
    if (at) {
        return {
            away: teamTricode(at[1].trim()),
            home: teamTricode(at[2].trim()),
        };
    }
    const vs = cleaned.match(/(.+?)\s+vs\.?\s+(.+)/i);
    if (vs) {
        return {
            home: teamTricode(vs[1].trim()),
            away: teamTricode(vs[2].trim()),
        };
    }
    // Fallback: scan the title for ANY mention of an MLB team name or
    // tricode. Bucket the first match as `home` and a second match as
    // `away`. For single-team futures ("Will Boston win the AL East?")
    // only home gets set, which is enough for the per-game filter to
    // accept it on either side.
    const found = findTricodesInText(cleaned);
    return {
        home: found[0] || null,
        away: found[1] || null,
    };
}

// Scan free-form text for every MLB team mention, deduped in
// appearance order. Used as a fallback team extractor for titles that
// don't follow a "X vs Y" pattern. Matches full team names and the
// canonical tricode, but NOT the 2-letter abbreviation aliases (those
// produce too many false positives in prose, e.g. "as" → OAK).
function findTricodesInText(text) {
    if (!text) return [];
    const t = text.toLowerCase();
    const seen = new Set();
    const order = [];
    for (const [tri, name] of MLB_TEAMS) {
        if (t.includes(name.toLowerCase()) || t.includes(tri.toLowerCase())) {
            if (!seen.has(tri)) { seen.add(tri); order.push(tri); }
        }
    }
    return order;
}


// ── HTTP helpers ──────────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
    const res = await fetch(url, {
        headers: { "User-Agent": UA, ...(opts.headers || {}) },
        cf: { cacheTtl: opts.cacheTtl ?? 30, cacheEverything: true },
    });
    if (!res.ok) {
        throw new Error(`${url} → HTTP ${res.status}`);
    }
    return res.json();
}

function parseJsonArray(s) {
    if (!s) return [];
    try {
        const v = JSON.parse(s);
        return Array.isArray(v) ? v : [];
    } catch { return []; }
}


// ── Polymarket adapter ────────────────────────────────────────────
//
// /events?tag_slug=baseball is the canonical baseball feed. Each event
// has zero or more sub-markets (multi-outcome questions are modeled as
// one parent event + N child markets). We flatten to one Market per
// sub-market so the UI can render them individually.

// Polymarket's event.startDate is the contract creation time (often a
// week before the underlying game). The descriptions, however,
// reliably embed the actual game time in the phrase
//   "scheduled for {Month} {day} at {h}:{mm} {AM/PM} ET"
// Parse that to a UTC millis timestamp so the per-game endpoint's
// 48h time-window check can match correctly. If parsing fails, we
// fall back to whatever was passed in (typically event.startDate).
const POLY_MONTH_INDEX = {
    jan:0,feb:1,mar:2,apr:3,may:4,jun:5,
    jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
};
function parsePolymarketGameTime(description, fallbackIso) {
    const fallbackMs = fallbackIso ? Date.parse(fallbackIso) : null;
    if (!description) return fallbackMs;
    const m = description.match(
        /scheduled for ([A-Z][a-z]+)\s+(\d{1,2})(?:[a-z]*)?(?:,\s*(\d{4}))?(?:[^.]*?at\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET)?/i
    );
    if (!m) return fallbackMs;
    const [, monStr, dayStr, yearStr, hhStr, mmStr, ampm] = m;
    const monIdx = POLY_MONTH_INDEX[monStr.slice(0, 3).toLowerCase()];
    if (monIdx == null) return fallbackMs;
    const day = Number(dayStr);
    if (!Number.isFinite(day) || day < 1 || day > 31) return fallbackMs;

    // Year: explicit > fallback's year > current year. (Polymarket
    // doesn't usually print a year, since the contracts resolve within
    // the same calendar season.)
    const year = yearStr ? Number(yearStr) :
        fallbackMs ? new Date(fallbackMs).getUTCFullYear() :
        new Date().getUTCFullYear();

    // Time: default to 7 PM ET when the description doesn't specify
    // (rare but possible). MLB regular-season games are in DST so
    // ET = UTC-4 → add 4 hours to convert ET clock time → UTC.
    let h24 = 19, mins = 0;
    if (hhStr) {
        h24 = Number(hhStr);
        mins = Number(mmStr) || 0;
        const tag = (ampm || "").toUpperCase();
        if (tag === "PM" && h24 < 12) h24 += 12;
        if (tag === "AM" && h24 === 12) h24 = 0;
    }
    return Date.UTC(year, monIdx, day, h24 + 4, mins);
}


async function listPolymarketMlbMarkets() {
    const url = `${POLY_GAMMA}/events`
              + `?tag_slug=baseball&active=true&closed=false&limit=200`;
    let events;
    try {
        // 10s edge cache — Polymarket's gamma API returns near-live
        // prices and the user explicitly asked for rapid updates.
        events = await fetchJson(url, { cacheTtl: 10 });
    } catch {
        return [];
    }
    if (!Array.isArray(events)) return [];

    const out = [];
    for (const ev of events) {
        const evTitle = ev.title || "";
        const evSlug  = ev.slug || "";
        // ev.startDate on Polymarket is the contract CREATION time
        // (often a week before the game). ev.endDate is the resolution
        // cut-off (often a week after the game). Neither matches "first
        // pitch", which the per-game time-window check needs. Parse the
        // real game time out of the description's "scheduled for X" line
        // and fall back to startDate only if the description is missing.
        // Without this, every Polymarket MLB market gets silently
        // dropped from /api/game/{id}/markets by the 48h window.
        const startMs = parsePolymarketGameTime(ev.description, ev.startDate);
        const endMs   = ev.endDate ? Date.parse(ev.endDate) : null;
        const evVol   = Number(ev.volume) || Number(ev.volume24hr) || undefined;
        const evLiq   = Number(ev.liquidity) || undefined;

        for (const m of ev.markets || []) {
            if (m.closed || m.archived) continue;
            const names  = parseJsonArray(m.outcomes);
            const prices = parseJsonArray(m.outcomePrices).map(Number);
            if (!names.length) continue;

            const mTitle = m.question || evTitle;
            // Extract team tricodes from BOTH the sub-market question
            // (which usually names a specific team, e.g. "Will Braves
            // win World Series?") AND the parent event title (which
            // names both teams in per-game events, e.g. "ATL @ BOS").
            // Take the sub-market's tricode when set, otherwise the
            // event's. This is the difference between Polymarket WS
            // futures showing up on every team vs. only on no team.
            const subTeams = extractTeamsFromTitle(mTitle);
            const evTeams  = extractTeamsFromTitle(evTitle);
            const teams = {
                home: subTeams.home || evTeams.home || null,
                away: subTeams.away || evTeams.away || null,
            };
            const qType  = classifyQuestion(mTitle, evTitle);
            const url    = m.slug || evSlug
                ? `https://polymarket.com/event/${evSlug || m.slug}`
                : `https://polymarket.com/`;

            // Sub-market may have its own scheduled date too — prefer
            // it over the event-level parse so per-game-of-a-series
            // contracts (rare but possible) bind to the right night.
            const subStartMs = parsePolymarketGameTime(m.description, null) || startMs;
            out.push(flat({
                id: `polymarket:${m.id || m.conditionId}`,
                source: "polymarket",
                title: mTitle,
                description: m.description || "",
                url,
                outcomes: names.map((name, i) => ({
                    id: `${m.id}:${i}`,
                    name: String(name),
                    probability: Number.isFinite(prices[i]) ? prices[i] : undefined,
                })),
                question_type: qType,
                status: m.closed ? "closed" : "open",
                start_time: subStartMs ? new Date(subStartMs).toISOString() : null,
                close_time: endMs ? new Date(endMs).toISOString() : null,
                home_tricode: teams.home,
                away_tricode: teams.away,
                liquidity_usd: Number(m.liquidity) || evLiq,
                volume_usd:    Number(m.volume) || evVol,
                raw_market_id: m.id || m.conditionId,
                source_event_id: ev.id,
                source_event_title: evTitle,
            }));
        }
    }
    return out;
}


// ── Kalshi adapter ────────────────────────────────────────────────
//
// Kalshi splits a two-outcome game into two YES/NO markets (one per
// team). We fold the pair back into one Market with two outcomes so
// the UI renders one card per game. Tickers carry the date + teams,
// which we parse to set start_time + home/away tricode.

// Series we pull. Game-day moneylines + season futures + per-game
// player props / team props. Kalshi exposes a clean per-game ticker
// convention for sports — every market in the per-game series carries
// the game date + team pair in the ticker (e.g.
// KXMLBHR-26MAY301410DETCWS-DETFVALDEZ59-9), so we can attach the
// game's home/away tricodes at parse time and the markets flow
// straight into the per-game endpoint without needing roster
// cross-reference.
const KALSHI_SERIES = [
    // Per-game moneyline
    { ticker: "KXMLBGAME",        type: "game" },

    // ── Team season futures (per-team binary markets) ─────────────
    // Each market is "Will {team} win {category}?" with the team
    // tricode as the LAST hyphen-segment of the market ticker
    // (e.g. KXMLBALEAST-26-NYY). extractTeamTricodeFromKalshiTicker
    // walks the ticker from the right and matches against
    // MLB_TRICODE_SET to attach home_tricode.
    { ticker: "KXMLB",            type: "future_team" }, // World Series champion
    { ticker: "KXMLBAL",          type: "future_team" }, // AL pennant
    { ticker: "KXMLBNL",          type: "future_team" }, // NL pennant
    { ticker: "KXMLBALEAST",      type: "future_team" }, // AL East division
    { ticker: "KXMLBALCENT",      type: "future_team" }, // AL Central division
    { ticker: "KXMLBALWEST",      type: "future_team" }, // AL West division
    { ticker: "KXMLBNLEAST",      type: "future_team" }, // NL East division
    { ticker: "KXMLBNLCENT",      type: "future_team" }, // NL Central division
    { ticker: "KXMLBNLWEST",      type: "future_team" }, // NL West division
    { ticker: "KXMLBPLAYOFFS",    type: "future_team" }, // Will {team} make the playoffs
    { ticker: "KXMLBBESTRECORD",  type: "future_team" }, // Best regular-season record
    { ticker: "KXMLBWORSTRECORD", type: "future_team" }, // Worst regular-season record

    // ── Player season futures (awards + leaderboards) ─────────────
    // Each market is "Will {player} win/lead?" — team attribution
    // via extractKalshiDescTeam reading the subtitle, same as the
    // existing KXLEADERMLBHR / KXMLBRBI flow.
    { ticker: "KXLEADERMLBHR",      type: "future_player" }, // HR leader
    { ticker: "KXLEADERMLBRBI",     type: "future_player" }, // RBI leader
    { ticker: "KXLEADERMLBAVG",     type: "future_player" }, // Batting average leader
    { ticker: "KXLEADERMLBHITS",    type: "future_player" }, // Hits leader
    { ticker: "KXLEADERMLBRUNS",    type: "future_player" }, // Runs leader
    { ticker: "KXLEADERMLBDOUBLES", type: "future_player" }, // Doubles leader
    { ticker: "KXLEADERMLBTRIPLES", type: "future_player" }, // Triples leader
    { ticker: "KXLEADERMLBSTEALS",  type: "future_player" }, // Stolen bases leader
    { ticker: "KXLEADERMLBOPS",     type: "future_player" }, // OPS leader
    { ticker: "KXLEADERMLBWAR",     type: "future_player" }, // WAR leader
    { ticker: "KXLEADERMLBKS",      type: "future_player" }, // Strikeouts leader (pitcher)
    { ticker: "KXLEADERMLBWINS",    type: "future_player" }, // Wins leader (pitcher)
    { ticker: "KXLEADERMLBERA",     type: "future_player" }, // Lowest ERA (pitcher)
    { ticker: "KXMLBALMVP",         type: "future_player" }, // AL MVP
    { ticker: "KXMLBNLMVP",         type: "future_player" }, // NL MVP
    { ticker: "KXMLBALCY",          type: "future_player" }, // AL Cy Young
    { ticker: "KXMLBNLCY",          type: "future_player" }, // NL Cy Young
    { ticker: "KXMLBALROTY",        type: "future_player" }, // AL Rookie of the Year
    { ticker: "KXMLBNLROTY",        type: "future_player" }, // NL Rookie of the Year
    { ticker: "KXMLBALMOTY",        type: "future_player" }, // AL Manager of the Year
    { ticker: "KXMLBNLMOTY",        type: "future_player" }, // NL Manager of the Year
    { ticker: "KXMLBALRELOTY",      type: "future_player" }, // AL Reliever of the Year
    { ticker: "KXMLBNLRELOTY",      type: "future_player" }, // NL Reliever of the Year
    { ticker: "KXMLBALCPOTY",       type: "future_player" }, // AL Comeback Player of the Year
    { ticker: "KXMLBNLCPOTY",       type: "future_player" }, // NL Comeback Player of the Year
    { ticker: "KXMLBALHAARON",      type: "future_player" }, // AL Hank Aaron Award
    { ticker: "KXMLBNLHAARON",      type: "future_player" }, // NL Hank Aaron Award
    { ticker: "KXMLBPITCHEROTM",    type: "future_player" }, // Pitcher of the Month

    // Per-game player props (titled "Will X get Y+ stat?")
    { ticker: "KXMLBHR",          type: "per_game_player" }, // home runs in game
    { ticker: "KXMLBKS",          type: "per_game_player" }, // pitcher strikeouts in game
    { ticker: "KXMLBHIT",         type: "per_game_player" }, // hits in game
    { ticker: "KXMLBTB",          type: "per_game_player" }, // total bases in game
    { ticker: "KXMLBHRR",         type: "per_game_player" }, // hits+runs+RBIs combo
    // Per-game team props
    { ticker: "KXMLBSPREAD",      type: "per_game_team" },   // run line
    { ticker: "KXMLBTOTAL",       type: "per_game_team" },   // total runs O/U
    { ticker: "KXMLBTEAMTOTAL",   type: "per_game_team" },   // team total runs
    { ticker: "KXMLBF5",          type: "per_game_team" },   // first 5 innings winner
    { ticker: "KXMLBF5SPREAD",    type: "per_game_team" },   // first 5 spread
    { ticker: "KXMLBF5TOTAL",     type: "per_game_team" },   // first 5 total
    { ticker: "KXMLBRFI",         type: "per_game_team" },   // run in 1st inning
];

async function listKalshiMlbMarkets() {
    const all = [];

    // Fan ALL Kalshi series fetches out in parallel — sequential await
    // pushed total wall-time past the per-worker budget, so the later
    // series (HIT, TB, SPREAD, TOTAL, F5...) silently never landed.
    // With Promise.allSettled the slowest fetch sets total latency
    // instead of the sum, and we still get every series that succeeds.
    const seriesResults = await Promise.allSettled(KALSHI_SERIES.map((s) =>
        fetchJson(
            `${KALSHI_BASE}/markets?series_ticker=${s.ticker}&status=open&limit=400`,
            { cacheTtl: 30 },
        ).then((data) => ({ s, mkts: Array.isArray(data?.markets) ? data.markets : [] }))
    ));

    for (const r of seriesResults) {
        if (r.status !== "fulfilled") continue;
        const { s, mkts } = r.value;
        try {
            if (s.type === "game") {
                all.push(...foldKalshiGameMarkets(mkts));
            } else if (s.type === "per_game_player" || s.type === "per_game_team") {
                // Per-game series carry the game date + team pair in
                // the ticker so we can attach home/away tricodes at
                // parse time, no roster cross-reference needed.
                for (const m of mkts) {
                    const market = toKalshiSingleMarket(m, s.type);
                    const parsed = parseKalshiPerGameTicker(m.ticker);
                    if (parsed) {
                        market.home_tricode = parsed.home;
                        market.away_tricode = parsed.away;
                        market.start_time   = parsed.game_start;
                    }
                    all.push(market);
                }
            } else {
                for (const m of mkts) all.push(toKalshiSingleMarket(m, s.type));
            }
        } catch {
            // single-series mapping failure shouldn't drop the rest
        }
    }
    // Team season-wins futures (KXMLBWINS-{TRI}) — previously one
    // series per team × 30 teams = 30 subrequests. Cloudflare caps
    // total subrequests per request at 50 on the free tier, and we
    // already burn ~17 each on Bovada and Pinnacle plus Smarkets's
    // batch. Hold to the league-aggregate series KXMLBWINS only when
    // it returns batched data — single request covers all teams.
    try {
        const data = await fetchJson(
            `${KALSHI_BASE}/markets?series_ticker=KXMLBWINS&status=open&limit=400`,
            { cacheTtl: 60 },
        );
        const mkts = data?.markets || [];
        for (const m of mkts) {
            const market = toKalshiSingleMarket(m, "future_team");
            // Try to extract tricode from ticker tail: KXMLBWINS-XXX-...
            const triMatch = (m.ticker || "").match(/^KXMLBWINS-([A-Z]{2,4})/);
            if (triMatch) market.home_tricode = triMatch[1];
            all.push(market);
        }
    } catch { /* season wins are bonus, no fatal */ }
    return all.filter(Boolean);
}

// Parse KXMLBGAME-YYMMM DD HHMM AAABBB-TEAM into game key + side.
// Example: KXMLBGAME-26MAY281610ATLBOS-ATL
//   date = 2026-05-28, time = 16:10 ET, away = ATL, home = BOS, side = ATL
//
// The team-pair section concatenates two 2-3 character tricodes with no
// separator. A greedy regex split fails (e.g. "ATLBOS" greedy-matches
// as "ATLB"+"OS", and "OS" then aliases incorrectly to BAL via the
// Orioles alias). We deterministically try every valid (2 or 3) +
// (2 or 3) split and accept the first where BOTH halves resolve to
// canonical MLB tricodes.
function parseKalshiGameTicker(ticker) {
    const m = (ticker || "").match(
        /^KXMLBGAME-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})([A-Z]+)-([A-Z]{2,4})$/
    );
    if (!m) return null;
    const [, yy, monStr, dd, hh, mm, pair, sideRaw] = m;
    const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
    const monthIdx = months[monStr];
    if (monthIdx == null) return null;
    const split = splitMlbTeamPair(pair);
    if (!split) return null;
    const sideTri = teamTricode(sideRaw);
    if (!sideTri || (sideTri !== split.t1 && sideTri !== split.t2)) {
        // Side has to be one of the two teams in the pair — sanity check.
        return null;
    }
    // ET = UTC-4 (DST) / UTC-5 (standard). MLB regular season is in DST.
    const year = 2000 + Number(yy);
    const startUtc = Date.UTC(year, monthIdx, Number(dd), Number(hh) + 4, Number(mm));
    return {
        date:  `${year}-${String(monthIdx + 1).padStart(2, "0")}-${dd}`,
        start: new Date(startUtc).toISOString(),
        // Kalshi convention is AWAY+HOME in the pair concatenation.
        t1: split.t1,  // away
        t2: split.t2,  // home
        side: sideTri,
    };
}

// Parse the per-game prop ticker convention into game info. Examples:
//   KXMLBHR-26MAY301410DETCWS-DETFVALDEZ59-9   → DET @ CHW, May 30 14:10 ET
//   KXMLBKS-26MAY301410DETCWS-DETFVALDEZ59-9   → same
//   KXMLBSPREAD-26MAY301410DETCWS-CWS5         → same
//   KXMLBTOTAL-26MAY301605SDWSH-9              → SD @ WSH, May 30 16:05 ET
//
// Returns { game_start, away, home } with team tricodes canonicalized
// to MLB-Stats abbreviations (CHW not CWS). Returns null if the
// ticker doesn't match the per-game series pattern (e.g. for KXMLBGAME
// or season-future tickers).
function parseKalshiPerGameTicker(ticker) {
    const m = (ticker || "").match(
        /^KX[A-Z]+-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})([A-Z]+)-/
    );
    if (!m) return null;
    const [, yy, monStr, dd, hh, mm, pair] = m;
    const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
    const monIdx = months[monStr];
    if (monIdx == null) return null;
    const split = splitMlbTeamPair(pair);
    if (!split) return null;
    const year = 2000 + Number(yy);
    // Kalshi encodes ET clock time; convert to UTC by adding 4h (DST).
    const startUtc = Date.UTC(year, monIdx, Number(dd), Number(hh) + 4, Number(mm));
    return {
        game_start: new Date(startUtc).toISOString(),
        away: split.t1,
        home: split.t2,
    };
}

// Deterministically split a concatenated two-team tricode pair. Tries
// every valid (2 or 3) + (2 or 3) split and returns the first where
// BOTH halves are recognized MLB tricodes — or known aliases (CWS for
// White Sox, ATH for Athletics, etc.). Both halves get canonicalized
// to MLB-Stats abbrs (CHW, OAK, ...) before return so downstream
// team-pair matching works against the MLB feed.
//
// Returns null if no split works — caller should drop the market.
const MLB_TRICODE_SET = new Set();
for (const [tri, _name, aliases] of MLB_TEAMS) {
    MLB_TRICODE_SET.add(tri);
    for (const a of aliases || []) {
        const up = String(a).toUpperCase();
        if (up.length >= 2 && up.length <= 4 && /^[A-Z]+$/.test(up)) {
            MLB_TRICODE_SET.add(up);
        }
    }
}
function splitMlbTeamPair(pair) {
    if (!pair || pair.length < 4 || pair.length > 6) return null;
    // Order matters: try 3+3 (most common), then 2+3, 3+2, 2+2.
    const splits = [];
    if (pair.length === 6) splits.push([3, 3]);
    if (pair.length === 5) splits.push([2, 3], [3, 2]);
    if (pair.length === 4) splits.push([2, 2]);
    for (const [a, b] of splits) {
        const t1 = pair.slice(0, a);
        const t2 = pair.slice(a, a + b);
        if (MLB_TRICODE_SET.has(t1) && MLB_TRICODE_SET.has(t2)) {
            // Canonicalize via teamTricode so "CWS" becomes "CHW",
            // matching the MLB Stats API abbreviation.
            return {
                t1: teamTricode(t1) || t1,
                t2: teamTricode(t2) || t2,
            };
        }
    }
    return null;
}

function foldKalshiGameMarkets(markets) {
    // Group by everything-up-to-the-trailing-team in the ticker — that's
    // the game key. Each game produces TWO Kalshi markets (one per team)
    // that we collapse into one two-outcome Market.
    const groups = new Map();
    for (const m of markets || []) {
        const t = m.ticker || "";
        const parsed = parseKalshiGameTicker(t);
        if (!parsed) continue;
        const key = t.replace(/-[A-Z]{2,4}$/, "");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ market: m, parsed });
    }
    const out = [];
    for (const [key, arr] of groups) {
        if (!arr.length) continue;
        const sample = arr[0];
        const t1 = sample.parsed.t1;
        const t2 = sample.parsed.t2;
        const outcomes = arr.map(({ market, parsed }) => {
            const yb = Number(market.yes_bid);
            const ya = Number(market.yes_ask);
            const last = Number(market.last_price);
            const mid = (Number.isFinite(yb) && Number.isFinite(ya) && yb + ya > 0)
                ? (yb + ya) / 200
                : (Number.isFinite(last) && last > 0 ? last / 100 : undefined);
            return {
                id:   `${market.ticker}:yes`,
                name: parsed.side,
                probability: mid,
            };
        });
        out.push(flat({
            id: `kalshi:${key}`,
            source: "kalshi",
            title: `${t1} vs ${t2} winner`,
            description: arr[0].market.subtitle || "",
            url: `https://kalshi.com/markets/${key.toLowerCase()}`,
            outcomes,
            question_type: "moneyline",
            status: "open",
            start_time: sample.parsed.start,
            close_time: arr[0].market.close_time || null,
            home_tricode: t2,
            away_tricode: t1,
            liquidity_usd: undefined,
            volume_usd: undefined,
            raw_market_id: key,
            source_event_id: key,
            source_event_title: `${t1} vs ${t2}`,
        }));
    }
    return out;
}

// Kalshi season-long player futures (HR leader, Pitcher of the Month,
// etc.) embed the player's team in the market's `subtitle`/description
// using their own shorthand (":: Colorado", ":: A's", ":: Chicago WS").
// Map that to our canonical tricode so we can attach it to home_tricode
// on the market — that lets the team-profile page surface the future
// for the right team via its existing tricode filter.
const KALSHI_DESC_TO_TRI = {
    "arizona":       "ARI", "atlanta":      "ATL", "baltimore":    "BAL",
    "boston":        "BOS", "chicago c":    "CHC", "chicago ws":   "CHW",
    "chicago w":     "CHW", "cincinnati":   "CIN", "cleveland":    "CLE",
    "colorado":      "COL", "detroit":      "DET", "houston":      "HOU",
    "kansas city":   "KC",  "los angeles a":"LAA", "los angeles d":"LAD",
    "miami":         "MIA", "milwaukee":    "MIL", "minnesota":    "MIN",
    "new york m":    "NYM", "new york y":   "NYY", "a's":          "OAK",
    "oakland":       "OAK", "philadelphia": "PHI", "pittsburgh":   "PIT",
    "san diego":     "SD",  "seattle":      "SEA", "san francisco":"SF",
    "st. louis":     "STL", "tampa bay":    "TB",  "texas":        "TEX",
    "toronto":       "TOR", "washington":   "WSH",
};
// Keys ordered longest-first so "los angeles a" matches before "los angeles".
const KALSHI_DESC_KEYS = Object.keys(KALSHI_DESC_TO_TRI).sort((a, b) => b.length - a.length);
function extractKalshiDescTeam(desc) {
    if (!desc) return null;
    const d = desc.toLowerCase().replace(/::/g, "").trim();
    for (const k of KALSHI_DESC_KEYS) {
        if (d.includes(k)) return KALSHI_DESC_TO_TRI[k];
    }
    return null;
}

// Per-team season-futures markets carry the team tricode as the LAST
// hyphen-segment of the market ticker — KXMLB-26-NYY (World Series),
// KXMLBALEAST-26-NYY (AL East), KXMLBPLAYOFFS-26-NYY, etc. Walk the
// ticker right-to-left and accept the first segment that resolves
// against MLB_TRICODE_SET, then canonicalize via aliases (CWS→CWS,
// ATH→OAK on the schedule API side). Returns null when no segment
// matches — that's fine, the market just won't surface on team pages.
function extractTeamTricodeFromKalshiTicker(ticker) {
    if (!ticker) return null;
    const parts = String(ticker).split("-");
    for (let i = parts.length - 1; i >= 0; i--) {
        const tok = parts[i].toUpperCase();
        if (MLB_TRICODE_SET.has(tok)) return tok;
    }
    return null;
}

// Kalshi shortens shared-city team names to single-letter
// disambiguators in their market titles: "New York Y" for Yankees,
// "New York M" for Mets, "Chicago C" / "Chicago WS", "Los Angeles A"
// / "Los Angeles D". Useless in headlines — replace with the proper
// nickname so "Will New York Y win the AL East" reads as "Will
// Yankees win the AL East" everywhere downstream.
const KALSHI_TEAM_NAME_FIX = [
    [/\bNew York Y\b/g,    "Yankees"],
    [/\bNew York M\b/g,    "Mets"],
    [/\bChicago WS\b/g,    "White Sox"],
    [/\bChicago C\b/g,     "Cubs"],
    [/\bLos Angeles A\b/g, "Angels"],
    [/\bLos Angeles D\b/g, "Dodgers"],
];
function fixKalshiTeamNames(s) {
    if (!s) return s;
    let out = String(s);
    for (const [rx, repl] of KALSHI_TEAM_NAME_FIX) {
        out = out.replace(rx, repl);
    }
    return out;
}

function toKalshiSingleMarket(m, type) {
    const yb = Number(m.yes_bid);
    const ya = Number(m.yes_ask);
    const last = Number(m.last_price);
    const yesProb = (Number.isFinite(yb) && Number.isFinite(ya) && yb + ya > 0)
        ? (yb + ya) / 200
        : (Number.isFinite(last) && last > 0 ? last / 100 : undefined);
    const noProb = yesProb != null ? 1 - yesProb : undefined;
    const title = fixKalshiTeamNames(m.title || m.subtitle || m.ticker);
    // For season-long player futures (HR leader, Pitcher of the Month),
    // tag home_tricode with the player's team from the description so
    // the team-profile page can pick them up via its tricode filter.
    // We DELIBERATELY leave away_tricode null — that single-tricode
    // shape is what the per-game endpoint uses to distinguish season
    // futures from real per-game props.
    let derivedHome = null;
    if (type === "future_player") {
        derivedHome = extractKalshiDescTeam(m.subtitle || "");
    } else if (type === "future_team") {
        // Per-team binary markets (KXMLB-26-NYY, KXMLBALEAST-26-NYY, …)
        // carry the team tricode in the ticker tail. Subtitle fallback
        // catches any series that names the team in the subtitle
        // instead (e.g. some manager / executive futures).
        derivedHome = extractTeamTricodeFromKalshiTicker(m.ticker)
                   || extractKalshiDescTeam(m.subtitle || "");
    }
    return flat({
        id: `kalshi:${m.ticker}`,
        source: "kalshi",
        title,
        description: fixKalshiTeamNames(m.subtitle || ""),
        url: `https://kalshi.com/markets/${(m.ticker || "").toLowerCase()}`,
        outcomes: [
            { id: `${m.ticker}:yes`, name: fixKalshiTeamNames(m.yes_sub_title || "Yes"), probability: yesProb },
            { id: `${m.ticker}:no`,  name: fixKalshiTeamNames(m.no_sub_title  || "No"),  probability: noProb },
        ],
        question_type:
            type === "future_player" || type === "per_game_player" ? "player_prop"
            : type === "future_team" ? "future"
            : type === "per_game_team" ? "team_prop"
            : classifyQuestion(title),
        status: m.status === "active" ? "open" : (m.status || "unknown"),
        start_time: m.open_time || null,
        close_time: m.close_time || null,
        home_tricode: derivedHome,
        away_tricode: null,
        liquidity_usd: undefined,
        volume_usd:    undefined,
        raw_market_id: m.ticker,
        source_event_id: m.event_ticker,
        source_event_title: m.event_ticker,
    });
}


// ── Manifold adapter ──────────────────────────────────────────────

async function listManifoldMlbMarkets() {
    const url = `${MANIFOLD_BASE}/search-markets`
              + `?term=MLB&filter=open&sort=score&limit=80`;
    let data;
    try {
        data = await fetchJson(url, { cacheTtl: 60 });
    } catch {
        return [];
    }
    const arr = Array.isArray(data) ? data : (data?.markets || []);
    const out = [];
    for (const m of arr) {
        if (m.isResolved) continue;
        if (m.outcomeType !== "BINARY") continue;
        const p = typeof m.probability === "number" ? m.probability : undefined;
        const teams = extractTeamsFromTitle(m.question || "");
        out.push(flat({
            id: `manifold:${m.id}`,
            source: "manifold",
            title: m.question || "",
            description: "",
            url: m.url || `https://manifold.markets/${m.creatorUsername}/${m.slug}`,
            outcomes: [
                { id: `${m.id}:yes`, name: "Yes", probability: p },
                { id: `${m.id}:no`,  name: "No",  probability: p != null ? 1 - p : undefined },
            ],
            question_type: classifyQuestion(m.question || ""),
            status: "open",
            start_time: m.createdTime ? new Date(m.createdTime).toISOString() : null,
            close_time: m.closeTime ? new Date(m.closeTime).toISOString() : null,
            home_tricode: teams.home,
            away_tricode: teams.away,
            liquidity_usd: Number(m.totalLiquidity) || undefined,
            volume_usd:    Number(m.volume) || undefined,
            raw_market_id: m.id,
            source_event_id: m.id,
            source_event_title: m.question,
        }));
    }
    return out;
}


// ── The Odds API adapter (sportsbook aggregator) ──────────────────
//
// Two layers:
//
//   1. Game lines (h2h / spreads / totals) via the sport-level endpoint
//      — ONE request returns every MLB game. Cache 5 min. This is what
//      the free tier of The Odds API gives you (500 req/mo budget).
//
//   2. Player props (batter / pitcher) via the per-event endpoint —
//      one request per event. Only fires when ODDS_API_INCLUDE_PROPS
//      is set in env (and only on paid tiers >= $30/mo). Cache 15 min.
//
// We collapse the bookmaker dimension to a CONSENSUS market per
// (event × market_type) by averaging probabilities across books.
// Sportsbooks each get their own row in the response too via the
// `book_lines` metadata so the UI can dive in. Simpler than rendering
// 6 duplicate "FanDuel / DraftKings / BetMGM / Caesars / PointsBet /
// BetRivers" rows per game.

// Markets we ask the per-event endpoint for. The Odds API names props
// by canonical key — these are MLB-specific. Most require a paid tier.
const ODDS_API_PROP_MARKETS = [
    "batter_hits",
    "batter_home_runs",
    "batter_total_bases",
    "batter_rbis",
    "batter_runs_scored",
    "batter_walks",
    "batter_strikeouts",
    "batter_singles",
    "batter_doubles",
    "batter_stolen_bases",
    "pitcher_strikeouts",
    "pitcher_hits_allowed",
    "pitcher_walks",
    "pitcher_earned_runs",
    "pitcher_outs",
    "pitcher_record_a_win",
];

async function listOddsApiMlbMarkets(env) {
    const key = env?.ODDS_API_KEY || env?.THE_ODDS_API_KEY;
    if (!key) return [];

    // 1. Game lines from the sport-level endpoint.
    const gameLines = await fetchOddsApiGameLines(key);

    // 2. Optional: player props per event. Paid-tier feature.
    let propLines = [];
    if (env?.ODDS_API_INCLUDE_PROPS) {
        // Only fetch props for events that haven't started yet, to
        // conserve the per-month request budget.
        const upcoming = gameLines
            .map((m) => m.source_event_id)
            .filter((id, i, a) => id && a.indexOf(id) === i)  // dedupe
            .slice(0, 16);  // cap at 16 games/day
        propLines = await fetchOddsApiPlayerProps(key, upcoming);
    }
    return [...gameLines, ...propLines];
}

async function fetchOddsApiGameLines(key) {
    const params = new URLSearchParams({
        apiKey: key,
        regions: "us",
        markets: "h2h,spreads,totals",
        oddsFormat: "decimal",
    });
    const url = `${ODDS_API_BASE}/sports/baseball_mlb/odds?${params}`;
    let events;
    try {
        events = await fetchJson(url, { cacheTtl: 300 });
    } catch {
        return [];
    }
    return collapseOddsApiEvents(events, "game");
}

async function fetchOddsApiPlayerProps(key, eventIds) {
    if (!eventIds.length) return [];
    const results = await Promise.allSettled(eventIds.map((id) => {
        const params = new URLSearchParams({
            apiKey: key,
            regions: "us",
            markets: ODDS_API_PROP_MARKETS.join(","),
            oddsFormat: "decimal",
        });
        const url = `${ODDS_API_BASE}/sports/baseball_mlb/events/${id}/odds?${params}`;
        return fetchJson(url, { cacheTtl: 900 });
    }));
    const events = results
        .filter((r) => r.status === "fulfilled" && r.value)
        .map((r) => r.value);
    return collapseOddsApiEvents(events, "prop");
}

// Convert The Odds API's nested {event → bookmakers → markets → outcomes}
// into our flat Market shape. For each (event × market_key) we emit ONE
// Market whose outcomes carry the consensus probability across books.
function collapseOddsApiEvents(events, kind) {
    const out = [];
    for (const ev of events || []) {
        const homeTri = teamTricode(ev.home_team);
        const awayTri = teamTricode(ev.away_team);
        // For each market_key, group outcomes from every bookmaker so
        // we can average probabilities cross-book.
        const grouped = new Map();  // market_key → outcomes Map
        for (const bm of ev.bookmakers || []) {
            for (const m of bm.markets || []) {
                if (!grouped.has(m.key)) grouped.set(m.key, {
                    market_key: m.key,
                    description: m.description || "",
                    outcomes_by_name: new Map(),  // name → [{book, price, probability, point}]
                    books_present: new Set(),
                });
                const g = grouped.get(m.key);
                g.books_present.add(bm.key);
                for (const o of m.outcomes || []) {
                    const key = o.point != null ? `${o.name}@${o.point}` : o.name;
                    if (!g.outcomes_by_name.has(key)) {
                        g.outcomes_by_name.set(key, []);
                    }
                    g.outcomes_by_name.get(key).push({
                        book: bm.title,
                        book_key: bm.key,
                        price: o.price,
                        point: o.point,
                        probability: o.price > 1 ? 1 / o.price : undefined,
                        description: o.description || null,  // for player props (player name)
                    });
                }
            }
        }

        for (const g of grouped.values()) {
            const qType = mapOddsApiMarketKey(g.market_key);
            const outcomes = Array.from(g.outcomes_by_name.entries()).map(([key, books]) => {
                const probs = books.map((b) => b.probability).filter((p) => p != null);
                const mean = probs.length ? probs.reduce((s, p) => s + p, 0) / probs.length : undefined;
                const sample = books[0];
                // Outcome `name` = the player (for props) or side (for ML).
                // For props we append the side and threshold so it reads "Aaron Judge over 1.5".
                const baseName = sample.description ? sample.description : sample.book ? key.split("@")[0] : key;
                const point = sample.point;
                const sideToken = key.includes("@") ? key.split("@")[0] : key;  // Over/Under or team name
                const displayName = sample.description
                    ? `${sample.description}: ${sideToken}${point != null ? ` ${point}` : ""}`
                    : (point != null ? `${sideToken} ${point}` : sideToken);
                return {
                    id: `${g.market_key}:${key}`,
                    name: displayName,
                    probability: mean,
                    point: point,
                    book_count: probs.length,
                    book_lines: books.map((b) => ({
                        book: b.book, price: b.price, probability: b.probability,
                    })),
                };
            });

            const titleBase = `${ev.away_team} @ ${ev.home_team}`;
            const title = kind === "prop"
                ? `${titleBase} · ${prettyPropName(g.market_key)}`
                : `${titleBase} · ${prettyGameLineName(g.market_key)}`;
            out.push(flat({
                id: `odds:${ev.id}:${g.market_key}`,
                source: "odds_api",
                title,
                description: g.description,
                url: `https://the-odds-api.com/sports/baseball_mlb/`,
                outcomes,
                question_type: qType,
                status: "open",
                start_time: ev.commence_time || null,
                close_time: null,
                home_tricode: homeTri,
                away_tricode: awayTri,
                home_team: ev.home_team,
                away_team: ev.away_team,
                liquidity_usd: undefined,
                volume_usd:    undefined,
                raw_market_id: `${ev.id}:${g.market_key}`,
                source_event_id: ev.id,
                source_event_title: titleBase,
                book_count: g.books_present.size,
                books_present: Array.from(g.books_present),
            }));
        }
    }
    return out;
}

function mapOddsApiMarketKey(k) {
    if (k === "h2h")     return "moneyline";
    if (k === "spreads") return "spread";
    if (k === "totals")  return "total";
    if (k && k.startsWith("batter_") || (k && k.startsWith("pitcher_")))
        return "player_prop";
    return "other";
}

function prettyGameLineName(k) {
    if (k === "h2h") return "moneyline";
    if (k === "spreads") return "run line";
    if (k === "totals") return "total runs O/U";
    return k;
}

function prettyPropName(k) {
    const m = {
        batter_hits:           "Batter hits O/U",
        batter_home_runs:      "Batter HRs O/U",
        batter_total_bases:    "Batter total bases O/U",
        batter_rbis:           "Batter RBIs O/U",
        batter_runs_scored:    "Batter runs scored O/U",
        batter_walks:          "Batter walks O/U",
        batter_strikeouts:     "Batter K's O/U",
        batter_singles:        "Batter singles O/U",
        batter_doubles:        "Batter doubles O/U",
        batter_stolen_bases:   "Batter SB O/U",
        pitcher_strikeouts:    "Pitcher K's O/U",
        pitcher_hits_allowed:  "Pitcher hits allowed O/U",
        pitcher_walks:         "Pitcher walks O/U",
        pitcher_earned_runs:   "Pitcher ER O/U",
        pitcher_outs:          "Pitcher outs O/U",
        pitcher_record_a_win:  "Pitcher to record a win",
    };
    return m[k] || k;
}


// ── Question-type classification ──────────────────────────────────
//
// Buckets a market into one of:
//   moneyline | spread | total | player_prop | team_prop | series | future | other
// These are the buckets the UI dashboard renders sections for. Order
// matters — more-specific patterns first so we don't shadow them.

function classifyQuestion(text, eventText) {
    const t = (text || "").toLowerCase();
    const e = (eventText || "").toLowerCase();
    const both = `${t} ${e}`;

    // Award & season-long futures — match first so "MLB MVP" doesn't
    // get caught by a more generic pattern below.
    if (/mvp|cy young|rookie of the year|comeback player|hank aaron|manager of the year/.test(both)) {
        return "player_prop";  // player-level future, surfaces alongside game props
    }
    if (/world series|championship|league pennant|wins the (al|nl)/.test(both)) {
        return "future";
    }
    if (/division (champion|winner)|(wins?|win the) (al|nl) (east|west|central)/.test(both)) {
        return "future";
    }
    if (/(al|nl) (east|west|central)( title|champion)?/.test(both))    return "future";
    if (/regular season win total|win total|over\/under.*wins|season wins/.test(both)) {
        return "future";  // team season-wins
    }
    if (/win (more|fewer|at least|over) .* games/.test(both))           return "future";
    if (/(next|new) [a-z ]*manager\??$/.test(both))                     return "future";
    if (/longest winning streak|longest losing streak/.test(both))      return "future";

    // Player-level nightly + season props.
    if (/home runs?|hrs?|over .* hr/.test(t))                    return "player_prop";
    if (/strikeouts?|k['']?s?|so total/.test(t))                 return "player_prop";
    if (/hits?\b|over .* hit/.test(t))                            return "player_prop";
    if (/rbis?\b|runs batted in/.test(t))                         return "player_prop";
    if (/total bases|tb total/.test(t))                           return "player_prop";
    if (/stolen bases?\b|sb total/.test(t))                       return "player_prop";

    // Game-level markets.
    if (/run line|spread/.test(t))                                return "spread";
    if (/total runs?\b|over\/under|o\/u|combined runs/.test(t))   return "total";
    if (/moneyline|who wins|winner\?|win[\s-]?probability|win this game|game winner/.test(t)) {
        return "moneyline";
    }
    // Bare "Team1 vs Team2" / "Team1 @ Team2" with both being MLB
    // teams — Polymarket's per-game moneyline events have this as
    // their title with no "winner?" keyword. We catch them by detecting
    // the matchup pattern AND a two-outcome shape (caller can override).
    if (/^[\w. ]+\s+(vs\.?|@)\s+[\w. ]+$/.test((text || "").trim())) {
        const { home, away } = extractTeamsFromTitle(text || "");
        if (home && away) return "moneyline";
    }
    // Series outcome (sweep, take series, win series).
    if (/series\b|sweep/.test(t))                                 return "series";

    // Team props that aren't moneyline/spread/total (first to score,
    // both teams score, etc.).
    if (/first to score|both teams|innings?\b/.test(t))           return "team_prop";

    return "other";
}


// ── Flatten + finalize ────────────────────────────────────────────

// Ensure every market has the full set of UI-expected keys, even when
// the adapter didn't set them — undefined fields disappear silently in
// the UI, but missing fields show "—" weirdly. We materialize the full
// shape here so consumers see consistent keys.
function flat(o) {
    return {
        id: o.id,
        source: o.source,
        sport: "mlb",
        league: "MLB",
        title: o.title || "",
        description: o.description || "",
        url: o.url || null,
        outcomes: o.outcomes || [],
        question_type: o.question_type || "other",
        status: o.status || "unknown",
        start_time: o.start_time || null,
        close_time: o.close_time || null,
        home_tricode: o.home_tricode || null,
        away_tricode: o.away_tricode || null,
        home_team: o.home_team || null,
        away_team: o.away_team || null,
        liquidity_usd: o.liquidity_usd != null ? Number(o.liquidity_usd) : null,
        volume_usd:    o.volume_usd    != null ? Number(o.volume_usd)    : null,
        raw_market_id: o.raw_market_id || null,
        source_event_id: o.source_event_id || null,
        source_event_title: o.source_event_title || null,
        // Sportsbook-aggregator extras (Odds API): how many books quote
        // this market and which ones, so the UI can show "consensus of
        // 6 books" rather than 6 duplicate rows.
        book_count:    o.book_count != null ? Number(o.book_count) : null,
        books_present: Array.isArray(o.books_present) ? o.books_present : null,
        // Spread / total handicap line. Helps the UI label cards
        // ("Spread ±1.5") and highlight the main line vs alternates.
        handicap:      o.handicap != null ? Number(o.handicap) : null,
        is_main_line:  !!o.is_main_line,
    };
}


// ── Registry: fan out, gather, normalize ──────────────────────────

// Optional second return value `diagnostics` exposes per-adapter
// outcomes (count or error) — used by /api/markets?debug=1 to surface
// silent adapter failures without spamming user-facing responses.
export async function listAllMlbMarkets(env, opts = {}) {
    // Source filter: when the caller declares it only needs one
    // source (the frontend is in Kalshi-only mode and throws the
    // other 10 sources' data away on the client anyway), skip the
    // dead adapters entirely. Saves ~10 fan-outs worth of
    // subrequests + CPU per /api/markets call — the difference
    // between "/api/markets degraded, slowed auto-refresh to 30s"
    // and the endpoint just working.
    const onlySource = opts.source || null;
    const ALL_ADAPTERS = [
        ["polymarket", listPolymarketMlbMarkets],
        ["kalshi",     listKalshiMlbMarkets],
        ["manifold",   listManifoldMlbMarkets],
        ["odds_api",   () => listOddsApiMlbMarkets(env || {})],
        ["bovada",     listBovadaMlbMarkets],
        ["pinnacle",   listPinnacleMlbMarkets],
        ["smarkets",   listSmarketsMlbMarkets],
        ["sxbet",      listSxBetMlbMarkets],
        ["thescore",   listTheScoreMlbMarkets],
        ["espn_dk",    listEspnDraftKingsMlbMarkets],
        ["vegasinsider", listVegasInsiderMlbMarkets],
    ];
    const labeled = onlySource
        ? ALL_ADAPTERS.filter(([name]) => name === onlySource)
                      .map(([name, fn]) => [name, fn()])
        : ALL_ADAPTERS.map(([name, fn]) => [name, fn()]);
    const results = await Promise.allSettled(labeled.map((x) => x[1]));
    const out = [];
    const diagnostics = {};
    for (let i = 0; i < labeled.length; i++) {
        const [name] = labeled[i];
        const r = results[i];
        if (r.status === "fulfilled") {
            out.push(...r.value);
            const entry = { ok: true, count: r.value.length };
            if (r.value._dbg) entry.dbg = r.value._dbg;
            diagnostics[name] = entry;
        } else {
            diagnostics[name] = { ok: false, error: String(r.reason?.message || r.reason || "unknown") };
        }
    }
    // Attach diagnostics as a non-enumerable property so it travels with
    // the array but doesn't change the public shape.
    Object.defineProperty(out, "_diagnostics", { value: diagnostics, enumerable: false });
    return out;
}


// ── Bovada adapter (free public sportsbook API, real American odds) ──
//
// Bovada serves their full MLB market book at a public no-auth JSON
// endpoint. ~16 games/day, each with 100+ markets when we hit the
// per-event URL: moneyline + run line + total + alternate lines +
// pitcher props (win, K's O/U) + player props (HR, 2+ HR, first HR,
// hit / total bases per player) + 1st-inning markets + game props +
// run markets + correct score. Real American + decimal + fractional
// odds on every row. THE free real-odds source.
//
// Two-step fetch:
//   1. League endpoint: list events (gives game lines but no props).
//   2. Per-event slug URL: full 126-market book per game.
//
// Cache 5 min — Bovada updates throughout the day; this keeps the page
// feeling live without hammering them.

async function listBovadaMlbMarkets() {
    let leagueData;
    try {
        // No `preMatchOnly=true` — that filter drops every in-progress
        // game from the league listing, which is exactly when users
        // care about live moneyline / total / spread odds. Unfiltered
        // returns BOTH pre-match and live events.
        const leagueUrl = `${BOVADA_BASE}/baseball/mlb?lang=en`;
        leagueData = await fetchJson(leagueUrl, { cacheTtl: 30 });
    } catch {
        return [];
    }
    const root = Array.isArray(leagueData) ? leagueData[0] : leagueData;
    let events = root?.events || [];
    if (!events.length) return [];
    // Cap to 10 events to stay under Cloudflare's 50-subrequest limit
    // (shared across all adapters in listAllMlbMarkets fan-out). The
    // 5-min edge cache means concurrent viewers see the same hit so
    // we don't lose coverage in practice — just delayed by one cycle.
    events = events.slice(0, 6);

    // Per-event fan-out to get the full market book (props included).
    const fullEvents = await Promise.allSettled(
        events.map((ev) => {
            const link = (ev.link || "").replace(/^\//, "");
            if (!link) return Promise.resolve(null);
            const url = `${BOVADA_BASE}/${link}?lang=en`;
            // 15s per-event cache — odds tick on Bovada throughout the
            // day; this keeps the page feeling live without DOS'ing them.
            return fetchJson(url, { cacheTtl: 15 })
                .then((d) => (Array.isArray(d) ? d[0] : d)?.events?.[0] || null)
                .catch(() => null);
        })
    );

    const out = [];
    for (const r of fullEvents) {
        if (r.status !== "fulfilled" || !r.value) continue;
        out.push(...parseBovadaEvent(r.value));
    }
    return out;
}

function parseBovadaEvent(ev) {
    const home = (ev.competitors || []).find((c) => c.home);
    const away = (ev.competitors || []).find((c) => !c.home);
    const homeTri = teamTricode(home?.name);
    const awayTri = teamTricode(away?.name);
    const startMs = ev.startTime || null;
    const startIso = startMs ? new Date(startMs).toISOString() : null;
    const eventTitle = ev.description || `${away?.name} @ ${home?.name}`;
    const slug = (ev.link || "").replace(/^\//, "");
    const eventUrl = slug ? `https://www.bovada.lv/${slug}` : "https://www.bovada.lv/baseball/mlb";
    const ctx = { homeTri, awayTri, home, away, startIso, eventTitle, eventUrl };

    const out = [];
    for (const g of ev.displayGroups || []) {
        for (const m of g.markets || []) {
            // Spread / Total markets sometimes pack many handicap lines
            // into ONE Bovada market with N outcomes mixing them all
            // together. Split into one synthetic market per unique
            // handicap pair so the UI renders compact 2-outcome cards
            // (the Cubs-Pirates spread had 12 outcomes in one card —
            // user complaint).
            const split = splitBovadaMultiHandicap(m, g);
            for (const sub of split) {
                const market = bovadaMarketToFlat(sub.market, g, ev, ctx, sub.handicap, sub.isMain);
                if (market) out.push(market);
            }
        }
    }
    return out;
}

// Take one Bovada market and, if it's a spread/total with multiple
// handicaps, return one synthetic market per handicap pair. Otherwise
// return the original wrapped in a single-entry array. Tags the
// most-juice-balanced handicap as the "main line" so the UI can
// surface it prominently.
function splitBovadaMultiHandicap(m, group) {
    const groupDesc = group.description || "";
    if (groupDesc !== "Game Lines" && groupDesc !== "Alternate Lines") {
        return [{ market: m, handicap: null, isMain: false }];
    }
    const descBlob = `${m.descriptionKey || ""} ${m.description || ""}`.toLowerCase();
    const isSpread = /runline|run line|spread|asian/.test(descBlob);
    const isTotal  = /total|over\/under/.test(descBlob);
    if (!isSpread && !isTotal) {
        return [{ market: m, handicap: null, isMain: false }];
    }

    // Group outcomes by absolute handicap value (spread) or by handicap
    // value (total — Over/Under share the same number).
    const byKey = new Map();
    for (const o of m.outcomes || []) {
        const h = o.price?.handicap != null ? Number(o.price.handicap) : null;
        if (h == null) continue;
        const key = isSpread ? Math.abs(h).toFixed(1) : h.toFixed(1);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(o);
    }
    if (!byKey.size) {
        return [{ market: m, handicap: null, isMain: false }];
    }

    // "Main line": the handicap with the smallest absolute price
    // spread across its two sides — i.e. the most-balanced juice.
    let mainKey = null;
    let mainSpread = Infinity;
    for (const [key, outs] of byKey) {
        if (outs.length < 2) continue;
        const a = Math.abs(Number(outs[0].price?.american) || 0);
        const b = Math.abs(Number(outs[1].price?.american) || 0);
        const spread = Math.abs(a - b);
        if (spread < mainSpread) {
            mainSpread = spread;
            mainKey = key;
        }
    }
    // For MLB spreads, also prefer ±1.5 specifically (the conventional
    // "run line") when it exists, since traders converge on that.
    if (isSpread && byKey.has("1.5")) mainKey = "1.5";

    const out = [];
    for (const [key, outs] of byKey) {
        // Synthetic per-handicap market: shares the parent metadata
        // but only the outcomes for THIS handicap, and a sub-id so
        // dedupe doesn't collapse them.
        const sub = {
            ...m,
            id: `${m.id}:h${key}`,
            outcomes: outs,
            description: isSpread
                ? `${m.description || "Spread"} ±${key}`
                : `${m.description || "Total"} ${key}`,
        };
        out.push({
            market: sub,
            handicap: Number(key),
            isMain: key === mainKey,
        });
    }
    return out;
}

function bovadaMarketToFlat(m, group, ev, ctx, handicapHint, isMainLine) {
    const desc = m.description || "";
    const descKey = m.descriptionKey || "";
    const groupDesc = group.description || "";

    let qType = "other";
    if (groupDesc === "Game Lines" || groupDesc === "Alternate Lines") {
        if (/head to head|moneyline/i.test(descKey + " " + desc)) qType = "moneyline";
        else if (/runline|run line|spread|asian/i.test(descKey + " " + desc)) qType = "spread";
        else if (/total|over\/under/i.test(descKey + " " + desc)) qType = "total";
        else qType = "other";
    } else if (groupDesc === "Pitcher Props" || groupDesc === "Player Props") {
        qType = "player_prop";
    } else if (groupDesc === "Game Props" || groupDesc === "1st Inning" || groupDesc === "Run Markets") {
        qType = "team_prop";
    }

    const outcomes = (m.outcomes || []).map((o) => {
        const p = o.price || {};
        const american = p.american;
        const decimal  = Number(p.decimal) || null;
        let probability = null;
        if (decimal && decimal > 1) {
            probability = 1 / decimal;
        }
        const handicap = p.handicap != null ? Number(p.handicap) : null;
        const sideName = o.description || o.type || "";
        const display = handicap != null && /over|under/i.test(sideName)
            ? `${sideName} ${handicap}`
            : (handicap != null && qType === "spread"
                ? `${sideName} ${handicap > 0 ? "+" : ""}${handicap}`
                : sideName);
        return {
            id: `bovada:${m.id}:${o.id}`,
            name: display,
            probability: probability,
            price: decimal,
            american: american,
            point: handicap,
            book_count: 1,
            book_lines: [{ book: "Bovada", american, price: decimal, probability }],
        };
    });

    // De-vig for clean model-comparison probability.
    if (outcomes.length === 2
        && outcomes[0].probability != null
        && outcomes[1].probability != null) {
        const sum = outcomes[0].probability + outcomes[1].probability;
        if (sum > 0) {
            for (const o of outcomes) {
                o.probability_devig = o.probability / sum;
            }
        }
    }

    if (!outcomes.length) return null;

    const titleBase = ctx.eventTitle;
    const title = `${titleBase} · ${desc || descKey || groupDesc}`;

    return flat({
        id: `bovada:${ev.id}:${m.id}`,
        source: "bovada",
        title,
        description: m.notes || "",
        url: ctx.eventUrl,
        outcomes,
        question_type: qType,
        status: "open",
        start_time: ctx.startIso,
        close_time: null,
        home_tricode: ctx.homeTri,
        away_tricode: ctx.awayTri,
        home_team: ctx.home?.name || null,
        away_team: ctx.away?.name || null,
        liquidity_usd: undefined,
        volume_usd: undefined,
        raw_market_id: m.id,
        source_event_id: ev.id,
        source_event_title: titleBase,
        book_count: 1,
        books_present: ["bovada"],
        // New fields so UI can highlight the main line and group
        // alternates separately.
        handicap: handicapHint != null ? handicapHint : null,
        is_main_line: !!isMainLine,
    });
}


// Markets that apply to one specific game — matched by team tricode
// (either pair direction) AND time-bound to tonight.
//
// HARD EXCLUSIONS for the per-game endpoint:
//   - future:  season-long futures (WS odds, MVP, etc.) belong on the
//              team page, not the game tracker.
//   - series:  series-outcome bets (sweep, take series) are season
//              context, not this-game-tonight.
//
// What gets included:
//   - moneyline / spread / total / team_prop : 48h start-time window
//   - player_prop : 48h start-time window too (a Polymarket
//                   "MVP" market with January start_time is filtered
//                   out; an Odds-API "Bregman over 1.5 hits tonight"
//                   with start_time = tonight's first pitch is kept)
//
// Per-game endpoint = lines relevant to THIS game's first pitch.
// Everything else lives on the team page.
const PER_GAME_TYPES   = new Set(["moneyline", "spread", "total", "team_prop", "player_prop"]);
const PER_GAME_EXCLUDE = new Set(["future", "series"]);
const PER_GAME_WINDOW_MS = 48 * 3600 * 1000;

export function filterMarketsForGame(markets, home, away, gameStartTime) {
    const homeTri = teamTricode(home);
    const awayTri = teamTricode(away);
    if (!homeTri && !awayTri) return [];

    const startMs = gameStartTime ? new Date(gameStartTime).getTime() : null;

    const matches = [];
    for (const m of markets) {
        if (PER_GAME_EXCLUDE.has(m.question_type)) continue;
        if (!PER_GAME_TYPES.has(m.question_type)) continue;

        const mHome = m.home_tricode;
        const mAway = m.away_tricode;
        const both = mHome && mAway;
        const teamsMatch = both
            ? ((mHome === homeTri && mAway === awayTri) ||
               (mHome === awayTri && mAway === homeTri))
            : ((mHome && (mHome === homeTri || mHome === awayTri)) ||
               (mAway && (mAway === homeTri || mAway === awayTri)));
        if (!teamsMatch) continue;

        if (startMs && m.start_time) {
            const dt = Math.abs(new Date(m.start_time).getTime() - startMs);
            if (dt > PER_GAME_WINDOW_MS) {
                // Player / team props can be season-long futures
                // (Kalshi: HR leader, RBI leader, Pitcher of the Month).
                // Their start_time is when the market opened, often
                // weeks before tonight's first pitch — but they're
                // still relevant to every game during the open window.
                // Skip the time-window rejection for those question
                // types; team-pair match alone is enough.
                if (m.question_type !== "player_prop"
                    && m.question_type !== "team_prop") continue;
            }
        }
        matches.push(m);
    }
    return dedupeByQuestionAndSource(matches, startMs);
}

// User-visible dedup: per (question_type × source), keep only the
// market with start_time closest to the game's first pitch. Kalshi
// has multiple KXMLBGAME tickers for the same team-pair (doubleheaders,
// next-day series games), each getting its own moneyline row — the
// per-game tab was showing the SAME-looking card 3 times in a row.
// Player props are intentionally NOT folded because each prop is a
// different question (HRs vs hits vs K's by player), so each row is
// distinct already.
function dedupeByQuestionAndSource(markets, anchorMs) {
    const NON_DEDUPED = new Set(["player_prop", "team_prop"]);
    const byKey = new Map();   // `${question}|${source}|${handicap}` → best market
    const out = [];
    for (const m of markets) {
        if (NON_DEDUPED.has(m.question_type)) { out.push(m); continue; }
        // Handicap goes in the key so different spread/total lines stay
        // as distinct markets (Cubs -1, Cubs -1.5, etc.). Moneylines
        // have no handicap so they still collapse properly.
        const hKey = m.handicap != null ? `:${m.handicap}` : "";
        const key = `${m.question_type}|${m.source}${hKey}`;
        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, m); continue; }
        // Pick the closer-to-anchor of the two by start_time. Ties (no
        // start_time on either) break toward the one with more priced
        // outcomes — usually the one with real trading.
        const dNew = anchorMs && m.start_time
            ? Math.abs(new Date(m.start_time).getTime() - anchorMs) : Infinity;
        const dPrev = anchorMs && prev.start_time
            ? Math.abs(new Date(prev.start_time).getTime() - anchorMs) : Infinity;
        if (dNew < dPrev) { byKey.set(key, m); continue; }
        if (dNew === dPrev) {
            const newPriced  = (m.outcomes || []).filter((o) => o.probability != null).length;
            const prevPriced = (prev.outcomes || []).filter((o) => o.probability != null).length;
            if (newPriced > prevPriced) byKey.set(key, m);
        }
    }
    for (const m of byKey.values()) out.push(m);
    return out;
}


// ── Pinnacle adapter (no-auth guest API) ──────────────────────────
//
// Pinnacle's website calls a public guest endpoint at
//   https://guest.api.arcadia.pinnacle.com/0.1/
// using an X-API-Key header that's baked into their public site bundle
// — same header any browser visiting pinnacle.com sends. League id 246
// is MLB. Returns real American odds via /matchups + /markets/related/
// straight. 30s edge cache.

const PINNACLE_BASE    = "https://guest.api.arcadia.pinnacle.com/0.1";
const PINNACLE_API_KEY = "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R";   // bundled in their public site
const PINNACLE_MLB_LEAGUE = 246;

async function listPinnacleMlbMarkets() {
    let matchups;
    try {
        const url = `${PINNACLE_BASE}/leagues/${PINNACLE_MLB_LEAGUE}/matchups?withSpecials=false`;
        matchups = await fetchJson(url, {
            cacheTtl: 30,
            headers: { "X-API-Key": PINNACLE_API_KEY },
        });
    } catch {
        return [];
    }
    if (!Array.isArray(matchups)) return [];

    // For each top-level (parent==null) matchup, hit the straight
    // markets endpoint to get moneyline / total / spread prices.
    const eligible = matchups.filter((m) => !m.parent && m.participants?.length >= 2).slice(0, 6);
    const results = await Promise.allSettled(
        eligible.map(async (ev) => {
            const id = ev.id;
            const straight = await fetchJson(
                `${PINNACLE_BASE}/matchups/${id}/markets/related/straight`,
                {
                    cacheTtl: 30,
                    headers: { "X-API-Key": PINNACLE_API_KEY },
                },
            ).catch(() => null);
            return { ev, straight };
        }),
    );

    const out = [];
    for (const r of results) {
        if (r.status !== "fulfilled" || !r.value) continue;
        const { ev, straight } = r.value;
        if (!Array.isArray(straight)) continue;
        const parts = ev.participants;
        const home = parts.find((p) => (p.alignment || "").toLowerCase() === "home") || parts[1];
        const away = parts.find((p) => (p.alignment || "").toLowerCase() === "away") || parts[0];
        const homeTri = teamTricode(home?.name);
        const awayTri = teamTricode(away?.name);
        const titleBase = `${away?.name} @ ${home?.name}`;
        const startIso = ev.startTime || null;
        const eventUrl = `https://www.pinnacle.com/en/baseball/mlb/${(home?.name || "").toLowerCase().replace(/\s+/g, "-")}-vs-${(away?.name || "").toLowerCase().replace(/\s+/g, "-")}/${ev.id}`;

        for (const mkt of straight) {
            if (mkt.period !== 0) continue;  // 0 = full game
            if (mkt.isAlternate) continue;     // main lines only for now
            const type = mkt.type;             // moneyline / spread / total
            const prices = mkt.prices || [];

            let qType = "other";
            let outcomes = [];
            if (type === "moneyline") {
                qType = "moneyline";
                // Pinnacle's straight markets endpoint sometimes
                // returns MULTIPLE prices for the same designation
                // (alternate moneylines without the isAlternate flag
                // set). Without de-duping, one Pinnacle moneyline can
                // emit 50+ outcomes all labelled "Milwaukee Brewers"
                // at different prices — which then flooded the
                // dashboard card. Keep only the first price per
                // designation (home/away) so the market has at most 2
                // outcomes, matching how every other sportsbook shows
                // a moneyline.
                const byDesignation = {};
                for (const p of prices) {
                    if (!byDesignation[p.designation]) {
                        byDesignation[p.designation] = p;
                    }
                }
                outcomes = Object.values(byDesignation).map((p) => {
                    const am = p.price;
                    const decimal = americanToDecimal(am);
                    return {
                        id: `pinnacle:${ev.id}:${type}:${p.designation}`,
                        name: p.designation === "home" ? home?.name : away?.name,
                        american: pinnacleAmericanStr(am),
                        price: decimal,
                        probability: decimal && decimal > 1 ? 1 / decimal : undefined,
                    };
                });
            } else if (type === "total") {
                qType = "total";
                outcomes = prices.map((p) => {
                    const am = p.price;
                    const decimal = americanToDecimal(am);
                    return {
                        id: `pinnacle:${ev.id}:${type}:${p.designation}:${p.points}`,
                        name: `${p.designation} ${p.points}`,
                        american: pinnacleAmericanStr(am),
                        price: decimal,
                        point: p.points,
                        probability: decimal && decimal > 1 ? 1 / decimal : undefined,
                    };
                });
            } else if (type === "spread") {
                qType = "spread";
                outcomes = prices.map((p) => {
                    const am = p.price;
                    const decimal = americanToDecimal(am);
                    const sideName = p.designation === "home" ? home?.name : away?.name;
                    return {
                        id: `pinnacle:${ev.id}:${type}:${p.designation}:${p.points}`,
                        name: `${sideName} ${p.points > 0 ? "+" : ""}${p.points}`,
                        american: pinnacleAmericanStr(am),
                        price: decimal,
                        point: p.points,
                        probability: decimal && decimal > 1 ? 1 / decimal : undefined,
                    };
                });
            } else {
                continue;
            }

            // De-vig two-outcome markets.
            if (outcomes.length === 2
                && outcomes[0].probability != null
                && outcomes[1].probability != null) {
                const sum = outcomes[0].probability + outcomes[1].probability;
                if (sum > 0) {
                    for (const o of outcomes) {
                        o.probability_devig = o.probability / sum;
                    }
                }
            }

            if (!outcomes.length) continue;

            out.push(flat({
                id: `pinnacle:${ev.id}:${type}`,
                source: "pinnacle",
                title: `${titleBase} · ${type}`,
                description: "",
                url: eventUrl,
                outcomes,
                question_type: qType,
                status: "open",
                start_time: startIso,
                close_time: mkt.cutoffAt || null,
                home_tricode: homeTri,
                away_tricode: awayTri,
                home_team: home?.name || null,
                away_team: away?.name || null,
                liquidity_usd: undefined,
                volume_usd:    undefined,
                raw_market_id: `${ev.id}:${type}`,
                source_event_id: String(ev.id),
                source_event_title: titleBase,
                book_count: 1,
                books_present: ["pinnacle"],
                is_main_line: true,
            }));
        }
    }
    return out;
}

function pinnacleAmericanStr(price) {
    if (price == null) return null;
    const n = Number(price);
    if (!Number.isFinite(n)) return null;
    return n > 0 ? `+${n}` : `${n}`;
}

function americanToDecimal(american) {
    if (american == null) return null;
    const n = Number(american);
    if (!Number.isFinite(n) || n === 0) return null;
    return n > 0 ? (n / 100) + 1 : (100 / Math.abs(n)) + 1;
}


// ── Smarkets adapter (UK exchange, no auth) ───────────────────────
//
// Smarkets is a UK peer-to-peer betting exchange. Their public API at
// api.smarkets.com/v3 exposes events / markets / contracts /
// last_executed_prices with no auth. Prices are 0-100 (last executed
// in cents) → divide by 100 to get implied probability. type=
// baseball_match catches MLB games.

const SMARKETS_BASE = "https://api.smarkets.com/v3";

async function listSmarketsMlbMarkets() {
    const dbg = { phase: "init" };
    let events;
    try {
        const url = `${SMARKETS_BASE}/events/?type=baseball_match&state=upcoming&limit=20`;
        const data = await fetchJson(url, { cacheTtl: 30 });
        events = Array.isArray(data?.events) ? data.events : [];
        dbg.events_count = events.length;
        dbg.phase = "events_loaded";
    } catch (e) {
        dbg.error_events = String(e?.message || e);
        const out = [];
        Object.defineProperty(out, "_dbg", { value: dbg, enumerable: false });
        return out;
    }
    if (!events.length) {
        const out = [];
        Object.defineProperty(out, "_dbg", { value: dbg, enumerable: false });
        return out;
    }
    events = events.slice(0, 6);  // cap for Cloudflare 50-subreq budget shared across all adapters
    dbg.events_capped = events.length;

    // 1. Per-event markets fan-out (~16 reqs).
    const marketsByEvent = await Promise.allSettled(
        events.map((ev) => fetchJson(`${SMARKETS_BASE}/events/${ev.id}/markets/`, { cacheTtl: 30 })
            .then((mkts) => ({ ev, markets: mkts?.markets || [] }))
            .catch(() => ({ ev, markets: [] }))
        ),
    );

    // 2. Find each event's "Match winner" market id.
    const winners = [];
    let markets_total = 0, markets_fetched_ok = 0;
    for (const r of marketsByEvent) {
        if (r.status !== "fulfilled") continue;
        markets_fetched_ok += 1;
        const { ev, markets } = r.value;
        markets_total += markets.length;
        const winner = markets.find((m) => /winner|match/i.test(m.name || ""));
        if (winner) winners.push({ ev, winner });
    }
    dbg.markets_fetched_ok = markets_fetched_ok;
    dbg.markets_total = markets_total;
    dbg.winners_count = winners.length;
    dbg.phase = "winners_found";
    if (!winners.length) {
        const out = [];
        Object.defineProperty(out, "_dbg", { value: dbg, enumerable: false });
        return out;
    }

    // 3. Batch contracts + prices in TWO total requests using
    //    Smarkets's comma-separated market-id URL syntax. Saves us
    //    30+ subrequests vs. one call per market.
    const winnerIds = winners.map((w) => w.winner.id).join(",");
    const [contractsResp, pricesResp] = await Promise.allSettled([
        fetchJson(`${SMARKETS_BASE}/markets/${winnerIds}/contracts/`, { cacheTtl: 20 }),
        fetchJson(`${SMARKETS_BASE}/markets/${winnerIds}/last_executed_prices/`, { cacheTtl: 10 }),
    ]);
    const contractsAll = contractsResp.status === "fulfilled" ? (contractsResp.value?.contracts || []) : [];
    const pricesByMkt  = pricesResp.status   === "fulfilled" ? (pricesResp.value?.last_executed_prices || {}) : {};
    dbg.contracts_status = contractsResp.status;
    if (contractsResp.status === "rejected") dbg.contracts_error = String(contractsResp.reason?.message || contractsResp.reason);
    dbg.prices_status = pricesResp.status;
    if (pricesResp.status === "rejected") dbg.prices_error = String(pricesResp.reason?.message || pricesResp.reason);
    dbg.contracts_count = contractsAll.length;
    dbg.prices_keys = Object.keys(pricesByMkt).length;
    dbg.phase = "batched";

    const contractsByMkt = new Map();
    for (const c of contractsAll) {
        const mid = String(c.market_id);
        if (!contractsByMkt.has(mid)) contractsByMkt.set(mid, []);
        contractsByMkt.get(mid).push(c);
    }

    const out = [];
    for (const { ev, winner } of winners) {
        const contracts = contractsByMkt.get(String(winner.id)) || [];
        const prices = pricesByMkt[String(winner.id)] || null;
        if (!contracts.length) continue;
        // Smarkets event name is "Astros at Rangers" — home is the
        // second team. We map contract_type ("HOME" / "AWAY") so the
        // mapping is unambiguous regardless of name order.
        const { home, away } = parseSmarketsEventName(ev.name);
        const homeTri = teamTricode(home);
        const awayTri = teamTricode(away);
        const startIso = ev.start_datetime || null;
        const url = `https://smarkets.com${ev.full_slug || ""}`;

        const outcomes = contracts.map((c) => {
            const side = (c.contract_type?.name || "").toUpperCase();   // HOME / AWAY
            const last = (prices || []).find((p) => p.contract_id === c.id);
            const lastPx = last?.last_executed_price != null
                ? Number(last.last_executed_price) : null;
            const probability = lastPx != null ? lastPx / 100 : undefined;
            return {
                id: `smarkets:${winner.id}:${c.id}`,
                name: side === "HOME" ? (home || c.name) : (away || c.name),
                probability,
                american: probabilityToAmerican(probability),
                price: probability ? 1 / probability : undefined,
                side,
            };
        });

        if (outcomes.length === 2
            && outcomes[0].probability != null
            && outcomes[1].probability != null) {
            const sum = outcomes[0].probability + outcomes[1].probability;
            if (sum > 0) {
                for (const o of outcomes) o.probability_devig = o.probability / sum;
            }
        }
        if (!outcomes.length) continue;

        const titleBase = `${away} @ ${home}`;
        out.push(flat({
            id: `smarkets:${ev.id}`,
            source: "smarkets",
            title: `${titleBase} · Match winner`,
            description: "",
            url,
            outcomes,
            question_type: "moneyline",
            status: "open",
            start_time: startIso,
            close_time: null,
            home_tricode: homeTri,
            away_tricode: awayTri,
            home_team: home || null,
            away_team: away || null,
            liquidity_usd: undefined,
            volume_usd: undefined,
            raw_market_id: String(winner.id),
            source_event_id: String(ev.id),
            source_event_title: titleBase,
            book_count: 1,
            books_present: ["smarkets"],
        }));
    }
    dbg.out_count = out.length;
    dbg.phase = "done";
    Object.defineProperty(out, "_dbg", { value: dbg, enumerable: false });
    return out;
}

function parseSmarketsEventName(name) {
    if (!name) return { home: null, away: null };
    // Smarkets uses "Team A at Team B" (US away/home convention).
    const m = name.match(/^(.+?)\s+(?:at|@|vs\.?)\s+(.+)$/i);
    if (m) return { away: m[1].trim(), home: m[2].trim() };
    return { home: null, away: null };
}

// Convert an implied probability to an American odds string. The
// inverse of americanToDecimal. Used so Smarkets's 54.5 cent price
// renders as something like "-120" alongside Bovada's American odds
// in the UI.
function probabilityToAmerican(p) {
    if (p == null || !Number.isFinite(p) || p <= 0 || p >= 1) return null;
    if (p >= 0.5) {
        const n = Math.round(-(p * 100) / (1 - p));
        return `${n}`;
    }
    const n = Math.round((100 * (1 - p)) / p);
    return `+${n}`;
}


// ── Sx Bet adapter (blockchain prediction market) ─────────────────
//
// Sx Bet is a Polygon-side prediction market with a public REST API
// at api.sx.bet. Sport 3 = Baseball, league 171 = MLB, market type
// 226 = moneyline (12 default). The active markets endpoint returns
// percentageOdds as a 1e20-scaled fixed-point number on the maker's
// resting order (best available price).
//
// We fetch active markets + the best order book entry per market to
// compute the implied probability for outcomeOne (away/team1) and
// outcomeTwo (home/team2).

const SX_BET_BASE = "https://api.sx.bet";
const THESCORE_BASE = "https://api.thescore.com";
const ESPN_CORE_BASE = "https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb";

async function listSxBetMlbMarkets() {
    let markets;
    try {
        const url = `${SX_BET_BASE}/markets/active?sportIds=3&leagueId=171&type=226`;
        const data = await fetchJson(url, { cacheTtl: 20 });
        markets = data?.data?.markets || [];
    } catch {
        return [];
    }
    if (!markets.length) return [];

    // Best price per market = the midpoint of the top of the order
    // book. Sx Bet's /orders endpoint returns resting orders. For
    // simplicity we fetch all orders for our market hashes once and
    // group client-side.
    const hashes = markets.map((m) => m.marketHash);
    let orders = [];
    try {
        const ordersData = await fetchJson(
            `${SX_BET_BASE}/orders?marketHashes=${hashes.join(",")}`,
            { cacheTtl: 10 },
        );
        orders = ordersData?.data || [];
    } catch { /* no orders → unpriced market still surfaces */ }

    const bestByHash = new Map();   // hash → { outcomeOneProb, outcomeTwoProb }
    for (const o of orders) {
        // percentageOdds is the probability the MAKER is laying on the
        // outcome they're betting. If isMakerBettingOutcomeOne, this
        // is outcomeOne's implied prob from their side (offer).
        const prob = Number(o.percentageOdds) / 1e20;
        if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) continue;
        const slot = bestByHash.get(o.marketHash) || {};
        if (o.isMakerBettingOutcomeOne) {
            if (slot.outcomeOneProb == null || prob > slot.outcomeOneProb) {
                slot.outcomeOneProb = prob;
            }
        } else {
            if (slot.outcomeTwoProb == null || prob > slot.outcomeTwoProb) {
                slot.outcomeTwoProb = prob;
            }
        }
        bestByHash.set(o.marketHash, slot);
    }

    const out = [];
    for (const m of markets) {
        const startIso = m.gameTime ? new Date(m.gameTime * 1000).toISOString() : null;
        // Sx Bet's outcomeOneName / outcomeTwoName ordering: typically
        // outcomeOne = team listed first in the matchup (often the
        // home team but it varies). We use teamTricode + leave it to
        // the UI to map by name match.
        const team1 = m.outcomeOneName;
        const team2 = m.outcomeTwoName;
        const t1Tri = teamTricode(team1);
        const t2Tri = teamTricode(team2);
        const best = bestByHash.get(m.marketHash) || {};
        const probOne = best.outcomeOneProb;
        const probTwo = best.outcomeTwoProb;

        const outcomes = [
            {
                id: `sxbet:${m.marketHash}:one`,
                name: team1,
                probability: probOne,
                american: probabilityToAmerican(probOne),
                price: probOne ? 1 / probOne : undefined,
            },
            {
                id: `sxbet:${m.marketHash}:two`,
                name: team2,
                probability: probTwo,
                american: probabilityToAmerican(probTwo),
                price: probTwo ? 1 / probTwo : undefined,
            },
        ];

        if (probOne != null && probTwo != null) {
            const sum = probOne + probTwo;
            if (sum > 0) {
                outcomes[0].probability_devig = probOne / sum;
                outcomes[1].probability_devig = probTwo / sum;
            }
        }

        // Sx Bet's ordering convention: t2 (outcomeTwo) is HOME in
        // their American sports config based on observed data — but
        // tricode_pair matching in the UI handles both orderings, so
        // we just expose both tricodes.
        out.push(flat({
            id: `sxbet:${m.marketHash}`,
            source: "sxbet",
            title: `${team1} vs ${team2} · Moneyline`,
            description: "",
            url: `https://sx.bet/markets/${m.marketHash}`,
            outcomes,
            question_type: "moneyline",
            status: "open",
            start_time: startIso,
            close_time: null,
            home_tricode: t2Tri,
            away_tricode: t1Tri,
            home_team: team2,
            away_team: team1,
            liquidity_usd: undefined,
            volume_usd: undefined,
            raw_market_id: m.marketHash,
            source_event_id: m.sportXeventId,
            source_event_title: `${team1} vs ${team2}`,
            book_count: 1,
            books_present: ["sxbet"],
        }));
    }
    return out;
}


// ── theScore adapter (sports media public API, no auth) ──────────
//
// theScore's news/scoreboard backend (api.thescore.com) is a public
// JSON API — same one their iOS / Android / web app reads from. They
// embed Sportradar (Betradar) moneyline + total in every MLB event's
// `timestamped_odds[]` array. No auth, no key, no Akamai.
//
// Flow:
//   1. /mlb/schedule → list of dates with event_ids[]
//   2. Filter to today + tomorrow (ET calendar).
//   3. Cap to 10 events, fetch /mlb/events/{id} in parallel.
//   4. Each event has `timestamped_odds[]` array sorted by
//      `created_at`. Take the LAST entry — most recent line.
//   5. Emit one moneyline market + one total market per event.
//
// Total subrequests: 1 + 10 = 11, fits Cloudflare budget.

async function listTheScoreMlbMarkets() {
    let schedule;
    try {
        schedule = await fetchJson(`${THESCORE_BASE}/mlb/schedule`, { cacheTtl: 300 });
    } catch {
        return [];
    }
    const days = schedule?.current_season || [];
    if (!days.length) return [];

    // Pick today + next-day buckets in ET. theScore IDs days as YYYY-MM-DD.
    const nowMs = Date.now();
    const dayLabel = (offset) => {
        const d = new Date(nowMs + offset * 86400 * 1000);
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(d);
        const y = parts.find((p) => p.type === "year").value;
        const m = parts.find((p) => p.type === "month").value;
        const dy= parts.find((p) => p.type === "day").value;
        return `${y}-${m}-${dy}`;
    };
    const wanted = new Set([dayLabel(0), dayLabel(1)]);
    const eventIds = [];
    for (const day of days) {
        if (wanted.has(day.id)) {
            for (const id of (day.event_ids || [])) eventIds.push(id);
        }
    }
    if (!eventIds.length) return [];

    const capped = eventIds.slice(0, 6);
    const fullEvents = await Promise.allSettled(
        capped.map((id) => fetchJson(`${THESCORE_BASE}/mlb/events/${id}`, { cacheTtl: 30 })
            .catch(() => null)),
    );

    const out = [];
    for (const r of fullEvents) {
        if (r.status !== "fulfilled" || !r.value) continue;
        const ev = r.value;
        const homeName = ev.home_team?.full_name;
        const awayName = ev.away_team?.full_name;
        const homeTri  = teamTricode(ev.home_team?.abbreviation) || teamTricode(homeName);
        const awayTri  = teamTricode(ev.away_team?.abbreviation) || teamTricode(awayName);
        const startIso = ev.game_date ? new Date(ev.game_date).toISOString() : null;
        const tso = Array.isArray(ev.timestamped_odds) ? ev.timestamped_odds : [];
        if (!tso.length) continue;
        // Last entry is the most recent.
        const latest = tso[tso.length - 1];
        const mlAwayAm = Number(latest.money_line_away);
        const mlHomeAm = Number(latest.money_line_home);
        if (!Number.isFinite(mlAwayAm) || !Number.isFinite(mlHomeAm)) continue;

        const eventUrl = `https://www.thescore.com/mlb/events/${ev.id}`;

        // Moneyline
        const mlHomeDec = americanToDecimal(mlHomeAm);
        const mlAwayDec = americanToDecimal(mlAwayAm);
        const mlOutcomes = [
            {
                id: `thescore:${ev.id}:ml:home`,
                name: homeName,
                american: mlHomeAm > 0 ? `+${mlHomeAm}` : `${mlHomeAm}`,
                price: mlHomeDec,
                probability: mlHomeDec && mlHomeDec > 1 ? 1 / mlHomeDec : undefined,
            },
            {
                id: `thescore:${ev.id}:ml:away`,
                name: awayName,
                american: mlAwayAm > 0 ? `+${mlAwayAm}` : `${mlAwayAm}`,
                price: mlAwayDec,
                probability: mlAwayDec && mlAwayDec > 1 ? 1 / mlAwayDec : undefined,
            },
        ];
        if (mlOutcomes[0].probability != null && mlOutcomes[1].probability != null) {
            const sum = mlOutcomes[0].probability + mlOutcomes[1].probability;
            if (sum > 0) {
                for (const o of mlOutcomes) o.probability_devig = o.probability / sum;
            }
        }
        out.push(flat({
            id: `thescore:${ev.id}:ml`,
            source: "thescore",
            title: `${awayName} @ ${homeName} · Moneyline`,
            description: "",
            url: eventUrl,
            outcomes: mlOutcomes,
            question_type: "moneyline",
            status: "open",
            start_time: startIso,
            close_time: null,
            home_tricode: homeTri,
            away_tricode: awayTri,
            home_team: homeName,
            away_team: awayName,
            liquidity_usd: undefined,
            volume_usd: undefined,
            raw_market_id: `${ev.id}:ml`,
            source_event_id: String(ev.id),
            source_event_title: `${awayName} @ ${homeName}`,
            book_count: 1,
            books_present: ["thescore"],
            is_main_line: true,
        }));

        // Total — theScore stores it as "7.5", "7.5o25", "7.5u30" etc.
        // The number prefix is the threshold; ignored suffix is the
        // exact close-time indicator. Standard juice -110/-110 assumed.
        const totalRaw = String(latest.total || "");
        const totalMatch = totalRaw.match(/^(\d+(?:\.\d+)?)/);
        if (totalMatch) {
            const threshold = Number(totalMatch[1]);
            const totalOutcomes = [
                {
                    id: `thescore:${ev.id}:tot:over`,
                    name: `Over ${threshold}`,
                    american: "-110",
                    price: americanToDecimal(-110),
                    probability: 1 / americanToDecimal(-110),
                    point: threshold,
                },
                {
                    id: `thescore:${ev.id}:tot:under`,
                    name: `Under ${threshold}`,
                    american: "-110",
                    price: americanToDecimal(-110),
                    probability: 1 / americanToDecimal(-110),
                    point: threshold,
                },
            ];
            // De-vig.
            const sum = totalOutcomes[0].probability + totalOutcomes[1].probability;
            if (sum > 0) {
                for (const o of totalOutcomes) o.probability_devig = o.probability / sum;
            }
            out.push(flat({
                id: `thescore:${ev.id}:tot`,
                source: "thescore",
                title: `${awayName} @ ${homeName} · Total Runs ${threshold}`,
                description: "",
                url: eventUrl,
                outcomes: totalOutcomes,
                question_type: "total",
                status: "open",
                start_time: startIso,
                close_time: null,
                home_tricode: homeTri,
                away_tricode: awayTri,
                home_team: homeName,
                away_team: awayName,
                liquidity_usd: undefined,
                volume_usd: undefined,
                raw_market_id: `${ev.id}:tot`,
                source_event_id: String(ev.id),
                source_event_title: `${awayName} @ ${homeName}`,
                book_count: 1,
                books_present: ["thescore"],
                handicap: threshold,
                is_main_line: true,
            }));
        }
    }
    return out;
}


// ── ESPN core API → DraftKings adapter (no auth) ──────────────────
//
// ESPN's public core API exposes EVERY MLB game's odds with provider
// = DraftKings (priority 1). No auth, no key, no Akamai. Endpoint:
//   GET /v2/sports/baseball/leagues/mlb/events?dates=YYYYMMDD
//     → list of events with { $ref: '.../events/{id}?...' }
//   GET /v2/sports/baseball/leagues/mlb/events/{id}/competitions/{id}/odds
//     → items[].provider.name=DraftKings,
//        awayTeamOdds.current.moneyLine.american,
//        homeTeamOdds.current.moneyLine.american,
//        overUnder, overOdds, underOdds, spread
//
// Cost: 1 events call + ~10 odds calls (capped) = 11 subrequests.

async function listEspnDraftKingsMlbMarkets() {
    // Today + tomorrow in ET so we cover the full slate.
    const nowMs = Date.now();
    const yyyymmdd = (offset) => {
        const d = new Date(nowMs + offset * 86400 * 1000);
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(d);
        const y = parts.find((p) => p.type === "year").value;
        const m = parts.find((p) => p.type === "month").value;
        const dy= parts.find((p) => p.type === "day").value;
        return `${y}${m}${dy}`;
    };
    const dates = `${yyyymmdd(0)}-${yyyymmdd(1)}`;
    let eventsList;
    try {
        eventsList = await fetchJson(
            `${ESPN_CORE_BASE}/events?dates=${dates}&limit=40`,
            { cacheTtl: 120 },
        );
    } catch {
        return [];
    }
    const items = eventsList?.items || [];
    if (!items.length) return [];

    // Each item has $ref → extract event id from the URL.
    const eventIds = items.map((it) => {
        const ref = it.$ref || "";
        const m = ref.match(/\/events\/(\d+)/);
        return m ? m[1] : null;
    }).filter(Boolean).slice(0, 5);   // cap for CF subrequest budget

    if (!eventIds.length) return [];

    // Two parallel fetches per event: event details (for teams + start
    // time) and competition odds. To save subrequests, fetch BOTH off
    // the event detail when possible (event endpoint has shortName +
    // date + competitions[0].$ref but odds need a separate call).
    const eventData = await Promise.allSettled(
        eventIds.map((id) => Promise.all([
            fetchJson(`${ESPN_CORE_BASE}/events/${id}`, { cacheTtl: 60 }).catch(() => null),
            fetchJson(`${ESPN_CORE_BASE}/events/${id}/competitions/${id}/odds?limit=5`, { cacheTtl: 30 }).catch(() => null),
        ])),
    );

    const out = [];
    for (const r of eventData) {
        if (r.status !== "fulfilled") continue;
        const [event, oddsResp] = r.value;
        if (!event || !oddsResp) continue;
        const items = oddsResp?.items || [];
        // Prefer DraftKings entry; fall back to first provider.
        const dk = items.find((it) => (it.provider?.name || "").toLowerCase() === "draftkings") || items[0];
        if (!dk) continue;

        // event.shortName e.g. "ATL @ CIN" → away / home tricode
        const sn = event.shortName || event.name || "";
        const tricodeMatch = sn.match(/^([A-Z]{2,4})\s+@\s+([A-Z]{2,4})/);
        if (!tricodeMatch) continue;
        const awayTri = teamTricode(tricodeMatch[1]) || tricodeMatch[1];
        const homeTri = teamTricode(tricodeMatch[2]) || tricodeMatch[2];

        const homeMlAm = dk.homeTeamOdds?.current?.moneyLine?.american
                      || dk.homeTeamOdds?.moneyLine;
        const awayMlAm = dk.awayTeamOdds?.current?.moneyLine?.american
                      || dk.awayTeamOdds?.moneyLine;
        const eventUrl = `https://www.espn.com/mlb/odds`;
        const startIso = event.date ? new Date(event.date).toISOString() : null;

        // Moneyline
        if (homeMlAm != null && awayMlAm != null) {
            const homeAmNum = typeof homeMlAm === "string" ? Number(homeMlAm.replace(/[^\d+-]/g, "")) : Number(homeMlAm);
            const awayAmNum = typeof awayMlAm === "string" ? Number(awayMlAm.replace(/[^\d+-]/g, "")) : Number(awayMlAm);
            const homeDec = americanToDecimal(homeAmNum);
            const awayDec = americanToDecimal(awayAmNum);
            const outcomes = [
                {
                    id: `espn_dk:${event.id}:ml:home`,
                    name: homeTri,
                    american: homeAmNum > 0 ? `+${homeAmNum}` : `${homeAmNum}`,
                    price: homeDec,
                    probability: homeDec && homeDec > 1 ? 1 / homeDec : undefined,
                },
                {
                    id: `espn_dk:${event.id}:ml:away`,
                    name: awayTri,
                    american: awayAmNum > 0 ? `+${awayAmNum}` : `${awayAmNum}`,
                    price: awayDec,
                    probability: awayDec && awayDec > 1 ? 1 / awayDec : undefined,
                },
            ];
            if (outcomes[0].probability != null && outcomes[1].probability != null) {
                const sum = outcomes[0].probability + outcomes[1].probability;
                if (sum > 0) {
                    for (const o of outcomes) o.probability_devig = o.probability / sum;
                }
            }
            out.push(flat({
                id: `espn_dk:${event.id}:ml`,
                source: "espn_dk",
                title: `${awayTri} @ ${homeTri} · Moneyline (DraftKings)`,
                description: "Via ESPN",
                url: eventUrl,
                outcomes,
                question_type: "moneyline",
                status: "open",
                start_time: startIso,
                close_time: null,
                home_tricode: homeTri,
                away_tricode: awayTri,
                home_team: homeTri,
                away_team: awayTri,
                liquidity_usd: undefined,
                volume_usd: undefined,
                raw_market_id: `${event.id}:ml`,
                source_event_id: String(event.id),
                source_event_title: sn,
                book_count: 1,
                books_present: ["draftkings"],
                is_main_line: true,
            }));
        }

        // Total (overUnder)
        const total = Number(dk.overUnder);
        const overAm  = Number(dk.overOdds);
        const underAm = Number(dk.underOdds);
        if (Number.isFinite(total) && Number.isFinite(overAm) && Number.isFinite(underAm)) {
            const overDec  = americanToDecimal(overAm);
            const underDec = americanToDecimal(underAm);
            const totalOutcomes = [
                {
                    id: `espn_dk:${event.id}:tot:over`,
                    name: `Over ${total}`,
                    american: overAm > 0 ? `+${overAm}` : `${overAm}`,
                    price: overDec,
                    probability: overDec && overDec > 1 ? 1 / overDec : undefined,
                    point: total,
                },
                {
                    id: `espn_dk:${event.id}:tot:under`,
                    name: `Under ${total}`,
                    american: underAm > 0 ? `+${underAm}` : `${underAm}`,
                    price: underDec,
                    probability: underDec && underDec > 1 ? 1 / underDec : undefined,
                    point: total,
                },
            ];
            const sum = (totalOutcomes[0].probability || 0) + (totalOutcomes[1].probability || 0);
            if (sum > 0) {
                for (const o of totalOutcomes) o.probability_devig = o.probability / sum;
            }
            out.push(flat({
                id: `espn_dk:${event.id}:tot`,
                source: "espn_dk",
                title: `${awayTri} @ ${homeTri} · Total ${total} (DraftKings)`,
                description: "Via ESPN",
                url: eventUrl,
                outcomes: totalOutcomes,
                question_type: "total",
                status: "open",
                start_time: startIso,
                close_time: null,
                home_tricode: homeTri,
                away_tricode: awayTri,
                home_team: homeTri,
                away_team: awayTri,
                liquidity_usd: undefined,
                volume_usd: undefined,
                raw_market_id: `${event.id}:tot`,
                source_event_id: String(event.id),
                source_event_title: sn,
                book_count: 1,
                books_present: ["draftkings"],
                handicap: total,
                is_main_line: true,
            }));
        }
    }
    return out;
}


// ── Live-line source whitelist ────────────────────────────────────
//
// Some sources serve LIVE in-play odds (updated continuously while the
// game is in progress); others are PREGAME-ONLY (the line is frozen at
// first pitch and stays stuck on the opener until the next slate).
// Mixing both into a "cross-source consensus" makes the average
// meaningless once a game starts moving — the stale pregame number
// drags consensus toward the pregame opinion even as live sources have
// already moved 50pp the other way.
//
// CLASSIFICATION DISCIPLINE: every source listed below was verified
// against MLB's official Baseball Savant home_win probability on a
// real live game. A source qualifies as LIVE only if its quote is
// within ~10pp of Savant on at least one in-progress game (and the
// adapter actually covers in-progress games rather than next-up ones).
// Anything else is PREGAME. Verification harness lives at
// docs/markets/source-verification.md — re-run when adding a source.
//
// LIVE (verified against in-progress games):
//   polymarket : prediction-market CLOB, 24/7 trading. Verified
//                2026-05-28 game 822896: 6.5% home vs Savant 6.6%
//                (0.1pp error).
//   bovada     : sportsbook, public coupon endpoint serves live events
//                (the league listing intentionally has preMatchOnly off).
//                Verified 2026-05-28 game 822896: 12.6% home vs Savant
//                6.6% (6pp sportsbook lag, but tracking live state).
//   kalshi     : KXMLBGAME tickers trade until the game ends. No
//                traders during tonight's game so the row was null
//                (harmless — null skips consensus), but the model is
//                live by design.
//   sxbet      : on-chain orderbook, continuous. Same as kalshi —
//                null tonight, harmless.
//   manifold   : prediction market, continuously priced. Often missing
//                from MLB games entirely (low volume); harmless.
//
// PREGAME / BROKEN (DO NOT use in live consensus):
//   pinnacle     : VERIFIED 2026-05-28 — adapter's
//                  /leagues/246/matchups endpoint excludes in-progress
//                  matches by default. Every one of pinnacle's 62
//                  moneyline rows tonight pointed at TOMORROW's slate
//                  (TEX-KC, LAD-PHI, PIT-MIN, ...) — none covered the
//                  live HOU-TEX. Add to LIVE_LINE_SOURCES only after
//                  the adapter is rewritten to fetch the in-play
//                  matchups endpoint and verified live.
//   smarkets     : 2026-05-28 — adapter hits Cloudflare's per-Worker
//                  subrequest cap on the prices fetch; when prices
//                  come back empty, the adapter still emits outcomes
//                  with probability=0 instead of probability=null,
//                  which would land in consensus as a 0% home-win
//                  quote and drag the average to the floor. Stays
//                  PREGAME until the adapter is fixed.
//   espn_dk      : VERIFIED 2026-05-28 game 823378 — reported PIT
//                  -175 (~64% home) while PIT was getting blown out
//                  and Savant had them at ~2%. The ESPN odds endpoint
//                  reports the pregame line and does not refresh
//                  in-play.
//   thescore     : VERIFIED 2026-05-28 game 822896 — reported TEX
//                  -145 (~57% home) for an in-progress game where
//                  Savant had TEX at 6.6%. Also serves the prior
//                  day's date in start_time (May 28 00:05Z) instead
//                  of tonight's, suggesting `timestamped_odds[]`
//                  freezes at the previous day's close-time line.
//   vegasinsider : Las Vegas OPENING odds grid HTML — by design a
//                  pregame snapshot of where the retail books opened.
//                  Tonight's grid even returned TEX @ DET (a
//                  tomorrow-or-later game), not tonight's HOU @ TEX.
//   vi_*         : every VegasInsider sub-book (bet365, betmgm,
//                  draftkings, caesars, fanduel, hardrock, fanatics,
//                  riverscasino) inherits the grid's pregame-ness.
//   odds_api     : free-tier sport-level h2h/spreads/totals are
//                  pregame. (Currently disabled — no key configured.)
//
// 2026-05-28 user report: live UI showed market consensus 36.3% for
// TEX while bovada had 12.6% and thescore had 57.1% — averaging the
// stale thescore line into the live bovada line gave a number 30pp
// off from reality. This whitelist is the fix.
export const LIVE_LINE_SOURCES = new Set([
    "polymarket",
    "bovada",
    "kalshi",
    "sxbet",
    "manifold",
]);

export function isLiveLineSource(source) {
    return LIVE_LINE_SOURCES.has(source);
}

// Drop every market whose source doesn't update continuously through
// the game. Use this before computing cross-source consensus or before
// handing markets to the UI — pregame-only sources freeze at first
// pitch and quietly pollute every downstream calc with stale prices.
export function filterToLiveLineSources(markets) {
    if (!Array.isArray(markets)) return [];
    return markets.filter((m) => LIVE_LINE_SOURCES.has(m.source));
}


// Slice a list of markets into per-question-type groups for the UI.
// Keys are exactly the ones the UI's renderMarketsSection looks for.
export function groupByQuestion(markets) {
    const out = {
        moneyline:   [],
        spread:      [],
        total:       [],
        player_prop: [],
        team_prop:   [],
        series:      [],
        future:      [],
        other:       [],
    };
    for (const m of markets) {
        const q = m.question_type || "other";
        (out[q] || out.other).push(m);
    }
    return out;
}


// Average probability across markets where any outcome matches `match`.
// Used for cross-source consensus on a yes/no question (e.g. "home wins").
export function consensusProbability(markets, match) {
    let sum = 0, n = 0;
    for (const m of markets || []) {
        for (const o of m.outcomes || []) {
            if (o.probability == null) continue;
            if (match(o, m)) { sum += o.probability; n += 1; break; }
        }
    }
    if (!n) return null;
    return sum / n;
}


// ── VegasInsider HTML adapter — fans out 8 Akamai-blocked books ───
//
// VegasInsider's public Las Vegas odds grid is a single HTML page
// containing one moneyline cell per book per game in a fixed column
// order: Open, Bet365, BetMGM, DraftKings, Caesars, FanDuel, HardRock,
// Fanatics, RiversCasino, Consensus. That gives us a free read of the
// exact 8 retail US books that block direct API access via Akamai —
// DraftKings, FanDuel, BetMGM, Caesars, Bet365, HardRock, Fanatics,
// RiversCasino — plus Bet365 (not US-licensed) — all in a single
// subrequest (the cheapest possible adapter for our 50-subrequest cap).
//
// We emit one Market per (game, book) so each book gets its own row
// (and chip) in the UI — same shape as Bovada / Pinnacle / etc., just
// with `source: vi_<book>` keys. The Consensus column is skipped
// (we already compute our own cross-source consensus downstream).
// The Open column is also skipped — it's a historical opener, not live.

const VEGAS_INSIDER_URL = "https://www.vegasinsider.com/mlb/odds/las-vegas/";

// Column order in the VI grid, used to map each <td.game-odds> to a book.
const VI_BOOK_ORDER = [
    "open",
    "bet365",
    "betmgm",
    "draftkings",
    "caesars",
    "fanduel",
    "hardrock",
    "fanatics",
    "riverscasino",
    "consensus",
];

// Books we surface — Open + Consensus skipped (see above).
const VI_BOOKS_EMIT = new Set([
    "bet365", "betmgm", "draftkings", "caesars",
    "fanduel", "hardrock", "fanatics", "riverscasino",
]);

const VI_BOOK_LABELS = {
    bet365:       "Bet365",
    betmgm:       "BetMGM",
    draftkings:   "DraftKings",
    caesars:      "Caesars",
    fanduel:      "FanDuel",
    hardrock:     "Hard Rock",
    fanatics:     "Fanatics",
    riverscasino: "BetRivers",
};

// American odds → implied probability (no devig — we devig per-pair below).
function americanToProbability(american) {
    const n = Number(american);
    if (!Number.isFinite(n) || n === 0) return null;
    if (n > 0)  return 100 / (n + 100);
    return -n / (-n + 100);
}

async function listVegasInsiderMlbMarkets() {
    let html;
    try {
        const res = await fetch(VEGAS_INSIDER_URL, {
            headers: { "User-Agent": UA, "accept": "text/html" },
            cf: { cacheTtl: 30, cacheEverything: true },
        });
        if (!res.ok) return [];
        html = await res.text();
    } catch {
        return [];
    }
    if (!html || html.length < 5000) return [];

    // Each game has TWO rows (header = away team, footer = home team).
    // We walk every <tr> with class "header" or "footer", capture the
    // data-abbr (team) and the ordered list of moneyline cells.
    const trRe   = /<tr[^>]*class="[^"]*(?:header|footer)[^"]*"[\s\S]*?<\/tr>/g;
    const abbrRe = /data-abbr="([A-Z]+)"/;
    const mlRe   = /class="data-moneyline">\s*([+\-0-9]+)\s*</g;

    const rows = [];
    let m;
    while ((m = trRe.exec(html)) !== null) {
        const row = m[0];
        const abbr = abbrRe.exec(row);
        if (!abbr) continue;
        const lines = [];
        let lm;
        const localRe = new RegExp(mlRe.source, "g");
        while ((lm = localRe.exec(row)) !== null) {
            lines.push(lm[1]);
        }
        if (lines.length < 8) continue;
        rows.push({ abbr: abbr[1], lines });
    }

    // Pair adjacent rows into games (away first, then home — VI's order).
    const out = [];
    for (let i = 0; i + 1 < rows.length; i += 2) {
        const away = rows[i];
        const home = rows[i + 1];
        const awayTri = teamTricode(away.abbr);
        const homeTri = teamTricode(home.abbr);
        if (!awayTri || !homeTri) continue;

        for (let col = 0; col < VI_BOOK_ORDER.length; col++) {
            const book = VI_BOOK_ORDER[col];
            if (!VI_BOOKS_EMIT.has(book)) continue;
            const aAm = away.lines[col];
            const hAm = home.lines[col];
            if (!aAm || !hAm) continue;
            const aP = americanToProbability(aAm);
            const hP = americanToProbability(hAm);
            if (aP == null || hP == null) continue;

            // Two-outcome devig — normalize sum to 1.
            const sum = aP + hP;
            const aDevig = sum > 0 ? aP / sum : null;
            const hDevig = sum > 0 ? hP / sum : null;

            const src = `vi_${book}`;
            const label = VI_BOOK_LABELS[book] || book;
            const matchup = `${away.abbr} @ ${home.abbr}`;
            out.push(flat({
                id:       `${src}:${awayTri}v${homeTri}:ml`,
                source:   src,
                title:    `${label} — ${matchup} Moneyline`,
                question_type: "moneyline",
                status:   "open",
                start_time: null,        // VI grid is today's slate only
                home_tricode: homeTri,
                away_tricode: awayTri,
                home_team:    home.abbr,
                away_team:    away.abbr,
                outcomes: [
                    {
                        id:   `${src}:${awayTri}v${homeTri}:away`,
                        name: away.abbr,
                        probability: aP,
                        probability_devig: aDevig,
                        american: aAm,
                        price:    aP > 0 ? 1 / aP : undefined,
                    },
                    {
                        id:   `${src}:${awayTri}v${homeTri}:home`,
                        name: home.abbr,
                        probability: hP,
                        probability_devig: hDevig,
                        american: hAm,
                        price:    hP > 0 ? 1 / hP : undefined,
                    },
                ],
                raw_market_id:       `${awayTri}v${homeTri}`,
                source_event_id:     `${awayTri}v${homeTri}`,
                source_event_title:  matchup,
                book_count:    1,
                books_present: [book],
                is_main_line:  true,
            }));
        }
    }
    return out;
}
