# 08 — Model Improvement Plan

*DIAMOND:CONTEXT · Drafted 2026-05-25 after a 24-PR engineering session*

> Forward-looking plan for making the WE / matchup engine **better, more
> accurate, clearer**. This is the engine-side counterpart to
> [`04-ROADMAP.md`](04-ROADMAP.md) which sets the product-level phases.
> Owned by the engine work; revisit after each phase.

## Where we are right now

As of end-of-day 2026-05-25, the engine has shipped (in order):

1. **State-WE table v2** — 15M historical PAs keyed by (inning, half,
   outs, bases, score). The baseline.
2. **Count-aware matchup engine** — per-pitch outcome predictions using
   Statcast 2020-24 by-count rates.
3. **Daily PA × 10× recency weighting** — current-season data dominates
   the input vs 5-year-old career. Calibration-selected from a sweep
   (PR #70).
4. **Bullpen-aware EOG forecast** — Monte Carlo (N=200, deterministic
   seeding from state) walking the rest of the game with the actual
   lineup + predicted reliever sequence.
5. **Team-strength adjustment** — pre-game baseline shifted by
   `0.54 + (home_combined − away_combined) × 0.20` where combined is
   25% season + 25% Pythagorean + 30% L30 + 20% L10.
6. **Per-PA WE trace** with pitch-by-pitch hover tooltips.
7. **WPA leaderboard** — season-aggregate of per-PA WE deltas, refreshed
   nightly.
8. **Player Tonight projection** — surfaces expected hits / HR / BB / K
   using matchup engine × lineup-spot PA estimate.
9. **Multi-variant calibration tracking** — measures per-PA outcome
   accuracy across naive / v1 / v2 / v3 / v4 variants. Live in footer.

Production variant: `v4_daily_10x`. Top-1 accuracy 46.18%, Brier 0.694
on 202,101 PAs.

What we have NOT yet measured: whether the engine's **game-level WE
predictions** are well-calibrated. That's Phase 1 below — and it's the
prerequisite for honest tuning of everything else.

---

## Phase 1 — Measure what we already have

**Goal:** Establish ground truth for whether our WE actually predicts
game outcomes correctly. Without this, every tuning decision below is
guesswork.

**Build:**
- **Game-level calibration loop** (Python, nightly cron). For every
  completed game in `daily_pa` history, record our predicted WE at
  meaningful checkpoints (first pitch / end of 3rd / end of 6th /
  start of 9th), compare to actual game outcome.
- **`model_metrics_game` Supabase table** with columns:
  `(game_pk, checkpoint, variant, predicted_we, actual_home_won,
   computed_at)`.
- **Per-checkpoint Brier score + reliability diagram** rolled up by
  variant. Reliability diagram answers "of all games where we predicted
  70% home win at end-of-6th, did 70% of them actually win?"
- Display on the About page as a calibration history chart. Real
  receipts — nobody public publishes this.

**Why first:** Everything in Phase 2 (tuning the knobs) needs an
objective judge. Every decision in Phase 3 (adding layers) needs a way
to prove the layer earned its keep. The literature's claims about
team-quality adjustment / recency weighting are SUPPORTED by aggregate
research but not VERIFIED for our specific data + implementation.

**Effort:** 4-6 hours for v1 (table + script + chart). 1-2 sessions.

**Outcome:** Honest assessment of every layer we shipped today. The
calibration footer extends from "per-PA accuracy" to also showing
"game-level WE accuracy" with the comparison curve.

---

## Phase 2 — Tune what we have, with calibration as judge

**Goal:** With Phase 1's measurement in place, sweep tunable parameters
and ship the configuration that minimizes game-level Brier.

**Parameters to sweep:**

| Knob | Current value | Sweep range |
|---|---|---|
| `DAILY_PA_WEIGHT` (matchup.js) | 10× | 5, 10, 15, 20, 30 |
| Team strength weights (season/Pyth/L30/L10) | 25/25/30/20 | grid-search reasonable splits |
| `STRENGTH_SCALAR` | 0.20 | 0.10, 0.15, 0.20, 0.25, 0.30 |
| `ADJUSTMENT_CAP_PP` | ±15pp | ±10, ±15, ±20, uncapped |
| Per-year sub-weighting within daily_pa | none (all equal) | 2026 × 2, 2026 × 3 |
| `MIN_COUNT_SAMPLE` | 30 | 15, 30, 60 |
| `REGRESSION_PA` (league regression) | 100 | 50, 100, 150, 200 |

**Method:** For each parameter, add a calibration variant in
`src/calibration.py` (variants v6_*, v7_*, ...). Run the nightly cron
on the variant. Compare Brier vs production. Ship the winner.

**Why:** These are real knobs that affect accuracy. Tuning by intuition
is guessing. Tuning by calibration is engineering. We did this once for
DAILY_PA_WEIGHT (PR #70) — the same discipline applied to the rest of
the engine.

**Effort:** 6-10 hours across 2-3 sessions (each sweep = code, deploy,
calibration run, analyze, ship-or-skip).

**Outcome:** Each tuning decision is backed by receipts. The variant
tooltip in the footer grows to v5, v6, v7 with each gain plotted.

---

## Phase 3 — Close known accuracy gaps

**Goal:** Add the layers we knowingly don't have but the research
(and our own audit) flagged as worth pursuing. Run each through
Phase 1's calibration before merging — if it doesn't help, don't ship.

### 3a — Two-team modeling in bullpen forecast (5-8 hours)
Currently `we-forward.js` simulates only ONE team's pitchers/lineup
through the rest of the game. When the half flips, opposing team's PAs
use league baseline. Modeling both halves doubles precompute (~50
matchup queries vs ~25) but makes the forecast symmetric and honest.
Closes the one ⚠ flagged in the engine audit.

### 3b — Per-manager pull tendencies (6-10 hours)
Currently league-average pull rule (pitch count > 95 OR inning ≥ 7).
Real managers differ wildly — Boone (quick hook) vs Bochy (slow hook)
diverge meaningfully. Train a logistic regression from PBP per manager:
given `(pitch_count, score_state, TTO, inning, leverage)`, what's the
probability of pull? Apply to forecast simulation.

### 3c — Park factors (6-8 hours)
Coors +28% runs, Petco -7%, Yankee Stadium +5% HR. Apply per-outcome
multipliers to the matchup engine's distribution based on the venue
ID. Real signal currently missing entirely from the engine. Easy to
test — apply to one stadium pair (Coors vs Petco), measure.

### 3d — Weather adjustment (4-6 hours)
Wind out 15+ mph adds ~6% HR rate. Cold air takes ~16 ft off fly
balls. Pull from Visual Crossing API. Adjust HR / 2B / 3B probabilities
in the matchup output per game's forecast. Modest impact except in
extreme weather, but tangible in those cases.

### 3e — Pitcher fatigue / TTO penalty (4-6 hours)
wOBA-against rises ~10-30 points by 3rd time through the order. Mostly
captured implicitly by the pitch-count pull rule but worth modeling
the per-PA adjustment explicitly: if `pitcher_pa_count > 18`, multiply
hit-rate factors by 1.07.

### 3f — Closer / setup man identification (3-5 hours)
Currently uses "last in bullpen list" heuristic (~85% right per audit).
Pull season saves leader + recent 8th-inning usage from MLB stats.
More accurate forecast pitcher sequence → more accurate forecast WE.

**Why:** Each layer is independently shippable. Each can be measured
against Phase 1's calibration BEFORE merging. We don't have to ship
all of them — only the ones that demonstrably help.

**Effort:** 25-40 hours total. 1-2 weeks of focused work.

**Outcome:** Engine becomes meaningfully more accurate in specific
situations: ARI-COL at Coors looks materially different from ARI-COL
at OAK. Late-game starter projections capture fatigue. Closer
identification is right.

---

## Phase 4 — Make the engine FEEL alive (1 week)

**Goal:** Accuracy is necessary but not sufficient. Real users need
to feel the engine pulse — to come BACK to the product because something
keeps happening on it.

### 4a — Big-swing notifications (4-6 hours)
When a live PA shifts WE > 12pp, surface a notification. Browser push
for opted-in users. In-app red badge on the Board tab. The fan-product
hook — "your phone just buzzed because Judge hit a walk-off."

### 4b — Hot Moments tab (5-8 hours)
New top-nav view showing only games where something big is happening
RIGHT NOW. Filtered by leverage index. "Bottom 9, bases loaded, walk-
off opportunity." "0-0 in the 11th, ghost runner advanced to 3rd."
Users come here when they don't know what game to watch.

### 4c — Calibration history chart (3-4 hours)
Line chart on the About page showing our Brier over time per variant.
Visualizes Phase 1's measurement. Receipts in chart form. Genuinely
novel — no public WE engine publishes calibration history.

### 4d — Mobile review (4-6 hours)
Test every view on a phone. Likely needs spacing/font fixes. The
product is read on a couch with a phone in hand more than a desk
with a monitor. Probably the single biggest UX gap right now.

### 4e — Player Tonight on the Board (3-4 hours)
For star players in tonight's games, surface mini-projection on their
team's game tile. "Judge tonight: 1.2 H projected, on 6-game hit
streak." Brings the Player Tonight feature (PR #71) to the entry
surface instead of being buried in player profiles.

**Why:** A measurably accurate engine that's hard to use loses to a
less-accurate engine that feels great. After Phases 1-3 the math is
ironclad; Phase 4 makes the product worth opening.

**Effort:** 20-30 hours.

**Outcome:** The product becomes something fans WANT to open during
games. Not just a stat lookup.

---

## Phase 5 — Show it to the world (ongoing, parallel to others)

**Goal:** Non-engineering moves that probably have the highest impact
of anything in this document.

### 5a — User testing (THIS WEEKEND)
Send the URL to 3 baseball-watching friends. Watch their reactions
during games. Note what confuses them. What surprises them. What they
screenshot to text someone. **This single act redirects the next month
of engineering more than any of the items above.**

### 5b — Methodology blog post (4-6 hours)
1500-2000 words explaining the engine, the layer stack, the receipts.
Submit to r/sabermetrics. Tweet at Tom Tango, Russell Carleton,
Mitchel Lichtman. They'll engage if it's novel — and this is novel:
count-aware predictions × recency-weighted matchup × team-strength
adjustment × bullpen-aware Monte Carlo × per-pitch UX, all measured,
all published with calibration receipts.

### 5c — API access (8-16 hours)
Open the matchup engine + WE forecast as a paid developer API.
Sabermetric Twitter, fantasy sites, prop-bet content creators are
the audience.

### 5d — Documentation (3-5 hours)
Write `docs/09-ENGINE.md` explaining each layer, each variant, the
calibration story. Both for project handoff and for visitors evaluating
"is this serious?"

### 5e — Pricing experiment (variable)
Ask: would someone pay $5/mo for the per-pitch projected WE on every
live game? Build a paywall on one feature, see what happens.

**Why:** Engineering further has diminishing returns. Real users
redirect engineering effort. Public attention attracts collaborators.

**Effort:** Sporadic, weeks-to-months.

---

## What we deliberately do NOT prioritize

Things that sound appealing but the research / our analysis don't
support spending time on (yet):

- **Catcher framing adjustment** — 0.125 runs/strike framed; real in
  aggregate but very noisy per-pitch and adds complexity without
  proportional accuracy.
- **Per-umpire zone modeling** — same: real in aggregate, too noisy
  per-PA, will erode user trust when users see calls labeled "this
  ump favors away team."
- **Base-running player customization** — the Nov 2025 academic paper
  ([arxiv 2511.17733](https://arxiv.org/pdf/2511.17733)) explicitly
  found "virtually no impact" on WE despite log-loss gains. Skip.
- **Per-pitch WE table v3** — the compositional approach
  (matchup × post-state) gets us 95% of the value without the data
  re-aggregation cost.
- **Adding more historical data** — we're at the data-quality /
  model-form ceiling for the matchup-engine approach; more data
  won't move it.

---

## The single most important thing in this document

**Phase 1 (game-level calibration) is the prerequisite for everything
else here.** Every variant decision, every tuning sweep, every
"should we keep this layer?" question gets answered by measuring
against game outcomes.

Right now the team-strength adjustment (PR #72) is shipping on
intuition + literature support, not on measured proof for our
specific data. The recency-weight schedule (PR #70) was the only
thing we tuned by measurement so far, and it produced a real gain.
The same discipline applied to the rest of the engine is the
single highest-leverage move available.

**Phase 1 first. Everything else flows from it.**

---

## Phase tracking

Update this section as phases ship.

- [ ] **Phase 1** — Game-level calibration (started: ____, shipped: ____)
- [ ] **Phase 2** — Parameter sweep with calibration as judge
- [ ] **Phase 3a** — Two-team bullpen forecast
- [ ] **Phase 3b** — Per-manager pull tendencies
- [ ] **Phase 3c** — Park factors
- [ ] **Phase 3d** — Weather adjustment
- [ ] **Phase 3e** — Pitcher fatigue / TTO penalty
- [ ] **Phase 3f** — Closer / setup man identification
- [ ] **Phase 4a** — Big-swing notifications
- [ ] **Phase 4b** — Hot Moments tab
- [ ] **Phase 4c** — Calibration history chart
- [ ] **Phase 4d** — Mobile review
- [ ] **Phase 4e** — Player Tonight on Board
- [ ] **Phase 5a** — Send to 3 friends (ongoing)
- [ ] **Phase 5b** — Methodology blog post
- [ ] **Phase 5c** — API access
- [ ] **Phase 5d** — Engine documentation (`docs/09-ENGINE.md`)
- [ ] **Phase 5e** — Pricing experiment
