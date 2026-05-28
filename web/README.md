# web/ — DIAMOND:CONTEXT frontend

The live product, served from **Cloudflare Pages** at
[diamond-context.pages.dev](https://diamond-context.pages.dev).

## Layout

```
web/
├── public/                Static assets — Cloudflare Pages serves these.
│   ├── index.html         The shell — header, board container, bottom nav.
│   ├── style.css          The design system (per docs/07-DESIGN.md).
│   └── app.js             Board logic — fetches games, renders tiles.
├── functions/             Cloudflare Pages Functions (the API layer).
│   └── api/games/
│       ├── today.js       /api/games/today — MLB schedule + WE.
│       └── _we_table.js   Baked-in win-expectancy lookup (all-history).
├── wrangler.toml          Pages config (project name, build output dir).
└── README.md
```

## Local dev

```bash
cd web && PATH=/opt/homebrew/bin:$PATH wrangler pages dev
```

Opens at http://localhost:8788. Hot-reloads static assets; restart to pick
up function changes.

## Deploy

From `web/`:

```bash
PATH=/opt/homebrew/bin:$PATH wrangler pages deploy --branch main
```

`--branch main` pushes to the production URL (`diamond-context.pages.dev`).
Omitting it (or using `--branch <name>`) creates a preview URL like
`<name>.diamond-context.pages.dev` instead.

## Markets integration (Polymarket, Kalshi, Manifold, The Odds API)

The Markets tab on game view, the sidebar `#markets` dashboard, and the
per-team `#team/{tricode}` page all read from `/api/markets` (everything)
and `/api/game/{pk}/markets` (one game's slice).

Three sources work **with no setup**:

| Source     | Coverage                                                              |
|------------|------------------------------------------------------------------------|
| Polymarket | Season futures (World Series, MVP, Cy Young, division titles, HR/RBI leaders, ROY, Comeback Player), large player-prop set. Real prices. |
| Kalshi     | Per-game moneyline (every MLB game), team season-wins ladder. Often no trading volume on non-primetime games. |
| Manifold   | Long-tail community markets. Small but sometimes useful. |

For **nightly game lines** (moneyline / total / spread) updated every
minute from real sportsbooks, and **per-game player props** (batter HRs,
batter hits, pitcher K's, etc.), wire **The Odds API**:

1. Sign up at https://the-odds-api.com — free tier is 500 requests/month
   (plenty for the game-line endpoint, ~30 days × 1 fetch/5min = ~250).
2. Copy your API key from the dashboard.
3. Set it as a Pages secret so it never lands in chat or git:

   ```bash
   PATH=/opt/homebrew/bin:$PATH wrangler pages secret put ODDS_API_KEY --project-name=diamond-context
   ```

   Wrangler will prompt for the value; paste, hit return.

4. (Optional) Player props are a paid-tier feature (≥ $30/mo on The Odds
   API). When you have that, also set:

   ```bash
   PATH=/opt/homebrew/bin:$PATH wrangler pages secret put ODDS_API_INCLUDE_PROPS --project-name=diamond-context
   ```

   Any non-empty value enables it. The adapter then fans out one request
   per upcoming MLB event (max 16/day) for every batter + pitcher prop
   market The Odds API covers (`batter_hits`, `batter_home_runs`,
   `batter_total_bases`, `batter_rbis`, `pitcher_strikeouts`, etc.).

The adapter (`functions/api/_markets.js`, `listOddsApiMlbMarkets`) wakes
up automatically when `ODDS_API_KEY` is set — no code change needed.

When the key is **not** set, the team page shows a hint card with the
above instructions; no errors.

## Regenerating the win-expectancy table

```bash
PYTHONPATH=.. ../venv/bin/python -c "
import json, sqlite3
db = sqlite3.connect('../data/processed/win_expectancy.db')
rows = db.execute('''
    SELECT inning, half, home_lead, SUM(wins), SUM(total)
    FROM win_expectancy
    WHERE inning BETWEEN 1 AND 9
    GROUP BY inning, half, home_lead
    HAVING SUM(total) > 100
    ORDER BY inning, half, home_lead
''').fetchall()
data = {f'{i}|{h}|{l}': round(w/t, 4) for i,h,l,w,t in rows}
print('export const WE_TABLE = ' + json.dumps(data, separators=(',',':')) + ';')
" > functions/api/games/_we_table.js
```
