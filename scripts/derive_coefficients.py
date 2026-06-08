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


def derive_kprop_threshold_hit_rates_by_k_per_start(conn: sqlite3.Connection):
    """Empirical hit rate for each K threshold, bucketed by the pitcher's
    season K-per-start.

    autobot.js uses this table to derive — at runtime — the YES ceiling
    (highest threshold worth taking), the NO floor (lowest threshold
    where NO has real chance), and the borderline-sizing band (where the
    bet is positive-EV but high-variance). When this table refreshes,
    those rules update automatically.
    """
    print("  K-prop hit rates by K/start...", file=sys.stderr)
    sql = f"""
    WITH per_game AS (
        SELECT year, pitcher, game_id,
               SUM(CASE WHEN outcome = 'K' THEN 1 ELSE 0 END) AS k,
               COUNT(*) AS bf
        FROM at_bats
        WHERE year IN {YEARS_SQL}
        GROUP BY year, pitcher, game_id
    ),
    starts AS (
        -- BF >= 15 filters out relievers more aggressively than the
        -- generic K-prop-pitcher-quality function (which uses 12).
        -- Closer to 'true starter game' for the threshold-rate computation.
        SELECT * FROM per_game WHERE bf >= 15
    ),
    season_pitching AS (
        SELECT year, pitcher,
               SUM(k) AS season_k,
               COUNT(*) AS season_starts,
               CAST(SUM(k) AS REAL) / COUNT(*) AS k_per_start
        FROM starts
        GROUP BY year, pitcher
        HAVING COUNT(*) >= 10
    )
    SELECT s.k, sp.k_per_start
    FROM starts s
    JOIN season_pitching sp USING (year, pitcher)
    """
    buckets = [
        ("<4",  0.0, 4.0),
        ("4-5", 4.0, 5.0),
        ("5-6", 5.0, 6.0),
        ("6-7", 6.0, 7.0),
        ("7-8", 7.0, 8.0),
        ("8+",  8.0, 99.0),
    ]
    thresholds = list(range(2, 11))   # 2+ through 10+
    bucket_data = {b[0]: {"n": 0, **{f"p_{t}_plus": 0 for t in thresholds}} for b in buckets}

    for row in conn.execute(sql):
        kps = row["k_per_start"]
        k_in_start = row["k"] or 0
        if kps is None:
            continue
        for label, lo, hi in buckets:
            if lo <= kps < hi:
                d = bucket_data[label]
                d["n"] += 1
                for t in thresholds:
                    if k_in_start >= t:
                        d[f"p_{t}_plus"] += 1
                break

    out = {}
    for label, d in bucket_data.items():
        n = d["n"] or 1
        rec = {"n": d["n"]}
        for t in thresholds:
            rec[f"p_{t}_plus"] = round(d[f"p_{t}_plus"] / n, 4)
        out[label] = rec
    return out


def derive_hitprop_hit_rates_by_season_avg(conn: sqlite3.Connection):
    """Empirical TB and Hits hit rate per threshold, bucketed by the
    batter's season TB/game and H/game respectively.

    Used by autobot.js to fire hitter YES bets when the bucket's
    empirical rate is well above market price. Same structure as
    kprop_hit_rates_by_k_per_start.
    """
    print("  Hit-prop hit rates by season avg...", file=sys.stderr)
    sql_tb = f"""
    WITH per_game AS (
        SELECT year, batter, game_id,
               SUM(CASE outcome WHEN '1B' THEN 1 WHEN '2B' THEN 2 WHEN '3B' THEN 3 WHEN 'HR' THEN 4 ELSE 0 END) AS tb,
               COUNT(*) AS pa
        FROM at_bats
        WHERE year IN {YEARS_SQL}
        GROUP BY year, batter, game_id
    ),
    starts AS (SELECT * FROM per_game WHERE pa >= 3),
    season_avgs AS (
        SELECT year, batter,
               COUNT(*) AS games,
               CAST(SUM(tb) AS REAL) / COUNT(*) AS tb_per_game
        FROM starts
        GROUP BY year, batter
        HAVING COUNT(*) >= 40
    )
    SELECT s.tb, sa.tb_per_game
    FROM starts s
    JOIN season_avgs sa USING (year, batter)
    """
    tb_buckets = [
        ("<0.8",   0.0, 0.8),
        ("0.8-1.0", 0.8, 1.0),
        ("1.0-1.2", 1.0, 1.2),
        ("1.2-1.4", 1.2, 1.4),
        ("1.4-1.6", 1.4, 1.6),
        ("1.6-1.8", 1.6, 1.8),
        ("1.8+",   1.8, 99.0),
    ]
    tb_thresholds = [1, 2, 3, 4]
    tb_data = {b[0]: {"n": 0, **{f"p_{t}_plus": 0 for t in tb_thresholds}} for b in tb_buckets}
    for row in conn.execute(sql_tb):
        rate = row["tb_per_game"]
        tb   = row["tb"] or 0
        if rate is None: continue
        for label, lo, hi in tb_buckets:
            if lo <= rate < hi:
                d = tb_data[label]
                d["n"] += 1
                for t in tb_thresholds:
                    if tb >= t: d[f"p_{t}_plus"] += 1
                break

    sql_h = f"""
    WITH per_game AS (
        SELECT year, batter, game_id,
               SUM(CASE WHEN outcome IN ('1B','2B','3B','HR') THEN 1 ELSE 0 END) AS h,
               COUNT(*) AS pa
        FROM at_bats
        WHERE year IN {YEARS_SQL}
        GROUP BY year, batter, game_id
    ),
    starts AS (SELECT * FROM per_game WHERE pa >= 3),
    season_avgs AS (
        SELECT year, batter,
               COUNT(*) AS games,
               CAST(SUM(h) AS REAL) / COUNT(*) AS h_per_game
        FROM starts
        GROUP BY year, batter
        HAVING COUNT(*) >= 40
    )
    SELECT s.h, sa.h_per_game
    FROM starts s
    JOIN season_avgs sa USING (year, batter)
    """
    h_buckets = [
        ("<0.5",    0.0, 0.5),
        ("0.5-0.7", 0.5, 0.7),
        ("0.7-0.8", 0.7, 0.8),
        ("0.8-0.9", 0.8, 0.9),
        ("0.9-1.0", 0.9, 1.0),
        ("1.0+",    1.0, 99.0),
    ]
    h_thresholds = [1, 2, 3]
    h_data = {b[0]: {"n": 0, **{f"p_{t}_plus": 0 for t in h_thresholds}} for b in h_buckets}
    for row in conn.execute(sql_h):
        rate = row["h_per_game"]
        h    = row["h"] or 0
        if rate is None: continue
        for label, lo, hi in h_buckets:
            if lo <= rate < hi:
                d = h_data[label]
                d["n"] += 1
                for t in h_thresholds:
                    if h >= t: d[f"p_{t}_plus"] += 1
                break

    def finalize(buckets_data, thresholds):
        out = {}
        for label, d in buckets_data.items():
            n = d["n"] or 1
            rec = {"n": d["n"]}
            for t in thresholds:
                rec[f"p_{t}_plus"] = round(d[f"p_{t}_plus"] / n, 4)
            out[label] = rec
        return out

    return {
        "tb_by_season_tb_per_game":  finalize(tb_data, tb_thresholds),
        "hits_by_season_h_per_game": finalize(h_data, h_thresholds),
    }


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


# ── PA-exhaustion (game state → remaining PA distribution) ──

def derive_pa_exhaustion(conn: sqlite3.Connection):
    """For each (inning, half) game state where a batter has a PA,
    compute the empirical distribution of PAs the SAME batter has
    REMAINING in that game from that state forward.

    Replaces the hand-waved 'turns_remaining < 0.5 → skip' threshold
    with actual lookup: at game state S, what fraction of batters
    get N more PAs?
    """
    print("  PA-exhaustion (game-state → remaining PAs)...", file=sys.stderr)
    sql = f"""
    WITH pa_seq AS (
        SELECT
            game_id, batter, inning, half,
            ROW_NUMBER() OVER (
                PARTITION BY game_id, batter
                ORDER BY inning,
                         CASE WHEN half = 'top' THEN 0 ELSE 1 END,
                         outs
            ) AS pa_num,
            COUNT(*) OVER (PARTITION BY game_id, batter) AS total_pa
        FROM at_bats
        WHERE year IN {YEARS_SQL}
    )
    SELECT
        inning, half,
        (total_pa - pa_num) AS pas_remaining,
        COUNT(*) AS n
    FROM pa_seq
    GROUP BY inning, half, (total_pa - pa_num)
    """
    by_state = {}
    for row in conn.execute(sql):
        inning = row["inning"]; half = row["half"]
        if inning is None or half is None or inning < 1 or inning > 12:
            continue
        key = f"{inning}|{half}"
        if key not in by_state:
            by_state[key] = {"n": 0, "remaining": {}}
        rec = by_state[key]
        rec["n"] += row["n"]
        r = row["pas_remaining"]
        rec["remaining"][r] = rec["remaining"].get(r, 0) + row["n"]
    # Compute summaries per state: mean remaining PAs + P(at least 1 more).
    out = {}
    for key, rec in by_state.items():
        total = rec["n"] or 1
        weighted = sum(r * n for r, n in rec["remaining"].items())
        mean_remaining = weighted / total
        n_zero    = rec["remaining"].get(0, 0)
        p_at_least_1 = 1 - (n_zero / total)
        out[key] = {
            "sample": total,
            "mean_remaining_pa": round(mean_remaining, 3),
            "p_at_least_1_more_pa": round(p_at_least_1, 4),
        }
    return out


# ── K-prop conditional P (cashout) ────────────────────────────

def derive_kprop_conditional(conn: sqlite3.Connection):
    """For each (BF_so_far, current_K, K9 bucket), report the
    empirical P(final_K ≥ threshold). The bot uses this for cashout:

      hold_value = P(threshold reached | current state) × $1
      sell_value = current YES bid

    Sell when bid > hold_value + margin; hold otherwise.

    Buckets are coarse to keep sample sizes meaningful:
      BF: 6, 9, 12, 15, 18, 21, 24, 27, 30+
      K:  0..10
      K9: <7.5, 7.5-9.0, 9.0-10.5, 10.5+
    """
    print("  K-prop conditional P (cashout table)...", file=sys.stderr)
    sql = f"""
    WITH starts AS (
        SELECT year, pitcher, game_id,
               SUM(CASE WHEN outcome = 'K' THEN 1 ELSE 0 END) AS total_k,
               COUNT(*) AS total_bf
        FROM at_bats
        WHERE year IN {YEARS_SQL}
        GROUP BY year, pitcher, game_id
        HAVING COUNT(*) >= 12
    ),
    season AS (
        SELECT year, pitcher,
               SUM(total_k) AS sk,
               SUM(total_bf) AS sbf
        FROM starts
        GROUP BY year, pitcher
        HAVING SUM(total_bf) >= 100
    ),
    walked AS (
        SELECT
            ab.game_id, ab.pitcher, ab.year,
            ROW_NUMBER() OVER (PARTITION BY ab.game_id, ab.pitcher
                               ORDER BY ab.inning,
                                        CASE WHEN ab.half='top' THEN 0 ELSE 1 END,
                                        ab.outs) AS bf_num,
            SUM(CASE WHEN ab.outcome = 'K' THEN 1 ELSE 0 END) OVER (
                PARTITION BY ab.game_id, ab.pitcher
                ORDER BY ab.inning,
                         CASE WHEN ab.half='top' THEN 0 ELSE 1 END,
                         ab.outs
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS k_after,
            s.total_k,
            sea.sk * 9.0 / NULLIF(CAST(sea.sbf AS REAL) / 4.3, 0) AS k9
        FROM at_bats ab
        JOIN starts s   ON s.game_id   = ab.game_id AND s.pitcher   = ab.pitcher
        JOIN season sea ON sea.year    = ab.year    AND sea.pitcher = ab.pitcher
        WHERE ab.year IN {YEARS_SQL}
    )
    SELECT bf_num, k_after, k9, total_k
    FROM walked
    WHERE bf_num <= 35
    """

    def bf_bucket(bf):
        if bf < 6:  return "0-6"
        if bf < 9:  return "6-9"
        if bf < 12: return "9-12"
        if bf < 15: return "12-15"
        if bf < 18: return "15-18"
        if bf < 21: return "18-21"
        if bf < 24: return "21-24"
        if bf < 27: return "24-27"
        if bf < 30: return "27-30"
        return "30+"
    def k9_bucket(k9):
        if k9 is None: return None
        if k9 < 7.5: return "<7.5"
        if k9 < 9.0: return "7.5-9.0"
        if k9 < 10.5: return "9.0-10.5"
        return "10.5+"

    thresholds = [3, 4, 5, 6, 7, 8, 9, 10]
    agg = {}      # key=(bf_bucket, k_after, k9_bucket) → {n, p_T+...}
    for row in conn.execute(sql):
        bf  = row["bf_num"]
        k   = row["k_after"]
        k9  = row["k9"]
        tot = row["total_k"]
        k9b = k9_bucket(k9)
        if k9b is None or k is None or tot is None: continue
        # Cap k_after at 10 (above is rare and binned together)
        kb = min(int(k), 10)
        key = (bf_bucket(bf), kb, k9b)
        if key not in agg:
            agg[key] = {"n": 0, **{f"p_{t}_plus": 0 for t in thresholds}}
        a = agg[key]
        a["n"] += 1
        for t in thresholds:
            if tot >= t: a[f"p_{t}_plus"] += 1

    out = {}
    for (bfb, k, k9b), a in agg.items():
        if a["n"] < 30:  # need some sample
            continue
        rec = {"n": a["n"]}
        for t in thresholds:
            rec[f"p_{t}_plus"] = round(a[f"p_{t}_plus"] / a["n"], 4)
        out[f"{bfb}|k{k}|{k9b}"] = rec
    return out


# ── Hit-prop conditional (batter cashout EV) ──────────────────

def derive_hitprop_conditional(conn: sqlite3.Connection):
    """For each (PA num, current_hits, current_TB, current_HR, AVG bucket),
    report P(final ≥ threshold) for hits / TB / HR. The bot uses this
    for hitter-prop cashout decisions analogous to the K-prop table.
    """
    print("  hit-prop conditional P (cashout table)...", file=sys.stderr)
    sql = f"""
    WITH game_lines AS (
        SELECT
            year, batter, game_id,
            SUM(CASE WHEN outcome IN ('1B','2B','3B','HR') THEN 1 ELSE 0 END) AS total_h,
            SUM(CASE WHEN outcome = 'HR' THEN 1 ELSE 0 END) AS total_hr,
            SUM(CASE outcome WHEN '1B' THEN 1 WHEN '2B' THEN 2 WHEN '3B' THEN 3 WHEN 'HR' THEN 4 ELSE 0 END) AS total_tb,
            SUM(CASE WHEN outcome NOT IN ('BB','HBP','OTHER') AND sh_fl=0 AND sf_fl=0 THEN 1 ELSE 0 END) AS total_ab
        FROM at_bats
        WHERE year IN {YEARS_SQL}
        GROUP BY year, batter, game_id
    ),
    season AS (
        SELECT year, batter,
               SUM(total_h)  AS sh,
               SUM(total_ab) AS sab
        FROM game_lines
        GROUP BY year, batter
        HAVING SUM(total_ab) >= 200
    ),
    walked AS (
        SELECT
            ab.game_id, ab.batter, ab.year, ab.inning, ab.half,
            ROW_NUMBER() OVER (PARTITION BY ab.game_id, ab.batter
                               ORDER BY ab.inning,
                                        CASE WHEN ab.half='top' THEN 0 ELSE 1 END,
                                        ab.outs) AS pa_num,
            SUM(CASE WHEN ab.outcome IN ('1B','2B','3B','HR') THEN 1 ELSE 0 END) OVER (
                PARTITION BY ab.game_id, ab.batter
                ORDER BY ab.inning,
                         CASE WHEN ab.half='top' THEN 0 ELSE 1 END,
                         ab.outs
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS h_after,
            SUM(CASE WHEN ab.outcome = 'HR' THEN 1 ELSE 0 END) OVER (
                PARTITION BY ab.game_id, ab.batter
                ORDER BY ab.inning,
                         CASE WHEN ab.half='top' THEN 0 ELSE 1 END,
                         ab.outs
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS hr_after,
            SUM(CASE ab.outcome WHEN '1B' THEN 1 WHEN '2B' THEN 2 WHEN '3B' THEN 3 WHEN 'HR' THEN 4 ELSE 0 END) OVER (
                PARTITION BY ab.game_id, ab.batter
                ORDER BY ab.inning,
                         CASE WHEN ab.half='top' THEN 0 ELSE 1 END,
                         ab.outs
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS tb_after,
            gl.total_h,
            gl.total_hr,
            gl.total_tb,
            CAST(s.sh AS REAL) / NULLIF(s.sab, 0) AS avg
        FROM at_bats ab
        JOIN game_lines gl ON gl.game_id = ab.game_id AND gl.batter = ab.batter
        JOIN season s      ON s.year     = ab.year    AND s.batter  = ab.batter
        WHERE ab.year IN {YEARS_SQL}
    )
    SELECT inning, half, h_after, hr_after, tb_after,
           total_h, total_hr, total_tb, avg
    FROM walked
    WHERE inning <= 12
    """

    def avg_b(a):
        if a is None: return None
        if a < 0.200: return "0.000-0.200"
        if a < 0.225: return "0.200-0.225"
        if a < 0.250: return "0.225-0.250"
        if a < 0.275: return "0.250-0.275"
        if a < 0.300: return "0.275-0.300"
        return "0.300+"
    def state_b(inn, half):
        if inn is None or half is None: return None
        return f"{inn}|{half}"

    # State: (inning|half, h_after capped at 3, hr_after capped at 2,
    #         tb_after capped at 5, avg_bucket)
    agg = {}
    for row in conn.execute(sql):
        ab = avg_b(row["avg"])
        sb = state_b(row["inning"], row["half"])
        if ab is None or sb is None: continue
        h  = min(3, int(row["h_after"]  or 0))
        hr = min(2, int(row["hr_after"] or 0))
        tb = min(5, int(row["tb_after"] or 0))
        key = (sb, h, hr, tb, ab)
        if key not in agg:
            agg[key] = {
                "n": 0,
                "p_1_plus_h": 0, "p_2_plus_h": 0, "p_3_plus_h": 0,
                "p_1_plus_hr": 0, "p_2_plus_hr": 0,
                "p_2_plus_tb": 0, "p_3_plus_tb": 0, "p_4_plus_tb": 0,
            }
        a = agg[key]
        a["n"] += 1
        if (row["total_h"]  or 0) >= 1: a["p_1_plus_h"]  += 1
        if (row["total_h"]  or 0) >= 2: a["p_2_plus_h"]  += 1
        if (row["total_h"]  or 0) >= 3: a["p_3_plus_h"]  += 1
        if (row["total_hr"] or 0) >= 1: a["p_1_plus_hr"] += 1
        if (row["total_hr"] or 0) >= 2: a["p_2_plus_hr"] += 1
        if (row["total_tb"] or 0) >= 2: a["p_2_plus_tb"] += 1
        if (row["total_tb"] or 0) >= 3: a["p_3_plus_tb"] += 1
        if (row["total_tb"] or 0) >= 4: a["p_4_plus_tb"] += 1

    out = {}
    for (sb, h, hr, tb, ab), a in agg.items():
        if a["n"] < 20: continue
        rec = {"n": a["n"]}
        for k in ("p_1_plus_h","p_2_plus_h","p_3_plus_h","p_1_plus_hr","p_2_plus_hr",
                  "p_2_plus_tb","p_3_plus_tb","p_4_plus_tb"):
            rec[k] = round(a[k] / a["n"], 4)
        out[f"{sb}|h{h}|hr{hr}|tb{tb}|{ab}"] = rec
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
        "kprop_hit_rates_by_k_per_start": derive_kprop_threshold_hit_rates_by_k_per_start(conn),
        "hitprop_hit_rates_by_season_avg": derive_hitprop_hit_rates_by_season_avg(conn),
        "weather":                        derive_weather(conn),
        "batter_recent_form_15g":         derive_batter_recent_form(conn),
        "pitcher_recent_form_5gs":        derive_pitcher_recent_form(conn),
        "pitcher_pull_point":             derive_pitcher_pull_point(conn),
        "kprop_conditional":              derive_kprop_conditional(conn),
        "hitprop_conditional":            derive_hitprop_conditional(conn),
        "pa_exhaustion_by_state":         derive_pa_exhaustion(conn),
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
