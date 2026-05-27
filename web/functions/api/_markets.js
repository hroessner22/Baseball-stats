// Markets SDK — vendored from sports-oracle's @oracle/markets package.
//
// Source: github.com/alexroessner/sports-oracle/packages/markets
// Vendored 2026-05-27 for use in Cloudflare Pages Functions (no Bun
// monorepo). Kept the read-only adapters that don't need API keys:
// Polymarket (Gamma API), Kalshi (public REST), Manifold. The Odds API
// adapter is stubbed in — wakes up when ODDS_API_KEY is set in env.
//
// Unified Market shape:
//   {
//     id, source, sport, league?, title, description?,
//     outcomes: [{ id, name, probability?, price?, liquidity? }],
//     status: "open"|"closed"|"resolved"|"cancelled"|"unknown",
//     startTime?, closeTime?, resolutionTime?,
//     metadata: { homeTeam?, awayTeam?, homeTricode?, awayTricode?, gamePk?, ... },
//     rawUrl?
//   }
//
// All probabilities normalized to [0, 1]. Consumers should prefer
// `probability` over `price` for portable cross-source comparison.

const POLY_GAMMA = "https://gamma-api.polymarket.com";
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const MANIFOLD_BASE = "https://api.manifold.markets/v0";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";


// ── MLB team normalization ────────────────────────────────────────

export const MLB_TEAMS = [
    ["ARI","Arizona Diamondbacks",["arizona","d-backs","dbacks","diamondbacks"]],
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
    ["LAD","Los Angeles Dodgers",["la dodgers","dodgers"]],
    ["MIA","Miami Marlins",["miami","marlins","florida"]],
    ["MIL","Milwaukee Brewers",["milwaukee","brewers"]],
    ["MIN","Minnesota Twins",["minnesota","twins"]],
    ["NYM","New York Mets",["ny mets","mets"]],
    ["NYY","New York Yankees",["ny yankees","yankees","yanks"]],
    ["OAK","Oakland Athletics",["oakland","athletics","as","a's"]],
    ["PHI","Philadelphia Phillies",["philadelphia","phillies","phils"]],
    ["PIT","Pittsburgh Pirates",["pittsburgh","pirates","bucs"]],
    ["SD","San Diego Padres",["san diego","padres","sdp"]],
    ["SEA","Seattle Mariners",["seattle","mariners","ms"]],
    ["SF","San Francisco Giants",["san francisco","giants","sfg"]],
    ["STL","St. Louis Cardinals",["st louis","saint louis","cardinals","cards"]],
    ["TB","Tampa Bay Rays",["tampa bay","rays","tbr"]],
    ["TEX","Texas Rangers",["texas","rangers"]],
    ["TOR","Toronto Blue Jays",["toronto","blue jays","jays"]],
    ["WSH","Washington Nationals",["washington","nationals","nats"]],
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
    // partial-contains fallback
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
    // "X @ Y" → X is away, Y is home
    const at = cleaned.match(/(.+?)\s+@\s+(.+)/);
    if (at) {
        return {
            away: teamTricode(at[1].trim()),
            home: teamTricode(at[2].trim()),
        };
    }
    // "X vs Y" / "X vs. Y" — convention varies; we don't know which is home
    const vs = cleaned.match(/(.+?)\s+vs\.?\s+(.+)/i);
    if (vs) {
        return {
            home: teamTricode(vs[1].trim()),
            away: teamTricode(vs[2].trim()),
        };
    }
    return { home: null, away: null };
}


// ── Polymarket adapter ────────────────────────────────────────────

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

async function listPolymarketMlbMarkets() {
    // Polymarket's /events endpoint with category=Sports + active=true.
    // Filter by title prefix "MLB:" (Polymarket's convention).
    const url = `${POLY_GAMMA}/events?category=Sports&active=true&closed=false&limit=200`;
    let events;
    try {
        events = await fetchJson(url, { cacheTtl: 30 });
    } catch (e) {
        return [];
    }
    const out = [];
    for (const ev of events || []) {
        const title = ev.title || "";
        if (!/\b(MLB|mlb)\b/i.test(title)) continue;
        for (const m of ev.markets || []) {
            if (m.closed || m.archived) continue;
            const outcomes = parseJsonArray(m.outcomes);
            const prices   = parseJsonArray(m.outcomePrices).map(Number);
            const { home, away } = extractTeamsFromTitle(ev.title);
            const market = {
                id:      `polymarket:${m.id || m.conditionId}`,
                source:  "polymarket",
                sport:   "mlb",
                league:  "MLB",
                title:   ev.title,
                description: m.question || "",
                outcomes: outcomes.map((name, i) => ({
                    id:   `${m.id}:${i}`,
                    name: String(name),
                    probability: Number.isFinite(prices[i]) ? prices[i] : undefined,
                })),
                status: m.closed ? "closed" : "open",
                startTime: ev.startDate ? new Date(ev.startDate) : undefined,
                closeTime: m.endDate ? new Date(m.endDate) : undefined,
                metadata: {
                    eventTitle: ev.title,
                    homeTricode: home,
                    awayTricode: away,
                    sourceMarketId: m.id,
                    sourceEventId:  ev.id,
                    questionType: classifyQuestion(m.question || ev.title),
                },
                rawUrl: m.slug
                    ? `https://polymarket.com/event/${ev.slug || m.slug}`
                    : undefined,
            };
            out.push(market);
        }
    }
    return out;
}


// ── Kalshi adapter ────────────────────────────────────────────────

async function listKalshiMlbMarkets() {
    // Kalshi has MLB markets under series prefixes like "KXMLB" (game),
    // "KXMLBSER" (series), etc. We pull the open markets for series
    // tickers starting with KXMLB.
    const url = `${KALSHI_BASE}/markets?status=open&limit=200`;
    let data;
    try {
        data = await fetchJson(url, { cacheTtl: 30 });
    } catch {
        return [];
    }
    const out = [];
    for (const m of data?.markets || []) {
        const ticker = m.ticker || "";
        if (!ticker.toUpperCase().startsWith("KXMLB")) continue;
        // Two-outcome event (Yes/No on a binary question, or two-team game).
        // Kalshi prices are in cents (0-100). Convert to probability.
        const yesProb = (m.yes_bid != null && m.yes_ask != null)
            ? (m.yes_bid + m.yes_ask) / 200
            : (m.last_price != null ? m.last_price / 100 : undefined);
        const noProb = yesProb != null ? 1 - yesProb : undefined;
        const { home, away } = extractTeamsFromTitle(m.title || m.subtitle || "");
        out.push({
            id: `kalshi:${ticker}`,
            source: "kalshi",
            sport:  "mlb",
            league: "MLB",
            title:  m.title || ticker,
            description: m.subtitle || "",
            outcomes: [
                { id: `${ticker}:yes`, name: m.yes_sub_title || "Yes", probability: yesProb },
                { id: `${ticker}:no`,  name: m.no_sub_title  || "No",  probability: noProb },
            ],
            status: m.status === "active" ? "open" : (m.status || "unknown"),
            startTime: m.open_time ? new Date(m.open_time) : undefined,
            closeTime: m.close_time ? new Date(m.close_time) : undefined,
            metadata: {
                eventTitle: m.event_ticker,
                homeTricode: home,
                awayTricode: away,
                sourceMarketId: ticker,
                questionType: classifyQuestion(m.title || m.subtitle || ""),
            },
            rawUrl: `https://kalshi.com/markets/${ticker.toLowerCase()}`,
        });
    }
    return out;
}


// ── Manifold adapter ──────────────────────────────────────────────

async function listManifoldMlbMarkets() {
    // Manifold tag search. Free, no auth. Returns play-money markets but
    // they're often closer to "real" prob than betting markets because
    // there's no vig.
    const url = `${MANIFOLD_BASE}/search-markets?term=MLB&filter=open&sort=score&limit=80`;
    let data;
    try {
        data = await fetchJson(url, { cacheTtl: 60 });
    } catch {
        return [];
    }
    const out = [];
    const arr = Array.isArray(data) ? data : (data.markets || []);
    for (const m of arr) {
        if (m.isResolved) continue;
        // Binary markets: probability is the "yes" probability
        if (m.outcomeType !== "BINARY") continue;
        const p = typeof m.probability === "number" ? m.probability : undefined;
        const { home, away } = extractTeamsFromTitle(m.question || "");
        out.push({
            id: `manifold:${m.id}`,
            source: "manifold",
            sport:  "mlb",
            league: "MLB",
            title:  m.question || "",
            description: "",
            outcomes: [
                { id: `${m.id}:yes`, name: "Yes", probability: p },
                { id: `${m.id}:no`,  name: "No",  probability: p != null ? 1 - p : undefined },
            ],
            status: m.isResolved ? "resolved" : "open",
            startTime: m.createdTime ? new Date(m.createdTime) : undefined,
            closeTime: m.closeTime ? new Date(m.closeTime) : undefined,
            metadata: {
                eventTitle: m.question,
                homeTricode: home,
                awayTricode: away,
                sourceMarketId: m.id,
                liquidity: m.totalLiquidity,
                questionType: classifyQuestion(m.question || ""),
            },
            rawUrl: m.url || `https://manifold.markets/${m.creatorUsername}/${m.slug}`,
        });
    }
    return out;
}


// ── The Odds API adapter (sportsbook aggregator) ──────────────────

async function listOddsApiMlbMarkets(env) {
    const key = env?.ODDS_API_KEY || env?.THE_ODDS_API_KEY;
    if (!key) return [];

    // moneyline (h2h), run line (spreads), total runs O/U (totals)
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
                out.push({
                    id: `theoddsapi:${ev.id}:${bm.key}:${m.key}`,
                    source: "theoddsapi",
                    sport:  "mlb",
                    league: "MLB",
                    title,
                    description: `${m.key} via ${bm.title}`,
                    outcomes: (m.outcomes || []).map((o) => ({
                        id: `${bm.key}:${m.key}:${o.name}${o.point != null ? `:${o.point}` : ""}`,
                        name: o.point != null ? `${o.name} ${o.point}` : o.name,
                        price: o.price,
                        probability: o.price > 0 ? 1 / o.price : undefined,
                    })),
                    status: "open",
                    startTime: ev.commence_time ? new Date(ev.commence_time) : undefined,
                    metadata: {
                        eventTitle: title,
                        homeTeam: ev.home_team,
                        awayTeam: ev.away_team,
                        homeTricode: homeTri,
                        awayTricode: awayTri,
                        sourceMarketId: `${ev.id}:${bm.key}:${m.key}`,
                        bookmaker: bm.title,
                        marketType: m.key,
                        questionType: m.key,  // h2h / spreads / totals
                    },
                });
            }
        }
    }
    return out;
}


// ── Question-type classification ──────────────────────────────────

// Buckets a market title/question into a coarse category we can group on
// in the UI. Keeps grouping cheap without parsing every source's nuances.
function classifyQuestion(text) {
    if (!text) return "other";
    const t = text.toLowerCase();
    if (/win the world series|championship|pennant/.test(t)) return "championship";
    if (/win the division|division winner/.test(t))          return "division";
    if (/mvp|cy young|rookie of the year|manager of the year/.test(t)) return "award";
    if (/win the (al|nl)|league pennant/.test(t))            return "pennant";
    if (/h2h|moneyline|who wins|win[\s-]?probability|win this game/.test(t)) return "moneyline";
    if (/run line|spread/.test(t))                            return "spread";
    if (/total|over\/under|o\/u|combined runs/.test(t))       return "total";
    if (/home runs|hr|over .* hr/.test(t))                    return "player_hr";
    if (/strikeouts|k's|so/.test(t))                          return "player_k";
    if (/hits|h \(/.test(t))                                  return "player_hits";
    if (/series|sweep/.test(t))                               return "series";
    return "other";
}


// ── Registry: fan out, gather, normalize ──────────────────────────

// Pulls MLB markets from every adapter (in parallel) and normalizes to
// the unified Market shape. Adapter failures are swallowed individually
// so one source being down doesn't break the rest. Returns markets in
// no particular order — caller can group/filter.
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


// Markets attached to one specific game — matched by home/away tricodes
// and (when available) by game start time being on the right ET date.
// MLB StatsAPI game_pks aren't in any market title, so we match by team
// pair instead. Tricodes survive aliasing differences across sources.
export function filterMarketsForGame(markets, home, away, gameStartTime) {
    const homeTri = teamTricode(home);
    const awayTri = teamTricode(away);
    if (!homeTri && !awayTri) return [];

    const startMs = gameStartTime ? new Date(gameStartTime).getTime() : null;
    const TWO_DAYS = 48 * 3600 * 1000;

    const matches = [];
    for (const m of markets) {
        const mHome = m.metadata?.homeTricode;
        const mAway = m.metadata?.awayTricode;
        // Tricode match: either pair direction works (some sources don't
        // distinguish home/away in the title).
        const teamsMatch =
            (mHome === homeTri && mAway === awayTri) ||
            (mHome === awayTri && mAway === homeTri);
        if (!teamsMatch) continue;

        // Date filter: if both have a start time, they should be within
        // 48h of each other (covers postponed games + time zones).
        if (startMs && m.startTime) {
            const dt = Math.abs(new Date(m.startTime).getTime() - startMs);
            if (dt > TWO_DAYS) continue;
        }
        matches.push(m);
    }
    return matches;
}


// Slice a list of markets into per-question-type groups for the dashboard.
// Returns { moneyline: [...], spread: [...], total: [...], other: [...] }.
export function groupByQuestion(markets) {
    const out = {
        moneyline:   [],
        spread:      [],
        total:       [],
        championship:[],
        division:    [],
        pennant:     [],
        series:      [],
        player_hr:   [],
        player_k:    [],
        player_hits: [],
        other:       [],
    };
    for (const m of markets) {
        const q = m.metadata?.questionType || "other";
        (out[q] || out.other).push(m);
    }
    return out;
}


// Average implied probability across N markets for the SAME outcome
// (e.g. "Mets win this game" priced by Polymarket, Kalshi, Manifold).
// Returns null when no market quotes that outcome. Weighted by liquidity
// when available; equal-weighted otherwise.
export function consensusProbability(markets, matchOutcomeName) {
    const numerators = [];
    const denominators = [];
    for (const m of markets) {
        const o = (m.outcomes || []).find(
            (x) => matchOutcomeName(x, m)
        );
        if (!o || o.probability == null) continue;
        const weight = m.metadata?.liquidity > 0 ? m.metadata.liquidity : 1;
        numerators.push(o.probability * weight);
        denominators.push(weight);
    }
    if (numerators.length === 0) return null;
    const num = numerators.reduce((a, b) => a + b, 0);
    const den = denominators.reduce((a, b) => a + b, 0);
    return den > 0 ? num / den : null;
}
