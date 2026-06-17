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

## What to watch as the sample grows
- **Moneylines:** is the 4–0 ROI real, or just chalk regressing? Track ROI and
  hit-rate vs. implied probability.
- **Props:** are the NO-under fires actually +EV, or are we paying the vig on
  coin-flips? If props stay ≤ break-even over ~150–200 bets, tighten the gate.
- **Bet sizing:** winners and losers are similarly sized (~$1.5–2). If the edge
  concentrates in a sub-group, size up there and trim the rest.
