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
| Phase | 0 — Foundation (see [`04-ROADMAP.md`](04-ROADMAP.md)) |
| Application code | **None yet.** Implementation begins at Phase 1 |
| What exists | This planning documentation; a clean, scaffolded repository |
| Stack | GitHub + Cloudflare + Supabase |
| Repository | https://github.com/hroessner22/Baseball-stats |

This is an honest starting point: a clear vision and a clean repo, with the
build still ahead. There is no code to review yet — and that is expected at
Phase 0.

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

## The recommended first task

**Phase 1 — the proof-of-concept engine:** download one season of Retrosheet
game logs, compute the inning × score-difference win-expectancy table, and print
it. It is small, and it validates the entire data foundation before anything
larger is built on it. Full spec in
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
