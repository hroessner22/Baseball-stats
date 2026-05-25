// /api/leaders/wpa?season=2026&role=batter&limit=10
//
// Top players this season by Win Probability Added — sum of per-PA
// home-WP swings, signed for the player's team's perspective. Joins
// the precomputed wpa_season table to the players + people MLB API
// so each row carries the player's name.
//
// Cached short (10min) since the underlying table refreshes once a
// day via the build-wpa GitHub Actions cron.

const DEFAULT_LIMIT = 10;
const MIN_PA_FILTER = 50;  // qualify: at least 50 PAs to appear on the board

export async function onRequest(context) {
    const env = context.env || {};
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return jsonError(500, "supabase not configured");
    }

    const url    = new URL(context.request.url);
    const season = parseInt(url.searchParams.get("season") || "2026", 10);
    const role   = url.searchParams.get("role") || "batter";
    const limit  = Math.min(50, parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT), 10));

    if (!["batter", "pitcher"].includes(role)) {
        return jsonError(400, "role must be 'batter' or 'pitcher'");
    }

    try {
        // Pull WPA rows for this season + role, sorted by WPA desc.
        // We fetch a 4× margin so we have headroom after applying the
        // PA-qualifier filter client-side.
        const rows = await sb(env, "wpa_season", {
            season:    `eq.${season}`,
            role:      `eq.${role}`,
            pa_count:  `gte.${MIN_PA_FILTER}`,
            select:    "player_mlbam,wpa,pa_count,last_updated",
            order:     "wpa.desc",
            limit:     String(limit * 2),
        });

        // Resolve names. For each player, the players Chadwick map
        // gives us name; MLB Stats API gives us anything missing.
        const ids = rows.slice(0, limit).map(r => r.player_mlbam);
        const names = await resolveNames(env, ids);

        const leaders = rows.slice(0, limit).map((r, i) => ({
            rank:         i + 1,
            player_mlbam: r.player_mlbam,
            name:         names[r.player_mlbam] || `MLBAM ${r.player_mlbam}`,
            wpa:          r.wpa,
            pa_count:     r.pa_count,
        }));

        return jsonResponse({
            season,
            role,
            min_pa_filter: MIN_PA_FILTER,
            last_updated:  rows[0]?.last_updated || null,
            leaders,
        }, 600);
    } catch (e) {
        return jsonError(502, `${e.message || e}`);
    }
}


async function resolveNames(env, mlbamIds) {
    if (mlbamIds.length === 0) return {};

    // 1. Fast path: pull from our players table (Chadwick map).
    const idList = mlbamIds.join(",");
    const players = await sb(env, "players", {
        mlbam:  `in.(${idList})`,
        select: "mlbam,name_first,name_last",
    });

    const out = {};
    const found = new Set();
    for (const p of players) {
        const full = `${p.name_first || ""} ${p.name_last || ""}`.trim();
        if (full) out[p.mlbam] = full;
        found.add(p.mlbam);
    }

    // 2. Fallback: MLB Stats API for missing IDs (modern callups etc.).
    const missing = mlbamIds.filter(id => !found.has(id));
    if (missing.length === 0) return out;

    await Promise.all(missing.map(async (id) => {
        try {
            const res = await fetch(
                `https://statsapi.mlb.com/api/v1/people/${id}`,
                { cf: { cacheTtl: 86400, cacheEverything: true } },
            );
            if (!res.ok) return;
            const d = await res.json();
            const p = d.people?.[0];
            if (p) out[id] = p.fullName || `${p.firstName || ""} ${p.lastName || ""}`.trim();
        } catch {
            // leave missing — UI shows MLBAM number
        }
    }));

    return out;
}


async function sb(env, table, params) {
    const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
        headers: {
            "apikey":        env.SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
        },
        cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase ${table} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

function jsonResponse(body, maxAge) {
    return new Response(JSON.stringify(body), {
        headers: {
            "content-type": "application/json",
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
