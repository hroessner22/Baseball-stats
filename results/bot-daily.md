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

## What to watch as the sample grows
- **Moneylines:** is the 4–0 ROI real, or just chalk regressing? Track ROI and
  hit-rate vs. implied probability.
- **Props:** are the NO-under fires actually +EV, or are we paying the vig on
  coin-flips? If props stay ≤ break-even over ~150–200 bets, tighten the gate.
- **Bet sizing:** winners and losers are similarly sized (~$1.5–2). If the edge
  concentrates in a sub-group, size up there and trim the rest.
