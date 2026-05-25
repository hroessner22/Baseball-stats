"""Calibration: how well does the matchup engine predict reality?

Scores each of FOUR engine variants against the same set of PAs from
``daily_pa``. Comparing across variants tells us whether the layers
we add to the engine actually earn their keep — i.e. does adding
daily_pa contribute? Does recency-weighting it move the needle?

Variants:

  naive          League baseline only (just the bats/throws handedness
                 split). The dumb floor — every PA gets the league
                 average outcome distribution. If our engine doesn't
                 beat this, we have a real problem.

  v1_historical  Retrosheet 2020-24 rates (batter + pitcher), combined
                 via log5 / odds-ratio with regression to league mean.
                 No current-season data. The original engine; what
                 lived in production before the daily ingest started.

  v2_with_daily  v1 + adding current-season daily_pa counts onto the
                 historical batter / pitcher input. Shipped when the
                 daily ingest started writing rows.

  v3_recency     v2 + recency form factor (PR #68): per-outcome
                 multiplier from (last-30d rate × 3 + 30-90d × 1.5 +
                 older) / overall, regressed toward 1.0. The current
                 production engine.

For each variant we compute:
  * top-pick accuracy — % of PAs where the model's #1 predicted
    outcome was the actual one
  * top-3 accuracy
  * Brier score — sum of squared errors across all 9 outcome buckets,
    averaged per PA. Lower is better.

Out-of-sample-ish: predictions for each variant use the same rates
the production engine would for that variant. We're scoring the
ENGINES against the OUTCOMES, not training/validating a model.

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

# Recency-weight schedule — must match
# web/functions/api/matchup.js RECENCY_WEIGHTS and FORM_REGRESSION_PA.
RECENCY_RECENT_DAYS = 30
RECENCY_MID_DAYS    = 90
RECENCY_RECENT_W    = 3.0
RECENCY_MID_W       = 1.5
RECENCY_BASE_W      = 1.0
FORM_REGRESSION_PA  = 50


# ── HTTP plumbing ─────────────────────────────────────────────────────

def _ssl_ctx() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=certifi.where())


def _request(method: str, url: str, key: str, body: dict | None = None,
             extra_headers: dict | None = None) -> tuple[int, bytes]:
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
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


# ── prediction engine (port of web/functions/api/matchup.js) ─────────

def predict(batter_c: dict, pitcher_c: dict, league_c: dict,
            regression_pa: int = REGRESSION_PA) -> dict:
    """Odds-ratio combination with league-mean regression — exact port
    of the JS predict() in matchup.js so the two engines agree."""
    league_total = sum(league_c.values())
    league_rates = {
        o: (league_c.get(o, 0) / league_total) if league_total > 0 else 0
        for o in OUTCOMES
    }

    def regressed(counts: dict) -> dict:
        t = sum(counts.values()) + regression_pa
        if t == 0:
            return league_rates
        return {
            o: ((counts.get(o, 0)) + regression_pa * league_rates[o]) / t
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


def recency_form_factor(daily_rows: list[dict], today: dt.date) -> dict | None:
    """Per-outcome ratio of recent-weighted rate vs overall rate.
    Mirrors recencyFormFactor in matchup.js."""
    if not daily_rows:
        return None
    cutoff_recent = today - dt.timedelta(days=RECENCY_RECENT_DAYS)
    cutoff_mid    = today - dt.timedelta(days=RECENCY_MID_DAYS)

    recent_n = 0.0
    base_n = 0
    recent: dict[str, float] = defaultdict(float)
    base: dict[str, int] = defaultdict(int)
    for r in daily_rows:
        gd = r.get("game_date")
        if not gd: continue
        try:
            d = dt.date.fromisoformat(gd)
        except ValueError:
            continue
        if d >= cutoff_recent: w = RECENCY_RECENT_W
        elif d >= cutoff_mid:  w = RECENCY_MID_W
        else:                  w = RECENCY_BASE_W
        recent[r["outcome"]] += w
        base[r["outcome"]] += 1
        recent_n += w
        base_n += 1
    if recent_n == 0 or base_n == 0:
        return None
    reliability = min(1.0, base_n / (base_n + FORM_REGRESSION_PA))
    factor: dict[str, float] = {}
    for o in OUTCOMES:
        recent_rate = recent[o] / recent_n
        base_rate   = base[o] / base_n if base_n else 0
        raw = recent_rate / base_rate if base_rate > 0 else 1
        factor[o] = 1 + (raw - 1) * reliability
    return factor


def apply_form_factor(counts: dict, factor: dict | None) -> dict:
    """Multiplies counts by per-outcome ratio then renormalizes to the
    original total so regression-to-league uses the right N."""
    if not factor:
        return dict(counts)
    orig_total = sum(counts.get(o, 0) for o in OUTCOMES)
    if orig_total <= 0:
        return dict(counts)
    scaled = {o: counts.get(o, 0) * factor.get(o, 1) for o in OUTCOMES}
    new_total = sum(scaled.values())
    if new_total <= 0:
        return dict(counts)
    k = orig_total / new_total
    return {o: scaled[o] * k for o in OUTCOMES}


# ── scoring ──────────────────────────────────────────────────────────

def score_predictions(predicted: dict, actual: str) -> tuple[bool, bool, float]:
    """Returns (top1_hit, top3_hit, brier_contribution_for_this_PA)."""
    sorted_o = sorted(predicted, key=lambda o: -predicted[o])
    top1 = sorted_o[0] == actual
    top3 = actual in sorted_o[:3]
    brier = 0.0
    for o in OUTCOMES:
        actual_p = 1.0 if o == actual else 0.0
        brier += (actual_p - predicted.get(o, 0)) ** 2
    return top1, top3, brier


# ── main ─────────────────────────────────────────────────────────────

def main() -> int:
    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not base_url or not key:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.", file=sys.stderr)
        return 2

    today = dt.date.today()

    print("Fetching daily_pa…", file=sys.stderr)
    pas = fetch_all(base_url, key, "daily_pa",
                    "batter_mlbam,batter_hand,pitcher_mlbam,pitcher_hand,outcome,game_date")
    print(f"  {len(pas)} PAs", file=sys.stderr)
    if not pas:
        print("No PAs in daily_pa yet — nothing to calibrate.", file=sys.stderr)
        return 1

    print("Fetching players (mlbam → retrosheet)…", file=sys.stderr)
    players = fetch_all(base_url, key, "players", "mlbam,retrosheet")
    mlbam_to_retro = {p["mlbam"]: p.get("retrosheet") for p in players if p.get("retrosheet")}
    print(f"  {len(mlbam_to_retro)} mapped", file=sys.stderr)

    print("Fetching batter_rates…", file=sys.stderr)
    batter_rates = fetch_all(base_url, key, "batter_rates", "batter,bats,vs_hand,outcome,n")
    print(f"  {len(batter_rates)} rows", file=sys.stderr)

    print("Fetching pitcher_rates…", file=sys.stderr)
    pitcher_rates = fetch_all(base_url, key, "pitcher_rates", "pitcher,throws,vs_hand,outcome,n")
    print(f"  {len(pitcher_rates)} rows", file=sys.stderr)

    print("Fetching league_rates…", file=sys.stderr)
    league_rates_rows = fetch_all(base_url, key, "league_rates", "bats,throws,outcome,n")
    print(f"  {len(league_rates_rows)} rows", file=sys.stderr)

    # Index historical rates.
    batter_idx: dict = defaultdict(lambda: defaultdict(int))
    for r in batter_rates:
        batter_idx[(r["batter"], r["bats"], r["vs_hand"])][r["outcome"]] += r["n"]
    pitcher_idx: dict = defaultdict(lambda: defaultdict(int))
    for r in pitcher_rates:
        pitcher_idx[(r["pitcher"], r["throws"], r["vs_hand"])][r["outcome"]] += r["n"]
    league_idx: dict = defaultdict(lambda: defaultdict(int))
    for r in league_rates_rows:
        league_idx[(r["bats"], r["throws"])][r["outcome"]] += r["n"]

    # Index daily_pa per player and hand for the v2/v3 paths. Same shape
    # as what /api/matchup pulls at request time.
    batter_daily: dict = defaultdict(list)   # (mlbam, opp_throws) → [rows]
    pitcher_daily: dict = defaultdict(list)  # (mlbam, opp_bats)   → [rows]
    for pa in pas:
        batter_daily[(pa["batter_mlbam"], pa["pitcher_hand"])].append(pa)
        pitcher_daily[(pa["pitcher_mlbam"], pa["batter_hand"])].append(pa)

    # Aggregated outcome counts from daily_pa per (mlbam, opp_hand).
    batter_daily_counts = {
        k: defaultdict(int, {o: sum(1 for r in rows if r["outcome"] == o) for o in OUTCOMES})
        for k, rows in batter_daily.items()
    }
    pitcher_daily_counts = {
        k: defaultdict(int, {o: sum(1 for r in rows if r["outcome"] == o) for o in OUTCOMES})
        for k, rows in pitcher_daily.items()
    }

    # Track aggregates per variant.
    #
    # Variants we're sweeping today are about REWEIGHTING the daily_pa
    # contribution relative to career. The original v2/v3 added daily
    # PAs equally weighted (1×) with career PAs from Retrosheet 2020-24.
    # For regulars with ~250 daily PAs vs ~2700 career, that's only 8%
    # season weight before log5 and the 100-PA league regression — way
    # too thin for recency to actually shift predictions. Daily-PA
    # weight bumps give recent data more authority before regression.
    variants = [
        "naive",
        "v1_historical",
        "v2_with_daily",            # daily × 1, no recency
        "v3_recency",               # daily × 1 + recency form factor
        "v4_daily_3x",              # daily × 3, no recency
        "v4_daily_5x",              # daily × 5, no recency
        "v4_daily_10x",             # daily × 10, no recency
        "v5_daily_5x_plus_recency", # daily × 5 + recency form factor
        "v5_daily_10x_plus_recency",# daily × 10 + recency form factor
    ]
    sample: dict[str, int] = defaultdict(int)
    top1:   dict[str, int] = defaultdict(int)
    top3:   dict[str, int] = defaultdict(int)
    brier:  dict[str, float] = defaultdict(float)
    skipped_no_map = 0
    skipped_no_data = 0
    earliest_date = None
    latest_date   = None

    for pa in pas:
        gd = pa.get("game_date")
        if gd:
            if earliest_date is None or gd < earliest_date: earliest_date = gd
            if latest_date   is None or gd > latest_date:   latest_date   = gd

        bats = pa["batter_hand"]
        throws = pa["pitcher_hand"]
        # Switch hitters: pick the favorable side vs this pitcher (same
        # rule as the production engine).
        if bats == "S":
            bats = "L" if throws == "R" else "R"

        l_counts = league_idx.get((bats, throws), {})
        if not l_counts:
            skipped_no_data += 1
            continue

        actual = pa["outcome"]
        league_rates_pred = {
            o: l_counts.get(o, 0) / max(1, sum(l_counts.values()))
            for o in OUTCOMES
        }

        # === naive ===
        t1, t3, br = score_predictions(league_rates_pred, actual)
        sample["naive"] += 1
        top1["naive"]   += t1
        top3["naive"]   += t3
        brier["naive"]  += br

        # The next three variants need player-specific historical data.
        retro_b = mlbam_to_retro.get(pa["batter_mlbam"])
        retro_p = mlbam_to_retro.get(pa["pitcher_mlbam"])
        if not retro_b or not retro_p:
            skipped_no_map += 1
            continue

        b_counts_hist = batter_idx.get((retro_b, bats, throws), {})
        p_counts_hist = pitcher_idx.get((retro_p, throws, bats), {})
        if not b_counts_hist or not p_counts_hist:
            skipped_no_data += 1
            continue

        # === v1_historical ===
        predicted_v1 = predict(b_counts_hist, p_counts_hist, l_counts)
        t1, t3, br = score_predictions(predicted_v1, actual)
        sample["v1_historical"] += 1
        top1["v1_historical"]   += t1
        top3["v1_historical"]   += t3
        brier["v1_historical"]  += br

        # === v2_with_daily — historical + daily_pa current-season counts ===
        b_daily = batter_daily_counts.get((pa["batter_mlbam"], throws), {})
        p_daily = pitcher_daily_counts.get((pa["pitcher_mlbam"], bats), {})
        b_counts_v2 = dict(b_counts_hist)
        p_counts_v2 = dict(p_counts_hist)
        for o in OUTCOMES:
            b_counts_v2[o] = b_counts_v2.get(o, 0) + b_daily.get(o, 0)
            p_counts_v2[o] = p_counts_v2.get(o, 0) + p_daily.get(o, 0)
        predicted_v2 = predict(b_counts_v2, p_counts_v2, l_counts)
        t1, t3, br = score_predictions(predicted_v2, actual)
        sample["v2_with_daily"] += 1
        top1["v2_with_daily"]   += t1
        top3["v2_with_daily"]   += t3
        brier["v2_with_daily"]  += br

        # === v3_recency — v2 + recency form factor ===
        b_form = recency_form_factor(batter_daily.get((pa["batter_mlbam"], throws), []), today)
        p_form = recency_form_factor(pitcher_daily.get((pa["pitcher_mlbam"], bats), []), today)
        b_counts_v3 = apply_form_factor(b_counts_v2, b_form)
        p_counts_v3 = apply_form_factor(p_counts_v2, p_form)
        predicted_v3 = predict(b_counts_v3, p_counts_v3, l_counts)
        t1, t3, br = score_predictions(predicted_v3, actual)
        sample["v3_recency"] += 1
        top1["v3_recency"]   += t1
        top3["v3_recency"]   += t3
        brier["v3_recency"]  += br

        # === v4_daily_{3,5,10}x — same composition as v2 but daily_pa
        # counts get multiplied by N before being added to career, so
        # current-season data dominates the prediction more. Higher N =
        # more responsive to recent form, less reliance on 2020-24
        # historical baseline. Pure additive amplification; no recency
        # window weighting on top.
        for daily_weight in [3, 5, 10]:
            v_name = f"v4_daily_{daily_weight}x"
            b_counts_v4 = dict(b_counts_hist)
            p_counts_v4 = dict(p_counts_hist)
            for o in OUTCOMES:
                b_counts_v4[o] = b_counts_v4.get(o, 0) + b_daily.get(o, 0) * daily_weight
                p_counts_v4[o] = p_counts_v4.get(o, 0) + p_daily.get(o, 0) * daily_weight
            predicted_v4 = predict(b_counts_v4, p_counts_v4, l_counts)
            t1, t3, br = score_predictions(predicted_v4, actual)
            sample[v_name] += 1
            top1[v_name]   += t1
            top3[v_name]   += t3
            brier[v_name]  += br

        # === v5_daily_{5,10}x_plus_recency — v4 + recency form factor.
        # The form factor operates on the now-heavier daily sample, so
        # within-season hot/cold streaks actually shift predictions
        # instead of being washed out by 3-year-old career data.
        for daily_weight in [5, 10]:
            v_name = f"v5_daily_{daily_weight}x_plus_recency"
            b_counts_v5 = dict(b_counts_hist)
            p_counts_v5 = dict(p_counts_hist)
            for o in OUTCOMES:
                b_counts_v5[o] = b_counts_v5.get(o, 0) + b_daily.get(o, 0) * daily_weight
                p_counts_v5[o] = p_counts_v5.get(o, 0) + p_daily.get(o, 0) * daily_weight
            b_counts_v5 = apply_form_factor(b_counts_v5, b_form)
            p_counts_v5 = apply_form_factor(p_counts_v5, p_form)
            predicted_v5 = predict(b_counts_v5, p_counts_v5, l_counts)
            t1, t3, br = score_predictions(predicted_v5, actual)
            sample[v_name] += 1
            top1[v_name]   += t1
            top3[v_name]   += t3
            brier[v_name]  += br

    # ── output + insert ─────────────────────────────────────────────
    print("", file=sys.stderr)
    print(f"Skipped: {skipped_no_map} no_map · {skipped_no_data} no_data", file=sys.stderr)
    print("", file=sys.stderr)
    header = f"  {'variant':<16}{'sample':>10}{'top-1':>10}{'top-3':>10}{'brier':>10}"
    print(header, file=sys.stderr)
    print("  " + "-" * (len(header) - 2), file=sys.stderr)
    rows_to_insert = []
    for v in variants:
        n = sample[v]
        if n == 0:
            print(f"  {v:<16}{'(no PAs)':>10}", file=sys.stderr)
            continue
        t1_pct = top1[v] / n * 100
        t3_pct = top3[v] / n * 100
        br_avg = brier[v] / n
        print(f"  {v:<16}{n:>10}{t1_pct:>9.2f}%{t3_pct:>9.2f}%{br_avg:>10.5f}",
              file=sys.stderr)
        rows_to_insert.append({
            "variant":           v,
            "sample_size":       n,
            "top_pick_accuracy": round(top1[v] / n, 4),
            "top3_accuracy":     round(top3[v] / n, 4),
            "brier_score":       round(br_avg, 5),
            "pa_start_date":     earliest_date,
            "pa_end_date":       latest_date,
            "note":              f"variant={v} · skipped {skipped_no_map} no_map "
                                 f"+ {skipped_no_data} no_data",
        })

    if not rows_to_insert:
        print("No scorable PAs — nothing to write.", file=sys.stderr)
        return 1

    print("\nInserting into model_metrics…", file=sys.stderr)
    status, body = _request(
        "POST", f"{base_url}/rest/v1/model_metrics", key,
        body=rows_to_insert,
        extra_headers={"Prefer": "return=minimal"},
    )
    if status not in (200, 201):
        print(f"  insert failed: HTTP {status} {body[:300]!r}", file=sys.stderr)
        return 4
    print("Done.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
