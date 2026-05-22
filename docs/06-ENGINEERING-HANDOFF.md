# 06 — Engineering Handoff

*Baseball-stats (working title) · Draft v2 · May 2026*

> For the senior engineer joining the project. Start here, then read the other
> documents in order.

## Purpose

This document gets a senior engineer productive quickly: what the project is,
what exists today, how to set it up, what to build first, and every open
decision that needs an answer.

## Project in one paragraph

We are building a **live companion for baseball** — every game in progress,
each led by an empirical win probability drawn from 150 years of history. One
product in three layers of depth: the **Board** (every game on now), the
**Game** (the live win-expectancy story), and the **Deep Dive** (the full
situational matrix). Full vision in [`01-VISION.md`](01-VISION.md); the product
in [`02-PRODUCT-SPEC.md`](02-PRODUCT-SPEC.md).

## Team context (please read)

- **Harris (project owner / founder)** owns the product vision and direction.
  He is **early in learning Python and software development.** Keep him close
  to product decisions, but he is not, today, positioned to lead implementation.
- **You (senior engineer)** are expected to **own technical implementation and
  architecture.** Treat the architecture document as a researched starting
  point, not a constraint — your judgment governs.
- Communication should assume a non-technical founder: explain trade-offs in
  plain terms.

## Current repository state

| Item | State |
|------|-------|
| Repository | https://github.com/hroessner22/Baseball-stats |
| Default branch | `main` |
| Local clone (owner's machine) | `~/Documents/Baseball-stats` |
| Stack | GitHub + Cloudflare + Supabase — decided ([`03-ARCHITECTURE.md`](03-ARCHITECTURE.md)) |
| Python | 3.10, virtual environment at `venv/` |
| Documentation | Complete — the planning set, `docs/01`–`07` |
| Application code | **None yet** — implementation begins at Phase 1 |

There is no code to review. You are starting from a clean, documented Phase 0.

## Environment setup

```bash
# 1. Clone
git clone git@github.com:hroessner22/Baseball-stats.git
cd Baseball-stats

# 2. Create and activate the Python environment
python3 -m venv venv
source venv/bin/activate          # macOS / Linux

# 3. Install dependencies (currently none beyond the standard library)
pip install -r requirements.txt
```

Note: `venv/` and `data/` are intentionally git-ignored.

## Recommended first task

**Phase 1 — the Proof-of-Concept engine** (see [`04-ROADMAP.md`](04-ROADMAP.md)).
This is Milestone 1 — the current focus.

Concretely:
1. Download one season (e.g. 2024) of Retrosheet game logs into `data/raw/`.
2. Parse each game into end-of-inning state records:
   `(year, inning, half, score_difference, team_eventually_won)`.
3. Aggregate into the win-expectancy table: inning × score-difference → win %.
4. Print it; spot-check it (≈50% for a 1st-inning tie; ≈100% for a big late
   lead).

This task is small, and it validates the entire data foundation before anything
larger is built on it. It also resolves several of the open questions below.

## Suggested conventions

Yours to finalize — a reasonable default:
- Python 3.10+, [PEP 8](https://peps.python.org/pep-0008/), type hints.
- Dependencies pinned in `requirements.txt`.
- Feature branches; pull requests into `main`; small, descriptive commits.
- Tests (`pytest`) for parsing and aggregation from Phase 2 onward.

## Document reading order

1. [`01-VISION.md`](01-VISION.md) — the why
2. [`02-PRODUCT-SPEC.md`](02-PRODUCT-SPEC.md) — the what
3. [`03-ARCHITECTURE.md`](03-ARCHITECTURE.md) — how it is built
4. [`07-DESIGN.md`](07-DESIGN.md) — how it looks and behaves
5. [`04-ROADMAP.md`](04-ROADMAP.md) — the order of work
6. [`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md) — the why-it-matters and funding reality

## Open questions / decisions needed

The consolidated list. **Owner = founder (Harris)** unless noted; several need
the founder and engineer together.

### Product
- **Product name** — the design uses `DIAMOND:CONTEXT` as the header; confirm
  whether that is the name.
- How far back the **era toggle** defaults — all of history, or the modern era
  only? (Pre-1900 baseball is a very different game.)

### Technical *(owner = engineer)*
- Confirm the Retrosheet game-log and event-file formats and coverage years.
- Exact **win-expectancy definition** — state at the start vs. end of an inning;
  the home team not batting in the bottom of the 9th; extra innings;
  tied/suspended games.
- Integrating the **MLB Stats API** live feed — polling vs. streaming, latency,
  rate limits.
- `pandas` vs. plain Python; when the engine's local store moves to SQLite.
- The **Supabase schema** for the matrix, game, and season data.
- Tuning the **relevance engine** — the weighting of surprise, trust, and
  proximity.

### Business / strategic *(owner = founder)*
- **Data-rights review** — Retrosheet's attribution terms, and the MLB
  live-feed and Statcast licensing. *Blocking before commercialization.*
- Monetization direction (subscription / API / B2B / betting fork).
- **Team structure** — the technical co-founder question (see
  [`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md)); the most important decision
  here.

### Design
- The exact secondary-text color and the monospace typeface family
  ([`07-DESIGN.md`](07-DESIGN.md)).

## A note on these documents

This set is **Draft v2** — substantially reworked from the early Draft v1
around a live-first product. It is still meant to be **revised** — argue with
it, correct it, and treat the open-questions list as the live agenda for the
first founder/engineer working session.
