# 04 — Roadmap

*Baseball-stats (working title) · Draft v2 · May 2026*

> The extended build process, Phase 0 to growth. Effort sizes are
> **planning-grade estimates** assuming roughly one focused engineer; the
> incoming senior engineer should re-estimate. Calendar dates are deliberately
> omitted — they depend on team capacity.

## Shape of the plan

```
Phase 0   Foundation                ✅ complete
Phase 1   The Engine (PoC)          ✅ complete
Phase 2   The Historical Engine     ✅ complete
Phase 3   The Live MVP  ──────────── first real users; validate the idea
Phase 4   The Deep Dive             ◐ matchup engine built; UI remains
Phase 5   Production & every scale    first investor-ready product
Phase 6   Growth & monetization
```

The most important line is **Phase 3.** Everything before it is setup;
everything after depends on what real users do.

**Plan reordered:** at the founder's direction, the historical depth came
first — Phase 4's data engine (play-by-play ingestion and the batter-vs-pitcher
matchup engine) was built ahead of Phase 3. The live MVP now launches on top of
both engines, and Phase 3 is the next milestone.

## Phase 0 — Foundation ✅

**Status: complete.**
- GitHub repository created and cloned.
- Python virtual environment; folder structure, `.gitignore`, `requirements.txt`.
- The stack chosen — GitHub + Cloudflare + Supabase.
- This documentation set.

## Phase 1 — The Engine (Proof of Concept)

**Goal:** prove the core computation on real data. **Status: complete.**

**Deliverables:**
- Download one season of Retrosheet game logs.
- Parse it into end-of-inning game-state records.
- Compute the inning × score-difference win-expectancy table.
- Print it clearly; spot-check a few cells against intuition.

**Definition of done:** the script prints a believable win-expectancy table
from real data. Sanity check: a tie in the 1st sits near 50%; a big late lead
near 100%.

**Size:** Small. The recommended first task — it validates the entire data
foundation before anything else is built on it.

## Phase 2 — The Historical Engine

**Goal:** all of history — win expectancy for any game state, any era.
**Status: complete.**

**Deliverables:**
- Ingest all available seasons of Retrosheet game logs.
- The **year-range / era toggle** as a first-class parameter of the aggregation.
- A processed data store (SQLite is the natural step up from flat files).
- Automated tests on parsing and aggregation.

**Definition of done:** the win-expectancy table for any year range — a single
season to all of history — is produced in seconds.

**Size:** Small–Medium. Keep it lean — the goal is to reach Phase 3 fast.

## Phase 3 — The Live MVP

**Goal:** the first thing a real user can touch. **The validation milestone.**

**Deliverables:**
- Wire in the **MLB Stats API** live feed — today's schedule and pitch-by-pitch
  game state.
- The **Board** (every game now, each tile led by score + win expectancy) and
  the **Game** (open one → the live win-expectancy story) — frontend on
  Cloudflare Pages, API on Cloudflare Workers, data in Supabase.
- Deployed to a public URL.
- Put in front of 5–20 real baseball fans; reactions gathered.

**Definition of done:** a stranger opens the link on a game night, sees the
slate, taps the closest game, and "gets it" without explanation — and some of
them come back tomorrow.

**Size:** Medium. **Do not skip the user feedback** — it decides Phase 4+.

## Phase 4 — The Deep Dive

**Goal:** depth — the full situational matrix.

**The data engine is already built** (ahead of Phase 3): play-by-play ingestion
via the Chadwick tooling, and the batter-vs-pitcher matchup engine — the
odds-ratio / log5 method with handedness splits, over 1910–2024.

**Deliverables:**
- ✅ Ingest the Retrosheet play-by-play event files (the Chadwick tooling).
- The **situational splits** — handedness is done; by count, base state, and
  RISP remain — and ✅ the **matchup likelihood** (the odds-ratio / log5 method).
- The **relevance engine** in full — surfacing only what matters, per moment.
- The **Deep Dive** UI — the recursive card, point and axis modes.

**Definition of done:** a user drills from a live moment into any variation —
lefty/righty, by count, by era — and never gets lost.

**Size:** Medium–Large.

### Next planned chunk: real per-pitch Win Expectancy

The current WE engine is keyed only by `(inning, half, run_diff)`. Two visible
artefacts of that limitation:

- the "100% WSH" bug we patched on 2026-05-24 — mid-half states have no
  honest answer in a half-level table
- the WE Trace chart's granularity is one point per half-inning, not one
  point per PA or pitch

The user-stated spec for the next big WE pass (deliberately deferred so it
gets its own focused session):

1. **State the table by `(inning, half, run_diff, outs, base_state, balls, strikes)`.**
   A re-aggregation of historical PBP indexed by those dimensions. ~100K cells;
   fits comfortably in JS. Honest WE at any pitch-level state.
2. **Update WE on every event that changes state.** Every pitch (count moves),
   every PA-completion (outs/bases/score), every pitching change (the
   pitcher's quality changes — needs blending with the matchup engine's
   outcome distribution for the current PA).
3. **Make the trace chart interactive.** Hover any point on the curve →
   tooltip with the inning, score, and the play that caused the WE delta.
   Auto-highlight the biggest swings (largest |Δ WE| per PA) with annotations.
4. **Account for pitcher quality, not just state.** A 95th-percentile reliever
   entering with a 1-run lead has a different WE than a replacement-level
   reliever in the same spot. The matchup engine output for the current PA
   plus the in-game state should both feed the WE.

Rough size: ~12–17 hours of focused work split across data re-aggregation,
new endpoint shape, and frontend chart interactivity. Worth its own session,
not a tack-on.

**Size:** Medium (alone) — wraps into the broader Phase 4 Deep Dive.

## Phase 5 — Production & every scale

**Goal:** the real, polished product — the engine pointed at every scale.

**Deliverables:**
- The other scales — `STANDINGS`, `LEADERS`, `MVP`, record chases — each as a
  board.
- WPA, the rarity radar, shareable moments.
- Visual design / branding; user accounts; performance, analytics, monitoring.

**Definition of done:** a product that looks and feels like something people
would pay for, or share unprompted.

**Size:** Large.

## Phase 6 — Growth & Monetization

**Goal:** turn a product into a business — see
[`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md).

**Possible deliverables:** the chosen monetization model (subscription, API,
B2B); growth loops (shareable moments, SEO across 230,000 game pages);
expansion to other sports.

**Definition of done:** measurable, repeatable growth and revenue.

**Size:** Ongoing.

## Where funding fits

A credible investor conversation (YC included) is realistic **around the end of
Phase 3 and into Phase 5** — when there is a live product, real users, and
early growth. Not before. Full reasoning in
[`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md).

## Critical advice

1. **Race to Phase 3.** Phases 1–2 should be quick. The product is unproven
   until a real user touches it.
2. **Let user feedback drive Phase 4+.** The roadmap past Phase 3 is a
   hypothesis; real reactions rewrite it.
3. **Don't stand up the product stack during Phase 1.** The engine (Phases 1–2)
   is local Python — no hosting, no database — until there is something to
   deploy.
4. **The live feed is a Phase 3 concern.** Phases 1–2 run entirely on free
   historical Retrosheet data; the MLB feed — and its licensing question — only
   matters once the live MVP is being built.
