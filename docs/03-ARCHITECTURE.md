# 03 — Architecture

*Baseball-stats (working title) · Draft v2 · May 2026*

> Recommendations, not commandments. The incoming senior engineer owns final
> technical decisions and should treat this as a well-researched starting point.

## Guiding principles

1. **Precompute, don't recompute.** History doesn't change. Crunch it once into
   lookup tables; at game time, *look up* — never recompute.
2. **Start simple; earn complexity.** The early phases need almost no
   infrastructure. Don't build a platform before there is a product.
3. **Separate the engine from the interface.** The computed matrix is the
   asset; the UI is replaceable. Keep a clean boundary.
4. **The historical dataset is small.** Favor clarity over cleverness.

## Data sources

The product has two data needs — historical and live — sourced very
differently.

### Retrosheet — the historical foundation *(free)*
- Game logs covering all of MLB history (1871–present): one row per game —
  date, teams, score, line score.
- Play-by-play event files from ~1914 onward (complete for modern decades) —
  every plate appearance, with count, base-out state, and outcome. Parsing the
  event format uses the open-source **Chadwick** tools (`cwevent`).
- Free, and the basis of every historical calculation. Carries a required
  attribution notice (see below).

### MLB Stats API — the live feed
- `statsapi.mlb.com` — the backend behind MLB.com and the MLB app. Today's
  schedule, live scores, box scores, and pitch-by-pitch game state, in
  near-real-time.
- Publicly reachable and used by essentially every baseball app — perfect for
  building and validating. It is MLB's data and API; a commercial product needs
  a licensing answer (see below).

### Baseball Savant — Statcast *(later)*
- MLB's Statcast site — exit velocity, launch angle, expected stats; modern era
  (~2015+). Consumed as-is (MLB's measurements). Not needed early.

> **Data licensing is a real constraint, not a footnote.** Retrosheet is free
> but requires its attribution notice. The MLB Stats API and Statcast are MLB's
> intellectual property — fine for building and validating now; a licensed feed
> (or an MLB agreement) is required before commercial launch. Treat a full
> data-rights review as **blocking before commercialization** — see the open
> questions in [`06-ENGINEERING-HANDOFF.md`](06-ENGINEERING-HANDOFF.md).

## Calculations — borrow the methods, compute the numbers

Three kinds of "thing," each handled differently:

1. **Raw feeds and measurements** — *consumed* from the authoritative source.
   You don't recompute a score or a 98-mph reading.
2. **Methods** — the proven, public sabermetric ones are *borrowed.* We don't
   reinvent the math.
3. **The probabilistic numbers** — *computed ourselves.* That engine is the
   asset, and our own computation is the only way to be transparent — to show
   the sample size and the method behind every number.

| Thing | Source | Ours or theirs |
|-------|--------|----------------|
| Live game state, schedule, rosters | MLB Stats API | Consume |
| All historical games & plays | Retrosheet | Consume — raw material |
| Win expectancy | Retrosheet | **Ours** — empirical frequency |
| Run expectancy | Retrosheet | **Ours** — standard method |
| Situational splits | Retrosheet + current-season feed | **Ours** |
| Matchup likelihood (hitter × pitcher) | Retrosheet | **Ours** — odds-ratio / log5 |
| Leverage | Retrosheet | **Ours** — leverage index |
| Playoff & World Series odds | Retrosheet + live standings | **Ours** — Monte Carlo |
| Records / milestone probability | Retrosheet | **Ours** |
| Statcast (exit velocity, xBA) | Baseball Savant | Theirs — MLB measurements |

The numbers are ours, computed on our own data — and **cross-checked against the
trusted public references** (FanGraphs win probability, Baseball Prospectus
playoff odds) so we know they are right.

## Real-time architecture — precompute, then look up

The expensive work — crunching 150 years of Retrosheet into every
win-expectancy and situational cell — is a **batch job.** It runs on a
schedule; the result is a set of compact lookup tables (kilobytes to a few
megabytes) stored in Supabase. History doesn't change, so it is computed once.

Live:

- The **MLB Stats API feed** pushes game state pitch by pitch (seconds of
  latency — genuinely real-time).
- For each new state, a **Cloudflare Worker** *looks up* the precomputed cells
  and does light live math — the log5 blend, the relevance ranking. No heavy
  computation in the live path.
- Current-season numbers update incrementally as games finish.
- Playoff odds re-run the Monte Carlo simulation periodically (after each game,
  a few times a day) — they don't need pitch-granularity.

Real time is not recomputing history every pitch; it is *looking up* against
history every pitch. Fast, and cheap.

## The engine

The core asset — a pipeline from raw data to the matrix:

```
Retrosheet game logs + event files
        │  download
        ▼
   raw data (data/raw/)
        │  parse: one record per game state
        ▼
   game-state records  →  (era, inning, score_diff, outs, bases, … , won?)
        │  aggregate over the chosen axes and year range
        ▼
   LOOKUP TABLES   (win expectancy · run expectancy · situational splits)
```

Key decisions:
- **Precompute** the tables; the live layer only ever reads them.
- Make the **year range and the axes parameters** of the aggregation from day
  one.
- Keep parsing and aggregation as **separate, testable steps.**

Phase 1 builds the smallest slice of this — the inning × score-difference win
table from one season. The full matrix is the same pipeline, widened.

## How big is the data?

Reassuringly small:

- All Retrosheet game logs: **tens of megabytes** of text.
- Play-by-play event files, all history: a few hundred megabytes.
- The computed lookup tables: **kilobytes to a few megabytes.**
- The live feed: a trickle — one game state per pitch.

The historical engine runs comfortably on a laptop; the live product runs on
free-tier infrastructure. **Do not over-engineer for scale that doesn't exist.**

## System components

```
Batch (history)
  Retrosheet  →  Python: parse + aggregate  →  lookup tables in Supabase

Live (per pitch)
  MLB Stats API  →  Cloudflare Worker: look up the tables · log5 blend ·
                    relevance ranking  →  Cloudflare Pages: Board / Game /
                    Deep Dive
```

## Technology stack

**GitHub + Cloudflare + Supabase** — this project's standard stack, and the
standard across all of the founder's projects. One stack carries the product
from the first deployed MVP to production: there is no throwaway prototype
framework and no later migration, because this infrastructure is cheap, fast to
deploy, and generous on free tiers.

### The engine (Phases 1–2) — local Python

The engine is data processing, not a deployed service. It runs on a laptop and
produces a small set of output tables.

| Layer | Choice | Why |
|-------|--------|-----|
| Language | Python 3.10+ | Already set up; ideal for data work |
| Ingestion / engine | Plain Python; `pandas` optional | Dataset is small; clarity first |
| Local store | CSV, then SQLite, in `data/` | Zero infrastructure; easy to inspect |

### The product (Phase 3 onward) — GitHub + Cloudflare + Supabase

| Layer | Choice | Why |
|-------|--------|-----|
| Source & CI | **GitHub** | Already in use; deploys trigger from here |
| Database & backend | **Supabase** (hosted PostgreSQL) | Managed Postgres, auth, storage, auto-generated APIs; an account is already connected |
| API / compute | **Cloudflare Workers** | Serverless API layer — serves the precomputed matrix and the live blends |
| Frontend | **Cloudflare Pages** | Hosts the web frontend — the Board, the Game, the Deep Dive; all deployments |

The engine's output — the lookup tables and game/season data — is loaded into
Supabase; Cloudflare Workers serve it to the Cloudflare Pages frontend.

> **On the frontend.** Cloudflare Pages serves a real web app (HTML/CSS/JS,
> typically a framework such as React or Svelte) — not a pure-Python tool like
> Streamlit. The trade-off is deliberate: the MVP is a genuine web app from day
> one, more capable and already on the production path, rather than a Python
> prototype that would later be rebuilt. Claude Code handles the web build.

## Proposed repository structure

```
Baseball-stats/
├── docs/                  Planning documentation
├── data/                  Downloaded + processed data (git-ignored)
│   ├── raw/               As downloaded from Retrosheet
│   └── processed/         Parsed records, lookup tables
├── src/
│   ├── ingest/            Download + parse Retrosheet data
│   ├── engine/            Matrix aggregation (win expectancy, splits)
│   ├── api/               Cloudflare Workers — the API + live layer
│   └── app/               Cloudflare Pages — the web frontend
├── tests/                 Automated tests
├── requirements.txt
└── README.md
```

## Open technical questions

Consolidated with all other decisions in
[`06-ENGINEERING-HANDOFF.md`](06-ENGINEERING-HANDOFF.md). The technical ones:

- Confirm the Retrosheet game-log and event-file formats and coverage years.
- Confirm the exact win-expectancy definition: state at the *start* vs. *end*
  of an inning; the home team not batting in the bottom of the 9th; extra
  innings; tied/suspended games.
- Integrating the MLB Stats API live feed — polling vs. streaming, latency,
  rate limits.
- `pandas` vs. plain Python for the engine.
- When the engine's local store moves from flat files to SQLite.
- The **Supabase schema** for the matrix, game, and season data.
- Tuning the relevance engine — the weighting of surprise, trust, and proximity.
