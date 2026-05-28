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
    return { home: null, away: null };
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

async function listPolymarketMlbMarkets() {
    const url = `${POLY_GAMMA}/events`
              + `?tag_slug=baseball&active=true&closed=false&limit=200`;
    let events;
    try {
        events = await fetchJson(url, { cacheTtl: 30 });
    } catch {
        return [];
    }
    if (!Array.isArray(events)) return [];

    const out = [];
    for (const ev of events) {
        const evTitle = ev.title || "";
        const evSlug  = ev.slug || "";
        const teams   = extractTeamsFromTitle(evTitle);
        const startMs = ev.startDate ? Date.parse(ev.startDate) : null;
        const endMs   = ev.endDate ? Date.parse(ev.endDate) : null;
        const evVol   = Number(ev.volume) || Number(ev.volume24hr) || undefined;
        const evLiq   = Number(ev.liquidity) || undefined;

        for (const m of ev.markets || []) {
            if (m.closed || m.archived) continue;
            const names  = parseJsonArray(m.outcomes);
            const prices = parseJsonArray(m.outcomePrices).map(Number);
            if (!names.length) continue;

            const mTitle = m.question || evTitle;
            const qType  = classifyQuestion(mTitle, evTitle);
            const url    = m.slug || evSlug
                ? `https://polymarket.com/event/${evSlug || m.slug}`
                : `https://polymarket.com/`;

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
                start_time: startMs ? new Date(startMs).toISOString() : null,
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

// Series we pull. Game-day moneylines + a curated list of season
// futures we know exist on Kalshi today.
const KALSHI_SERIES = [
    { ticker: "KXMLBGAME",        type: "game" },          // per-game moneyline
    { ticker: "KXLEADERMLBHR",    type: "future_player" }, // HR leader
    { ticker: "KXMLBRBI",         type: "future_player" }, // RBI leader
    { ticker: "KXMLBPITCHEROTM",  type: "future_player" }, // pitcher of the month
];

async function listKalshiMlbMarkets() {
    const all = [];
    for (const s of KALSHI_SERIES) {
        try {
            const url = `${KALSHI_BASE}/markets`
                      + `?series_ticker=${s.ticker}&status=open&limit=400`;
            const data = await fetchJson(url, { cacheTtl: 30 });
            const mkts = Array.isArray(data?.markets) ? data.markets : [];
            if (s.type === "game") {
                all.push(...foldKalshiGameMarkets(mkts));
            } else {
                for (const m of mkts) all.push(toKalshiSingleMarket(m, s.type));
            }
        } catch {
            // skip this series, keep going with the rest
        }
    }
    // Also fetch team season-wins futures (KXMLBWINS-{TRI}). One series
    // per team — list them all in one parallel fan-out.
    try {
        const winsSeries = MLB_TEAMS.map(([tri]) => `KXMLBWINS-${tri}`);
        const results = await Promise.allSettled(
            winsSeries.map((s) => fetchJson(
                `${KALSHI_BASE}/markets?series_ticker=${s}&status=open&limit=50`,
                { cacheTtl: 60 },
            ))
        );
        for (let i = 0; i < results.length; i++) {
            if (results[i].status !== "fulfilled") continue;
            const tri = MLB_TEAMS[i][0];
            const mkts = results[i].value?.markets || [];
            for (const m of mkts) {
                const market = toKalshiSingleMarket(m, "future_team");
                market.home_tricode = tri;
                all.push(market);
            }
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

// Deterministically split a concatenated two-team tricode pair. Tries
// every valid (2 or 3) + (2 or 3) split and returns the first where
// BOTH halves are recognized MLB tricodes. Returns null if no split
// works — caller should drop the market.
const MLB_TRICODE_SET = new Set(MLB_TEAMS.map(([tri]) => tri));
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
            return { t1, t2 };
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

function toKalshiSingleMarket(m, type) {
    const yb = Number(m.yes_bid);
    const ya = Number(m.yes_ask);
    const last = Number(m.last_price);
    const yesProb = (Number.isFinite(yb) && Number.isFinite(ya) && yb + ya > 0)
        ? (yb + ya) / 200
        : (Number.isFinite(last) && last > 0 ? last / 100 : undefined);
    const noProb = yesProb != null ? 1 - yesProb : undefined;
    const title = m.title || m.subtitle || m.ticker;
    return flat({
        id: `kalshi:${m.ticker}`,
        source: "kalshi",
        title,
        description: m.subtitle || "",
        url: `https://kalshi.com/markets/${(m.ticker || "").toLowerCase()}`,
        outcomes: [
            { id: `${m.ticker}:yes`, name: m.yes_sub_title || "Yes", probability: yesProb },
            { id: `${m.ticker}:no`,  name: m.no_sub_title  || "No",  probability: noProb },
        ],
        question_type:
            type === "future_player" ? "player_prop"
            : type === "future_team" ? "future"
            : classifyQuestion(title),
        status: m.status === "active" ? "open" : (m.status || "unknown"),
        start_time: m.open_time || null,
        close_time: m.close_time || null,
        home_tricode: null,
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

async function listOddsApiMlbMarkets(env) {
    const key = env?.ODDS_API_KEY || env?.THE_ODDS_API_KEY;
    if (!key) return [];

    const params = new URLSearchParams({
        apiKey: key,
        regions: "us",
        markets: "h2h,spreads,totals",
        oddsFormat: "decimal",
    });
    const url = `${ODDS_API_BASE}/sports/baseball_mlb/odds?${params}`;
    let events;
    try {
        events = await fetchJson(url, { cacheTtl: 60 });
    } catch {
        return [];
    }
    const out = [];
    for (const ev of events || []) {
        const homeTri = teamTricode(ev.home_team);
        const awayTri = teamTricode(ev.away_team);
        for (const bm of ev.bookmakers || []) {
            for (const m of bm.markets || []) {
                const title = `${ev.away_team} @ ${ev.home_team} · ${m.key} · ${bm.title}`;
                const qType = m.key === "h2h"    ? "moneyline"
                            : m.key === "spreads" ? "spread"
                            : m.key === "totals"  ? "total"
                            : "other";
                out.push(flat({
                    id: `odds:${ev.id}:${bm.key}:${m.key}`,
                    source: "odds_api",
                    title,
                    description: "",
                    url: `https://the-odds-api.com/`,
                    outcomes: (m.outcomes || []).map((o) => ({
                        id: `${bm.key}:${m.key}:${o.name}${o.point != null ? `:${o.point}` : ""}`,
                        name: o.point != null ? `${o.name} ${o.point}` : o.name,
                        price: o.price,
                        point: o.point,
                        probability: o.price > 1 ? 1 / o.price : undefined,
                    })),
                    question_type: qType,
                    status: "open",
                    start_time: ev.commence_time || null,
                    close_time: null,
                    home_tricode: homeTri,
                    away_tricode: awayTri,
                    home_team: ev.home_team,
                    away_team: ev.away_team,
                    liquidity_usd: undefined,
                    volume_usd: undefined,
                    raw_market_id: `${ev.id}:${bm.key}:${m.key}`,
                    source_event_id: ev.id,
                    source_event_title: title,
                }));
            }
        }
    }
    return out;
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
    if (/division (champion|winner)|wins (al|nl) (east|west|central)/.test(both)) {
        return "future";
    }
    if (/regular season win total|win total|over\/under.*wins|season wins/.test(both)) {
        return "future";  // team season-wins
    }

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
    };
}


// ── Registry: fan out, gather, normalize ──────────────────────────

export async function listAllMlbMarkets(env) {
    const results = await Promise.allSettled([
        listPolymarketMlbMarkets(),
        listKalshiMlbMarkets(),
        listManifoldMlbMarkets(),
        listOddsApiMlbMarkets(env || {}),
    ]);
    const out = [];
    for (const r of results) {
        if (r.status === "fulfilled") out.push(...r.value);
    }
    return out;
}


// Markets that apply to one specific game — matched by team tricode
// (either pair direction) plus, for game-specific markets only, a
// start-time window.
//
// Game-specific markets (moneyline, spread, total) MUST have a
// start_time within 48 hours of this game. Otherwise we'd surface
// stale Polymarket events from earlier in the series.
//
// Futures / season-long props (World Series odds, season wins,
// MVP, etc.) ALWAYS apply to a team that's playing tonight. They
// have arbitrary startDate (often the event-creation date), so we
// skip the date check for those question types and match purely on
// team involvement.
//
// Player props match by player name in the UI layer (per matchup-card
// hydration), not here — this just bundles them with the team feed.
export function filterMarketsForGame(markets, home, away, gameStartTime) {
    const homeTri = teamTricode(home);
    const awayTri = teamTricode(away);
    if (!homeTri && !awayTri) return [];

    const startMs = gameStartTime ? new Date(gameStartTime).getTime() : null;
    const TWO_DAYS = 48 * 3600 * 1000;

    const TIME_BOUND_TYPES = new Set(["moneyline", "spread", "total", "team_prop"]);

    const matches = [];
    for (const m of markets) {
        const mHome = m.home_tricode;
        const mAway = m.away_tricode;
        const both = mHome && mAway;
        const teamsMatch = both
            ? ((mHome === homeTri && mAway === awayTri) ||
               (mHome === awayTri && mAway === homeTri))
            : ((mHome && (mHome === homeTri || mHome === awayTri)) ||
               (mAway && (mAway === homeTri || mAway === awayTri)));
        if (!teamsMatch) continue;

        // Game-day markets are time-bound. Futures and player props
        // aren't — a season-long "Will the Braves win the World
        // Series?" applies tonight whether it was created in Feb or May.
        if (TIME_BOUND_TYPES.has(m.question_type)
            && startMs && m.start_time) {
            const dt = Math.abs(new Date(m.start_time).getTime() - startMs);
            if (dt > TWO_DAYS) continue;
        }
        matches.push(m);
    }
    return matches;
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
