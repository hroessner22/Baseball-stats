// /api/game/{id}/recap
//
// LLM-generated recap of a Final game. Built on top of the plays endpoint
// and the matchup engine — the prompt feeds Claude the play sequence AND
// the predicted-vs-actual delta per PA, so the recap can lean on the
// "model said 4%, it happened" angle no other recap engine has.
//
// Cached in Supabase (table: game_recaps) so we only pay Anthropic once
// per game across all users / refreshes. Returns the cached row on
// subsequent calls. Generates only when the game is Final.

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 700;

export async function onRequest(context) {
    const env = context.env || {};
    const gameId = context.params?.id;
    if (!gameId || (gameId !== "demo" && !/^\d+$/.test(gameId))) {
        return jsonError(400, "invalid game id");
    }
    // Demo games are never Final — the recap card just renders its
    // "not yet" state rather than calling Anthropic with synthetic data.
    if (gameId === "demo") {
        return jsonResponse({
            game_pk: "demo",
            recap: null,
            cached: false,
            unavailable: true,
            reason: "Demo game — recaps only generate after the game is Final.",
        }, 60);
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return jsonError(500, "SUPABASE_URL / SUPABASE_ANON_KEY not configured");
    }

    // 1. Cache hit?
    try {
        const cached = await fetchCached(env, gameId);
        if (cached) {
            return jsonResponse({
                game_pk: Number(gameId),
                recap: cached.recap_text,
                cached: true,
                generated_at: cached.generated_at,
                model: cached.model,
            }, 3600);
        }
    } catch (e) {
        // Cache miss handler can also fail (RLS, network). Press on with
        // a generate attempt — the cache write below will retry persistence.
    }

    // 2. Need to generate. The ANTHROPIC_API_KEY secret must be present.
    if (!env.ANTHROPIC_API_KEY) {
        return jsonResponse({
            game_pk: Number(gameId),
            recap: null,
            cached: false,
            unavailable: true,
            reason: "Recaps not configured. Add the ANTHROPIC_API_KEY env var to Cloudflare Pages.",
        }, 60);
    }

    // 3. Fetch the play-by-play. Reuse our own endpoint for consistency.
    const origin = new URL(context.request.url).origin;
    let plays, schedule;
    try {
        const [playsRes, schedRes] = await Promise.all([
            fetch(`${origin}/api/game/${gameId}/plays`),
            fetch(`${origin}/api/game/${gameId}`),
        ]);
        if (!playsRes.ok) throw new Error(`plays HTTP ${playsRes.status}`);
        if (!schedRes.ok) throw new Error(`schedule HTTP ${schedRes.status}`);
        plays = await playsRes.json();
        schedule = await schedRes.json();
    } catch (e) {
        return jsonError(502, `failed to load game data: ${e.message || e}`);
    }

    if (schedule.status !== "Final") {
        return jsonResponse({
            game_pk: Number(gameId),
            recap: null,
            cached: false,
            unavailable: true,
            reason: "Recaps generate only after the game is Final.",
        }, 60);
    }

    // 4. Predictions per unique batter-pitcher pair. Limit to the most
    //    recent N PAs so the prompt stays small + we limit Anthropic cost.
    const considered = (plays.plays || []).slice(0, 40);
    const pairs = [...new Set(considered.map((p) => `${p.batter.id}-${p.pitcher.id}`))];
    const predictionMap = {};
    await Promise.all(pairs.map(async (k) => {
        const [b, p] = k.split("-");
        try {
            const r = await fetch(`${origin}/api/matchup?batter=${b}&pitcher=${p}`);
            if (r.ok) predictionMap[k] = await r.json();
        } catch { /* skip — recap just won't reference this pair's miss */ }
    }));

    // 5. Build the prompt and call Anthropic.
    const prompt = buildPrompt(schedule, plays, considered, predictionMap);
    let recapText, usage;
    try {
        const result = await callAnthropic(env.ANTHROPIC_API_KEY, prompt);
        recapText = result.text;
        usage = result.usage;
    } catch (e) {
        return jsonError(502, `Anthropic call failed: ${e.message || e}`);
    }

    // 6. Cache (best-effort — return the recap even if the cache write fails).
    let cacheStatus;
    if (!env.SUPABASE_SERVICE_KEY) {
        cacheStatus = "skipped: SUPABASE_SERVICE_KEY not set";
    } else {
        try {
            await cacheRecap(env, gameId, recapText, usage);
            cacheStatus = "written";
        } catch (e) {
            cacheStatus = `failed: ${e.message || e}`;
        }
    }

    return jsonResponse({
        game_pk: Number(gameId),
        recap: recapText,
        cached: false,
        model: ANTHROPIC_MODEL,
        usage,
        cache_status: cacheStatus,
    }, 3600);
}

async function fetchCached(env, gameId) {
    const url = `${env.SUPABASE_URL}/rest/v1/game_recaps` +
                `?game_pk=eq.${gameId}&select=*&limit=1`;
    const res = await fetch(url, {
        headers: {
            "apikey":        env.SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
        },
        cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
}

async function cacheRecap(env, gameId, text, usage) {
    // Write via the service-role key — anon can SELECT but not INSERT.
    const url = `${env.SUPABASE_URL}/rest/v1/game_recaps?on_conflict=game_pk`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "apikey":        env.SUPABASE_SERVICE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            "Content-Type":  "application/json",
            "Prefer":        "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
            game_pk:           Number(gameId),
            recap_text:        text,
            model:             ANTHROPIC_MODEL,
            prompt_tokens:     usage?.input_tokens  ?? null,
            completion_tokens: usage?.output_tokens ?? null,
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
}

async function callAnthropic(apiKey, prompt) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "x-api-key":         apiKey,
            "anthropic-version": "2023-06-01",
            "content-type":      "application/json",
        },
        body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: MAX_TOKENS,
            messages: [{ role: "user", content: prompt }],
        }),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const j = await res.json();
    const text = (j.content || []).map((c) => c.text || "").join("");
    return { text, usage: j.usage };
}

// Pack the play log + the model's predictions into a single prompt
// Claude can write a tight recap from. Predictions are surfaced as
// "model said X%" for each play where we have one — gives the recap
// its DIAMOND:CONTEXT angle (predicted-vs-actual) instead of a generic
// summary.
function buildPrompt(schedule, plays, considered, predictionMap) {
    const home = schedule.teams.home.abbr;
    const away = schedule.teams.away.abbr;
    const homeScore = schedule.score?.home ?? 0;
    const awayScore = schedule.score?.away ?? 0;
    const venue = schedule.venue || "";

    const linesIn = considered.map((p) => {
        const inn = `${p.half === "top" ? "▲" : "▼"} ${p.inning}`;
        const pred = predictionMap[`${p.batter.id}-${p.pitcher.id}`];
        let predNote = "";
        if (pred?.available && pred.predicted && p.outcome) {
            const sortedOutcomes = Object.entries(pred.predicted)
                .sort((a, b) => b[1] - a[1]);
            const rank = sortedOutcomes.findIndex(([o]) => o === p.outcome) + 1;
            const prob = Math.round((pred.predicted[p.outcome] || 0) * 100);
            if (rank > 0) {
                predNote = ` [model: ${prob}% · rank #${rank}]`;
            }
        }
        const score = p.score_after
            ? ` (${p.score_after.away}-${p.score_after.home})`
            : "";
        return `${inn} ${p.batter.name} vs ${p.pitcher.name} → ${p.outcome_event}${score}${predNote}`;
    }).reverse();

    return `You're writing a tight, factual recap for DIAMOND:CONTEXT, a live baseball companion app.

The angle that distinguishes our recaps: we lean into model-says-vs-reality. When the prediction column shows "[model: 4% · rank #6]" and that outcome happened anyway, that's a model upset — worth calling out. When "[model: 38% · rank #1]" matched the actual outcome, that's a model nailed-it moment.

Write 2-3 short paragraphs (about 150 words total). Cover:
1. Who won and the final score, with a one-sentence frame for the game's character (blowout, pitcher's duel, late comeback, etc.).
2. The key turning point — usually a 2-out hit, a HR with runners on, a late-inning shift. Reference at least one model upset or nailed-it call if there's a notable one.
3. Standout pitcher or hitter performance based on the play log.

Be sportswriting tight, not chatty. No greetings, no sign-offs, no "Here's the recap:" preamble. No betting / fantasy talk.

GAME:
${away} @ ${home} — Final: ${away} ${awayScore}, ${home} ${homeScore}
${venue ? "At " + venue : ""}

PLAYS (most recent ${considered.length} of ${plays.plays?.length || 0}, chronological order, oldest first):
${linesIn.join("\n")}`;
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
