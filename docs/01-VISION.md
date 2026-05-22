# 01 — Vision

*Baseball-stats (working title) · Draft v2 · May 2026*

## One-line pitch

**A live companion for baseball. Every game in progress, each led by its score
and a win probability counted from 150 years of history — so you can see, in
one glance, which game matters and why.**

## The problem

On any given night, a dozen baseball games are in progress. Every scoreboard on
earth will tell you the score of each one.

None of them tells you the thing you actually want to know: **which game should
I be watching, and how much does this moment matter?**

A 5–0 lead in the 9th and a 5–4 lead in the 9th look almost identical on a
scoreboard — same inning, same team ahead. One game is effectively decided; the
other can still go either way. The score cannot tell them apart. A win
probability, drawn from every comparable game in history, can — and that
difference is the whole story no product surfaces.

The data to close that gap exists. But today it is split in two:

- **Scoreboards** (MLB.com, ESPN) are live and friendly — and shallow. They
  show the score, not the stakes.
- **Analytics tools** (Baseball Savant, FanGraphs) are deep — and built for
  analysts. A wall of numbers a normal fan will not wade into.

Nobody has fused them. Nobody has made *live, history-grounded context*
something a regular fan can simply feel.

## The insight

Every moment of every game has thousands of historical echoes — past games that
passed through the exact same situation: this inning, this score, this matchup.

Count them, and you get a **win probability**: *of every team that has ever
stood exactly here, this share went on to win.* It is empirical — a direct
frequency count of what truly happened — not a prediction from a black box.

That single number is the most powerful thing in the sport, because it does
three jobs at once:

1. **It measures drama.** A win probability near 50% late in a game *is* a
   nail-biter, by definition. The number tells you what to watch.
2. **It carries emotion.** *"Teams trailing by three in the 8th come back 14%
   of the time"* turns a score into suspense — live, while it is still
   undecided.
3. **It is a door into history.** The number exists only *because* of 150 years
   of games. Touch it, and the whole archive opens behind it.

So we lead with it. Score and win probability, on every game, front and center.
Everything else in the product hangs off that one number.

## What we're building

One product, experienced in **three layers of depth** — each a step further in,
all anchored on win probability.

### Layer 1 — The Board
The front door: every game on right now, plus every game scheduled today, as a
living grid of tiles. Each tile leads with the **score** and the **win
probability** — and, before first pitch, the head-to-head history of the two
teams. The Board does not just list games; it tells you instantly which one is a
blowout and which one is history in the making.

### Layer 2 — The Game
Tap any game. Live score and box score — but wrapped in the win-probability
story: the curve as it rises and falls, the swing moments, the historical echo
at the current situation. This is the live companion — the thing you keep open
next to the game itself.

### Layer 3 — The Deep Dive
Everything in the Game is a door. Tap a hitter, a team, a situation, and fall
into the deep-stats world — batting average in *every* situation, the splits,
the history, the full picture. As much depth as Baseball Savant holds — but
beautiful, browsable, and built for a human being rather than an analyst.

You can stop at any layer. A casual fan lives on the Board; a curious one opens
a Game; a stat-head disappears into the Deep Dive. Win probability is the thread
that ties all three together.

## The experience (a vignette)

> It is a Saturday in July; nine games are in progress. A fan opens the app to
> the Board. Eight tiles are calm — and one is lit up: a 4–4 game, bottom of the
> 8th, win probability swinging between 46% and 61% pitch to pitch. She taps it.
>
> The Game opens. The win-probability curve looks like a heartbeat. A line
> reads: *"Teams tied entering the 9th at home win 53% of the time."* The batter
> steps in; she taps his name and drops into the Deep Dive — he hits .311, but
> .347 with a runner on second. She surfaces just in time to watch him line one
> into the gap. The curve spikes. Twenty minutes later she is still there — and
> she opened the app for a single tile.

That pull — *the score told me to look, the history told me why it mattered* —
is the product.

## Positioning

> **We live in the gap between ESPN and Baseball Savant.**

ESPN is friendly but shallow. Baseball Savant is deep but built for analysts.
Nobody owns *deep* **and** *beautiful* **and** *in-the-moment* — and neither
incumbent can move into that gap without betraying its own model: ESPN lives on
breadth and ad views; Savant is MLB's tool for analysts. The gap is structural.
That gap is the company.

## The north star

> **Open it during any game, and instantly feel exactly how much this moment
> matters.**

Baseball is the start, not the boundary. The engine — *surface the historical
echo of any live situation* — is the same for basketball, football, and soccer.
**Baseball is the wedge; live sports made meaningful is the ceiling.**

## Principles

1. **Lead with the one number.** Score and win probability come first,
   everywhere. The product has a spine, and that is it.
2. **Context over raw numbers.** A number alone is trivia; a number against
   history is a story. Always show the echo.
3. **Everything is a door.** Every game, player, team, and situation opens
   something deeper — with a clear way back.
4. **Beautiful, or it doesn't count.** The depth already exists elsewhere; our
   job is to be the first place a normal fan actually enjoys reaching it.
5. **Honest data.** Our numbers are empirical — counted from what truly
   happened, transparent and explainable. Never a black box.

## What this is *not*

- **Not a scoreboard.** We show scores, but we are not competing to be your
  source of record. We are the companion you open *because the score alone is
  not enough.*
- **Not another analytics wall.** Baseball Savant and FanGraphs serve analysts
  superbly; we serve the fan who wants that depth without the barrier.
- **Not a betting product.** Live win probability sits close to betting — a
  deliberate strategic *option* (see the business case), not the v1 identity.
- **Not everything at once.** The vision is three layers and, one day, every
  sport. The *first build* is one layer — the Board, a handful of live games,
  win probability done beautifully. Depth and breadth are earned after that.

## Related documents

- Features in detail → [`02-PRODUCT-SPEC.md`](02-PRODUCT-SPEC.md)
- How it looks and behaves → [`07-DESIGN.md`](07-DESIGN.md)
- How it gets built → [`03-ARCHITECTURE.md`](03-ARCHITECTURE.md) ·
  [`04-ROADMAP.md`](04-ROADMAP.md)
- Market & funding → [`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md)
