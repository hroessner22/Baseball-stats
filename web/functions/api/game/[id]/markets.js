// /api/game/{id}/markets
//
// Pull every prediction-market quote for this specific MLB game from
// every public source we wrap (Polymarket, Kalshi, Manifold, plus The
// Odds API when ODDS_API_KEY is configured). Group by question type
// (moneyline / spread / total / props), compute cross-source consensus,
// and surface alongside our model's WE so users can see where we agree
// or diverge from real money.
//
// Vendored from sports-oracle's @oracle/markets — see web/functions/api/
// _markets.js for the full SDK. Same unified Market shape that
// alexroessner's prediction-protocol consumes; this endpoint is our
// data-platform's read of the same surface.
//
// Cache: 20s. Sportsbook lines move quickly; user said update rapidly.

import {
    listAllMlbMarkets,
    listKalshiMlbMarkets,
    filterMarketsForGame,
    filterToLiveLineSources,
    groupByQuestion,
    consensusProbability,
    teamTricode,
    LIVE_LINE_SOURCES,
} from "../../_markets.js";

const CACHE_SECONDS = 10;   // rapid updates per user feedback


export async function onRequest(context) {
    const env = context.env || {};
    const gameId = context.params?.id;

    if (gameId === "demo") {
        return jsonResponse({ game_pk: "demo", available: false,
            reason: "demo game has no real markets" }, 0);
    }
    if (!gameId || !/^\d+$/.test(gameId)) {
        return jsonError(400, "invalid game id");
    }

    // 1. Pull the game's team info + start time from our own API
    //    (which has it shaped from MLB feed).
    const origin = new URL(context.request.url).origin;
    let game;
    try {
        const res = await fetch(`${origin}/api/game/${gameId}`);
        if (!res.ok) throw new Error(`game HTTP ${res.status}`);
        game = await res.json();
    } catch (e) {
        return jsonError(502, `failed to load game: ${e.message || e}`);
    }

    const homeAbbr = game?.teams?.home?.abbr || game?.teams?.home?.name;
    const awayAbbr = game?.teams?.away?.abbr || game?.teams?.away?.name;
    if (!homeAbbr || !awayAbbr) {
        return jsonError(400, "couldn't resolve teams for this game");
    }

    // 2. Pull every MLB market across all sources (parallel inside
    //    the SDK), then filter to ones matching this game's teams.
    //    Also fetch MLB's official winProbability feed — Baseball
    //    Savant reads from the same source for the live-WE numbers it
    //    shows on its game pages, so we get "Savant's WE" by hitting
    //    /api/v1/game/{pk}/winProbability and reading the last entry's
    //    homeTeamWinProbability (returned as a percent number, 0-100).
    // Bot path: ?source=kalshi fetches ONLY Kalshi (the venue the bot actually
    // bets). The full multi-book fan-out (Polymarket, Bovada, ...) blows the
    // Cloudflare 50-subrequest budget and silently starves Kalshi's per-game
    // prop series (KXMLBHR/KXMLBKS/KXMLBHIT/KXMLBTB), so the bot saw zero Kalshi
    // props. Kalshi-only keeps every prop series and is far under budget.
    const kalshiOnly = new URL(context.request.url).searchParams.get("source") === "kalshi";
    const wantDebug = !!new URL(context.request.url).searchParams.get("debug");
    const kalshiDiag = wantDebug ? [] : undefined;
    let allMarkets;
    let savantHomeWe = null;
    let savantSource = null;
    try {
        const [marketsRes, savantRes] = await Promise.allSettled([
            kalshiOnly
                ? listKalshiMlbMarkets({ perGameOnly: true, botOnly: true, diag: kalshiDiag })
                : listAllMlbMarkets(env, { perGameOnly: true }),
            fetchSavantWe(gameId),
        ]);
        if (marketsRes.status === "fulfilled") {
            allMarkets = marketsRes.value;
        } else {
            throw marketsRes.reason;
        }
        if (savantRes.status === "fulfilled") {
            savantHomeWe = savantRes.value?.value;
            savantSource = savantRes.value?.source;
        }
    } catch (e) {
        return jsonError(502, `markets fetch failed: ${e.message || e}`);
    }

    // Roster cross-reference was removed — Kalshi's per-game player
    // props (KXMLBHR, KXMLBKS, ...) self-identify the game via their
    // ticker, so they flow through naturally. Season-long futures (HR
    // leader, Pitcher of the Month) are tagged with the player's team
    // in the adapter via description parsing and belong on the team
    // profile page; they get filtered out below for the per-game tab.

    // Filter to this game's teams + time window, THEN drop every
    // source that doesn't publish LIVE in-play lines. The pregame
    // sources (espn_dk, thescore, vegasinsider + all vi_* sub-books,
    // odds_api free-tier) freeze at first pitch and pollute every
    // downstream calculation — see LIVE_LINE_SOURCES in _markets.js
    // for the full source-by-source classification. User feedback
    // 2026-05-28: live consensus was averaging pregame openers with
    // current live lines and reporting nonsense numbers.
    const allGameMarkets = filterMarketsForGame(
        allMarkets, homeAbbr, awayAbbr, game.start_time,
    );
    let gameMarkets = filterToLiveLineSources(allGameMarkets);
    // Strict per-game filter for player_prop: require BOTH home and
    // away tricodes (i.e. the market is for THIS specific game).
    // Per-game Kalshi props (KXMLBHR/KXMLBKS/...) have both set by
    // parseKalshiPerGameTicker. Season-long futures (HR leader,
    // Pitcher of Month) only have home_tricode (player's team), and
    // those belong on the team page, not the per-game tab.
    gameMarkets = gameMarkets.filter((m) => {
        if (m.question_type !== "player_prop") return true;
        return !!(m.home_tricode && m.away_tricode);
    });
    const droppedPregame    = allGameMarkets.length - gameMarkets.length;
    const pregameSourcesSeen = Array.from(new Set(
        allGameMarkets
            .filter((m) => !LIVE_LINE_SOURCES.has(m.source))
            .map((m) => m.source)
    )).sort();

    // 3. Group by question type so the dashboard can render sections.
    const grouped = groupByQuestion(gameMarkets);

    // 4. Compute cross-source consensus probability for the headline
    //    "home wins" question. Matches both moneyline-style outcomes
    //    AND yes/no markets where the question is about home winning.
    const homeWinConsensus = consensusProbability(
        grouped.moneyline,
        (outcome, market) => {
            const oName = (outcome.name || "").toLowerCase();
            return oName === homeAbbr.toLowerCase()
                || oName.includes((game.teams?.home?.name || "").toLowerCase());
        },
    );
    const awayWinConsensus = consensusProbability(
        grouped.moneyline,
        (outcome, market) => {
            const oName = (outcome.name || "").toLowerCase();
            return oName === awayAbbr.toLowerCase()
                || oName.includes((game.teams?.away?.name || "").toLowerCase());
        },
    );

    // 5. Per-source quotes: one row per moneyline market with the
    //    home + away outcome probabilities + American odds so the
    //    UI can show each individual book's live line (user explicitly
    //    asked for every market's odds, not just a single consensus).
    const homeNameLc = (game.teams?.home?.name || "").toLowerCase();
    const awayNameLc = (game.teams?.away?.name || "").toLowerCase();
    const matchSide = (outcome, want) => {
        const oName = (outcome.name || "").toLowerCase();
        const wantAbbrLc = want === "home" ? homeAbbr.toLowerCase() : awayAbbr.toLowerCase();
        const wantNameLc = want === "home" ? homeNameLc : awayNameLc;
        return oName === wantAbbrLc
            || (wantNameLc && oName.includes(wantNameLc));
    };
    const perSource = (grouped.moneyline || []).map((m) => {
        const homeOut = (m.outcomes || []).find((o) => matchSide(o, "home"));
        const awayOut = (m.outcomes || []).find((o) => matchSide(o, "away"));
        const homeProb = homeOut?.probability_devig ?? homeOut?.probability ?? null;
        const awayProb = awayOut?.probability_devig ?? awayOut?.probability ?? null;
        return {
            source:        m.source,
            url:           m.url || null,
            title:         m.title || null,
            home_win:      homeProb,
            away_win:      awayProb,
            home_american: homeOut?.american ?? null,
            away_american: awayOut?.american ?? null,
            book_count:    m.book_count || 1,
            books_present: m.books_present || [m.source],
        };
    }).sort((a, b) => {
        // Prefer sources with priced outcomes, then alphabetical.
        const ap = a.home_win != null ? 1 : 0;
        const bp = b.home_win != null ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return (a.source || "").localeCompare(b.source || "");
    });

    // Diagnostic (?debug=1): count Kalshi player props surviving each stage so
    // we can see exactly where they vanish (fetch/parse vs team/time filter vs
    // live-source/tricode filter).
    const _debug = wantDebug
        ? {
            kalshi_only: kalshiOnly,
            kalshi_series_diag: kalshiDiag,
            raw_kalshi_pp: (allMarkets || []).filter((m) => m.source === "kalshi" && m.question_type === "player_prop").length,
            raw_kalshi_pp_with_tricodes: (allMarkets || []).filter((m) => m.source === "kalshi" && m.question_type === "player_prop" && m.home_tricode && m.away_tricode).length,
            after_teamtime_filter: (allGameMarkets || []).filter((m) => m.source === "kalshi" && m.question_type === "player_prop").length,
            final_kalshi_pp: (gameMarkets || []).filter((m) => m.source === "kalshi" && m.question_type === "player_prop").length,
            sample_raw_tickers: (allMarkets || []).filter((m) => m.source === "kalshi" && m.question_type === "player_prop").slice(0, 3).map((m) => ({ id: m.raw_market_id, home: m.home_tricode, away: m.away_tricode, start: m.start_time })),
        }
        : undefined;

    return jsonResponse({
        game_pk: parseInt(gameId, 10),
        available: true,
        _debug,
        teams: {
            home: { abbr: homeAbbr, tricode: teamTricode(homeAbbr) },
            away: { abbr: awayAbbr, tricode: teamTricode(awayAbbr) },
        },
        market_count: gameMarkets.length,
        sources_present: Array.from(new Set(gameMarkets.map((m) => m.source))).sort(),
        // Our model's headline WE (forwarded so the UI can show side-by-side).
        our_we_home: game.win_expectancy,
        // Consensus across all LIVE-LINE sources that quote the
        // question. Pregame-only sources (espn_dk, thescore,
        // vegasinsider + all vi_*) are deliberately excluded — see
        // LIVE_LINE_SOURCES in _markets.js for the source breakdown
        // and the 2026-05-28 evidence for why mixing was broken.
        consensus: {
            home_win:  homeWinConsensus,
            away_win:  awayWinConsensus,
            edge_home: homeWinConsensus != null && game.win_expectancy != null
                ? game.win_expectancy - homeWinConsensus
                : null,
            // Live-only metadata so the UI can show "consensus of N
            // LIVE sources" and surface what was filtered out as
            // pregame-stale.
            live_only:               true,
            contributing_sources:    Array.from(new Set(
                (grouped.moneyline || []).map((m) => m.source)
            )).sort(),
            pregame_sources_dropped: pregameSourcesSeen,
            dropped_market_count:    droppedPregame,
        },
        // Per-source individual quotes — one row per book. UI renders
        // these in the header instead of (or alongside) the averaged
        // consensus number.
        per_source: perSource,
        // Baseball Savant's live home win-probability. ALWAYS populated:
        //   mlb_official      = winProbability endpoint (Savant's source)
        //   pregame_baseline  = team-strength Pythagorean (pregame fallback)
        //   state_table       = our historical state-based WE (live fallback)
        // The UI uses savant_we_source to label which one is in play.
        savant_we_home:    savantHomeWe,
        savant_we_source:  savantSource,
        // Per-question-type buckets, each a list of Market rows.
        markets: grouped,
        // Flat array of all markets for clients that want their own grouping.
        all: gameMarkets,
        fetched_at: new Date().toISOString(),
    }, CACHE_SECONDS);
}


function jsonResponse(body, maxAge) {
    return new Response(JSON.stringify(body), {
        headers: {
            "content-type":  "application/json",
            "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
            "access-control-allow-origin": "*",
        },
    });
}

// Baseball Savant displays the live home/away win probability on every
// game page. The number lives at
//   https://baseballsavant.mlb.com/gf?game_pk={id}
//   scoreboard.currentPlay.homeTeamWinProbability  (0-100 percent)
// — which is the exact source their gamefeed UI reads from. We pull
// from there, divide by 100, and return as a 0-1 float.
//
// We do NOT fabricate a value when Savant doesn't have one. User was
// explicit: 'Dont make up the number'. If the gf endpoint has no
// currentPlay WE we return null and the UI shows '—' with a note
// that Savant hasn't published yet.
async function fetchSavantWe(gameId) {
    try {
        const url = `https://baseballsavant.mlb.com/gf?game_pk=${gameId}`;
        const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0" },  // savant rejects unknown agents
            cf: { cacheTtl: 15, cacheEverything: true },
        });
        if (!res.ok) return { value: null, source: null };
        const data = await res.json();
        const homePct = Number(data?.scoreboard?.currentPlay?.homeTeamWinProbability);
        if (Number.isFinite(homePct)) {
            return { value: homePct / 100, source: "savant_gf" };
        }
    } catch { /* no value */ }
    return { value: null, source: null };
}

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}

// MLB Stats API roster fetch — returns the active roster's full names
// as a plain string[]. Used by the player-prop cross-reference logic
// above to figure out which Kalshi season-long player futures should
// surface on this specific game.
//
// Cached 10 min at the edge — rosters don't change mid-game.
async function fetchRoster(teamId) {
    if (!teamId) return [];
    const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active`;
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": "DIAMOND-CONTEXT/0.1 (+https://diamond-context.pages.dev)" },
            cf: { cacheTtl: 600, cacheEverything: true },
        });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.roster || [])
            .map((p) => p.person?.fullName)
            .filter(Boolean);
    } catch {
        return [];
    }
}
