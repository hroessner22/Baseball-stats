# 02 — Product Specification

*Baseball-stats (working title) · Draft v2 · May 2026*

> *What* the product does. For *why*, see [`01-VISION.md`](01-VISION.md); for
> *how it looks and behaves*, [`07-DESIGN.md`](07-DESIGN.md); for *how it is
> built*, [`03-ARCHITECTURE.md`](03-ARCHITECTURE.md).

## The core concept: win expectancy and the matrix

Almost everything rests on one computed idea.

For any **game state** — at minimum an inning, half-inning, and score
difference; richer still with outs, baserunners, the count, and the matchup —
look across every historical game that passed through that exact state and
count the share that went on to win. That is the **win expectancy.**

Two properties matter:

- It is **empirical** — a direct frequency count of what actually happened, not
  a prediction from a black box. Transparent, and easy to explain.
- It is **configurable by era** — a rate from 1995–2024 differs from one from
  1901–1930. The user controls the year range.

Now extend it. Win expectancy is *one* stat conditioned on game state — and
**every** stat can be conditioned the same way: batting average by count,
strikeout rate against left-handers, on-base rate with a runner on second. So
the product's depth is not a longer list of stats. It is:

> **A matrix — every stat × every game situation × every player, team, and
> matchup × every era.** Millions of cells. A single game is one path through
> it; history is every path ever walked.

That matrix is the product. Everything below is a way to enter it, read it, or
drill into it.

## The three layers

One product, experienced as three layers of depth — each a step further into
the matrix. The casual fan lives on Layer 1; the curious open Layer 2; the
stat-head disappears into Layer 3. You stop where you want.

### Layer 1 — The Board

**Job:** show every game at once, and which one matters.

The home screen — a compact grid of tiles, one per game, the whole slate
visible without scrolling. Each tile leads with **score** and **win
expectancy**; a small diamond shows baserunners; a flag marks high-leverage
("hot") games.

| Aspect | MVP | Full vision |
|--------|-----|-------------|
| Coverage | Every game live or scheduled today | Any date in history; jump by team, series, era |
| Tile | Score, inning, win expectancy, baserunner diamond | A drama/leverage score, a win-expectancy sparkline |
| Pre-game | Head-to-head history of the two teams | Full matchup preview |
| Sorting | By start time | By leverage — the most dramatic game first |

The Board doesn't list games; it tells you, at a glance, which one is a blowout
and which is history in the making.

### Layer 2 — The Game

**Job:** make a single game an emotional, contextual experience. **The wedge.**

Tap a tile. Live score and box score, wrapped in the win-expectancy story: the
curve as it rises and falls, the swing moments, the historical echo at the
current situation. The companion you keep open next to the game.

| Aspect | MVP | Full vision |
|--------|-----|-------------|
| State | Live score, count, outs, baserunners, batter/pitcher | Pitch-by-pitch scrubbing |
| Win expectancy | The number, plus its sample size | The full interactive curve; tap any point |
| Context | "Teams in this spot win X%" | Comparable games, biggest swings, what usually happens next |
| Interactivity | Each entity is tappable | Every player, team, count, situation opens its own card |

### Layer 3 — The Deep Dive

**Job:** let a user roam the whole matrix — every variation, beautifully.

Everything in the Game is a door. Tap a hitter, a pitcher, a situation, and
fall into the situational matrix — batting average in every situation, the
splits, the history. The depth of Baseball Savant, built for a human being.

| Aspect | MVP | Full vision |
|--------|-----|-------------|
| Entry | The win-expectancy table (inning × score) | Any stat, any entity, any variation |
| Reading | One slice at a time, calm | Compare a stat across a whole axis at once |
| Cross-links | — | Every number links to the games behind it, and back |

## The variations — what "every situation" means

A "situation" is a coordinate in a space of roughly seven families of axes;
every combination is a cell in the matrix:

1. **Game state** — inning, outs, base state, score difference, count, times
   through the order, batting-order spot.
2. **The matchup** — batter/pitcher handedness and the pairing, the specific
   batter and pitcher, head-to-head history, pitcher role, pitch type.
3. **The conditions** — ballpark, home/away, day/night, weather, time of
   season, rest.
4. **The stakes** — leverage, regular season vs. postseason, postseason round,
   elimination games.
5. **The era** — historical era, rule environment, a specific year or range.
6. **The lens** — what is measured: win expectancy, run expectancy, the
   probability of each plate-appearance outcome, the rate stats.
7. **The population** — whose number: the league baseline, this hitter, this
   pitcher, the matchup, a team, a class of players.

Not every axis reaches equally far back — game state, handedness, and outcomes
go deepest; pitch type, contact quality, and weather are the modern era. The
product is honest about that (see *the yardstick*, [`07-DESIGN.md`](07-DESIGN.md)).

## The relevance engine

The matrix has millions of cells; a screen must show only a few. Every moment,
the product scores every candidate fact and shows the top:

- **Surprise** — how far it deviates from the baseline. Flat numbers never
  appear; deviations rise.
- **Trust** — sample size. Thin samples are discounted; they cannot headline.
- **Proximity** — does it bear on the imminent pitch or play?

The amount shown flexes with leverage: a tie game in the 9th surfaces a lot; a
blowout goes nearly silent. "Only relevant information on screen" is not a
filter applied to a list — it is the natural top of this ranking. The relevance
engine is the product's editor, and the hardest, most valuable computation in
it.

## One engine, every scale

A game state is a *state* — and a state exists at every scale. The same engine
runs at all of them; the bottom navigation is one engine at four zoom levels.

| Scale | The state | The number |
|-------|-----------|------------|
| **Live** — a pitch / game | inning, score, matchup | Win expectancy |
| **Standings** — a season | games up, games to play | Playoff & World Series odds |
| **Leaders / MVP** — a race | the gap, games left | Probability of finishing first |
| **Records** — a career pace | the pace, time remaining | Probability of reaching the milestone |

Standings are win expectancy for the *season*; a pennant race is a long game;
"records being broken" is the relevance engine at the season scale. The
`STANDINGS`, `LEADERS`, and `MVP` screens are not plain tables — each is a
*board*: every row alive with its probability, every row a door into its card.

## The stat set

Everything is win expectancy and its relatives, computed empirically:

- **Win expectancy** — the spine. Every game state → the share that win.
- **Win Probability Added (WPA)** — each play's swing in win expectancy, summed
  per player: the live hero-and-goat of every game.
- **Situational splits** — any rate stat (AVG, OBP, SLG, strikeout/walk rates)
  across any axis: by count, by base state, by handedness, RISP, and so on.
- **The matchup likelihood** — this hitter vs. this pitcher, combining the
  hitter's rate, the pitcher's rate, and the league baseline (the established
  odds-ratio / log5 method).
- **Run expectancy** — expected runs from any base-out state.
- **The rarity radar** — when the live game does something historically rare,
  the product catches it: "no team has come back from here since 1968."

## Cross-cutting rules

**Everything is a door.** Every meaningful element — a game, a player, a count,
a score, a standings row — opens its own contextual card, with a clear way
back. One interaction model, applied everywhere ([`07-DESIGN.md`](07-DESIGN.md)).

**The era toggle.** Every statistic is computed over a user-controlled year
range — "this season," "all-time," or any custom span. Comparing this season to
history is one of the most compelling things the product does.

**Never silent.** When no game is live — the off-season, a quiet afternoon —
the Board becomes history: "on this day," yesterday's drama, the deep dive. The
product is alive 365 days a year.

## Personas

- **The Curious Fan** — watches baseball, not a stats person. Wants stories and
  "wow." Lives on the Board and the Game.
- **The Stat-head** — already uses FanGraphs or Baseball Savant. Wants depth
  and speed. Disappears into the Deep Dive.
- **The Content Creator** *(future)* — writers, broadcasters, social accounts
  needing fast, beautiful context.
- **The Bettor** *(future, optional)* — empirical base rates; a strategic fork,
  see [`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md).

## The MVP — the smallest lovable product

> **The Board and the Game, live, led by win expectancy.** A user opens the
> app, sees every game on right now, taps the closest one, and watches it with
> real historical context.

That is enough to test the core question: *does the live historical echo make
people care?* The Deep Dive's full breadth, the other scales (standings,
records), and the richest model all come **after** that question is answered.

## Out of scope for v1

- The full Deep Dive breadth (the MVP drills shallow; depth grows after)
- Sports other than baseball
- User accounts, saved views, social features
- Native mobile apps (responsive web first)
- A predictive model (ship the empirical rate first)
