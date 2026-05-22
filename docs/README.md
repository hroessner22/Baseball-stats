# Project Handoff — Start Here

Welcome. This folder is the **complete planning package** for Baseball-stats
(working title) — everything a senior engineer needs to understand the project
and pick up the work.

## What this project is

A **live companion for baseball** — every game in progress, each led by an
empirical win probability drawn from 150 years of history. One product in three
layers of depth: the Board, the Game, and the Deep Dive. Full vision in
[`01-VISION.md`](01-VISION.md).

## Current state — read this first

| | |
|---|---|
| Phase | Phases 1–2 complete; the matchup engine built (see [`04-ROADMAP.md`](04-ROADMAP.md)) |
| Application code | Two historical engines — `src/`, tests in `tests/` |
| What exists | The planning set; the win-expectancy engine and the batter-vs-pitcher matchup engine |
| Stack | GitHub + Cloudflare + Supabase |
| Repository | https://github.com/hroessner22/Baseball-stats |

The win-expectancy engine covers 132 seasons; the matchup engine predicts
batter-vs-pitcher outcomes from play-by-play (1910–2024). Phase 3 — the live
MVP — is next.

## The documents, in reading order

| # | File | What it covers | Read time |
|---|------|----------------|-----------|
| 1 | [`01-VISION.md`](01-VISION.md) | The product, the problem, the north star | ~5 min |
| 2 | [`02-PRODUCT-SPEC.md`](02-PRODUCT-SPEC.md) | The three layers, the matrix, the relevance engine | ~9 min |
| 3 | [`03-ARCHITECTURE.md`](03-ARCHITECTURE.md) | Data sources, the engine, the stack, real-time | ~9 min |
| 4 | [`07-DESIGN.md`](07-DESIGN.md) | The visual and interaction design | ~8 min |
| 5 | [`04-ROADMAP.md`](04-ROADMAP.md) | The phased build plan, Phase 0 → growth | ~5 min |
| 6 | [`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md) | Market, competition, the honest funding picture | ~8 min |
| 7 | [`06-ENGINEERING-HANDOFF.md`](06-ENGINEERING-HANDOFF.md) | Engineer onboarding + every open decision | ~8 min |

**Short on time?** Read [`01-VISION.md`](01-VISION.md) (the *why*) and
[`06-ENGINEERING-HANDOFF.md`](06-ENGINEERING-HANDOFF.md) (the *what to do* and
the open questions).

## Getting set up

```bash
git clone git@github.com:hroessner22/Baseball-stats.git
cd Baseball-stats
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## The recommended next task

**Phase 3 — the live MVP.** The historical engines are built — win expectancy
(`python -m src.run_phase2`) and the batter-vs-pitcher matchup engine
(`python -m src.run_matchup`). Phase 3 turns them into a product — see
[`06-ENGINEERING-HANDOFF.md`](06-ENGINEERING-HANDOFF.md).

## Open questions

Every unresolved decision — product, technical, and business — is consolidated
into one list at the end of [`06-ENGINEERING-HANDOFF.md`](06-ENGINEERING-HANDOFF.md).
Treat it as the agenda for the first founder + engineer working session.

## About `CLAUDE.md`

There is a `CLAUDE.md` at the **repository root** (not in this folder). It gives
quick project context to the Claude Code tool, which reads it automatically from
the root. If you use Claude Code it will pick that up; either way, it doubles as
a concise one-page project summary.

## Status of these documents

**Draft v2** — reworked around a live-first product. They are meant to be
challenged and revised — start with the open-questions list.
