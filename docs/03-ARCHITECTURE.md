# 03 — Architecture

*Baseball-stats (working title) · Draft v1 · May 2026*

> Recommendations, not commandments. The incoming senior engineer owns final
> technical decisions and should treat this as a well-researched starting point.

## Guiding principles

1. **Start simple; earn complexity.** The early phases need almost no
   infrastructure. Do not build a platform before there is a product.
2. **Precompute, don't recompute.** The historical win rate is the same for
   everyone. Compute it once; serve it instantly.
3. **The dataset is small** (see below). Favor clarity over cleverness.
4. **Separate the engine from the interface.** The win-rate computation is the
   asset; the UI is replaceable. Keep a clean boundary between them.

## Data sources

### Primary: Retrosheet game logs
- One file per season, covering essentially all of MLB history (1871–present).
- Each row is one game: date, teams, final score, and a **line score** (runs
  per inning) for each team.
- Plain, comma-separated text — straightforward to parse.
- Sufficient to build the Scoreboard and the inning-level win rate for the
  entire product through Phase 3.

### Later: Retrosheet play-by-play event files
- Every individual play, from ~1914 onward (complete for modern decades).
- Stored in Retrosheet's custom event-file format; converting to tabular data
  needs tooling — the open-source **Chadwick** tools (`cwevent`).
- Needed only when the win-rate model is enriched with outs and baserunners
  (Phase 4).

### Later: live / current-season data
- Retrosheet publishes only completed seasons, with a lag. The most recent
  fully published season is approximately 2024 — **verify on retrosheet.org**
  (2025 may be available).
- A genuine *live* product would need a different feed (e.g. MLB's data). This
  is post-MVP and carries its own licensing considerations.

> **Data licensing is a real constraint, not a footnote.** Retrosheet data is
> free but carries a required attribution notice and conditions on use. MLB
> marks, logos, and live data are separately and more strictly licensed. Treat
> a full data-rights review as **blocking before any commercial launch** — see
> the open questions in [`06-ENGINEERING-HANDOFF.md`](06-ENGINEERING-HANDOFF.md).

## How big is the data, really?

Reassuringly small:

- All Retrosheet game logs, all of history: on the order of **tens of
  megabytes** of text.
- The computed win-rate lookup table: **kilobytes**.
- Play-by-play event files, all of history: a few hundred megabytes — still
  modest.

Implication: through Phase 3 this runs comfortably on a laptop and a free-tier
host. **Do not over-engineer for scale that does not exist.**

## The win-rate engine

The core asset — a pipeline:

```
Retrosheet game logs
        │  download
        ▼
   raw data (data/raw/)
        │  parse: one record per (game, end-of-inning) state
        ▼
   game-state records   →   (year, inning, score_diff, team_won?)
        │  aggregate over the chosen year range
        ▼
   WIN-RATE LOOKUP TABLE   (inning × score_diff → win %)
```

Key decisions:
- **Precompute** the lookup table; the UI only ever reads it.
- Make the **year range a parameter** of the aggregation from day one.
- Keep parsing and aggregation as **separate, testable steps.**

## System components

```
┌─────────────┐   ┌──────────────┐   ┌──────────┐   ┌─────────────┐
│ Ingestion   │──▶│ Processed    │──▶│ API /    │──▶│ Frontend    │
│ (Python):   │   │ data store:  │   │ data     │   │ scoreboard, │
│ download +  │   │ tables +     │   │ access   │   │ game view,  │
│ parse +     │   │ win-rate     │   │ layer    │   │ explorer    │
│ aggregate   │   │ lookup       │   │          │   │             │
└─────────────┘   └──────────────┘   └──────────┘   └─────────────┘
```

## Recommended technology stack (staged)

The stack should grow with the product. Two clear stages.

### Stage A — Proof of concept & MVP (Phases 1–3)

| Layer | Choice | Why |
|-------|--------|-----|
| Language | Python 3.10+ | Already set up; ideal for data work |
| Ingestion / engine | Plain Python; `pandas` optional | Dataset is small; clarity first |
| Data store | CSV / SQLite files | Zero infrastructure; easy to inspect |
| Frontend | **Streamlit** | Build an interactive web UI in pure Python — no HTML/CSS/JavaScript. Fastest path to a usable, shareable product |
| Hosting | Streamlit Community Cloud (free) | One-click deploy for early users |

Streamlit will **not** match MLB.com's polish — and that is the correct
trade-off for Phases 1–3. The goal there is to validate the *idea* fast and
cheap, not to ship final UI.

### Stage B — Production platform (Phase 5+)

| Layer | Choice | Why |
|-------|--------|-----|
| Database | **Supabase** (hosted PostgreSQL) | Managed Postgres, auth, and APIs; an account is already connected to this project |
| Backend / API | Supabase APIs, or a thin Python **FastAPI** service | Serve the precomputed data cleanly |
| Frontend | **Next.js / React** | The polished, MLB.com-grade, "everything interactive" UI |
| Hosting | Vercel (frontend) + Supabase (data) | Standard, scalable, generous free tiers |

The migration from Streamlit to Next.js happens **only after the idea is
validated** with real users. Rebuilding a validated product is cheap; building
the wrong product beautifully is not.

## Proposed repository structure

```
Baseball-stats/
├── docs/                  Planning documentation
├── data/                  Downloaded + processed data (git-ignored)
│   ├── raw/               As downloaded from Retrosheet
│   └── processed/         Parsed records, win-rate tables
├── src/
│   ├── ingest/            Download + parse Retrosheet data
│   ├── engine/            Win-rate aggregation
│   └── app/               Frontend (Streamlit now, Next.js later)
├── tests/                 Automated tests
├── requirements.txt
└── README.md
```

## Open technical questions

Consolidated with all other decisions in
[`06-ENGINEERING-HANDOFF.md`](06-ENGINEERING-HANDOFF.md). The technical ones:

- Confirm the Retrosheet game-log format and current coverage years.
- Confirm the exact win-rate definition: state at the *start* vs. *end* of an
  inning; the home team not batting in the bottom of the 9th; extra innings;
  tied/suspended games.
- `pandas` vs. plain Python for the engine (team preference).
- When to introduce SQLite vs. staying with flat files.
- The Streamlit → Next.js migration trigger and timing.
