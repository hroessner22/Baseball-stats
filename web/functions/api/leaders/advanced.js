// /api/leaders/advanced
//
// Statcast-driven leaderboards — the "advanced" companion to the
// standard Stats API leaders endpoint. Same response shape so the
// frontend can swap between them with a single toggle.
//
// Source: Baseball Savant CSV endpoints.
//   /leaderboard/expected_statistics?type={batter|pitcher}&year=&min=q&csv=true
//     → xBA, xSLG, xwOBA (both); xERA (pitcher only)
//   /leaderboard/statcast?type=batter&year=&min=q&csv=true
//     → avg_hit_speed, brl_percent, ev95percent, anglesweetspotpercent
//
// Team affiliation isn't in the Savant CSVs (just last_name, first_name
// + player_id), so we fan out a single MLB Stats API call for the
// full active-player roster and build mlbam → team / name lookup.
//
// All three fetches in parallel, edge-cached 15 min — Statcast
// leaderboards only update once per game day.

const SAVANT  = "https://baseballsavant.mlb.com/leaderboard";
const MLB     = "https://statsapi.mlb.com/api/v1";
const UA      = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";

// Each category: [savant_csv_column, display_label, source_endpoint,
//                 sort_direction, value_formatter]
// source_endpoint: 'exp_bat' | 'exp_pit' | 'sc_bat'  — which CSV the
//                  column comes from.
// sort_direction:  'desc' for higher-is-better, 'asc' for ERA-style.
// formatter:       fn(rawString) → display string.
const HITTING_ADV = [
    ["est_ba",                  "xBA",          "exp_bat", "desc", f3],
    ["est_slg",                 "xSLG",         "exp_bat", "desc", f3],
    ["est_woba",                "xwOBA",        "exp_bat", "desc", f3],
    ["avg_hit_speed",           "AVG EV",       "sc_bat",  "desc", fmph],
    ["brl_percent",             "BARREL%",      "sc_bat",  "desc", fpct],
    ["ev95percent",             "HARD HIT%",    "sc_bat",  "desc", fpct],
    ["anglesweetspotpercent",   "SWEET SPOT%",  "sc_bat",  "desc", fpct],
    ["max_hit_speed",           "MAX EV",       "sc_bat",  "desc", fmph],
];

const PITCHING_ADV = [
    ["xera",                    "xERA",         "exp_pit", "asc",  fxera],
    ["est_ba",                  "xBA AGAINST",  "exp_pit", "asc",  f3],
    ["est_slg",                 "xSLG AGAINST", "exp_pit", "asc",  f3],
    ["est_woba",                "xwOBA AGAINST","exp_pit", "asc",  f3],
];


export async function onRequest(context) {
    const url = new URL(context.request.url);
    const season = url.searchParams.get("season") || String(currentSeason());
    const limit  = Math.max(1, Math.min(25, parseInt(url.searchParams.get("limit") || "5", 10)));

    try {
        const [expBat, expPit, scBat, rosterMap] = await Promise.all([
            fetchSavantCsv(`expected_statistics?type=batter&year=${season}&min=q&csv=true`),
            fetchSavantCsv(`expected_statistics?type=pitcher&year=${season}&min=q&csv=true`),
            fetchSavantCsv(`statcast?type=batter&year=${season}&min=q&csv=true`),
            fetchRosterMap(season),
        ]);
        const sources = { exp_bat: expBat, exp_pit: expPit, sc_bat: scBat };
        const hitting  = HITTING_ADV.map((spec)  => buildCategory(spec, sources, rosterMap, limit));
        const pitching = PITCHING_ADV.map((spec) => buildCategory(spec, sources, rosterMap, limit));
        return jsonResponse({ season, hitting, pitching, source: "baseballsavant", fetched_at: new Date().toISOString() }, 900);
    } catch (e) {
        return jsonError(502, `advanced leaders fetch failed: ${e.message || e}`);
    }
}


// ── Savant CSV fetch + parse ───────────────────────────────────────

async function fetchSavantCsv(path) {
    const res = await fetch(`${SAVANT}/${path}`, {
        headers: { "User-Agent": UA, "Accept": "text/csv" },
        cf: { cacheTtl: 900, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`Savant /${path} → HTTP ${res.status}`);
    const text = await res.text();
    return parseCsv(text);
}

// Tiny CSV parser tuned for Savant's format:
//   "field with, comma","numeric",0.272,...
// Handles quoted-comma fields. First row = header. BOM optional.
function parseCsv(text) {
    if (!text) return [];
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);     // strip BOM
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (!lines.length) return [];
    const headers = splitCsvLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = splitCsvLine(lines[i]);
        const row = {};
        for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j];
        rows.push(row);
    }
    return rows;
}
function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            // Quoted-quote escape
            if (inQ && line[i+1] === '"') { cur += '"'; i++; continue; }
            inQ = !inQ;
        } else if (c === ',' && !inQ) {
            out.push(cur); cur = "";
        } else {
            cur += c;
        }
    }
    out.push(cur);
    return out;
}


// ── Roster lookup: mlbam → { team_abbrev, fullName } ──────────────

async function fetchRosterMap(season) {
    // hydrate=team on /sports/1/players returns only currentTeam.id +
    // a link, not the abbreviation we need to display. Fan out two
    // requests in parallel: the roster gives mlbam → teamId, the
    // /teams endpoint gives teamId → abbreviation. Stitched together
    // gives mlbam → "HOU" / "NYY" / etc.
    const [rosterRes, teamsRes] = await Promise.all([
        fetch(`${MLB}/sports/1/players?season=${season}`, {
            headers: { "User-Agent": UA },
            cf: { cacheTtl: 900, cacheEverything: true },
        }),
        fetch(`${MLB}/teams?sportId=1&season=${season}`, {
            headers: { "User-Agent": UA },
            cf: { cacheTtl: 3600, cacheEverything: true },
        }),
    ]);
    if (!rosterRes.ok) throw new Error(`MLB roster → HTTP ${rosterRes.status}`);
    if (!teamsRes.ok)  throw new Error(`MLB teams → HTTP ${teamsRes.status}`);
    const [rosterData, teamsData] = await Promise.all([rosterRes.json(), teamsRes.json()]);

    const teamIdToTri = new Map();
    for (const t of (teamsData.teams || [])) {
        teamIdToTri.set(t.id, t.abbreviation || t.teamCode || null);
    }
    const map = new Map();
    for (const p of (rosterData.people || [])) {
        const teamId = p.currentTeam?.id;
        map.set(String(p.id), {
            team:     teamId != null ? (teamIdToTri.get(teamId) || null) : null,
            fullName: p.fullName || null,
        });
    }
    return map;
}


// ── Build one leader category from a Savant CSV ───────────────────

function buildCategory([col, label, srcKey, dir, fmt], sources, rosterMap, limit) {
    const rows = sources[srcKey] || [];
    const scored = rows
        .map((r) => {
            const raw = r[col];
            const n = parseFloat(raw);
            if (!Number.isFinite(n)) return null;
            return { row: r, n, raw };
        })
        .filter(Boolean);
    scored.sort((a, b) => dir === "asc" ? a.n - b.n : b.n - a.n);
    const top = scored.slice(0, limit);
    return {
        category: col,
        label,
        leaders: top.map((s, i) => {
            const r = s.row;
            const mlbam = String(r.player_id || "");
            const lookup = rosterMap.get(mlbam) || {};
            // Savant gives "Last, First". Reformat to "First Last" so
            // it matches the rest of our UI's player labels.
            const rawName = r["last_name, first_name"] || "";
            const m = rawName.match(/^([^,]+),\s*(.+)$/);
            const display = m ? `${m[2].trim()} ${m[1].trim()}` : (lookup.fullName || rawName);
            return {
                rank:      i + 1,
                person_id: mlbam ? parseInt(mlbam, 10) : null,
                name:      display,
                team:      lookup.team || null,
                value:     fmt(s.raw),
            };
        }),
    };
}


// ── Value formatters ──────────────────────────────────────────────

function f3(s)   {                              // .272-style triple slash
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return s;
    return n.toFixed(3).replace(/^0/, "");
}
function fpct(s) {                              // 28.1 → "28.1%"
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return s;
    return `${n.toFixed(1)}%`;
}
function fmph(s) {                              // 89.5 → "89.5"
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return s;
    return n.toFixed(1);
}
function fxera(s) {                             // "2.90" → "2.90"
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return s;
    return n.toFixed(2);
}


// ── Tiny utilities ────────────────────────────────────────────────

function currentSeason() { return new Date().getUTCFullYear(); }
function jsonResponse(body, maxAge = 900) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            "content-type":  "application/json",
            "cache-control": `public, max-age=${maxAge}`,
            "access-control-allow-origin": "*",
        },
    });
}
function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
    });
}
