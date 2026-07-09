#!/usr/bin/env python3
"""Is the bot's edge real yet? — a repeatable significance test.

Pulls every settled fire from Supabase `bot_fires`, deduplicates by ticker,
EXCLUDES the Jun 1-2 malfunction era (tagged first_run_recovered), and asks a
single honest question per pocket: *is the realized P&L distinguishable from
zero?* via a one-sample t-test on per-bet profit.

Read the t-stat like this:
    |t| >= 2.0  -> statistically real (~95% confidence)
    |t| <  2.0  -> noise / not yet proven (break-even)

Run it every week or two. The green light to scale (server-side / real money)
is: the OVERALL t-stat turns reliably positive AND total_bases-YES holds its
edge past ~60-80 bets. Until then the honest status is "well-founded, not yet
proven."

Usage:
    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python3 scripts/validate_edge.py

Baseline (2026-07-09, n=280 model-era): ALL t=-0.24 (break-even);
total_bases-YES t=+2.26 (the one real edge); home_runs-YES t=-2.28 and
strikeouts-YES t=-1.95 (real losers, already gated).
"""
import math
import os
import sys
import urllib.parse
import urllib.request

PROJECT_TABLE = "bot_fires"
MALFUNCTION_TAG = "first_run_recovered"


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
    cols = ("kind,stat,side,ticker,placed_at,contracts,price_cents,"
            "settled,won,profit_cents,reasoning")
    rows, offset, page = [], 0, 1000
    while True:
        q = urllib.parse.urlencode({"select": cols, "settled": "eq.true",
                                    "limit": page, "offset": offset})
        url = f"{base}/rest/v1/{PROJECT_TABLE}?{q}"
        req = urllib.request.Request(url, headers={
            "apikey": key, "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            import json
            batch = json.load(r)
        rows.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return rows


def source_tag(row):
    r = row.get("reasoning")
    return str((r or {}).get("source", "")) if isinstance(r, dict) else ""


def dedup_by_ticker(rows):
    """One row per ticker: keep the earliest by placed_at (matches the
    ledger's dedup rule). Rows without a ticker are all kept."""
    best = {}
    passthrough = []
    for r in rows:
        t = r.get("ticker")
        if not t:
            passthrough.append(r)
            continue
        cur = best.get(t)
        if cur is None or (r.get("placed_at") or "") < (cur.get("placed_at") or ""):
            best[t] = r
    return list(best.values()) + passthrough


def tstat(vals):
    n = len(vals)
    if n < 2:
        return (n, sum(vals), 0.0)
    mean = sum(vals) / n
    var = sum((x - mean) ** 2 for x in vals) / (n - 1)
    sd = math.sqrt(var)
    se = sd / math.sqrt(n)
    t = mean / se if se > 0 else 0.0
    return (n, mean, t)


def main():
    rows = fetch_settled_fires()
    rows = dedup_by_ticker(rows)
    model = [r for r in rows if not source_tag(r).startswith(MALFUNCTION_TAG)]
    dropped = len(rows) - len(model)
    if dropped:
        print(f"# excluded {dropped} malfunction-era fires\n")

    pockets = {}
    for r in model:
        stat = r.get("stat") or "moneyline"
        pocket = f"{stat} {r.get('side')}"
        pockets.setdefault(pocket, []).append(float(r.get("profit_cents") or 0))

    print(f"# Edge validation — {len(model)} settled model-era bets\n")
    print(f"{'pocket':<18}{'n':>5}{'net$':>10}{'mean¢':>9}{'t-stat':>9}  verdict")
    print("-" * 66)
    order = sorted(pockets.items(), key=lambda kv: tstat(kv[1])[2], reverse=True)
    for pocket, vals in order:
        n, mean, t = tstat(vals)
        net = sum(vals) / 100.0
        if t >= 2.0:
            v = "REAL winning edge"
        elif t <= -2.0:
            v = "REAL loser (gate it)"
        else:
            v = "noise / break-even"
        print(f"{pocket:<18}{n:>5}{net:>10.2f}{mean:>9.1f}{t:>9.2f}  {v}")

    allv = [x for vals in pockets.values() for x in vals]
    n, mean, t = tstat(allv)
    print("-" * 66)
    print(f"{'ALL MODEL-ERA':<18}{n:>5}{sum(allv)/100.0:>10.2f}{mean:>9.1f}{t:>9.2f}")
    print()
    tb = pockets.get("total_bases yes", [])
    _, _, tb_t = tstat(tb)
    green = t > 0 and len(tb) >= 60 and tb_t >= 2.0
    print("GREEN LIGHT to scale (real money / server-side)? "
          + ("YES" if green else "NOT YET"))
    print(f"  need: overall t>0 (now {t:+.2f}) AND total_bases-YES n>=60 "
          f"(now {len(tb)}) with t>=2.0 (now {tb_t:+.2f}).")


if __name__ == "__main__":
    main()
