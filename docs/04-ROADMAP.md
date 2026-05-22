# 04 — Roadmap

*Baseball-stats (working title) · Draft v2 · May 2026*

> The extended build process, Phase 0 to growth. Effort sizes are
> **planning-grade estimates** assuming roughly one focused engineer; the
> incoming senior engineer should re-estimate. Calendar dates are deliberately
> omitted — they depend on team capacity.

## Shape of the plan

```
Phase 0   Foundation                ✅ complete
Phase 1   The Engine (PoC)          ← Milestone 1 — current focus
Phase 2   The Historical Engine
Phase 3   The Live MVP  ──────────── first real users; validate the idea
Phase 4   The Deep Dive
Phase 5   Production & every scale    first investor-ready product
Phase 6   Growth & monetization
```

The most important line is **Phase 3.** Everything before it is setup;
everything after depends on what real users do. **Get to Phase 3 fast.**

## Phase 0 — Foundation ✅

**Status: complete.**
- GitHub repository created and cloned.
- Python virtual environment; folder structure, `.gitignore`, `requirements.txt`.
- The stack chosen — GitHub + Cloudflare + Supabase.
- This documentation set.

## Phase 1 — The Engine (Proof of Concept)

**Goal:** prove the core computation on real data. *(This is Milestone 1 — the
current focus.)*

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

**Goal:** depth — the full situational matrix — once Phase 3 proves people care.

**Deliverables:**
- Ingest the Retrosheet play-by-play event files (the Chadwick tooling).
- The **situational splits** — by count, base state, handedness, RISP — and the
  **matchup likelihood** (the odds-ratio / log5 method).
- The **relevance engine** in full — surfacing only what matters, per moment.
- The **Deep Dive** UI — the recursive card, point and axis modes.

**Definition of done:** a user drills from a live moment into any variation —
lefty/righty, by count, by era — and never gets lost.

**Size:** Medium–Large.

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
