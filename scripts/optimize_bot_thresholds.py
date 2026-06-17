#!/usr/bin/env python3
"""Derive EV-maximizing bot thresholds from the realized bet record.

The bot's gates/buffers should be set by data, not by hand. This script pulls
every settled fire from Supabase `bot_fires` and computes the value of each
tunable that MAXIMIZES realized EV (total profit) on the bets we actually made.

What it can and cannot do (be honest about this):
  * It can only evaluate TIGHTENING a gate — filter the bets we made by a
    candidate threshold and re-sum the realized P&L. It cannot evaluate
    LOOSENING (we have no outcomes for bets the gate skipped). So every sweep
    reports the EV-max value at-or-above the current gate.
  * Small samples overfit. Each recommendation carries n and a Wilson 95% CI on
    the win rate; we only recommend a change when n is meaningful AND the CI
    clears break-even.

Levers:
  1. Per (kind, stat, side) EV — keep / flag each pocket.
  2. Model-edge band  (edge_pp) — EV-max [floor, ceiling], per side.
  3. Empirical buffer (emp_p − price) — EV-max margin per stat, once `emp_p`
     has been logged on enough fires (added 2026-06-17).

Run:
  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python3 scripts/optimize_bot_thresholds.py

Output: a human summary + a JSON block of recommended thresholds on stdout.
"""
import json
import math
import os
import sys
import urllib.parse
import urllib.request

PROJECT_TABLE = "bot_fires"


def _env(*names):
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return None


def fetch_settled_fires():
    base = _env("SUPABASE_URL")
    key = _env("SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY")
    if not base or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.")
    cols = ("kind,stat,side,threshold,contracts,price_cents,our_p,market_p,"
            "edge_pp,emp_p,settled,won,profit_cents")
    rows, offset, page = [], 0, 1000
    while True:
        q = urllib.parse.urlencode({"select": cols, "settled": "eq.true",
                                    "limit": page, "offset": offset})
        url = f"{base}/rest/v1/{PROJECT_TABLE}?{q}"
        req = urllib.request.Request(url, headers={
            "apikey": key, "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            batch = json.load(r)
        rows.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return rows


def wilson(wins, n, z=1.96):
    """95% Wilson interval for a proportion — robust at small n."""
    if n == 0:
        return (0.0, 1.0)
    p = wins / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = (z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d
    return (c - h, c + h)


def ev(rows):
    n = len(rows)
    if n == 0:
        return dict(n=0, wins=0, roi=None, net=0, lo=None, hi=None)
    wins = sum(1 for r in rows if r["won"])
    net = sum(r["profit_cents"] or 0 for r in rows)
    staked = sum((r["contracts"] or 1) * (r["price_cents"] or 0) for r in rows)
    lo, hi = wilson(wins, n)
    return dict(n=n, wins=wins, net=net,
                roi=(100.0 * net / staked) if staked else None,
                # CI on ROI is hard; report CI on win rate as the confidence proxy.
                win_lo=round(100 * lo, 1), win_hi=round(100 * hi, 1),
                win=round(100 * wins / n, 1))


def by_key(rows, keyfn):
    out = {}
    for r in rows:
        out.setdefault(keyfn(r), []).append(r)
    return out


def sweep_edge(rows, lo=0, hi=25):
    """EV-max [floor, ceiling] on model edge_pp (tightening only)."""
    pts = [r for r in rows if r.get("edge_pp") is not None]
    best = None
    floors = [x / 2 for x in range(lo * 2, hi * 2)]
    for f in floors:
        for c in [x / 2 for x in range(int(f * 2), hi * 2 + 1)]:
            band = [r for r in pts if f <= r["edge_pp"] <= c]
            if len(band) < 20:        # don't trust a band thinner than 20 bets
                continue
            e = ev(band)
            score = e["net"]          # maximize realized profit
            if best is None or score > best[0]:
                best = (score, f, c, e)
    return None if best is None else dict(floor=best[1], ceiling=best[2], **best[3])


def sweep_empirical_buffer(rows):
    """EV-max margin (emp_p − price) per stat, using LOGGED emp_p only."""
    pts = [r for r in rows
           if r.get("emp_p") is not None and r.get("price_cents") is not None]
    if len(pts) < 30:
        return {"_note": f"only {len(pts)} fires carry emp_p — need more logged "
                         "fires before the empirical buffer can be optimized"}
    out = {}
    for stat, grp in by_key(pts, lambda r: r.get("stat") or "(ml)").items():
        best = None
        for b in [x / 100 for x in range(0, 26)]:   # 0..25pp buffer
            kept = []
            for r in grp:
                side_price = (r["price_cents"] or 0) / 100.0
                emp_edge = r["emp_p"] - side_price
                if emp_edge >= b:
                    kept.append(r)
            if len(kept) < 15:
                continue
            e = ev(kept)
            if best is None or e["net"] > best[0]:
                best = (e["net"], b, e)
        if best:
            out[stat] = dict(buffer_pp=round(best[1] * 100), **best[2])
    return out


def main():
    rows = fetch_settled_fires()
    print(f"# Bot threshold optimizer — {len(rows)} settled fires\n")
    print("## Overall");  print(json.dumps(ev(rows), indent=0)); print()

    print("## Per kind × stat × side (EV pockets)")
    pockets = by_key(rows, lambda r: f"{r['kind']}|{r.get('stat') or '-'}|{r['side']}")
    rec = {}
    for k in sorted(pockets, key=lambda k: -(ev(pockets[k])["net"])):
        e = ev(pockets[k])
        # Recommend: KEEP if win-rate CI clears break-even AND profitable;
        # FLAG if clearly negative with enough sample; else WATCH (small n).
        verdict = "watch"
        if e["n"] >= 20 and e["net"] > 0 and e["win_lo"] > 0:
            verdict = "keep"
        elif e["n"] >= 20 and e["net"] < 0 and e["roi"] is not None and e["roi"] < -10:
            verdict = "flag"
        rec[k] = verdict
        print(f"  {k:38s} n={e['n']:3d} win={e['win']:5.1f}% "
              f"CI[{e['win_lo']:.0f},{e['win_hi']:.0f}] roi={e['roi']} net={e['net']} -> {verdict}")
    print()

    print("## EV-max model-edge band (per side, tightening only)")
    edge_rec = {}
    for side in ("yes", "no"):
        s = sweep_edge([r for r in rows if r["side"] == side])
        edge_rec[side] = s
        print(f"  {side}: {s}")
    print()

    print("## EV-max empirical buffer (per stat, from logged emp_p)")
    emp_rec = sweep_empirical_buffer(rows)
    print(json.dumps(emp_rec, indent=2)); print()

    print("## RECOMMENDATIONS (apply by hand after review — never auto-tune)")
    print(json.dumps({"pockets": rec, "edge_band": edge_rec,
                      "empirical_buffer": emp_rec}, indent=2, default=str))


if __name__ == "__main__":
    main()
