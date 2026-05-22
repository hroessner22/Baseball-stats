# 04 — Roadmap

*Baseball-stats (working title) · Draft v1 · May 2026*

> The extended build process, Phase 0 to growth. Effort sizes are
> **planning-grade estimates** assuming roughly one focused engineer; the
> incoming senior engineer should re-estimate. Calendar dates are deliberately
> omitted — they depend on team capacity.

## Shape of the plan

```
Phase 0   Foundation             ✅ complete
Phase 1   The Engine (PoC)       ← recommended first task
Phase 2   Historical pipeline
Phase 3   MVP app  ───────────── first real users; validate the idea
Phase 4   Explorer + depth
Phase 5   Production platform     first investor-ready product
Phase 6   Growth & monetization
```

The most important line above is **Phase 3.** Everything before it is setup;
everything after it depends on what real users do. **Get to Phase 3 fast.**

## Phase 0 — Foundation ✅

**Status: complete.**
- GitHub repository created and cloned.
- Python virtual environment.
- Folder structure, `.gitignore`, `requirements.txt`.
- This documentation set.

## Phase 1 — The Engine (Proof of Concept)

**Goal:** prove the core computation on real data.

**Deliverables:**
- Download one season of Retrosheet game logs.
- Parse it into end-of-inning game-state records.
- Compute the inning × score-difference win-rate table.
- Print it clearly; spot-check a few cells against intuition.

**Definition of done:** the script prints a believable win-rate table from real
data. Sanity check: a tie in the 1st should sit near 50%; a big lead late
should be near 100%.

**Size:** Small. **This is the recommended first task for the senior engineer**
— it doubles as an end-to-end validation of the data source.

## Phase 2 — Historical Data Pipeline

**Goal:** turn the one-season script into an all-history dataset.

**Deliverables:**
- Ingest all available seasons.
- The **year-range toggle** as a real, first-class parameter.
- A processed data store (SQLite is the natural step up from flat files).
- Basic automated tests on parsing and aggregation.

**Definition of done:** the win-rate table can be produced for any year range —
a single season to all of history — in seconds.

**Size:** Small–Medium.

## Phase 3 — MVP App

**Goal:** the first thing a real user can touch. **The validation milestone.**

**Deliverables:**
- A Streamlit app with the **Scoreboard** (pick a season → see games) and the
  **Game View** (open a game → inning-by-inning historical win rate).
- Deployed to a public URL.
- Put in front of 5–20 real baseball fans; reactions gathered.

**Definition of done:** a stranger can open the link, pick a game, and "get it"
without explanation — and some of them want to come back.

**Size:** Medium. **Do not skip the user feedback** — it decides Phase 4+.

## Phase 4 — Stats Explorer & Model Depth

**Goal:** depth — once Phase 3 proves people care.

**Deliverables:**
- The **Stats Explorer**: the organized, interactive drill-down.
- A richer win-rate model using play-by-play data (outs, baserunners) — adopt
  the Chadwick tooling here.
- "This season vs. historical" comparison views.

**Definition of done:** a user can roam from a single stat to the games behind
it and back, without getting lost.

**Size:** Medium–Large.

## Phase 5 — Production Platform

**Goal:** the real, polished product — the MLB.com-grade vision.

**Deliverables:**
- Rebuild the frontend in Next.js/React; move data to Supabase.
- The full "everything interactive" interaction model.
- Visual design / branding; user accounts.
- Performance, analytics, error monitoring.

**Definition of done:** a product that looks and feels like something people
would pay for, or share unprompted.

**Size:** Large.

## Phase 6 — Growth & Monetization

**Goal:** turn a product into a business — see
[`05-BUSINESS-CASE.md`](05-BUSINESS-CASE.md).

**Possible deliverables:** the chosen monetization model (subscription, API,
B2B); growth loops (shareable moments, SEO across 230,000 game pages);
expansion to other sports or to live games.

**Definition of done:** measurable, repeatable growth and revenue — the
evidence an investor actually wants.

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
3. **Don't build Phase 5 infrastructure during Phase 1.** Small data, simple
   tools, until the product earns more.
