# 01 — Vision

*Baseball-stats (working title) · Draft v1 · May 2026*

## One-line pitch

**A living, interactive encyclopedia of baseball — where every game in history
can be explored with the historical context that makes it meaningful.**

## The problem

Baseball has the deepest, best-recorded history of any sport on earth. Every
game played since 1871 — over 230,000 of them — is documented, inning by inning.

And yet that history is **inert**. It lives in:

- dense statistical tables built for analysts, not explorers;
- archives and spreadsheets that assume you already know what you want;
- the memories of fans, with no easy way to verify, compare, or relive.

When a team falls behind by three runs in the 8th inning, a question naturally
forms: *"Has anyone ever come back from this?"* Today, answering that is
genuinely hard. The data exists — but no product makes it feel **alive,
immediate, and explorable.**

## The insight

Every moment in a baseball game has thousands of historical echoes — past games
that passed through the exact same situation: the score, the inning, who was
ahead.

Surface that echo instantly and beautifully — *"teams trailing by 3 entering
the 8th have come back to win 14% of the time"* — and you turn a raw number
into **story, drama, and understanding.** That single statistic is context,
suspense, and education at once.

That echo is the heart of this product.

## What we're building

An interactive platform with **three connected pillars**:

### 1. The Scoreboard
A visual board of games — like the scoreboard on MLB.com — but for any date in
baseball history. Browse a day, a season, a team. Every game is a tile you can
open.

### 2. The Game View
Open any game and watch it unfold inning by inning, with **live historical
context** at every step: the win probability, how the game compares to history,
the moments that mattered. This is the emotional core of the product.

### 3. The Stats Explorer
A deeply organized, interactive space to travel through the data itself —
historical stats and season stats, every value clickable, every view leading
naturally to the next. "Stats on stats," highly organized.

These are not three separate apps. They are one connected experience: the
Scoreboard leads into a Game; a moment in the Game leads into the Stats
Explorer; a stat in the Explorer leads back to the games that produced it.

## The experience (a vignette)

> A fan opens the platform and picks October 2016. The Scoreboard shows that
> postseason. She opens Game 7 of the World Series. The Game View replays it
> inning by inning — and as the score swings, a quiet line of context appears:
> *"Teams leading after 6 have won 81% of the time."* The number climbs, then
> the rain delay, then the swing. She taps the win-probability line, and the
> Stats Explorer opens every comparable comeback in history. Twenty minutes
> later she has fallen down a century-deep rabbit hole — and loved every second.

That feeling — *history made explorable* — is the product.

## The north star

> **Every game. Every stat. Every moment. Explorable, interactive, and alive.**

In the long run this need not be only baseball, and not only historical. The
same engine — *surface the historical echo of any live situation* — extends to
other sports and to live games. **Baseball history is the wedge, not the
ceiling.**

## Principles

1. **Context over raw numbers.** A number alone is trivia. A number *in
   context* is insight. Always show the echo.
2. **Interactive by default.** Every element is a door to somewhere deeper.
3. **Beautiful and accessible.** Powerful enough for a stathead, inviting
   enough for a casual fan. Not another wall of tables.
4. **Honest data.** Our statistics are empirical and transparent — derived
   directly from what actually happened, not a black box.
5. **Depth is the moat.** 150 years of history, organized so well it feels
   effortless, is hard to copy.

## What this is *not* (for now)

- **Not a betting product.** Win probability has obvious betting adjacency;
  that is a deliberate strategic *option* (see the business case), not the v1
  identity.
- **Not a live in-game product first.** We start with history, where the data
  is complete and free. Live games come later.
- **Not another dense analytics table.** Baseball-Reference and FanGraphs
  already serve analysts superbly. We build for *exploration and engagement* —
  a different job.

## Related documents

- Features in detail → [`02-PRODUCT-SPEC.md`](02-PRODUCT-SPEC.md)
- How it gets built → [`03-ARCHITECTURE.md`](03-ARCHITECTURE.md) ·
  [`04-ROADMAP.md`](04-ROADMAP.md)
- Market & funding → [`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md)
