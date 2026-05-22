# CLAUDE.md

Guidance for [Claude Code](https://claude.com/claude-code) when working in this
repository. Keep this file short — put detail in `docs/`.

## What this project is

**Baseball-stats** (working title) — a live companion for baseball. Every game
in progress, each led by an empirical win probability drawn from 150 years of
history. One product in three layers: the **Board** (every game on now), the
**Game** (the live win-expectancy story), and the **Deep Dive** (the full
situational matrix).

Full vision: `docs/` — start with `docs/01-VISION.md`.

## Current state

Two historical engines are built and tested (code in `src/`, tests in `tests/`):

- the **win-expectancy engine** (Phases 1–2) — inning and score → the home
  team's win %, from 132 seasons of Retrosheet game logs.
- the **matchup engine** — batter vs. pitcher → a predicted outcome
  distribution, from play-by-play (1910–2024), with handedness splits.

**Next: Phase 3** — the live MVP (`docs/04-ROADMAP.md`).
Repository: https://github.com/hroessner22/Baseball-stats

## Tech stack

GitHub + Cloudflare + Supabase — the standard stack for this project.

- **Source & CI:** GitHub.
- **Database & backend:** Supabase (hosted Postgres) — all data, auth, storage.
- **API / compute:** Cloudflare Workers.
- **Frontend hosting:** Cloudflare Pages — all deployments.

The engine (Phases 1–2) is local Python that deploys nowhere. The product
(Phase 3 onward) is a Cloudflare Pages frontend and a Cloudflare Workers API
over data in Supabase. Don't introduce other hosts or databases without asking.
Detail: `docs/03-ARCHITECTURE.md`.

## Repository structure

```
Baseball-stats/
├── CLAUDE.md            This file
├── README.md            Repository front page
├── docs/                Vision & planning docs — start at docs/README.md
├── data/                Datasets — downloaded; git-ignored
├── src/                 Application source code — ingest + engine
├── tests/               Automated tests (pytest)
├── requirements.txt     Python dependencies
└── venv/                Local Python environment; git-ignored
```

## The documentation set

`docs/01` through `docs/07`, meant to be read in order. `docs/README.md` is the
handoff walkthrough; `docs/06-ENGINEERING-HANDOFF.md` holds the consolidated
list of open questions; `docs/07-DESIGN.md` is the visual and interaction
target.

## Development environment

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

The matchup engine also needs **Chadwick** to parse Retrosheet play-by-play —
`brew install chadwick` on macOS (https://chadwick.readthedocs.io).

`venv/` and `data/` are git-ignored — never commit them.

## Conventions

- Python 3.10+, PEP 8, type hints.
- Dependencies pinned in `requirements.txt`.
- Keep the data engine separate from the UI (see `docs/03-ARCHITECTURE.md`).
- Small, descriptive commits; feature branches; pull requests into `main`.
- Tests (`pytest`) for parsing and aggregation from Phase 2 onward.

## Running it

- `python -m src.run_phase2` — the win-expectancy engine (all of history).
- `python -m src.run_matchup` — the matchup engine (play-by-play; batter-vs-
  pitcher predictions). Needs Chadwick — see below.
- `python -m src.run_phase1` — the single-season win-expectancy proof of concept.
- `pytest` — the tests.

Next up is Phase 3 — the live MVP (`docs/04-ROADMAP.md`).

## Working principles

- Build in small, working increments. This project's main risk is scope creep —
  favor shipping a real, runnable slice over expanding the vision.
- Keep it simple: the dataset is small (see `docs/03-ARCHITECTURE.md`).
- Data licensing (Retrosheet attribution; the MLB live feed and IP) is a real
  constraint — treat a data-rights review as blocking before any commercial use.

## Data attribution

> The information used here was obtained free of charge from and is copyrighted
> by Retrosheet. Interested parties may contact Retrosheet at 20 Sunset Rd.,
> Newark, DE 19711.
