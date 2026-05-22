# 07 — Design Direction

*Baseball-stats (working title) · Draft v2 · May 2026*

> **The visual and interaction target for the product.** Not to be built yet —
> UI implementation waits until after the Milestone 1 data engine (Phase 1,
> [`04-ROADMAP.md`](04-ROADMAP.md)). This document is the reference the
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

`01 LIVE` is the home screen. The four are not separate apps — they are one
engine at four scales (see [`02-PRODUCT-SPEC.md`](02-PRODUCT-SPEC.md)).
`STANDINGS`, `LEADERS`, and `MVP` come after the live MVP.

## The card — the one unit

The product is not dozens of screens. It is **one unit, recursing** — the
**card.** Every card has the same five parts: the **subject** (where you are,
who, the exact situation), the **number** (with its plain-English label and its
picture), the **evidence** (the yardstick and the sample size), the **read**
(the meaning, in one sentence), and the **doors** (recompute, or drill).

```
  LIVE › Tigers–Yankees › Soto at-bat
  SOTO  vs  GLASNOW
  2-2 · 2 out · runner on 2nd · bot 8

  How often does Soto reach base here?
          41%
          ██████████░░░░░
          a typical hitter: 34%  ·  1,210 PA

  "Glasnow leans on his slider here, and
   Soto lays off it well."

  see it for:  overall · pitcher · [matchup]
  go deeper:   › the pitch  › every count
```

**Every tap swaps the subject and re-renders the same card.** The Board is a
grid of small cards; the Game is a card beside the field; the Deep Dive is the
card, recursing. One screen design, learned once — and then there is no "rest
of the app."

## Self-explanation — nothing on screen that can't explain itself

The governing rule: **if a number can't say, in plain English, what it is,
whose it is, and whether it is a lot or a little, it does not earn the screen.**
No naked numbers, no jargon.

- **Every number is the answer to a plain-English question — and the question
  is shown.** Not "OBP" — *"How often does Soto reach base here?"* You cannot
  misread a question and its answer.
- **The card reads top-to-bottom like a sentence:** where you are → who → the
  situation → the question → the answer → how it compares → what it means →
  where you can go.
- **The yardstick is non-negotiable.** A number alone is trivia; a number
  beside its baseline ("a typical hitter: 34%") tells someone who has never
  watched baseball that 41% is good. Every number shows what *normal* is, and
  its sample size, right there.
- **Label by meaning, never by jargon.** "Reaches base," not "OBP." Sabermetrics
  is translated into English at the surface; the depth stays intact underneath.
- **The read is the safety net.** Ignore every number and the one plain sentence
  still tells you what is happening and why it matters.

The test: a stranger who has never watched baseball looks at any card for three
seconds and can say what it is telling them. If they can't, the card is wrong.

## Reading the matrix — point and axis

The card has two modes:

- **Point mode** — one cell of the matrix: one number for one situation. The
  default.
- **Axis mode** — one stat fanned across one dimension: the lefty/righty split,
  the twelve counts, the eras as a sparkline. This is how variations are seen.

**Every coordinate in the subject line is a door.** Tap the handedness and the
card fans the handedness axis; tap the count and it fans all twelve counts. Any
variable not currently set is added as a *lens* — then it too is in the subject
line, and a door.

**"See more" is not a wall between shown and hidden.** There is one bottomless
relevance ranking; the screen shows its top; any "more" gesture walks further
down the *same* ranking — never a dump, always ranked descent.

## Progressive disclosure — calm at every depth

Every level shows only its own headline, so every level looks calm — *plain,
but never empty.* Clicking does not un-hide; it *zooms* one level deeper, where
again you see one relevant headline per thing.

The **relevance engine** ([`02-PRODUCT-SPEC.md`](02-PRODUCT-SPEC.md)) governs
every level — it surfaces only what is surprising, trustworthy, and relevant to
the moment, and the amount shown flexes with leverage. The matrix is infinite;
the screen is always one calm view; the tap is the only bridge.

## Screen 01 — LIVE (the Board)

The home screen: the whole slate at once — a compact, responsive grid of game
tiles, about **155px** each, sized so the entire slate fits without scrolling.

Each tile (a small card) shows:

- **Matchup** — the two teams.
- **Inning** and **score.**
- A small **four-base diamond** — first base at the **right**, second at the
  **top**, third at the **left**; a base **lit green when occupied.**
- **Win expectancy %**, color-coded: **bright green when lopsided**, fading to
  **gray as the game gets close.**
- A green ● **HOT** flag on **high-leverage games.**

When no game is live, the Board becomes history — "on this day," yesterday's
drama (see *Never silent*, [`02-PRODUCT-SPEC.md`](02-PRODUCT-SPEC.md)).

## Screen — Game detail

Tap a tile to open the Game. Two panes.

**Left — the field.** A clean **SVG baseball field**: curved outfield wall,
brown infield dirt, chalked base paths, the mound; the four-base diamond with
**runners labeled by name**; the field **tinted green in proportion to win
expectancy.** Below: outs, count, the current batter.

**Right — the context panel.** This is a card: the win-expectancy question and
answer with its sample size, the batting average on the current count, and the
plain-English read.

## The graphics

The visual vocabulary — information carried as light and shape, *felt* rather
than read:

- **The win-expectancy curve** — the signature graphic. The heartbeat of a
  game, pitch by pitch; it recurs at every scale (a pennant race is a curve
  too), and it is what becomes a shareable card.
- **The four-base diamond** — baserunners, lit green.
- **The field tint** — the SVG field greener the more lopsided the game.
- **The spray chart** — where a hitter hits the ball, dotted onto the field.
- **The hot/cold zone** — the strike zone tinted by where a hitter crushes it
  versus whiffs.
- *(Later)* the live curve with **comparable historical games ghosted faintly
  behind it** — "tracking like 2011, Game 6."

## Stat philosophy

- **Surface little per screen; reveal depth on click.** Restraint over clutter,
  every time.
- **Situational stats are the identity.** Win expectancy by game state, batting
  average by count, performance with runners in scoring position — *that* is
  the edge. Basic season stats are not the point.
- **`STANDINGS`, `LEADERS`, and `MVP`** come after the live MVP — each a
  *board* (rows alive with probability, every row a door), not a plain table.

## Build status

**Do not build any of this yet.** The current focus is the **Milestone 1 data
engine.** This document is the **target**: when UI work begins, it is built to
this spec — and revised here first if the direction changes.
