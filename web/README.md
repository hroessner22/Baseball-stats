# web/ — DIAMOND:CONTEXT frontend

The live product, served from **Cloudflare Pages**.

## Layout

```
web/
├── index.html         The shell — header, board container, bottom nav.
├── style.css          The design system (per docs/07-DESIGN.md).
├── app.js             The board logic — fetches games, renders tiles.
└── functions/         Cloudflare Pages Functions (the API layer).
    └── api/
        └── games/
            └── today.js   (next commit) — proxies MLB Stats API + adds WE.
```

## Local dev

```bash
PATH=/opt/homebrew/bin:$PATH wrangler pages dev web
```

## Deploy

```bash
PATH=/opt/homebrew/bin:$PATH wrangler pages deploy web --project-name diamond-context
```

The site lives at `diamond-context.pages.dev` once deployed.
