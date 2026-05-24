"""Build Supabase load files for the Phase 3.2 matchup engine.

Aggregates the local rates.db (modern era, 2020-2024 by default) into
per-(player, year, hand) outcome counts and writes SQL INSERT batches
that the Supabase MCP can execute against the production project.

Outputs:
  /tmp/diamond-supabase-load/batter_rates.sql
  /tmp/diamond-supabase-load/pitcher_rates.sql
  /tmp/diamond-supabase-load/league_rates.sql
  /tmp/diamond-supabase-load/players.sql

Run from the repo root:
  PYTHONPATH=. venv/bin/python scripts/build_supabase_load.py
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RATES_DB = REPO_ROOT / "data" / "processed" / "rates.db"
OUT_DIR = Path("/tmp/diamond-supabase-load")

# The window we load into Supabase (kept tight to fit the free tier
# comfortably and to make sense as a current-player demo).
FIRST_YEAR = 2020
LAST_YEAR = 2024

# Drop player-year slices below this PA threshold — a sparse cell off
# 5 PAs isn't useful and would inflate the table.
MIN_PA = 25

# Batch size for INSERT statements. 500 keeps each statement small
# enough to fit comfortably in any HTTP request.
BATCH_SIZE = 500


def aggregate_rates(conn: sqlite3.Connection):
    """Run the three rate aggregations against at_bats."""
    print(f"  aggregating batter_rates {FIRST_YEAR}-{LAST_YEAR}...")
    bat = conn.execute(
        "SELECT batter, year, bats, throws AS vs_hand, outcome, COUNT(*) AS n "
        "FROM at_bats "
        "WHERE year BETWEEN ? AND ? "
        "GROUP BY batter, year, bats, throws, outcome",
        (FIRST_YEAR, LAST_YEAR),
    ).fetchall()

    print(f"  aggregating pitcher_rates...")
    pit = conn.execute(
        "SELECT pitcher, year, throws, bats AS vs_hand, outcome, COUNT(*) AS n "
        "FROM at_bats "
        "WHERE year BETWEEN ? AND ? "
        "GROUP BY pitcher, year, throws, bats, outcome",
        (FIRST_YEAR, LAST_YEAR),
    ).fetchall()

    print(f"  aggregating league_rates...")
    lge = conn.execute(
        "SELECT year, bats, throws, outcome, COUNT(*) AS n "
        "FROM at_bats "
        "WHERE year BETWEEN ? AND ? "
        "GROUP BY year, bats, throws, outcome",
        (FIRST_YEAR, LAST_YEAR),
    ).fetchall()

    return bat, pit, lge


def filter_by_pa(rows, key_index, min_pa):
    """Drop rows whose (player, year) total PA is below the threshold."""
    totals: dict[tuple, int] = defaultdict(int)
    for r in rows:
        totals[(r[key_index[0]], r[key_index[1]])] += r[-1]
    return [r for r in rows
            if totals[(r[key_index[0]], r[key_index[1]])] >= min_pa]


def sql_value(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    return str(v)


def write_batches(rows, table: str, columns: list[str], path: Path) -> None:
    cols = ", ".join(columns)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for i in range(0, len(rows), BATCH_SIZE):
            batch = rows[i:i + BATCH_SIZE]
            values = ", ".join(
                "(" + ", ".join(sql_value(v) for v in row) + ")"
                for row in batch
            )
            stmt = (
                f"INSERT INTO {table} ({cols}) VALUES {values} "
                f"ON CONFLICT DO NOTHING;"
            )
            f.write(stmt + "\n")
    print(f"  wrote {path} — {len(rows):,} rows in "
          f"{(len(rows) + BATCH_SIZE - 1) // BATCH_SIZE} batches")


def fetch_chadwick(retro_ids: set[str]) -> list[tuple]:
    """Fetch the Chadwick Bureau register and filter to our roster."""
    print(f"  fetching Chadwick register (this triggers a one-time download)...")
    from pybaseball import chadwick_register
    df = chadwick_register()
    df = df[df["key_retro"].isin(retro_ids) & df["key_mlbam"].notna()]
    out: list[tuple] = []
    seen_mlbam: set[int] = set()
    for _, r in df.iterrows():
        mlbam = int(r["key_mlbam"])
        if mlbam in seen_mlbam:
            continue
        seen_mlbam.add(mlbam)
        out.append((
            mlbam,
            r["key_retro"] or None,
            (r.get("name_first") or "").strip() or None,
            (r.get("name_last")  or "").strip() or None,
        ))
    return out


def main() -> None:
    print(f"Reading {RATES_DB}")
    if not RATES_DB.exists():
        raise SystemExit(f"missing {RATES_DB} — run src.run_matchup first")
    conn = sqlite3.connect(f"file:{RATES_DB}?mode=ro", uri=True)

    bat, pit, lge = aggregate_rates(conn)
    print(f"  raw: batter={len(bat):,}  pitcher={len(pit):,}  league={len(lge):,}")

    bat = filter_by_pa(bat, key_index=(0, 1), min_pa=MIN_PA)
    pit = filter_by_pa(pit, key_index=(0, 1), min_pa=MIN_PA)
    print(f"  after MIN_PA={MIN_PA} filter: batter={len(bat):,}  pitcher={len(pit):,}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_batches(bat, "batter_rates",
                  ["batter", "year", "bats", "vs_hand", "outcome", "n"],
                  OUT_DIR / "batter_rates.sql")
    write_batches(pit, "pitcher_rates",
                  ["pitcher", "year", "throws", "vs_hand", "outcome", "n"],
                  OUT_DIR / "pitcher_rates.sql")
    write_batches(lge, "league_rates",
                  ["year", "bats", "throws", "outcome", "n"],
                  OUT_DIR / "league_rates.sql")

    # Players — only ones we actually have rates for
    retros = set(r[0] for r in bat) | set(r[0] for r in pit)
    print(f"\nFetching player IDs for {len(retros):,} retrosheet ids...")
    players = fetch_chadwick(retros)
    print(f"  matched {len(players):,} players")
    write_batches(players, "players",
                  ["mlbam", "retrosheet", "name_first", "name_last"],
                  OUT_DIR / "players.sql")

    print("\nDone. Load files written to /tmp/diamond-supabase-load/")


if __name__ == "__main__":
    main()
