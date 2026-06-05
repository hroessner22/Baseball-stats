"""Empirical bot coefficients — replaces every hand-waved number.

Reads ``data/processed/rates.db`` (198K games / 15M PAs from
Retrosheet 1910-2024, ~95K games with weather) and derives:

  1. Hitter-quality 1+ hit / 2+ hit / 1+ HR / 2+ TB rates by
     season AVG bucket.
  2. K-prop pitcher quality: P(X+ K in a start) by season K/9 bucket.
  3. Weather coefficients: HR rate and hit rate by temp / wind
     buckets, relative to neutral conditions.
  4. League-wide per-PA outcome rates (for sanity / baseline).
  5. Pitcher recent-form: how predictive last-5-starts ERA is.

Outputs ``web/functions/api/_bot_coefficients.json`` — the bot
imports it instead of using hardcoded buckets.

Re-run after each season ends or when the seasons window in
``YEARS`` needs to roll forward.

Usage:
    python scripts/derive_coefficients.py
"""

from __future__ import annotations

import json
import pathlib
import sqlite3
import sys
from collections import defaultdict


ROOT = pathlib.Path(__file__).resolve().parent.parent
DB   = ROOT / "data" / "processed" / "rates.db"
OUT  = ROOT / "web" / "functions" / "api" / "_bot_coefficients.json"
YEARS = list(range(2018, 2025))   # 7 most recent seasons
YEARS_SQL = "(" + ",".join(str(y) for y in YEARS) + ")"

# Outcome codes in the at_bats table (verified by direct query 2026-06-05):
#   1B / 2B / 3B / HR — hits
#   K / OUT — outs
#   BB — walk
#   HBP — hit by pitch
#   OTHER — catcher interference / other rare events
HIT_OUTCOMES = ("1B", "2B", "3B", "HR")
HR_OUTCOMES  = ("HR",)
TB_VALUE     = {"1B": 1, "2B": 2, "3B": 3, "HR": 4}
K_OUTCOMES   = ("K",)


def open_db() -> sqlite3.Connection:
    if not DB.exists():
        sys.exit(f"missing {DB} — run the ingest first")
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


# ── Hitter quality ────────────────────────────────────────────────

def derive_hitter_quality(conn: sqlite3.Connection):
    """For each (season, batter) compute the per-game line +
    season AVG. Bucket by AVG and report P(≥N hits), P(≥1 HR),
    P(≥2 TB), and the count of game-batter pairs in each bucket.
    """
    print("  hitter quality...", file=sys.stderr)
    sql = f"""
    WITH game_lines AS (
        SELECT
            year,
            batter,
            game_id,
            SUM(CASE WHEN outcome IN ('1B','2B','3B','HR') THEN 1 ELSE 0 END) AS hits,
            SUM(CASE WHEN outcome = 'HR' THEN 1 ELSE 0 END) AS hr,
            SUM(CASE outcome WHEN '1B' THEN 1 WHEN '2B' THEN 2 WHEN '3B' THEN 3 WHEN 'HR' THEN 4 ELSE 0 END) AS tb,
            -- AB excludes walks, HBP, sac flies, sac hits.
            SUM(CASE WHEN outcome NOT IN ('BB','HBP','OTHER') AND sh_fl=0 AND sf_fl=0 THEN 1 ELSE 0 END) AS ab,
            COUNT(*) AS pa
        FROM at_bats
        WHERE year IN {YEARS_SQL}
        GROUP BY year, batter, game_id
    ),
    season_avg AS (
        SELECT
            year, batter,
            SUM(hits) AS season_hits,
            SUM(ab)   AS season_ab,
            COUNT(*)  AS games
        FROM game_lines
        GROUP BY year, batter
        HAVING SUM(ab) >= 200   -- enough PAs for a meaningful AVG
    )
    SELECT
        gl.hits, gl.hr, gl.tb, gl.pa, gl.ab,
        CAST(sa.season_hits AS REAL) / NULLIF(sa.season_ab, 0) AS season_avg
    FROM game_lines gl
    JOIN season_avg sa USING (year, batter)
    """
    buckets = [
        ("0.000-0.200", 0.000, 0.200),
        ("0.200-0.225", 0.200, 0.225),
        ("0.225-0.250", 0.225, 0.250),
        ("0.250-0.275", 0.250, 0.275),
        ("0.275-0.300", 0.275, 0.300),
        ("0.300+",      0.300, 0.999),
    ]
    bucket_data = {b[0]: {"games": 0, "h1_plus": 0, "h2_plus": 0, "hr1_plus": 0, "tb2_plus": 0} for b in buckets}

    for row in conn.execute(sql):
        avg = row["season_avg"]
        if avg is None:
            continue
        for label, lo, hi in buckets:
            if lo <= avg < hi:
                d = bucket_data[label]
                d["games"]   += 1
                d["h1_plus"] += 1 if (row["hits"] or 0) >= 1 else 0
                d["h2_plus"] += 1 if (row["hits"] or 0) >= 2 else 0
                d["hr1_plus"]+= 1 if (row["hr"]   or 0) >= 1 else 0
                d["tb2_plus"]+= 1 if (row["tb"]   or 0) >= 2 else 0
                break

    out = {}
    for label, d in bucket_data.items():
        g = d["games"] or 1
        out[label] = {
            "game_batter_pairs": d["games"],
            "p_1_plus_hit":  round(d["h1_plus"]  / g, 4),
            "p_2_plus_hit":  round(d["h2_plus"]  / g, 4),
            "p_1_plus_hr":   round(d["hr1_plus"] / g, 4),
            "p_2_plus_tb":   round(d["tb2_plus"] / g, 4),
        }
    return out


# ── K-prop pitcher quality ────────────────────────────────────────

def derive_kprop_pitcher_quality(conn: sqlite3.Connection):
    """For each starter-season, compute K/9 and per-start K distribution.
    Output P(≥X K) per K/9 bucket for X in 4..10.
    """
    print("  K-prop pitcher quality...", file=sys.stderr)
    # 'GS' isn't on a PA — we approximate "start" as: pitcher's first
    # appearance in the game (inning 1, top or bottom, batting opposite
    # team). cleaner approach: pick games where pitcher recorded the
    # most BF among all pitchers in that game.
    sql = f"""
    WITH per_game AS (
        SELECT
            year, pitcher, game_id,
            SUM(CASE WHEN outcome = 'K' THEN 1 ELSE 0 END) AS k,
            -- Innings approximated as outs / 3 (count of outs against this pitcher).
            -- We don't track outs precisely per pitcher in at_bats, so use BF / 4.3
            -- as a rough proxy.
            COUNT(*) AS bf
        FROM at_bats
        WHERE year IN {YEARS_SQL}
        GROUP BY year, pitcher, game_id
    ),
    starts AS (
        -- Heuristic: a pitcher's start is a game where they faced at
        -- least 12 batters. Filters out relievers. ~95% of true starts pass.
        SELECT * FROM per_game WHERE bf >= 12
    ),
    season_pitching AS (
        SELECT
            year, pitcher,
            SUM(k)  AS season_k,
            SUM(bf) AS season_bf,
            COUNT(*) AS starts
        FROM starts
        GROUP BY year, pitcher
        HAVING COUNT(*) >= 8   -- at least 8 starts in the season
    )
    SELECT
        s.k, s.bf,
        CAST(sp.season_k AS REAL) * 9.0 / (NULLIF(sp.season_bf, 0) / 4.3) AS k9
    FROM starts s
    JOIN season_pitching sp USING (year, pitcher)
    """
    buckets = [
        ("<6.0",   0.0,  6.0),
        ("6.0-7.0", 6.0,  7.0),
        ("7.0-8.0", 7.0,  8.0),
        ("8.0-9.0", 8.0,  9.0),
        ("9.0-10.0", 9.0, 10.0),
        ("10.0-11.0", 10.0, 11.0),
        ("11.0+",   11.0, 99.0),
    ]
    k_thresholds = [3, 4, 5, 6, 7, 8, 9, 10]
    bucket_data = {b[0]: {"starts": 0, **{f"p_{k}_plus": 0 for k in k_thresholds}, "k_sum": 0} for b in buckets}

    for row in conn.execute(sql):
        k9 = row["k9"]
        k  = row["k"] or 0
        if k9 is None:
            continue
        for label, lo, hi in buckets:
            if lo <= k9 < hi:
                d = bucket_data[label]
                d["starts"] += 1
                d["k_sum"]  += k
                for thr in k_thresholds:
                    if k >= thr:
                        d[f"p_{thr}_plus"] += 1
                break

    out = {}
    for label, d in bucket_data.items():
        s = d["starts"] or 1
        rec = {
            "starts": d["starts"],
            "avg_k_per_start": round(d["k_sum"] / s, 2),
        }
        for thr in k_thresholds:
            rec[f"p_{thr}_plus"] = round(d[f"p_{thr}_plus"] / s, 4)
        out[label] = rec
    return out


# ── Weather coefficients ──────────────────────────────────────────

def derive_weather(conn: sqlite3.Connection):
    """HR rate and hit rate by temperature and wind speed bucket,
    expressed as multipliers relative to neutral conditions
    (60-75°F, wind 0-5mph).
    """
    print("  weather coefficients...", file=sys.stderr)
    # Per-PA outcomes joined to per-game weather.
    sql = f"""
    SELECT
        g.temp,
        g.wind_speed,
        ab.outcome,
        COUNT(*) AS n
    FROM at_bats ab
    JOIN games g ON g.game_id = ab.game_id
    WHERE ab.year IN {YEARS_SQL}
      AND g.temp IS NOT NULL AND g.temp > 0
      AND g.wind_speed IS NOT NULL AND g.wind_speed >= 0
    GROUP BY g.temp, g.wind_speed, ab.outcome
    """
    # Aggregate into our buckets.
    temp_buckets = [
        ("<50",   0,   50),
        ("50-60", 50,  60),
        ("60-70", 60,  70),
        ("70-80", 70,  80),
        ("80-90", 80,  90),
        ("90+",   90,  130),
    ]
    wind_buckets = [
        ("0-5",   0,  5),
        ("5-10",  5, 10),
        ("10-15", 10, 15),
        ("15+",   15, 60),
    ]
    bucket_counts = defaultdict(lambda: {"pa": 0, "hits": 0, "hr": 0})
    for row in conn.execute(sql):
        temp = row["temp"]; wind = row["wind_speed"]; oc = row["outcome"]; n = row["n"]
        tlabel = next((b[0] for b in temp_buckets if b[1] <= temp < b[2]), None)
        wlabel = next((b[0] for b in wind_buckets if b[1] <= wind < b[2]), None)
        if not tlabel or not wlabel:
            continue
        d = bucket_counts[(tlabel, wlabel)]
        d["pa"] += n
        if oc in HIT_OUTCOMES:  d["hits"] += n
        if oc in HR_OUTCOMES:   d["hr"]   += n

    # Reference: neutral = 60-70°F, 0-5mph wind.
    ref = bucket_counts.get(("60-70", "0-5"), {"pa": 0, "hits": 0, "hr": 0})
    ref_hit_rate = (ref["hits"] / ref["pa"]) if ref["pa"] else 0
    ref_hr_rate  = (ref["hr"]   / ref["pa"]) if ref["pa"] else 0
    out = {
        "reference": {"temp": "60-70", "wind": "0-5", "pa": ref["pa"],
                       "hit_rate": round(ref_hit_rate, 4),
                       "hr_rate":  round(ref_hr_rate,  4)},
        "by_bucket": {},
    }
    for (tlabel, wlabel), d in sorted(bucket_counts.items()):
        if d["pa"] < 5000:    # need a decent sample
            continue
        hit_rate = d["hits"] / d["pa"]
        hr_rate  = d["hr"]   / d["pa"]
        out["by_bucket"][f"{tlabel}|{wlabel}"] = {
            "pa":       d["pa"],
            "hit_rate": round(hit_rate, 4),
            "hr_rate":  round(hr_rate,  4),
            "hit_multiplier": round(hit_rate / ref_hit_rate, 3) if ref_hit_rate else 1.0,
            "hr_multiplier":  round(hr_rate  / ref_hr_rate,  3) if ref_hr_rate  else 1.0,
        }
    return out


# ── Batter recent form (rolling 15-game OPS → next-game outcome) ──

def derive_batter_recent_form(conn: sqlite3.Connection):
    """For each batter-game, compute the OPS over the prior 15 games
    (window = preceding 15 rows, excluding current). Bucket by that
    rolling OPS and report P(1+H/2+H/1+HR/2+TB) in the CURRENT game.

    Tells us how much the batter_recent_form factor's adjust_pp
    SHOULD be: instead of guessing ±3pp for hot/cold, look up the
    actual delta between OPS buckets.
    """
    print("  batter recent form (rolling 15g)...", file=sys.stderr)
    sql = f"""
    WITH gl AS (
        SELECT
            year, batter, game_id, date,
            SUM(CASE WHEN outcome IN ('1B','2B','3B','HR') THEN 1 ELSE 0 END) AS h,
            SUM(CASE WHEN outcome = 'HR' THEN 1 ELSE 0 END) AS hr,
            SUM(CASE outcome WHEN '1B' THEN 1 WHEN '2B' THEN 2 WHEN '3B' THEN 3 WHEN 'HR' THEN 4 ELSE 0 END) AS tb,
            SUM(CASE WHEN outcome NOT IN ('BB','HBP','OTHER') AND sh_fl=0 AND sf_fl=0 THEN 1 ELSE 0 END) AS ab,
            SUM(CASE WHEN outcome = 'BB' THEN 1 ELSE 0 END) AS bb,
            SUM(CASE WHEN outcome = 'HBP' THEN 1 ELSE 0 END) AS hbp,
            COUNT(*) AS pa
        FROM at_bats
        WHERE year IN {YEARS_SQL}
        GROUP BY year, batter, game_id
    ),
    rolling AS (
        SELECT *,
            SUM(h)   OVER w AS h15,
            SUM(ab)  OVER w AS ab15,
            SUM(bb)  OVER w AS bb15,
            SUM(hbp) OVER w AS hbp15,
            SUM(tb)  OVER w AS tb15,
            SUM(pa)  OVER w AS pa15
        FROM gl
        WINDOW w AS (
            PARTITION BY batter
            ORDER BY date
            ROWS BETWEEN 15 PRECEDING AND 1 PRECEDING
        )
    )
    SELECT
        h, hr, tb,
        CAST(h15 AS REAL) / NULLIF(ab15, 0) AS rba,
        CAST(h15 + bb15 + hbp15 AS REAL) / NULLIF(pa15, 0) AS robp,
        CAST(tb15 AS REAL) / NULLIF(ab15, 0) AS rslg
    FROM rolling
    WHERE ab15 >= 30   -- need a meaningful rolling sample
    """

    buckets = [
        ("cold   <.600",    0.000, 0.600),
        (".600-.700",        0.600, 0.700),
        (".700-.800",        0.700, 0.800),
        (".800-.900",        0.800, 0.900),
        (".900-1.000",       0.900, 1.000),
        ("hot   1.000+",     1.000, 9.000),
    ]
    bd = {b[0]: {"games": 0, "h1": 0, "h2": 0, "hr1": 0, "tb2": 0} for b in buckets}

    for row in conn.execute(sql):
        if row["robp"] is None or row["rslg"] is None:
            continue
        ops = row["robp"] + row["rslg"]
        for label, lo, hi in buckets:
            if lo <= ops < hi:
                d = bd[label]
                d["games"] += 1
                if (row["h"]  or 0) >= 1: d["h1"]  += 1
                if (row["h"]  or 0) >= 2: d["h2"]  += 1
                if (row["hr"] or 0) >= 1: d["hr1"] += 1
                if (row["tb"] or 0) >= 2: d["tb2"] += 1
                break

    out = {}
    for label, d in bd.items():
        g = d["games"] or 1
        out[label] = {
            "game_batter_pairs": d["games"],
            "p_1_plus_hit": round(d["h1"]  / g, 4),
            "p_2_plus_hit": round(d["h2"]  / g, 4),
            "p_1_plus_hr":  round(d["hr1"] / g, 4),
            "p_2_plus_tb":  round(d["tb2"] / g, 4),
        }
    return out


# ── Pitcher recent form (rolling 5-start K/9 → next-start K dist) ──

def derive_pitcher_recent_form(conn: sqlite3.Connection):
    """For each starter-game, compute K/9 over the prior 5 starts.
    Bucket by rolling K/9 and report P(N+ K) in the NEXT start.
    Replaces the hand-waved -2 to +2pp adjust_pp ranges based on
    raw K/9 with actual gradient between rolling buckets.
    """
    print("  pitcher recent form (rolling 5gs)...", file=sys.stderr)
    sql = f"""
    WITH starts AS (
        SELECT
            year, pitcher, game_id, date,
            SUM(CASE WHEN outcome = 'K' THEN 1 ELSE 0 END) AS k,
            COUNT(*) AS bf
        FROM at_bats
        WHERE year IN {YEARS_SQL}
        GROUP BY year, pitcher, game_id
        HAVING COUNT(*) >= 12
    ),
    rolling AS (
        SELECT *,
            SUM(k)  OVER w AS k5,
            SUM(bf) OVER w AS bf5
        FROM starts
        WINDOW w AS (
            PARTITION BY pitcher
            ORDER BY date
            ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING
        )
    )
    SELECT k, bf,
           CAST(k5 * 9.0 AS REAL) / NULLIF(bf5 / 4.3, 0) AS rk9
    FROM rolling
    WHERE bf5 >= 50    -- ≥50 BF in rolling window (about 2 starts)
    """
    buckets = [
        ("<6.0",    0.0,  6.0),
        ("6.0-7.5", 6.0,  7.5),
        ("7.5-9.0", 7.5,  9.0),
        ("9.0-10.5",9.0, 10.5),
        ("10.5+",  10.5, 99.0),
    ]
    k_thresholds = [3, 4, 5, 6, 7, 8, 9, 10]
    bd = {b[0]: {"starts": 0, "k_sum": 0, **{f"p_{t}_plus": 0 for t in k_thresholds}} for b in buckets}

    for row in conn.execute(sql):
        rk9 = row["rk9"]
        k   = row["k"] or 0
        if rk9 is None: continue
        for label, lo, hi in buckets:
            if lo <= rk9 < hi:
                d = bd[label]
                d["starts"] += 1
                d["k_sum"]  += k
                for t in k_thresholds:
                    if k >= t: d[f"p_{t}_plus"] += 1
                break

    out = {}
    for label, d in bd.items():
        s = d["starts"] or 1
        rec = {"starts": d["starts"], "avg_k_per_start": round(d["k_sum"] / s, 2)}
        for t in k_thresholds:
            rec[f"p_{t}_plus"] = round(d[f"p_{t}_plus"] / s, 4)
        out[label] = rec
    return out


# ── Pitcher pull point (BF distribution at final batter) ──

def derive_pitcher_pull_point(conn: sqlite3.Connection):
    """For each starter, find their FINAL BF in each game (= the
    batter they were pulled after). Distribution tells us, given
    a pitcher has reached BF=N, what's P(this is their last batter)?

    Replaces the hand-waved 'p80 + 10 pitches' pull threshold.
    """
    print("  pitcher pull point (BF distribution)...", file=sys.stderr)
    sql = f"""
    WITH per_game AS (
        SELECT
            game_id, pitcher, year,
            COUNT(*) AS bf
        FROM at_bats
        WHERE year IN {YEARS_SQL}
        GROUP BY game_id, pitcher
        HAVING COUNT(*) >= 12   -- only consider starts
    )
    SELECT bf, COUNT(*) AS n
    FROM per_game
    GROUP BY bf
    ORDER BY bf
    """
    by_bf = {}
    total = 0
    for row in conn.execute(sql):
        by_bf[row["bf"]] = row["n"]
        total += row["n"]
    # Cumulative count of "still pitching": for BF=N, how many starts
    # exceeded N? Pull rate at N = n(N) / (n(N) + n(>N)).
    sorted_bf = sorted(by_bf)
    pull_rate = {}
    cum_above = total
    for bf in sorted_bf:
        n_at = by_bf[bf]
        n_above = cum_above - n_at      # n(>bf)
        denom = n_at + n_above
        rate = (n_at / denom) if denom else 0.0
        pull_rate[bf] = {
            "n_ending_here": n_at,
            "n_still_pitching": n_above,
            "pull_rate": round(rate, 4),
        }
        cum_above = n_above
    return {
        "total_starts": total,
        "by_bf": pull_rate,
    }


# ── League per-PA rates (baseline / sanity) ───────────────────────

def derive_league_rates(conn: sqlite3.Connection):
    print("  league per-PA rates...", file=sys.stderr)
    sql = f"""
    SELECT outcome, COUNT(*) AS n
    FROM at_bats
    WHERE year IN {YEARS_SQL}
    GROUP BY outcome
    """
    total = 0
    by_outcome = {}
    for row in conn.execute(sql):
        by_outcome[row["outcome"]] = row["n"]
        total += row["n"]
    out = {"total_pa": total, "per_pa": {k: round(v / total, 4) for k, v in by_outcome.items()}}
    return out


# ── main ─────────────────────────────────────────────────────────

def main() -> int:
    conn = open_db()
    print(f"Deriving coefficients from {YEARS[0]}-{YEARS[-1]} ({YEARS_SQL})", file=sys.stderr)
    result = {
        "source":  "Retrosheet PBP via rates.db",
        "seasons": f"{YEARS[0]}-{YEARS[-1]}",
        "hitter_quality_by_season_avg":   derive_hitter_quality(conn),
        "kprop_by_pitcher_season_k9":     derive_kprop_pitcher_quality(conn),
        "weather":                        derive_weather(conn),
        "batter_recent_form_15g":         derive_batter_recent_form(conn),
        "pitcher_recent_form_5gs":        derive_pitcher_recent_form(conn),
        "pitcher_pull_point":             derive_pitcher_pull_point(conn),
        "league_per_pa":                  derive_league_rates(conn),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, indent=2))
    print(f"\nWrote {OUT.relative_to(ROOT)}", file=sys.stderr)

    # Pretty summary for the operator.
    print("\nHitter-quality buckets (game-batter pairs):", file=sys.stderr)
    for label, d in result["hitter_quality_by_season_avg"].items():
        print(f"  AVG {label:<13} n={d['game_batter_pairs']:>6}  "
              f"P(1+H)={d['p_1_plus_hit']:.3f}  "
              f"P(2+H)={d['p_2_plus_hit']:.3f}  "
              f"P(1+HR)={d['p_1_plus_hr']:.4f}  "
              f"P(2+TB)={d['p_2_plus_tb']:.3f}", file=sys.stderr)
    print("\nK-prop pitcher buckets (starts):", file=sys.stderr)
    for label, d in result["kprop_by_pitcher_season_k9"].items():
        print(f"  K/9 {label:<11} n={d['starts']:>4}  avg={d['avg_k_per_start']:.1f}  "
              f"P(5+)={d['p_5_plus']:.3f}  P(6+)={d['p_6_plus']:.3f}  "
              f"P(7+)={d['p_7_plus']:.3f}  P(8+)={d['p_8_plus']:.3f}", file=sys.stderr)
    print(f"\nWeather reference: {result['weather']['reference']}", file=sys.stderr)
    print("\nBatter recent-form (rolling 15g OPS):", file=sys.stderr)
    for label, d in result["batter_recent_form_15g"].items():
        print(f"  OPS {label:<16} n={d['game_batter_pairs']:>6}  "
              f"P(1+H)={d['p_1_plus_hit']:.3f}  P(1+HR)={d['p_1_plus_hr']:.4f}  "
              f"P(2+TB)={d['p_2_plus_tb']:.3f}", file=sys.stderr)
    print("\nPitcher recent-form (rolling 5gs K/9):", file=sys.stderr)
    for label, d in result["pitcher_recent_form_5gs"].items():
        print(f"  rK/9 {label:<11} n={d['starts']:>4}  avg={d['avg_k_per_start']:.1f}  "
              f"P(5+)={d['p_5_plus']:.3f}  P(6+)={d['p_6_plus']:.3f}  "
              f"P(7+)={d['p_7_plus']:.3f}  P(8+)={d['p_8_plus']:.3f}", file=sys.stderr)
    print(f"\nPitcher pull point: {result['pitcher_pull_point']['total_starts']} starts; "
          f"sample BF→pull-rate: ", end="", file=sys.stderr)
    for bf in [15, 18, 20, 22, 24, 26, 28, 30, 32]:
        rec = result["pitcher_pull_point"]["by_bf"].get(bf)
        if rec:
            print(f"BF{bf}:{rec['pull_rate']:.2f} ", end="", file=sys.stderr)
    print("", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
