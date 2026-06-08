// /api/savant/expected-stats?type=batter|pitcher&year=2025
//
// Baseball Savant publishes per-player expected statistics on its
// public leaderboard. The CSV download includes:
//
//   batters:  ba, est_ba (xBA), slg, est_slg (xSLG), woba, est_woba (xwOBA)
//   pitchers: era, est_era (xERA), bacon, est_bacon
//
// The expected variants come from Statcast launch speed + angle +
// sprint speed instead of raw outcomes — they're more predictive
// of future performance because they strip out cluster-luck on
// balls in play. A batter with .240 BA / .280 xBA has been
// unlucky and is likely to regress UP; a .280 BA / .240 xBA
// hitter has been lucky and is likely to regress DOWN.
//
// We use these as a scoring factor: when BA - xBA is meaningfully
// negative (hitter unlucky), bias toward YES on hit props. When
// positive (hitter lucky), bias toward NO. Same on pitcher side
// with ERA vs xERA.
//
// Cache: 6h. xStats only update once a day after games settle.

const SAVANT_BASE = "https://baseballsavant.mlb.com/leaderboard/expected_statistics";
const CACHE_SECONDS = 6 * 3600;
const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";


export async function onRequest(context) {
    const url = new URL(context.request.url);
    const type = (url.searchParams.get("type") || "batter").toLowerCase();
    const year = url.searchParams.get("year") || String(new Date().getFullYear());
    if (type !== "batter" && type !== "pitcher") {
        return jsonError(400, "type must be batter or pitcher");
    }

    // Savant's CSV endpoint. min=10 keeps the response manageable
    // (~300 batters / ~250 pitchers instead of every cup-of-coffee
    // call-up). The bot only cares about players with material
    // PA / IP anyway.
    const csvUrl =
        `${SAVANT_BASE}?type=${type}&year=${encodeURIComponent(year)}&filter=&min=10` +
        `&team=&csv=true`;

    let csvText;
    try {
        const res = await fetch(csvUrl, {
            headers: { "user-agent": UA, "accept": "text/csv" },
            cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
        });
        if (!res.ok) {
            return jsonResponse({
                available: false,
                reason: `Savant returned ${res.status}`,
                type, year,
            }, 60);
        }
        csvText = await res.text();
    } catch (e) {
        return jsonResponse({
            available: false,
            reason: `Savant fetch failed: ${e.message || e}`,
            type, year,
        }, 60);
    }

    const players = parseCsv(csvText, type);
    return jsonResponse({
        available: true,
        type, year,
        count: Object.keys(players).length,
        players,    // keyed by MLBAM player_id
    }, CACHE_SECONDS);
}


// ── CSV parser ─────────────────────────────────────────────────────
//
// Savant's CSV is RFC-4180-ish — fields can be quoted, embedded
// commas are rare for these leaderboards but we still handle them.

function parseCsv(text, type) {
    const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
    if (!lines.length) return {};
    const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
    const idCol = headers.indexOf("player_id");
    if (idCol < 0) return {};

    const out = {};
    for (let i = 1; i < lines.length; i++) {
        const cells = splitCsvLine(lines[i]);
        if (cells.length < headers.length / 2) continue;   // truncated row
        const id = parseInt(cells[idCol], 10);
        if (!Number.isFinite(id)) continue;
        const row = {};
        headers.forEach((h, j) => { row[h] = cells[j]; });
        const player = shapePlayer(row, type);
        if (player) out[id] = player;
    }
    return out;
}

function splitCsvLine(line) {
    // Single-line splitter that respects double-quoted fields.
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { q = !q; continue; }
        if (c === "," && !q) { out.push(cur); cur = ""; continue; }
        cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
}

function shapePlayer(row, type) {
    const num = (k) => {
        const v = row[k];
        if (v === undefined || v === "" || v === "NULL") return null;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
    };
    const nameLast  = row["last_name"]  || (row["last_name, first_name"] || "").split(",")[0]?.trim() || "";
    const nameFirst = row[" first_name"] || row["first_name"]   || "";
    const name = (nameLast && nameFirst)
        ? `${nameFirst.trim()} ${nameLast.trim()}`
        : (row["player_name"] || nameLast || "");

    if (type === "batter") {
        return {
            name,
            pa:        num("pa"),
            ba:        num("ba"),
            est_ba:    num("est_ba"),
            slg:       num("slg"),
            est_slg:   num("est_slg"),
            woba:      num("woba"),
            est_woba:  num("est_woba"),
            // Negative = hitter unlucky (xBA > BA → expect regression up)
            ba_diff:   (num("est_ba")  != null && num("ba")  != null) ? +(num("est_ba")  - num("ba")).toFixed(3)  : null,
            slg_diff:  (num("est_slg") != null && num("slg") != null) ? +(num("est_slg") - num("slg")).toFixed(3) : null,
            woba_diff: (num("est_woba")!= null && num("woba")!= null) ? +(num("est_woba")- num("woba")).toFixed(3): null,
        };
    }
    // pitcher
    return {
        name,
        pa:        num("pa"),
        ba:        num("ba"),
        est_ba:    num("est_ba"),
        era:       num("era"),
        est_era:   num("est_era"),
        woba:      num("woba"),
        est_woba:  num("est_woba"),
        // Negative ERA diff = pitcher LUCKY (xERA > ERA, expect regression up)
        era_diff:  (num("est_era") != null && num("era") != null) ? +(num("est_era") - num("era")).toFixed(2) : null,
        ba_against_diff:  (num("est_ba")  != null && num("ba")  != null) ? +(num("est_ba")  - num("ba")).toFixed(3)  : null,
        woba_against_diff: (num("est_woba")!= null && num("woba")!= null) ? +(num("est_woba")- num("woba")).toFixed(3): null,
    };
}


// ── response helpers ───────────────────────────────────────────────

function jsonResponse(body, maxAge) {
    return new Response(JSON.stringify(body), {
        headers: {
            "content-type":  "application/json",
            "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
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
