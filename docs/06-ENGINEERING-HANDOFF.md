# 06 — Engineering Handoff

*Baseball-stats (working title) · Draft v1 · May 2026*

> For the senior engineer joining the project. Start here, then read the other
> documents in order.

## Purpose

This document gets a senior engineer productive quickly: what the project is,
what exists today, how to set it up, what to build first, and every open
decision that needs an answer.

## Project in one paragraph

We are building an interactive platform to explore baseball history with live
historical context — a "win probability" historical echo for any game
situation. Three pillars: a **Scoreboard**, a **Game View**, and a **Stats
Explorer**. Full vision in [`01-VISION.md`](01-VISION.md) and
[`02-PRODUCT-SPEC.md`](02-PRODUCT-SPEC.md).

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
| Python | 3.10, virtual environment at `venv/` |
| Structure | `docs/`, `data/`, `src/` (with `.gitkeep` placeholders) |
| Application code | **None yet** |
| Git history | Foundation commit + this documentation set |

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

Concretely:
1. Download one season (e.g. 2024) of Retrosheet game logs into `data/raw/`.
2. Parse each game into end-of-inning state records:
   `(year, inning, half, score_difference, team_eventually_won)`.
3. Aggregate into the win-rate lookup table: inning × score-difference → win %.
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
3. [`03-ARCHITECTURE.md`](03-ARCHITECTURE.md) — the how
4. [`04-ROADMAP.md`](04-ROADMAP.md) — the order of work
5. [`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md) — the why-it-matters and funding reality

## Open questions / decisions needed

The consolidated list. **Owner = founder (Harris)** unless noted; several need
the founder and engineer together.

### Product
- Product **name** ("Baseball-stats" is a placeholder).
- Exact definition of **"this season"** given Retrosheet's publication lag.
- How far back should **"historical"** default — all of history, or the modern
  era only? (Pre-1900 baseball is a very different game.)
- Scope and shape of the **Stats Explorer** — the vaguest pillar; needs
  detailing before Phase 4.

### Technical *(owner = engineer)*
- Confirm the Retrosheet game-log format and current coverage years.
- Exact **win-rate definition**: state at the start vs. end of an inning; the
  home team not batting in the bottom of the 9th; extra innings;
  tied/suspended games.
- `pandas` vs. plain Python for the engine.
- When to move from flat files to SQLite, and later to Supabase.
- The Streamlit → Next.js migration trigger.

### Business / strategic *(owner = founder)*
- **Data licensing review** — Retrosheet's terms for any commercial use, and
  MLB IP (marks, logos, live data). *Blocking before commercialization.*
- Monetization direction (subscription / API / B2B / betting fork).
- Product **positioning** — fan platform vs. betting analytics vs. B2B media.
- **Team structure** — the technical co-founder question (see
  [`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md)); the most important decision
  here.

### Design
- Visual identity / branding.
- Whether to design the production UI early or after MVP validation
  (recommended: after).

## A note on these documents

This set is a **Draft v1**, generated from early vision conversations with the
founder. It is meant to be **revised** — argue with it, correct it, and treat
the open-questions list as the live agenda for the first founder/engineer
working session.
