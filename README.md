# Baseball-stats

> **Working title.** An interactive baseball analytics platform.
> Naming is an open decision — see [`docs/05-BUSINESS-CASE.md`](docs/05-BUSINESS-CASE.md).

Explore every game in baseball history with live historical context: win
probabilities, season statistics, and a deeply organized, interactive way to
travel through 150+ years of the sport.

## What's in this repository right now

This repo currently holds the **vision and planning documentation** for the
project, prepared for handoff to a senior engineer. **No application code
exists yet** — implementation begins at Phase 1 of the roadmap.

| | |
|---|---|
| **Current phase** | Phase 0 — Foundation (project scaffolding complete) |
| **Application code** | None yet (begins Phase 1) |
| **Documentation** | Complete — this planning set |
| **Repository** | https://github.com/hroessner22/Baseball-stats |

## Planning documents

Read in order:

| # | Document | What it covers |
|---|----------|----------------|
| 1 | [`docs/01-VISION.md`](docs/01-VISION.md) | The product, the problem, the north star |
| 2 | [`docs/02-PRODUCT-SPEC.md`](docs/02-PRODUCT-SPEC.md) | Every feature, in detail |
| 3 | [`docs/03-ARCHITECTURE.md`](docs/03-ARCHITECTURE.md) | Technical design, data, recommended stack |
| 4 | [`docs/04-ROADMAP.md`](docs/04-ROADMAP.md) | The phased build process, foundation to launch |
| 5 | [`docs/05-BUSINESS-CASE.md`](docs/05-BUSINESS-CASE.md) | Market, competition, monetization, the YC lens |
| 6 | [`docs/06-ENGINEERING-HANDOFF.md`](docs/06-ENGINEERING-HANDOFF.md) | Senior-engineer onboarding + open decisions |

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

The project is built on historical data from **Retrosheet**
(https://www.retrosheet.org).

> The information used here was obtained free of charge from and is copyrighted
> by Retrosheet. Interested parties may contact Retrosheet at 20 Sunset Rd.,
> Newark, DE 19711.

Retrosheet places conditions on the use of its data. **A data-licensing review
is a required pre-commercialization task** — see
[`docs/06-ENGINEERING-HANDOFF.md`](docs/06-ENGINEERING-HANDOFF.md).

---

*Documentation drafted May 2026 · Draft v1 — a starting point for discussion,
not a final specification.*
