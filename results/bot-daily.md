# Bot daily results ledger

A running, hand-kept log of the bot's settled bets, by day. The point is to
build a real sample before changing any gates — one day is noise. We split
**moneyline** vs **player props** because they behave differently and we want to
know which is actually carrying the P&L over time.

Rosters/teams come from the live MLB Stats API, so player→team mapping is always
current (e.g. Bichette & Semien are Mets in 2026 — that's correct, not a bug).

## Summary table

| Date | Bets | Settled | Net | Moneyline (rec · P&L) | Props (rec · P&L) | Notes |
|------|------|---------|-----|-----------------------|-------------------|-------|
| 2026-06-16 | 29 | 16–13 | +$0.85 | 4–0 · +$1.49 | 12–13 · −$0.64 | Day saved by 2 longshot YES props (Arias +$4.20, Díaz +$2.08); strip those → red. Props ~coin-flips (NO unders @ ~48–52¢). |

## Per-day detail

### 2026-06-16 — 11 games, 29 bets, 16–13, +$0.85

**Moneylines (4–0, +$1.49):** COL +$0.36 · STL +$0.50 · MIL +$0.12 · WSH +$0.51
— all YES on favorites. Small per-bet profit (chalk), ~23% ROI on ~$6.53 staked.

**Player props (12–13, −$0.64):**
- Biggest winners: Gabriel Arias YES +$4.20 · Spencer Steer NO +$2.08 · Elias Díaz 1+ hit YES +$2.08 · Josh Smith 2+ NO +$1.26 · Wyatt Langford NO +$1.23 · Samad Taylor 2+ NO +$1.20 · Matt McLain 1+ NO +$1.20 · Jazz Chisholm NO +$1.02
- Biggest losers: Seiya Suzuki 1+ NO −$1.92 · Francisco Álvarez NO −$1.86 · Logan O'Hoppe NO −$1.80 · Jesús Luzardo NO −$1.77 · Foster Griffin 6+ NO −$1.74 · Freddie Freeman NO −$1.59 · Zach Neto 2+ NO −$1.56 · Bo Bichette 2+ NO −$1.53

**Best game:** MIN@TEX 3–0 +$4.57.  **Worst:** LAA@ARI 0–2 −$3.36, COL@CHC 2–3 −$3.15.

**Read:** moneyline model (pitcher-aware rebuild) is the edge so far; props are
break-even/variance. No gate changes on this sample — keep logging.

## Patterns through 2026-06-17 (n = 205 settled, ~2 weeks)

**Tiny sample — 205 bets vs the 115-year engine. Treat everything below as a
hypothesis to keep testing, not a proven law.** That said, the cuts are
internally consistent and point the same way.

**Top line:** 101–104 (49.3%), **+$1.56, +0.5% ROI** — dead break-even overall.
But the average hides a clear shape: a couple of pockets carry it, several bleed.

### Where the money is made
| Cut | n | Win% | ROI | Net |
|-----|---|------|-----|-----|
| **total_bases YES (mostly 2+)** | 30 | 63% | **+89%** | **+$35.70** |
| — total_bases YES **2+** alone | 25 | **72%** | — | +$36.30 (18/25 hit — broad) |
| strikeouts **NO** (K unders) | 19 | 68% | +22% | +$7.09 |
| hits YES (small n) | 7 | 71% | +68% | +$6.77 |
| our_p 40–60% (moderate confidence) | 76 | ~52% | **+10–13%** | — |
| edge 5–10pp (moderate edge) | 46 | 44% | **+37%** | +$22.16 |

### Where it leaks
| Cut | n | Win% | ROI | Net |
|-----|---|------|-----|-----|
| **strikeouts YES** (pitcher-K overs) | 29 | **14%** | **−42%** | −$16.52 |
| **home_runs YES** (HR overs) | 13 | 23% | **−70%** | −$9.03 |
| **moneylines** | 16 | 50% | **−35%** | −$9.52 |
| our_p 60–70% (high confidence) | 37 | 51% | −15% | — |
| edge 10–20pp (the bulk of volume) | 134 | 50% | −7.5% | −$16.53 |

### The three real findings
1. **total_bases YES 2+ is the engine.** Strip it and the whole book is deeply
   red. The model is genuinely good at "this hitter gets 2+ total bases."
2. **Rare-event *overs* are a systematic leak** — betting YES on pitcher
   strikeouts (14% win) and home runs (23% win). We overpay for longshots that
   don't hit. The *unders* are fine (strikeouts NO +22%).
3. **The model's own confidence is inverted at the top.** It's well-calibrated
   and *profitable* in the middle (our_p 40–60%, edge 5–10pp), but its
   **high-conviction picks lose** — our_p 60–70% says 66% / only 51% hit (−15%),
   and the big "edge" bets (10–20pp, most of our volume) run −7.5%. Large claimed
   edges are mostly model error, not market mispricing. Classic overconfidence /
   favorite-longshot signature.

### Moneylines: my earlier read was wrong
6/16's 4–0 was noise. Over the full sample MLs are **−35% ROI**. Not an edge.

### If forced to act on this (don't yet — keep gathering):
- Lean into **total_bases 2+ YES**; keep **K unders**.
- Stop firing **K overs, HR overs, and moneylines** — those are the clearest leaks.
- Distrust the model's **biggest-edge / highest-our_p** signals; the middle is the edge.
- Re-check every ~100 settled bets; only harden gates when a pocket holds across 2–3 re-checks.

## Changes made 2026-06-17 (root-cause fixes, not amputations)

Diagnosed each leak against the data before touching code. Key finding: the
"fake huge edge" wasn't the override — it was **one broken projection**.

1. **Huge-edge override: KEPT, root cause fixed.** Cut the huge-edge bets by
   stat: total_bases YES (our_p 36% → actual 70%, +63%), HR YES (16% → 75%,
   +12%), K NO (68% → 67%, +19%) all WON. The *only* huge-edge loser was
   **strikeouts YES: our_p 47% → actual 0/8, −86%.** The override is fine; the
   strikeout-OVER projection was manufacturing fake edges it then sized up on.
2. **Strikeouts: data-backed gate, no made-up numbers.** First correction:
   `k_prop_yes_min_ratio` (which I briefly set to 1.15) is **not even read** by
   the firing logic — the real K gate is the **Retrosheet conditional table**
   (`kprop_conditional`, with sample sizes). Reverted that dead knob. The actual
   fix, all grounded in data:
   - **Probability = the historical rate only** (the conditional table), never
     the model projection.
   - **No historical data for the state → no bet** (was: fall back to the model
     projection and fire anyway — the source of the fake K-YES edges).
   - **Cell must be a valid sample** (textbook n·p≥10 & n·(1-p)≥10) or no bet.
   - **Margin over market = 5pp**, and that 5pp is itself backed by our results:
     edges <5pp ran −54% ROI, 5–10pp +37%. (Not the "1 SE" idea I floated — at
     these huge n's, 1 SE is ~0.4pp, which would *loosen* the gate; SE of a
     base-rate estimate isn't a betting margin.)
   K-NO stays (calibrated 68%). This also removes K-YES from the huge-edge pool,
   fixing #1 at the source.
3. **Home runs: unchanged — they're +EV.** All HR-YES were long odds (avg 10¢);
   the huge-edge ones hit 75% (+12%). "1/5 at +500 wins." Kept firing.
4. **Moneylines: fixed the cash-out leak.** The ML logic already holds to
   settlement and only sells when the market overpays live WE — BUT when the WE
   lookup returned null it **fell through to the generic profit-take and cashed
   winners out early.** Now: WE unavailable → hold to settlement (losers are the
   daily-loss limit's job). No more cashing out a winning ML when we're up.

**Still open (principled, needs the historical engine, not 205 bets):** recalibrate
the *entry* `our_p` for K/HR overs against the empirical Retrosheet probabilities
(`getEmpiricalKpropPYes` etc. already power the cash-out vetoes — wire them into
entry too) so "nothing is random." Staged for when the sample backs the per-stat
calibration.

## EV-maximizing the buffers (2026-06-17, later) — sizing is the real lever

User: "the buffers should maximize EV." The honest finding is that the single
biggest EV lever wasn't an entry buffer at all — it was **bet sizing**.

**Sizing now runs half-Kelly on the EMPIRICAL (Retrosheet) probability, not the
model.** Kelly is the growth/EV-optimal sizing criterion, but it was being fed
the overconfident model projection — so it sized *up* on the mirage edges (the
exact mechanism behind the huge-edge losses). Now, when a prop has a historical
rate (K via `kprop_conditional`; hits/HR/TB via `hitter_quality_by_season_avg`),
the bet is sized half-Kelly on **that** number. Same bets still fire; we just
stop overbetting spots history doesn't support. Self-correcting for HR exactly
as asked: long-odds HR where history beats the cheap market get sized up;
fairly-priced HR shrink toward zero. (Half-Kelly is the standard fractional-Kelly
hedge against estimation error — a documented choice, not a tuned constant.
Moneylines already size on the empirical WE table.)

**Buffers that remain, and their honest status:**
- **Entry edge buffer = 5pp** over the historical rate. Backed by our own
  results (edges <5pp ran −54% ROI, 5–10pp +37%). It's a risk buffer over a
  DATA-DERIVED probability, not a guessed probability.
- The truly EV-optimal buffer per pocket can't be derived from 205 noisy bets,
  and the empirical edge wasn't even logged. So: **`emp_p` is now logged on
  every fire**, and **`scripts/optimize_bot_thresholds.py`** pulls `bot_fires`
  and computes the EV-maximizing band/buffer per pocket (Wilson CIs, ≥20-bet
  guard, tightening-only since we can't score skipped bets). Re-run it as the
  sample grows; it prints recommendations to apply by hand (never auto-tuned).

**So:** probabilities come from 115 years of data; **sizing is EV-optimal
(half-Kelly on those probabilities)**; the one entry buffer is results-backed;
and the rest is now instrumented + has a reproducible optimizer instead of being
hand-set. No number in the firing/sizing path is a feel-based guess anymore.

## Data-backing the prop entry — and a bug the verification caught (2026-06-17)

Goal was to make prop ENTRY fire on the historical rate, not the model. Before
touching it I checked whether that would hurt `total_bases YES` (the one proven
winner). It would have — and it revealed a latent bug in the just-shipped sizing
change too.

**The finding (total_bases YES by market price):**
| market price | n | win% | net |
|---|---|---|---|
| ≤15¢ (deep value) | 8 | 88% | +$5.04 |
| >25¢ (avg 34¢) | 16 | **69%** | **+$32.07** |

The big winner is the **>25¢** bucket: the market said ~34%, they hit **69%**,
and the coarse AVG-bucket empirical says only **~30% — below the market.** The
AVG bucket is **contact-based and can't see power**, so it badly under-estimates
total bases / home runs. The MODEL captures power; the empirical doesn't.

**Consequences:**
1. Naively switching the YES entry to the empirical would **kill total_bases YES.**
2. **My pushed Kelly-on-empirical sizing had the same bug** — it sized TB YES on
   the empirical (~0.30), which is *below* the 34¢ market, so Kelly returned 0 →
   it would have **skipped the best pocket** once the app reloaded. Caught before
   it ever fired live.

**Fix — stat-aware probability source (data-backed):**
- **Contact stats (hits, strikeouts) → empirical** (reliable; K-NO calibrated,
  AVG predicts hits). Size on the historical rate.
- **Power stats (total_bases, home_runs) → model** (the empirical can't see
  power). `empPSide` left null → sizing falls back to the model. TB/HR YES
  preserved.

So "data-back the entry" turned out to be **stat-specific**, not a blanket swap.
The model and the empirical are each the better signal for different stats, and
the bot now routes to the right one per pocket for sizing.

## Moneyline scope (2026-06-17) — no rebuild needed, the fix is already deployed

Diagnosed before building. The WE model isn't broken:

| WE bucket | n | WE says | actual | avg contracts | ROI |
|---|---|---|---|---|---|
| **Favorites (≥60%)** | 7 | 71% | **86%** | 2.7 | **+23%** |
| Underdogs (<50%) | 10 | 43% | **30%** | **4.8** | **−57%** |

Same disease as the props: the model is fine on the high-probability side
(favorites — it even *under*-predicts), and the whole loss is **betting
underdogs**, where the WE over-predicts AND Kelly sizes them *bigger* (cheap
prices → more contracts). The −35% overall is entirely the underdog bucket.

**But the fix already exists and is deployed:** `checkAndMaybeFire` has a
LARGE-MARGIN GATE (added 06-16) requiring `our_p ≥ 0.5 + ml_confident_margin`
(= **WE ≥ 0.60**), citing a 3,201-game calibration (≥10pp margin ~63%, ≥15pp
~70%). Verified it's the **only** ML fire path (single call site, no bypass), so
every fire must be a confident favorite. Every 06-17 fire is ≥0.60; the losing
underdogs are all 06-15/06-16 — **pre-gate old code still running on the app.**
So the underdog bleed is already closed in code; it just needs the reload.

**One genuine, deferred improvement:** the WE *under*-predicts favorites
(71%→86%) — conservative, so we leave EV on the table and may miss some favorite
fires. Recalibrating the WE up would capture more, but 7 favorite bets is too few
— revisit once the sample grows.

## What to watch as the sample grows
- **Moneylines:** is the 4–0 ROI real, or just chalk regressing? Track ROI and
  hit-rate vs. implied probability.
- **Props:** are the NO-under fires actually +EV, or are we paying the vig on
  coin-flips? If props stay ≤ break-even over ~150–200 bets, tighten the gate.
- **Bet sizing:** winners and losers are similarly sized (~$1.5–2). If the edge
  concentrates in a sub-group, size up there and trim the rest.
