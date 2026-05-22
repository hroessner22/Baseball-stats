# 07 — Design Direction

*Baseball-stats (working title) · Draft v1 · May 2026*

> **The locked visual and interaction target for the product.** Not to be built
> yet — UI implementation waits until after the Milestone 1 data engine
> (Phase 1, [`04-ROADMAP.md`](04-ROADMAP.md)). This document is the reference the
> interface is built against when that work begins.

## Aesthetic — a dark terminal look

Spare, technical, terminal-inspired. Calm and precise, with plenty of room to
breathe — the deliberate opposite of a cluttered analytics wall.

| Token | Value |
|-------|-------|
| Background | Near-black — `#0c0e0c` |
| Accent (the only one) | Green — `#3ddc84` |
| Secondary text | Muted gray-green *(exact hex TBD)* |
| Typeface | Monospace *(family TBD)* |
| Borders | Thin — `0.5px` |
| Spacing | Generous — lots of breathing room |

A **single accent color.** Green carries every signal — live state, occupied
bases, leverage, win expectancy. Restraint is the aesthetic.

## The shell

**Header** — reads **`DIAMOND:CONTEXT`**, with a green ● **LIVE** indicator.

**Bottom navigation** — numbered, four destinations:

```
01 LIVE     02 STANDINGS     03 LEADERS     04 MVP
```

`01 LIVE` is the home screen. `STANDINGS`, `LEADERS`, and `MVP` come later (see
*Stat philosophy*).

## Screen 01 — LIVE

The home screen: the whole slate of games at once. *(This is the **Board**,
Layer 1 in [`01-VISION.md`](01-VISION.md).)*

A **compact, responsive grid of game tiles** — about **155px** per tile, sized
so the **entire slate fits on screen without scrolling.**

Each tile shows:

- **Matchup** — the two teams.
- **Inning** and **score.**
- A small **four-base diamond** — first base at the **right**, second at the
  **top**, third at the **left**; a base is **lit green when occupied.**
- **Win expectancy %**, color-coded: **bright green when lopsided**, fading to
  **gray as the game gets close.**
- A green ● **HOT** flag on **high-leverage games.**

At a glance: which games are close, who has runners on, and which one is *hot*
right now.

## Screen — Game detail

Tap a tile to open it. *(This is the **Game**, Layer 2 in
[`01-VISION.md`](01-VISION.md).)* Two panes.

### Left — the field

A clean **SVG baseball field**:

- a curved outfield wall, brown infield dirt, chalked base paths, the mound;
- the four-base diamond, with **runners labeled by name;**
- the field **tinted green in proportion to win expectancy** — the more lopsided
  the game, the greener the field.

Below the field: **outs, count, and the current batter.**

### Right — the context panel

- **Win expectancy %** — *always shown with its sample size.* The number is
  honest about how many historical games it stands on.
- **Batting average on the current count.**
- A plain-English **"read"** — one human sentence summing up the situation.

## Stat philosophy

- **Surface little per screen; reveal depth on click.** Restraint over clutter,
  every time.
- **Situational stats are the identity.** Win expectancy by game state, batting
  average by count, performance with runners in scoring position — *that* is the
  edge. Basic season stats are not the point.
- **Standings, Leaders, and MVP come later** — clean, sortable tables. Useful,
  but not the wedge.

## Build status

**Do not build any of this yet.** The current focus is the **Milestone 1 data
engine.** This document is the **target**: when UI work begins, it is built to
this spec — and revised here first if the direction changes.
