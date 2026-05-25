"""Build the per-PA Win Expectancy table.

Replaces the (inning, half, run_diff) half-level table with a PA-state
table keyed by (inning, half, outs, bases, home_lead). The 100% bug we
patched in PR #42 was a symptom of the half-level table; this is the
root fix.

Inputs:  data/processed/rates.db
  - at_bats  (15M rows, full PA-state)
  - games    (198k rows, final scores)

Output:  web/functions/api/games/_we_table_v2.js
  - a JS module exporting WE_TABLE_V2 keyed by
    `${inning}|${half}|${outs}|${bases}|${home_lead}` → home win prob

Aggregation: for each at_bat (state X), count games where the home
team eventually won. WE(X) = wins / count. We clip extras to inning 9
and home_lead to ±10 — sample-size protection for rare states.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Iterable


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "data" / "processed" / "rates.db"
OUT_PATH = (
    PROJECT_ROOT / "web" / "functions" / "api" / "games" / "_we_table_v2.js"
)

# Sample-size threshold below which we DON'T trust the empirical rate and
# fall back to the closest well-sampled neighbor. 50 is conservative;
# above this, the standard error on a proportion is < 7 points.
MIN_SAMPLE_FOR_TRUST = 50

# Clip ranges keep the table compact AND protect against under-sampled
# extreme states.
INNING_CLIP = (1, 9)
HOME_LEAD_CLIP = (-10, 10)


def aggregate(con: sqlite3.Connection) -> dict[tuple, tuple[int, int]]:
    """Walk every at_bat joined to its game's final score; return
    {(inning, half, outs, bases, home_lead) -> (count, home_wins)}.

    Streamed with SQLite GROUP BY so we don't pull 15M rows into Python.
    """
    print("Aggregating …", file=sys.stderr)
    # SQLite quirk: MIN(MAX(x, k), k') inside a GROUP BY can get parsed as
    # the *aggregate* min/max rather than the 2-arg scalar form, which
    # gives bogus per-row clipping. Use explicit CASE expressions to
    # avoid the ambiguity entirely.
    sql = f"""
        SELECT
            CASE
                WHEN ab.inning < {INNING_CLIP[0]} THEN {INNING_CLIP[0]}
                WHEN ab.inning > {INNING_CLIP[1]} THEN {INNING_CLIP[1]}
                ELSE ab.inning
            END AS inning_c,
            ab.half,
            ab.outs,
            ab.bases,
            CASE
                WHEN ab.home_lead < {HOME_LEAD_CLIP[0]} THEN {HOME_LEAD_CLIP[0]}
                WHEN ab.home_lead > {HOME_LEAD_CLIP[1]} THEN {HOME_LEAD_CLIP[1]}
                ELSE ab.home_lead
            END AS home_lead_c,
            COUNT(*) AS n,
            SUM(CASE WHEN g.home_score > g.away_score THEN 1 ELSE 0 END) AS wins
        FROM at_bats ab
        JOIN games g USING (game_id)
        WHERE ab.outs BETWEEN 0 AND 2
          AND ab.bases BETWEEN 0 AND 7
        GROUP BY inning_c, ab.half, ab.outs, ab.bases, home_lead_c
    """
    out: dict[tuple, tuple[int, int]] = {}
    for row in con.execute(sql):
        inning, half, outs, bases, home_lead, n, wins = row
        out[(inning, half, outs, bases, home_lead)] = (int(n), int(wins))
    print(f"  {len(out):,} unique states aggregated", file=sys.stderr)
    return out


def smooth_low_sample(
    raw: dict[tuple, tuple[int, int]],
) -> dict[tuple, float]:
    """For each state, compute WE = wins / count. If a state has fewer
    than MIN_SAMPLE_FOR_TRUST observations, average it with the closest
    home_lead values that DO have enough samples — keeps thin cells from
    publishing wild outliers (a single bottom-6th 2-out bases-loaded
    home-down-9 PA shouldn't drive the WE for that state on its own).
    """
    we: dict[tuple, float] = {}
    skipped = 0
    smoothed = 0
    for state, (n, wins) in raw.items():
        inning, half, outs, bases, home_lead = state
        if n >= MIN_SAMPLE_FOR_TRUST:
            we[state] = wins / n
            continue
        # Pool neighbors of the same (inning, half, outs, bases) across
        # home_lead until we have enough sample. Walk outward in
        # |home_lead delta| up to ±3.
        pooled_n = n
        pooled_w = wins
        for delta in range(1, 4):
            for sign in (-1, 1):
                neighbor = (inning, half, outs, bases, home_lead + sign * delta)
                if HOME_LEAD_CLIP[0] <= neighbor[4] <= HOME_LEAD_CLIP[1]:
                    if neighbor in raw:
                        nn, nw = raw[neighbor]
                        pooled_n += nn
                        pooled_w += nw
            if pooled_n >= MIN_SAMPLE_FOR_TRUST:
                break
        if pooled_n >= MIN_SAMPLE_FOR_TRUST:
            we[state] = pooled_w / pooled_n
            smoothed += 1
        else:
            # Still too thin — drop. The endpoint will fall back to the
            # half-level table or the start-of-half approximation.
            skipped += 1
    print(
        f"  states kept: {len(we):,}"
        f"  smoothed-from-thin: {smoothed:,}"
        f"  dropped: {skipped:,}",
        file=sys.stderr,
    )
    return we


def emit_js(we: dict[tuple, float], out_path: Path) -> None:
    """Serialize as a JS module — `WE_TABLE_V2` is a plain JS object
    keyed by `"inning|half|outs|bases|home_lead"`. Worker scripts have
    a size limit; we round WE to 4 decimals to keep the file under
    500 KB.
    """
    print(f"Writing {out_path} …", file=sys.stderr)
    table: dict[str, float] = {}
    for (inning, half, outs, bases, home_lead), wp in we.items():
        key = f"{inning}|{half}|{outs}|{bases}|{home_lead}"
        table[key] = round(wp, 4)

    lines = [
        "// Auto-generated by src/build_we_table_v2.py. Do not hand-edit.",
        "//",
        "// PA-state win-expectancy table. Keys encode",
        "// `${inning}|${half}|${outs}|${bases}|${home_lead}`.",
        "// Values are the home team's empirical win probability from",
        "// that state, computed over 1910-2024 historical PBP (~15M PAs).",
        "//",
        "// Inning clipped to 1-9; home_lead clipped to ±10. States with",
        f"// fewer than {MIN_SAMPLE_FOR_TRUST} samples are smoothed by",
        "// pooling with ±home_lead neighbors; cells we couldn't smooth",
        "// are absent — caller falls back to the half-level table.",
        "",
        "export const WE_TABLE_V2 = " + json.dumps(table, separators=(",", ":")) + ";",
        "",
    ]
    out_path.write_text("\n".join(lines))
    size_kb = out_path.stat().st_size / 1024
    print(f"  {len(table):,} keys · {size_kb:,.0f} KB", file=sys.stderr)


def main() -> int:
    if not DB_PATH.exists():
        print(f"Missing {DB_PATH}", file=sys.stderr)
        return 1
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA query_only=ON")
    try:
        raw = aggregate(con)
        we = smooth_low_sample(raw)
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        emit_js(we, OUT_PATH)
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
