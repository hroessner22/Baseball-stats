"""Calibration: how well does the matchup engine predict reality?

For every plate appearance in ``daily_pa``, we run the matchup model
using ONLY the historical 2020–2024 rates loaded in Supabase (no
daily_pa contribution to the prediction), then compare the predicted
outcome distribution to the actual outcome that happened. Aggregate
into:

  * top-pick accuracy — % of PAs where the model's #1 predicted outcome
                        was the actual outcome
  * top-3 accuracy    — same but for top-3
  * Brier score       — mean squared error between predicted distribution
                        and one-hot actual

Out-of-sample because the historical rates table doesn't include the
2026 PAs we're scoring against. Writes one row to ``model_metrics``.

Run as part of the daily GitHub Actions cron right after daily_ingest,
or by hand:

    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python -m src.calibration
"""
from __future__ import annotations

import datetime as dt
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from collections import defaultdict

import certifi


OUTCOMES = ["K", "BB", "HBP", "1B", "2B", "3B", "HR", "OUT", "OTHER"]
REGRESSION_PA = 100  # same as web/functions/api/matchup.js


def _ssl_ctx() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=certifi.where())


def _request(method: str, url: str, key: str, body: dict | None = None,
             extra_headers: dict | None = None) -> tuple[int, bytes]:
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=120) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read() or b""


def fetch_all(base_url: str, key: str, table: str, select: str,
              page_size: int = 1000) -> list[dict]:
    """Pull every row from a Supabase table via Range pagination."""
    out: list[dict] = []
    offset = 0
    while True:
        url = f"{base_url}/rest/v1/{table}?select={select}"
        status, body = _request(
            "GET", url, key,
            extra_headers={
                "Range-Unit": "items",
                "Range": f"{offset}-{offset + page_size - 1}",
            },
        )
        if status not in (200, 206):
            raise RuntimeError(f"GET {table} HTTP {status}: {body[:300]!r}")
        batch = json.loads(body) if body else []
        out.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return out


def predict(batter_c: dict, pitcher_c: dict, league_c: dict) -> dict:
    """JS port of web/functions/api/matchup.js predict(). Same odds-ratio
    with league-mean regression so the two engines agree."""
    league_total = sum(league_c.values())
    league_rates = {
        o: (league_c.get(o, 0) / league_total) if league_total > 0 else 0
        for o in OUTCOMES
    }

    def regressed(counts: dict) -> dict:
        t = sum(counts.values()) + REGRESSION_PA
        if t == 0:
            return league_rates
        return {
            o: ((counts.get(o, 0)) + REGRESSION_PA * league_rates[o]) / t
            for o in OUTCOMES
        }

    bat = regressed(batter_c)
    pit = regressed(pitcher_c)

    raw = {}
    for o in OUTCOMES:
        lg = league_rates[o]
        raw[o] = (bat[o] * pit[o]) / lg if lg > 0 else 0
    total = sum(raw.values())
    if total <= 0:
        return league_rates
    return {o: raw[o] / total for o in OUTCOMES}


def main() -> int:
    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not base_url or not key:
        print(
            "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Set both.",
            file=sys.stderr,
        )
        return 2

    print("Fetching daily_pa…", file=sys.stderr)
    pas = fetch_all(base_url, key, "daily_pa",
                    "batter_mlbam,batter_hand,pitcher_mlbam,pitcher_hand,outcome,game_date")
    print(f"  {len(pas)} PAs", file=sys.stderr)
    if not pas:
        print("No PAs in daily_pa yet — nothing to calibrate against.", file=sys.stderr)
        return 1

    print("Fetching players (mlbam → retrosheet)…", file=sys.stderr)
    players = fetch_all(base_url, key, "players", "mlbam,retrosheet")
    mlbam_to_retro = {p["mlbam"]: p.get("retrosheet") for p in players if p.get("retrosheet")}
    print(f"  {len(mlbam_to_retro)} mapped", file=sys.stderr)

    print("Fetching batter_rates…", file=sys.stderr)
    batter_rates = fetch_all(base_url, key, "batter_rates",
                             "batter,bats,vs_hand,outcome,n")
    print(f"  {len(batter_rates)} rows", file=sys.stderr)

    print("Fetching pitcher_rates…", file=sys.stderr)
    pitcher_rates = fetch_all(base_url, key, "pitcher_rates",
                              "pitcher,throws,vs_hand,outcome,n")
    print(f"  {len(pitcher_rates)} rows", file=sys.stderr)

    print("Fetching league_rates…", file=sys.stderr)
    league_rates_rows = fetch_all(base_url, key, "league_rates",
                                  "bats,throws,outcome,n")
    print(f"  {len(league_rates_rows)} rows", file=sys.stderr)

    # Index the rates for O(1) lookup. The rates tables have rows per
    # (year, hand, …, outcome) so we aggregate across years.
    batter_idx: dict = defaultdict(lambda: defaultdict(int))
    for r in batter_rates:
        key_ = (r["batter"], r["bats"], r["vs_hand"])
        batter_idx[key_][r["outcome"]] += r["n"]

    pitcher_idx: dict = defaultdict(lambda: defaultdict(int))
    for r in pitcher_rates:
        key_ = (r["pitcher"], r["throws"], r["vs_hand"])
        pitcher_idx[key_][r["outcome"]] += r["n"]

    league_idx: dict = defaultdict(lambda: defaultdict(int))
    for r in league_rates_rows:
        key_ = (r["bats"], r["throws"])
        league_idx[key_][r["outcome"]] += r["n"]

    # Walk each PA, predict, score.
    sample = 0
    top1 = 0
    top3 = 0
    brier_total = 0.0
    skipped_no_map = 0
    skipped_no_data = 0
    earliest_date = None
    latest_date = None

    for pa in pas:
        gd = pa.get("game_date")
        if gd:
            if earliest_date is None or gd < earliest_date: earliest_date = gd
            if latest_date is None or gd > latest_date: latest_date = gd

        retro_b = mlbam_to_retro.get(pa["batter_mlbam"])
        retro_p = mlbam_to_retro.get(pa["pitcher_mlbam"])
        if not retro_b or not retro_p:
            skipped_no_map += 1
            continue

        bats = pa["batter_hand"]
        throws = pa["pitcher_hand"]
        # Switch hitters get mapped to the favorable side vs this pitcher.
        if bats == "S":
            bats = "L" if throws == "R" else "R"

        b_counts = batter_idx.get((retro_b, bats, throws), {})
        p_counts = pitcher_idx.get((retro_p, throws, bats), {})
        l_counts = league_idx.get((bats, throws), {})

        if not b_counts or not p_counts or not l_counts:
            skipped_no_data += 1
            continue

        predicted = predict(b_counts, p_counts, l_counts)

        actual = pa["outcome"]
        sample += 1

        sorted_outcomes = sorted(predicted, key=lambda o: -predicted[o])
        if sorted_outcomes[0] == actual:
            top1 += 1
        if actual in sorted_outcomes[:3]:
            top3 += 1

        # Brier: sum over buckets of (actual - predicted)^2
        for o in OUTCOMES:
            actual_p = 1.0 if o == actual else 0.0
            brier_total += (actual_p - predicted.get(o, 0)) ** 2

    if sample == 0:
        print("No scorable PAs — every PA was missing data.", file=sys.stderr)
        return 1

    top1_acc = top1 / sample
    top3_acc = top3 / sample
    brier = brier_total / sample

    print("", file=sys.stderr)
    print("Results:", file=sys.stderr)
    print(f"  PAs scored:        {sample}", file=sys.stderr)
    print(f"  Skipped (no map):  {skipped_no_map}", file=sys.stderr)
    print(f"  Skipped (no data): {skipped_no_data}", file=sys.stderr)
    print(f"  Top-pick accuracy: {top1_acc * 100:.2f}%", file=sys.stderr)
    print(f"  Top-3 accuracy:    {top3_acc * 100:.2f}%", file=sys.stderr)
    print(f"  Brier score:       {brier:.5f}", file=sys.stderr)

    row = {
        "sample_size":       sample,
        "top_pick_accuracy": round(top1_acc, 4),
        "top3_accuracy":     round(top3_acc, 4),
        "brier_score":       round(brier, 5),
        "pa_start_date":     earliest_date,
        "pa_end_date":       latest_date,
        "note":              f"v1 odds-ratio · historical=2020-2024 · "
                              f"skipped {skipped_no_map} no_map + "
                              f"{skipped_no_data} no_data",
    }

    print("\nInserting into model_metrics…", file=sys.stderr)
    status, body = _request(
        "POST",
        f"{base_url}/rest/v1/model_metrics",
        key,
        body=row,
        extra_headers={"Prefer": "return=minimal"},
    )
    if status not in (200, 201):
        print(f"  insert failed: HTTP {status} {body[:300]!r}", file=sys.stderr)
        return 4
    print("Done.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
