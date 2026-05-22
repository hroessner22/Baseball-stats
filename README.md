# Baseball-stats

> **Working title.** A live companion for baseball.
> Naming is an open decision — the design uses `DIAMOND:CONTEXT`; see
> [`docs/06-ENGINEERING-HANDOFF.md`](docs/06-ENGINEERING-HANDOFF.md).

Every game in progress, each led by an empirical win probability drawn from
150 years of history — so you can see, at a glance, which game matters and why.
Tap in for the live win-expectancy story; drill down into the full situational
matrix.

## What's in this repository right now

This repo currently holds the **vision and planning documentation** for the
project, prepared for handoff to a senior engineer. **No application code
exists yet** — implementation begins at Phase 1 of the roadmap.

| | |
|---|---|
| **Current phase** | Phase 0 — Foundation (project scaffolding complete) |
| **Application code** | None yet (begins Phase 1) |
| **Documentation** | Complete — this planning set |
| **Stack** | GitHub + Cloudflare + Supabase |
| **Repository** | https://github.com/hroessner22/Baseball-stats |

## Planning documents

Read in order:

| # | Document | What it covers |
|---|----------|----------------|
| 1 | [`docs/01-VISION.md`](docs/01-VISION.md) | The product, the problem, the north star |
| 2 | [`docs/02-PRODUCT-SPEC.md`](docs/02-PRODUCT-SPEC.md) | The three layers, the matrix, the relevance engine |
| 3 | [`docs/03-ARCHITECTURE.md`](docs/03-ARCHITECTURE.md) | Data sources, the engine, the stack, real-time |
| 4 | [`docs/07-DESIGN.md`](docs/07-DESIGN.md) | The visual and interaction design |
| 5 | [`docs/04-ROADMAP.md`](docs/04-ROADMAP.md) | The phased build process, foundation to launch |
| 6 | [`docs/05-BUSINESS-CASE.md`](docs/05-BUSINESS-CASE.md) | Market, competition, monetization, the YC lens |
| 7 | [`docs/06-ENGINEERING-HANDOFF.md`](docs/06-ENGINEERING-HANDOFF.md) | Senior-engineer onboarding + open decisions |

**Senior engineer joining the project? Start with
[`docs/06-ENGINEERING-HANDOFF.md`](docs/06-ENGINEERING-HANDOFF.md).**

## Repository layout

```
Baseball-stats/
├── README.md            This file
├── docs/                Vision & planning documentation
├── data/                Datasets (downloaded; not committed to git)
├── src/                 Application source code (begins Phase 1)
├── requirements.txt     Python dependencies
└── venv/                Local Python environment (not committed)
```

## Data & attribution

Historical data comes from **Retrosheet** (https://www.retrosheet.org); live
game data comes from the **MLB Stats API**.

> The information used here was obtained free of charge from and is copyrighted
> by Retrosheet. Interested parties may contact Retrosheet at 20 Sunset Rd.,
> Newark, DE 19711.

Retrosheet requires the attribution above; the MLB live feed carries its own
licensing terms. **A data-rights review is a required pre-commercialization
task** — see [`docs/06-ENGINEERING-HANDOFF.md`](docs/06-ENGINEERING-HANDOFF.md).

---

*Documentation · Draft v2 · May 2026 — a starting point for discussion, not a
final specification.*
