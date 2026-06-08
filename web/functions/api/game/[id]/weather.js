// /api/game/{id}/weather
//
// Pulls the Visual Crossing forecast at the stadium's lat/lng for
// roughly the first-pitch hour. Used by the bot to apply weather
// adjustments to batter props (HR / hits) and moneylines.
//
// Cache 30 min — weather forecasts don't shift meaningfully on
// a shorter clock and the free tier allows ~33 calls/hour at this
// rate.
//
// VISUAL_CROSSING_KEY is provisioned as a Cloudflare Pages secret
// via the dashboard or `wrangler pages secret put`. Without it
// the endpoint returns available:false (and the bot just falls
// back to a neutral weather factor).
//
// For dome / retractable-closed venues the upstream weather is
// irrelevant. We still fetch (cheap, cached) but tag effective_
// indoor:true so the bot treats it as neutral.

import { stadiumFor } from "../../_stadiums.js";

const CACHE_SECONDS = 1800;   // 30 min — VC free tier is 1000/day, ~30 games × 24 calls/day = 720
const UA = "DIAMOND:CONTEXT/0.1 (+https://diamond-context.pages.dev)";

export async function onRequest(context) {
    const gameId = context.params?.id;
    const env    = context.env || {};
    const key    = env.VISUAL_CROSSING_KEY || env.VC_KEY;
    if (!gameId || !/^\d+$/.test(gameId)) {
        return jsonError(400, "invalid game id");
    }
    if (!key) {
        return jsonResponse({
            game_pk:  parseInt(gameId, 10),
            available: false,
            reason:   "VISUAL_CROSSING_KEY not configured",
        }, 60);
    }

    // 1) Pull MLB live feed for the game's stadium + first-pitch time.
    let feedRaw;
    try {
        feedRaw = await fetchJson(
            `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`,
            60,
        );
    } catch (e) {
        return jsonError(502, `live feed fetch failed: ${e.message || e}`);
    }
    const gameData = feedRaw?.gameData || {};
    const homeTeam = gameData.teams?.home || {};
    const homeAbbr = homeTeam.abbreviation || homeTeam.triCode || null;
    const stadium  = stadiumFor(homeAbbr);
    const gameDateISO = gameData.datetime?.dateTime || gameData.datetime?.originalDate || null;

    if (!stadium) {
        return jsonResponse({
            game_pk: parseInt(gameId, 10),
            available: false,
            reason: `no stadium coordinates for ${homeAbbr}`,
        }, 60);
    }
    // Dome → outside weather is irrelevant. Return neutral early.
    if (stadium.roof === "dome") {
        return jsonResponse({
            game_pk: parseInt(gameId, 10),
            available: true,
            stadium,
            effective_indoor: true,
            note: "fixed-roof venue — weather neutral",
            // Sane defaults so the bot's adjustments evaluate to zero.
            temperature_f: 72, wind_mph: 0, wind_dir_deg: 0,
            humidity_pct: 50, precip_probability: 0, condition: "indoor",
        }, CACHE_SECONDS);
    }

    // 2) Hit Visual Crossing for the forecast at that lat/lng. Asking
    //    for a single hour around first pitch keeps the response small.
    const targetIso = gameDateISO || new Date().toISOString();
    const targetDate = targetIso.slice(0, 10);
    const targetHour = parseInt(targetIso.slice(11, 13), 10) || 19;

    const url =
        `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/` +
        `${stadium.lat},${stadium.lng}/${targetDate}` +
        `?unitGroup=us&include=hours&elements=datetime,temp,windspeed,winddir,humidity,precipprob,conditions` +
        `&key=${encodeURIComponent(key)}`;

    let vcRaw;
    try {
        const res = await fetch(url, { headers: { "user-agent": UA } });
        if (!res.ok) {
            return jsonResponse({
                game_pk: parseInt(gameId, 10),
                available: false,
                reason: `Visual Crossing returned ${res.status}`,
            }, 60);
        }
        vcRaw = await res.json();
    } catch (e) {
        return jsonResponse({
            game_pk: parseInt(gameId, 10),
            available: false,
            reason: `Visual Crossing fetch failed: ${e.message || e}`,
        }, 60);
    }
    const dayBlock = (vcRaw.days || [])[0] || {};
    const hours = dayBlock.hours || [];
    // Pick the hour closest to game time.
    const pickedHour = hours.reduce((best, h) => {
        const hourNum = parseInt(String(h.datetime || "").slice(0, 2), 10);
        if (!Number.isFinite(hourNum)) return best;
        const dist = Math.abs(hourNum - targetHour);
        if (best == null || dist < best.dist) return { dist, h };
        return best;
    }, null)?.h || hours[0] || {};

    const temperatureF      = pickedHour.temp     ?? dayBlock.temp     ?? 72;
    const windMph           = pickedHour.windspeed ?? dayBlock.windspeed ?? 0;
    const windDirDeg        = pickedHour.winddir  ?? dayBlock.winddir  ?? 0;
    const humidityPct       = pickedHour.humidity ?? dayBlock.humidity ?? 50;
    const precipProbability = pickedHour.precipprob ?? dayBlock.precipprob ?? 0;
    const condition         = pickedHour.conditions || dayBlock.conditions || "unknown";

    // Retractable roof — they often close the roof in bad weather.
    // We don't get real-time roof status from VC; flag it so the bot
    // can treat it as 'maybe indoor' (apply weaker adjustments).
    const isRetractable = stadium.roof === "retractable";

    return jsonResponse({
        game_pk:  parseInt(gameId, 10),
        available: true,
        stadium,
        first_pitch_iso: targetIso,
        effective_indoor: false,
        retractable: isRetractable,
        temperature_f:    Math.round(temperatureF * 10) / 10,
        wind_mph:         Math.round(windMph * 10) / 10,
        wind_dir_deg:     Math.round(windDirDeg),
        humidity_pct:     Math.round(humidityPct),
        precip_probability: Math.round(precipProbability),
        condition,
    }, CACHE_SECONDS);
}


// ── helpers ────────────────────────────────────────────────────────

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
async function fetchJson(url, maxAge) {
    const res = await fetch(url, {
        headers: { "user-agent": UA },
        cf: { cacheTtl: maxAge, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return res.json();
}
