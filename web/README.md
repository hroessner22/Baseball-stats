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
