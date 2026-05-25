"""Build per-count rate tables from the local Statcast `pitches` table.

For each completed PA in 2020-2024, walk every pitch and attribute the PA's
eventual outcome to the (player, vs_hand, balls, strikes, outcome) cell.
"Visits" model: a PA that went 0-0 → 1-0 → 1-1 → 2-1 → 2-2 → single
contributes one "single" to each of those five count cells.

Produces two output files (CSV, gzipped):

  data/processed/batter_rates_by_count.csv.gz
  data/processed/pitcher_rates_by_count.csv.gz

Schema: batter_mlbam, vs_hand, balls, strikes, outcome, n
        pitcher_mlbam, vs_hand, balls, strikes, outcome, n

Sample size note: pitches table covers 2020-2024 only (~877k PAs, ~3.4M
pitch visits). Individual count cells for a regular hitter run 60-180
PAs each; for sub players they're in single digits. Downstream callers
should regress toward the league baseline — REGRESSION_PA in the
matchup engine is 100, which gracefully shrinks thin cells without
killing them.

Why pitches (not at_bats): at_bats has 15M rows back to 1910, but only
preserves the FINAL count of each PA. Terminal-count rates would be
useless (every "terminal 3-0" PA is a walk, every "terminal 0-2" is a
strikeout). Per-count predictions require the in-progress states, and
only pitches has those.

Run:
    python -m src.build_rates_by_count

This is a one-shot ahead of the count-aware matchup endpoint; upload
script (src/upload_rates_by_count.py) ships the rows to Supabase.
"""
from __future__ import annotations

import csv
import gzip
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

# Reuse the daily_ingest mapping so the per-count tables agree with the
# rest of the engine on what counts as an OUT vs OTHER, what's a K vs a
# strikeout-double-play, etc.
from src.daily_ingest import OUTCOME_MAP


DB = Path("data/processed/rates.db")
OUT_DIR = Path("data/processed")
BATTER_OUT = OUT_DIR / "batter_rates_by_count.csv.gz"
PITCHER_OUT = OUT_DIR / "pitcher_rates_by_count.csv.gz"


def main() -> int:
    if not DB.exists():
        print(f"missing {DB} — run the data ingest first.", file=sys.stderr)
        return 2

    con = sqlite3.connect(DB)
    cur = con.cursor()

    # Pass 1: PA → events. Statcast convention: only the LAST pitch of a
    # PA has the events column populated; everything else is null.
    print("Pass 1: collecting PA outcomes...")
    t0 = time.time()
    pa_outcome: dict[tuple, str] = {}
    rows = cur.execute(
        "SELECT game_pk, at_bat_number, events "
        "FROM pitches WHERE events IS NOT NULL AND events != ''"
    )
    for game_pk, ab_no, events in rows:
        outcome = OUTCOME_MAP.get(events)
        if outcome is None:
            # Unmapped event — leave it out of the count tables rather
            # than miscategorize. Print a warning so we notice new
            # Statcast event types we haven't mapped yet.
            continue
        pa_outcome[(game_pk, ab_no)] = outcome
    print(f"  {len(pa_outcome):,} mapped PAs in {time.time() - t0:.1f}s")

    # Pass 2: walk every pitch, attribute to (player, hand, count, outcome).
    # Batter and pitcher get their own tally — same pitch contributes one
    # cell increment to each table.
    print("Pass 2: walking pitches, aggregating per-count cells...")
    t0 = time.time()
    batter_cells = defaultdict(int)
    pitcher_cells = defaultdict(int)
    n_visits = 0
    n_skipped = 0
    rows = cur.execute(
        "SELECT game_pk, at_bat_number, balls, strikes, "
        "       batter_mlbam, pitcher_mlbam, stand, p_throws "
        "FROM pitches"
    )
    for game_pk, ab_no, balls_blob, strikes_blob, b_id, p_id, stand, p_throws in rows:
        outcome = pa_outcome.get((game_pk, ab_no))
        if outcome is None:
            n_skipped += 1
            continue
        # balls/strikes are stored as 8-byte little-endian int64 BLOBs in
        # this DB — a quirk of the original ingest. Decode in Python.
        b = int.from_bytes(balls_blob, "little")
        s = int.from_bytes(strikes_blob, "little")
        # Defensive: a clean MLB feed never produces balls > 3 or strikes
        # > 2 (4 balls = walk, 3 strikes = K, PA ends). Skip impossible
        # cells rather than create phantom data.
        if b < 0 or b > 3 or s < 0 or s > 2:
            n_skipped += 1
            continue
        # Batter side: keyed by what HAND of pitcher they faced.
        batter_cells[(b_id, p_throws, b, s, outcome)] += 1
        # Pitcher side: keyed by what HAND of batter they faced.
        pitcher_cells[(p_id, stand, b, s, outcome)] += 1
        n_visits += 1
    print(
        f"  {n_visits:,} pitch visits aggregated"
        f" ({n_skipped:,} skipped) in {time.time() - t0:.1f}s"
    )
    print(
        f"  batter cells: {len(batter_cells):,} · "
        f"pitcher cells: {len(pitcher_cells):,}"
    )
    con.close()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_csv(
        BATTER_OUT,
        ["batter_mlbam", "vs_hand", "balls", "strikes", "outcome", "n"],
        batter_cells,
    )
    write_csv(
        PITCHER_OUT,
        ["pitcher_mlbam", "vs_hand", "balls", "strikes", "outcome", "n"],
        pitcher_cells,
    )

    # League per-(batter_hand, pitcher_hand, count, outcome) — the
    # regression target for the count-aware predict(). Same shape as the
    # all-count league_rates table but split by count too. 4 × 12 × 9 =
    # 432 cells max (smaller in practice).
    league_cells = aggregate_league(batter_cells, pitcher_cells)
    write_league_js(league_cells)

    spot_check(batter_cells, pitcher_cells)
    return 0


def aggregate_league(batter_cells: dict, pitcher_cells: dict) -> dict:
    """Roll up per-(batter_hand, pitcher_hand, balls, strikes, outcome).

    Note: we can derive the batter's hand by joining batter_mlbam to a
    bats-hand map. The pitches table has `stand` (batter's stance) and
    `p_throws` directly per pitch, so we re-aggregate from there rather
    than threading the join through batter_cells.
    """
    con = sqlite3.connect(DB)
    cur = con.cursor()
    league: dict = defaultdict(int)
    n_visits = 0
    n_skipped = 0

    print()
    print("Aggregating league per-(bats, throws, count) baseline...")
    t0 = time.time()

    # Re-collect PA outcomes (same Pass 1 we did before; cheap to redo).
    pa_outcome: dict[tuple, str] = {}
    for game_pk, ab_no, events in cur.execute(
        "SELECT game_pk, at_bat_number, events "
        "FROM pitches WHERE events IS NOT NULL AND events != ''"
    ):
        oc = OUTCOME_MAP.get(events)
        if oc: pa_outcome[(game_pk, ab_no)] = oc

    for game_pk, ab_no, balls_blob, strikes_blob, stand, p_throws in cur.execute(
        "SELECT game_pk, at_bat_number, balls, strikes, stand, p_throws FROM pitches"
    ):
        outcome = pa_outcome.get((game_pk, ab_no))
        if outcome is None: n_skipped += 1; continue
        if stand not in ("L", "R") or p_throws not in ("L", "R"):
            n_skipped += 1; continue
        b = int.from_bytes(balls_blob, "little")
        s = int.from_bytes(strikes_blob, "little")
        if not (0 <= b <= 3 and 0 <= s <= 2):
            n_skipped += 1; continue
        league[(stand, p_throws, b, s, outcome)] += 1
        n_visits += 1
    con.close()
    print(
        f"  {n_visits:,} visits aggregated ({n_skipped:,} skipped) "
        f"in {time.time() - t0:.1f}s · {len(league):,} cells"
    )
    return league


def write_league_js(league_cells: dict) -> None:
    """Emit the LEAGUE_RATES_BY_COUNT constant for the Workers bundle.

    Shipping as a JS constant (not a Supabase table) because the league
    baseline is small (4 hand pairs × 12 counts × 9 outcomes = 432
    cells max, ~3KB JSON), latency-critical (read on every count-aware
    matchup request), and immutable (changes only when we rebuild). A
    Supabase round-trip per request would add ~30ms for no benefit.
    """
    import json
    table: dict = {}
    for (stand, throws, b, s, outcome), n in league_cells.items():
        k = f"{stand}|{throws}|{b}|{s}"
        table.setdefault(k, {})[outcome] = n

    path = Path("web/functions/api/_league_rates_by_count.js")
    path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "// Auto-generated by src/build_rates_by_count.py from the local\n"
        "// Statcast `pitches` table (2020-2024). League per-count outcome\n"
        "// COUNTS keyed by '<bats>|<throws>|<balls>|<strikes>' — same role\n"
        "// the league_rates table plays for the all-count engine, just\n"
        "// sliced by count too.\n"
        "//\n"
        "// Shipped as a constant (not a Supabase table) because it's tiny,\n"
        "// immutable, and latency-critical (read on every count-aware\n"
        "// matchup request). A round-trip per request would add ~30ms for\n"
        "// no benefit.\n"
        "export const LEAGUE_RATES_BY_COUNT = "
    )
    with open(path, "w") as f:
        f.write(header)
        f.write(json.dumps(table, separators=(",", ":"), sort_keys=True))
        f.write(";\n")
    print(
        f"  wrote {path}: {len(table):,} cells, "
        f"{path.stat().st_size:,} bytes"
    )


def write_csv(path: Path, header: list[str], cells: dict) -> None:
    t0 = time.time()
    with gzip.open(path, "wt", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        for key, n in cells.items():
            w.writerow([*key, n])
    size_kb = path.stat().st_size / 1024
    print(
        f"  wrote {path.name}: {len(cells):,} rows, "
        f"{size_kb:,.0f} KB in {time.time() - t0:.1f}s"
    )


def spot_check(batter_cells: dict, pitcher_cells: dict) -> None:
    """Sanity-check the aggregation against published league rates.

    Headline numbers we expect (roughly, from Baseball Savant league
    splits 2020-2024): 0-2 K% ~48%, 3-0 BB% ~52% (rounded over the
    Statcast era is a bit higher), full-count high variance. If these
    are way off we likely have a column-decoding bug.
    """
    print()
    print("League rollup spot-check (should match published 2020-2024):")
    from itertools import product

    by_count: dict[tuple, dict] = defaultdict(lambda: defaultdict(int))
    for (_, _, b, s, outcome), n in batter_cells.items():
        by_count[(b, s)][outcome] += n

    print(f"  {'count':<7}{'visits':>10}{'K%':>8}{'BB%':>8}{'hit%':>8}")
    for b, s in product(range(4), range(3)):
        counts = by_count[(b, s)]
        total = sum(counts.values())
        if total == 0:
            continue
        k = counts.get("K", 0)
        bb = counts.get("BB", 0)
        hits = counts.get("1B", 0) + counts.get("2B", 0) + counts.get("3B", 0) + counts.get("HR", 0)
        print(
            f"  {b}-{s:<5}{total:>10,}"
            f"{k / total * 100:>7.1f}%"
            f"{bb / total * 100:>7.1f}%"
            f"{hits / total * 100:>7.1f}%"
        )


if __name__ == "__main__":
    sys.exit(main())
