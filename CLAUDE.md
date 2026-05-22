# CLAUDE.md

Guidance for [Claude Code](https://claude.com/claude-code) when working in this
repository. Keep this file short — put detail in `docs/`.

## What this project is

**Baseball-stats** (working title) — an interactive platform to explore
baseball history with live historical context. For any game situation (an
inning and a score difference), it shows the historical win rate of teams in
that exact spot, and lets users explore the games, seasons, and stats around it.

Full vision: `docs/` — start with `docs/01-VISION.md`.

## Current state

- **Phase 0 — Foundation.** Planning documentation only; **no application code
  yet.** Implementation begins at Phase 1 (`docs/04-ROADMAP.md`).
- Repository: https://github.com/hroessner22/Baseball-stats

## Tech stack

GitHub + Cloudflare + Supabase — the standard stack for this project.

- **Source & CI:** GitHub.
- **Database & backend:** Supabase (hosted Postgres) — all data, auth, storage.
- **API / compute:** Cloudflare Workers.
- **Frontend hosting:** Cloudflare Pages — all deployments.

The win-rate engine (Phases 1–2) is local Python that deploys nowhere. The
product (Phase 3 onward) is a Cloudflare Pages frontend and a Cloudflare
Workers API over data in Supabase. Don't introduce other hosts or databases
without asking. Detail: `docs/03-ARCHITECTURE.md`.

## Repository structure

```
Baseball-stats/
├── CLAUDE.md            This file
├── README.md            Repository front page
├── docs/                Vision & planning docs — start at docs/README.md
├── data/                Datasets — downloaded; git-ignored
├── src/                 Application source code — begins Phase 1
├── requirements.txt     Python dependencies
└── venv/                Local Python environment; git-ignored
```

## The documentation set

`docs/01` through `docs/06`, meant to be read in order. `docs/README.md` is the
handoff walkthrough; `docs/06-ENGINEERING-HANDOFF.md` holds the consolidated
list of open questions.

## Development environment

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

`venv/` and `data/` are git-ignored — never commit them.

## Conventions

- Python 3.10+, PEP 8, type hints.
- Dependencies pinned in `requirements.txt`.
- Keep the data engine separate from the UI (see `docs/03-ARCHITECTURE.md`).
- Small, descriptive commits; feature branches; pull requests into `main`.
- Tests (`pytest`) for parsing and aggregation from Phase 2 onward.

## Recommended first task

Phase 1 — the proof-of-concept win-rate engine: download one season of
Retrosheet game logs, compute the inning × score-difference win-rate table,
and print it. Full spec in `docs/06-ENGINEERING-HANDOFF.md`.

## Working principles

- Build in small, working increments. This project's main risk is scope creep —
  favor shipping a real, runnable slice over expanding the vision.
- Keep it simple: the dataset is small (see `docs/03-ARCHITECTURE.md`).
- Data licensing (Retrosheet attribution; MLB intellectual property) is a real
  constraint — treat a data-rights review as blocking before any commercial use.

## Data attribution

> The information used here was obtained free of charge from and is copyrighted
> by Retrosheet. Interested parties may contact Retrosheet at 20 Sunset Rd.,
> Newark, DE 19711.
