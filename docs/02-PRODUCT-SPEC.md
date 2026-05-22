# 02 — Product Specification

*Baseball-stats (working title) · Draft v1 · May 2026*

> This document describes *what* the product does. For *why*, see
> [`01-VISION.md`](01-VISION.md); for *how*, see
> [`03-ARCHITECTURE.md`](03-ARCHITECTURE.md).

## The core concept: the historical win rate

Almost every feature rests on one computed idea.

For any **game state** — defined at minimum by *(inning, half-inning, score
difference)* — look across every historical game that passed through that exact
state, and compute the percentage that the team went on to win.

> Example: *of all the times a team has trailed by 2 runs entering the bottom
> of the 7th, X% went on to win.*

This is the **historical win rate** (informally, "win probability"). Two
important properties:

- It is **empirical**, not a predictive model — a direct frequency count of
  what actually happened. That makes it transparent and easy to explain: a
  product virtue, not a limitation.
- It is **configurable by era.** A win rate computed from 1995–2024 differs
  from one computed from 1901–1930. The user controls the year range (the
  "toggle"). This is a first-class feature.

Later, the game state can be enriched (outs, baserunners, ballpark, teams) for
a sharper number — see [`04-ROADMAP.md`](04-ROADMAP.md), Phase 4.

## Pillar 1 — The Scoreboard

**Job:** let the user find and enter any game in history.

| Aspect | MVP | Full vision |
|--------|-----|-------------|
| Browse | Pick a season; see its games in a grid | Pick any date; jump by team, series, or era |
| Game tile | Teams, final score, date | Mini line score, a "drama score," win-prob thumbnail |
| Filtering | By season | By team, month, postseason, close games, blowouts, comebacks |
| Search | — | "Show me the wildest comebacks of the 1980s" |

User stories:
- *As a fan, I pick a season and see every game, so I can find one I remember.*
- *As an explorer, I filter to "biggest comebacks" so the product shows me
  something I didn't know to look for.*

## Pillar 2 — The Game View

**Job:** make a single game an emotional, contextual experience. **This is the
wedge — the feature the product lives or dies on.**

| Aspect | MVP | Full vision |
|--------|-----|-------------|
| Replay | Step through the game inning by inning | Animate; scrub a timeline |
| Win-prob | Historical win rate per inning, as a number and a line | Full interactive curve; tap any point for detail |
| Context | "Teams in this spot won X%" | Comparable games, biggest swings, "what usually happens next" |
| Interactivity | Each inning is clickable | Every team, score, and stat opens its own contextual view |

User stories:
- *As a fan reliving a game, at each inning I see how unusual the situation
  was, so the game has stakes even though I know the result.*
- *As an explorer, I tap a win-probability swing and jump straight to every
  comparable game.*

The "everything interactive with its own stats" idea lives here: the Game View
is a web of clickable entities, each a door into the Stats Explorer.

## Pillar 3 — The Stats Explorer

**Job:** let a user roam the whole dataset — "stats on stats, highly organized."

| Aspect | MVP | Full vision |
|--------|-----|-------------|
| Entry point | The win-rate table: inning × score-difference grid | Any stat, any entity — teams, eras, situations |
| Organization | One clean, sortable table | A consistent drill-down model: every value expands |
| Cross-links | — | Every stat links to the games behind it, and back |
| Comparison | — | Compare eras; "this season vs. historical" side by side |

The design challenge here is **organization**, not raw capability. The promise
is *highly organized* — a consistent, predictable way to go deeper that never
overwhelms the user.

## Cross-cutting: "everything interactive"

One consistent rule across all three pillars:

> **Every meaningful element — a game, an inning, a team, a score, a stat — is
> a door. Clicking it opens that element's own contextual stats, with a clear
> way back.**

One interaction model, applied everywhere. That consistency is what makes a
deep product feel simple.

## Cross-cutting: the year-range toggle

Every statistic is computed over a **user-controlled year range**:

- **"This season"** — the most recent completed season.
- **"Historical"** — a wide range, up to all of recorded history.
- **Custom** — any span the user picks.

In the MVP this can be a simple control; in the full product it is a prominent,
always-available toggle, because comparing *this season vs. history* is one of
the most compelling things the product can do.

## Personas

- **The Curious Fan** — watches baseball, not a stats person. Wants stories and
  "wow." The Game View is for her.
- **The Stathead** — already uses FanGraphs. Wants depth and speed. The Stats
  Explorer is for him.
- **The Content Creator** *(future)* — writers, broadcasters, social accounts
  needing fast, beautiful historical context.
- **The Bettor** *(future, optional)* — see [`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md).

## The MVP — the smallest lovable product

The smallest thing worth shipping:

> **The Scoreboard for one era of seasons, plus the Game View with an
> inning-level historical win rate.** A user can pick a season, open a game,
> and relive it with real historical context.

That is enough to test the core question: *does the historical echo make people
care?* The richer Stats Explorer, advanced filtering, and the deeper model all
come **after** that question is answered.

## Out of scope for v1

- Live / in-progress games
- User accounts, saved views, social features
- Sports other than baseball
- A predictive model (ship the empirical rate first)
- Native mobile apps (responsive web first)
